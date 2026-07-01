import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";

const OWNER_WINDOW_MS = 5 * 60 * 1000;
const FORWARD_WINDOW_MS = 10 * 60 * 1000;
const TEXT_ATTACHMENT_WINDOW_MS = 3 * 60 * 1000;
const MAX_OWNER_BURST_SIZE = 10;

interface BundleCandidateRow extends Record<string, unknown> {
  id: string;
  telegram_chat_id: number;
  telegram_message_id: number;
  telegram_user_id: number;
  telegram_date: Date | string;
  current_text: string | null;
  message_type: string;
  forward_origin_type: string | null;
  forward_sender_name: string | null;
  forward_sender_username: string | null;
  forward_chat_title: string | null;
  reply_to_message_id: string | null;
  metadata: Record<string, unknown>;
  attachment_count: string;
}

export interface BundleSummary {
  bundlesCreated: number;
  messagesGrouped: number;
}

export class BundleService {
  constructor(private readonly db: Database) {}

  async rebuildAutoBundles(): Promise<BundleSummary> {
    const rows = await this.loadRows();
    const groups = this.buildGroups(rows);

    await this.db.execute(sql`
      delete from bundle_messages
      where bundle_id in (
        select id
        from bundles
        where metadata->>'createdBy' = 'auto_bundle_service'
      )
    `);

    let messagesGrouped = 0;
    for (const group of groups) {
      if (group.messageIds.length < 2) continue;
      const bundleId = await this.upsertBundle(group);
      for (const [index, messageId] of group.messageIds.entries()) {
        await this.db.execute(sql`
          insert into bundle_messages (bundle_id, message_id, position)
          values (${bundleId}, ${messageId}, ${index})
        `);
      }
      messagesGrouped += group.messageIds.length;
    }

    const activeKeys = groups
      .filter((group) => group.messageIds.length > 1)
      .map((group) => group.key);
    if (activeKeys.length > 0) {
      await this.db.execute(sql`
        delete from bundles
        where metadata->>'createdBy' = 'auto_bundle_service'
          and not (metadata->>'groupKey' in (${sql.join(
            activeKeys.map((key) => sql`${key}`),
            sql`, `,
          )}))
      `);
    } else {
      await this.db.execute(sql`
        delete from bundles
        where metadata->>'createdBy' = 'auto_bundle_service'
      `);
    }

    return { bundlesCreated: groups.filter((group) => group.messageIds.length > 1).length, messagesGrouped };
  }

  private async upsertBundle(group: {
    key: string;
    rule: string;
    title: string;
    messageIds: string[];
  }) {
    const metadata = {
      createdBy: "auto_bundle_service",
      groupKey: group.key,
      rule: group.rule,
      messageCount: group.messageIds.length,
    };
    const existing = await this.db.execute<{ id: string }>(sql`
      select id
      from bundles
      where metadata->>'createdBy' = 'auto_bundle_service'
        and metadata->>'groupKey' = ${group.key}
      limit 1
    `);
    if (existing.rows[0]) {
      await this.db.execute(sql`
        update bundles
        set
          title = ${group.title},
          metadata = ${JSON.stringify(metadata)}::jsonb,
          updated_at = now()
        where id = ${existing.rows[0].id}
      `);
      return existing.rows[0].id;
    }

    const inserted = await this.db.execute<{ id: string }>(sql`
      insert into bundles (title, metadata, updated_at)
      values (${group.title}, ${JSON.stringify(metadata)}::jsonb, now())
      returning id
    `);
    return inserted.rows[0]!.id;
  }

  async stats() {
    const result = await this.db.execute<{
      bundle_count: string;
      grouped_message_count: string;
    }>(sql`
      select
        (select count(*) from bundles where metadata->>'createdBy' = 'auto_bundle_service') as bundle_count,
        (select count(*)
         from bundle_messages bm
         join bundles b on b.id = bm.bundle_id
         where b.metadata->>'createdBy' = 'auto_bundle_service') as grouped_message_count
    `);
    return result.rows[0]!;
  }

  private async loadRows() {
    const result = await this.db.execute<BundleCandidateRow>(sql`
      select
        m.id,
        m.telegram_chat_id,
        m.telegram_message_id,
        m.telegram_user_id,
        m.telegram_date,
        m.current_text,
        m.message_type,
        m.forward_origin_type,
        m.forward_sender_name,
        m.forward_sender_username,
        m.forward_chat_title,
        m.reply_to_message_id,
        m.metadata,
        (select count(*) from attachments a where a.message_id = m.id) as attachment_count
      from messages m
      order by m.telegram_chat_id asc, m.telegram_date asc, m.telegram_message_id asc
    `);
    return result.rows;
  }

  private buildGroups(rows: BundleCandidateRow[]) {
    const groups: Array<{ key: string; rule: string; title: string; messageIds: string[] }> = [];
    const assigned = new Set<string>();

    for (const groupRows of groupByMediaGroup(rows)) {
      this.addGroup(groups, assigned, "media_group", groupRows, "Медиа-группа Telegram");
    }
    for (const groupRows of groupByReply(rows, assigned)) {
      this.addGroup(groups, assigned, "reply_thread", groupRows, "Связанные reply-сообщения");
    }
    for (const groupRows of groupSequentialForwards(rows, assigned)) {
      this.addGroup(groups, assigned, "sequential_forward", groupRows, "Серия пересланных сообщений");
    }
    for (const groupRows of groupTextThenAttachment(rows, assigned)) {
      this.addGroup(groups, assigned, "text_then_attachment", groupRows, "Текст и вложение");
    }
    for (const groupRows of groupOwnerBursts(rows, assigned)) {
      this.addGroup(groups, assigned, "owner_time_window", groupRows, "Серия сообщений владельца");
    }

    return groups;
  }

  private addGroup(
    groups: Array<{ key: string; rule: string; title: string; messageIds: string[] }>,
    assigned: Set<string>,
    rule: string,
    rows: BundleCandidateRow[],
    title: string,
  ) {
    const freshRows = rows.filter((row) => !assigned.has(row.id));
    if (freshRows.length < 2) return;
    const messageIds = freshRows.map((row) => row.id);
    for (const messageId of messageIds) assigned.add(messageId);
    groups.push({
      key: `${rule}:${hash(messageIds.join(":"))}`,
      rule,
      title,
      messageIds,
    });
  }
}

function groupByMediaGroup(rows: BundleCandidateRow[]) {
  const grouped = new Map<string, BundleCandidateRow[]>();
  for (const row of rows) {
    const mediaGroupId = row.metadata?.mediaGroupId;
    if (typeof mediaGroupId !== "string" || !mediaGroupId) continue;
    const key = `${row.telegram_chat_id}:${mediaGroupId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped.values()];
}

function groupByReply(rows: BundleCandidateRow[], assigned: Set<string>) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const grouped = new Map<string, BundleCandidateRow[]>();
  for (const row of rows) {
    if (assigned.has(row.id) || !row.reply_to_message_id) continue;
    const parent = byId.get(row.reply_to_message_id);
    if (!parent || assigned.has(parent.id)) continue;
    const key = parent.reply_to_message_id ?? parent.id;
    grouped.set(key, [...(grouped.get(key) ?? [parent]), row]);
  }
  return [...grouped.values()].map(sortRows);
}

function groupSequentialForwards(rows: BundleCandidateRow[], assigned: Set<string>) {
  return groupAdjacent(rows, assigned, (previous, current) => {
    if (!forwardKey(previous) || forwardKey(previous) !== forwardKey(current)) return false;
    return sameChatAndUser(previous, current) && deltaMs(previous, current) <= FORWARD_WINDOW_MS;
  });
}

function groupTextThenAttachment(rows: BundleCandidateRow[], assigned: Set<string>) {
  return groupAdjacent(rows, assigned, (previous, current) => {
    return (
      sameChatAndUser(previous, current) &&
      Boolean(previous.current_text?.trim()) &&
      Number(previous.attachment_count) === 0 &&
      Number(current.attachment_count) > 0 &&
      deltaMs(previous, current) <= TEXT_ATTACHMENT_WINDOW_MS
    );
  });
}

function groupOwnerBursts(rows: BundleCandidateRow[], assigned: Set<string>) {
  return groupAdjacent(rows, assigned, (previous, current, groupSize) => {
    return (
      groupSize < MAX_OWNER_BURST_SIZE &&
      sameChatAndUser(previous, current) &&
      !forwardKey(previous) &&
      !forwardKey(current) &&
      deltaMs(previous, current) <= OWNER_WINDOW_MS
    );
  });
}

function groupAdjacent(
  rows: BundleCandidateRow[],
  assigned: Set<string>,
  shouldJoin: (previous: BundleCandidateRow, current: BundleCandidateRow, groupSize: number) => boolean,
) {
  const groups: BundleCandidateRow[][] = [];
  let currentGroup: BundleCandidateRow[] = [];
  for (const row of rows) {
    if (assigned.has(row.id)) {
      if (currentGroup.length > 1) groups.push(currentGroup);
      currentGroup = [];
      continue;
    }
    const previous = currentGroup.at(-1);
    if (previous && shouldJoin(previous, row, currentGroup.length)) {
      currentGroup.push(row);
      continue;
    }
    if (currentGroup.length > 1) groups.push(currentGroup);
    currentGroup = [row];
  }
  if (currentGroup.length > 1) groups.push(currentGroup);
  return groups;
}

function sameChatAndUser(a: BundleCandidateRow, b: BundleCandidateRow) {
  return a.telegram_chat_id === b.telegram_chat_id && a.telegram_user_id === b.telegram_user_id;
}

function deltaMs(a: BundleCandidateRow, b: BundleCandidateRow) {
  return Math.abs(new Date(b.telegram_date).getTime() - new Date(a.telegram_date).getTime());
}

function forwardKey(row: BundleCandidateRow) {
  return [
    row.forward_origin_type,
    row.forward_sender_username,
    row.forward_sender_name,
    row.forward_chat_title,
  ]
    .filter(Boolean)
    .join(":");
}

function sortRows(rows: BundleCandidateRow[]) {
  return [...rows].sort((a, b) => {
    const byDate = new Date(a.telegram_date).getTime() - new Date(b.telegram_date).getTime();
    return byDate || a.telegram_message_id - b.telegram_message_id;
  });
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

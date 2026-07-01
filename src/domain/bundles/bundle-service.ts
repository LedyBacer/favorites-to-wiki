import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";

const FORWARD_WINDOW_MS = 10 * 60 * 1000;
const TEXT_ATTACHMENT_WINDOW_MS = 3 * 60 * 1000;
const BUNDLE_SETTLING_WINDOW_MS = 60 * 1000;

export interface BundleCandidateRow extends Record<string, unknown> {
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

export interface AutoBundleGroup {
  key: string;
  rule: string;
  title: string;
  messageIds: string[];
  status: "open" | "closed";
}

export class BundleService {
  constructor(private readonly db: Database) {}

  async rebuildAutoBundles(): Promise<BundleSummary> {
    const rows = await this.loadRows();
    const groups = buildAutoBundleGroups(rows);

    await this.db.execute(sql`
      delete from bundle_messages
      where bundle_id in (
        select id
        from bundles
        where metadata->>'createdBy' = 'auto_bundle_service'
          and status in ('open', 'closed')
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
        update bundles
        set status = 'superseded',
            metadata = metadata || jsonb_build_object('supersededAt', now()),
            updated_at = now()
        where metadata->>'createdBy' = 'auto_bundle_service'
          and status in ('open', 'closed')
          and not (metadata->>'groupKey' in (${sql.join(
            activeKeys.map((key) => sql`${key}`),
            sql`, `,
          )}))
      `);
    } else {
      await this.db.execute(sql`
        update bundles
        set status = 'superseded',
            metadata = metadata || jsonb_build_object('supersededAt', now()),
            updated_at = now()
        where metadata->>'createdBy' = 'auto_bundle_service'
          and status in ('open', 'closed')
      `);
    }

    await this.db.execute(sql`
      delete from bundle_messages
      where bundle_id in (
        select id
        from bundles
        where metadata->>'createdBy' = 'auto_bundle_service'
          and status = 'superseded'
      )
    `);

    return { bundlesCreated: groups.filter((group) => group.messageIds.length > 1).length, messagesGrouped };
  }

  private async upsertBundle(group: {
    key: string;
    rule: string;
    title: string;
    messageIds: string[];
    status: "open" | "closed";
  }) {
    const metadata = {
      createdBy: "auto_bundle_service",
      groupKey: group.key,
      rule: group.rule,
      messageCount: group.messageIds.length,
      lifecycle: group.status,
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
          status = ${group.status}::auto_bundle_status,
          closed_at = case
            when ${group.status} = 'closed' and closed_at is null then now()
            when ${group.status} = 'open' then null
            else closed_at
          end,
          metadata = ${JSON.stringify(metadata)}::jsonb,
          updated_at = now()
        where id = ${existing.rows[0].id}
      `);
      return existing.rows[0].id;
    }

    const inserted = await this.db.execute<{ id: string }>(sql`
      insert into bundles (title, status, closed_at, metadata, updated_at)
      values (
        ${group.title},
        ${group.status}::auto_bundle_status,
        case when ${group.status} = 'closed' then now() else null end,
        ${JSON.stringify(metadata)}::jsonb,
        now()
      )
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
        (select count(*) from bundles where metadata->>'createdBy' = 'auto_bundle_service' and status <> 'superseded') as bundle_count,
        (select count(*)
         from bundle_messages bm
         join bundles b on b.id = bm.bundle_id
         where b.metadata->>'createdBy' = 'auto_bundle_service'
           and b.status <> 'superseded') as grouped_message_count
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

}

export function buildAutoBundleGroups(rows: BundleCandidateRow[]): AutoBundleGroup[] {
  const groups: AutoBundleGroup[] = [];
  const assigned = new Set<string>();

  for (const groupRows of groupByMediaGroup(rows)) {
    addGroup(groups, assigned, "media_group", groupRows, "Медиа-группа Telegram");
  }
  for (const groupRows of groupByReply(rows, assigned)) {
    addGroup(groups, assigned, "reply_thread", groupRows, "Связанные reply-сообщения");
  }
  for (const groupRows of groupSequentialForwards(rows, assigned)) {
    addGroup(groups, assigned, "sequential_forward", groupRows, "Серия пересланных сообщений");
  }
  for (const groupRows of groupTextThenAttachment(rows, assigned)) {
    addGroup(groups, assigned, "text_then_attachment", groupRows, "Текст и вложение");
  }

  return groups;
}

function addGroup(
  groups: AutoBundleGroup[],
  assigned: Set<string>,
  rule: string,
  rows: BundleCandidateRow[],
  title: string,
) {
  const freshRows = rows.filter((row) => !assigned.has(row.id));
  if (freshRows.length < 2) return;
  const messageIds = freshRows.map((row) => row.id);
  for (const messageId of messageIds) assigned.add(messageId);
  const lastDate = Math.max(...freshRows.map((row) => new Date(row.telegram_date).getTime()));
  const status = Date.now() - lastDate >= BUNDLE_SETTLING_WINDOW_MS ? "closed" : "open";
  groups.push({
    key: `${rule}:${stableGroupSeed(rule, freshRows)}`,
    rule,
    title,
    messageIds,
    status,
  });
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

function stableGroupSeed(rule: string, rows: BundleCandidateRow[]) {
  const sorted = sortRows(rows);
  const first = sorted[0]!;
  if (rule === "media_group") {
    const mediaGroupId =
      typeof first.metadata?.mediaGroupId === "string" ? first.metadata.mediaGroupId : first.id;
    return hash(`${first.telegram_chat_id}:${mediaGroupId}`);
  }
  if (rule === "reply_thread") {
    return hash(`${first.telegram_chat_id}:${first.reply_to_message_id ?? first.id}`);
  }
  if (rule === "sequential_forward") {
    return hash(`${first.telegram_chat_id}:${forwardKey(first)}:${first.id}`);
  }
  if (rule === "text_then_attachment") {
    return hash(`${first.telegram_chat_id}:${first.id}`);
  }
  return hash(`${first.telegram_chat_id}:${first.id}`);
}

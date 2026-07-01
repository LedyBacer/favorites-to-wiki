import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { buildClassificationSource } from "../llm/classification-source.js";
import { LLM_CLASSIFICATION_JOB } from "../llm/llm-classification-service.js";

export type ReviewActionKind = "accept" | "reject" | "ignore" | "correct";

export interface InboxProposal extends Record<string, unknown> {
  id: string;
  type: string;
  title: string | null;
  body: string | null;
  sourceKind: string;
  sourceId: string;
  sourceMessageId: string | null;
  sourceBundleId: string | null;
  sourcePreview: string | null;
  sourceTelegramChatId: number | null;
  sourceTelegramMessageId: number | null;
  bundleMessageCount: number;
  clarificationRequestId: string | null;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  createdAt: Date | string;
}

export class ReviewService {
  constructor(
    private readonly db: Database,
    private readonly options: { llmMaxInputChars: number } = { llmMaxInputChars: 20_000 },
  ) {}

  async pendingInbox(limit = 3): Promise<InboxProposal[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 10);
    const result = await this.db.execute<InboxProposal>(sql`
      select
        r.id,
        r.type,
        r.title,
        r.body,
        coalesce(r.metadata->>'sourceKind', case when r.source_bundle_id is null then 'message' else 'bundle' end) as "sourceKind",
        coalesce(r.metadata->>'sourceId', r.source_message_id::text, r.source_bundle_id::text) as "sourceId",
        r.source_message_id as "sourceMessageId",
        r.source_bundle_id as "sourceBundleId",
        coalesce(source_message.current_text, bundle_preview.preview_text) as "sourcePreview",
        source_message.telegram_chat_id as "sourceTelegramChatId",
        source_message.telegram_message_id as "sourceTelegramMessageId",
        coalesce(bundle_preview.message_count, 0)::int as "bundleMessageCount",
        cr.id as "clarificationRequestId",
        coalesce((r.metadata->>'needsClarification')::boolean, false) as "needsClarification",
        coalesce(cr.question, r.metadata->>'clarificationQuestion') as "clarificationQuestion",
        r.created_at as "createdAt"
      from records r
      left join messages source_message on source_message.id = r.source_message_id
      left join lateral (
        select
          count(*) as message_count,
          string_agg(coalesce(m.current_text, '[' || m.message_type || ']'), E'\n' order by bm.position) as preview_text
        from bundle_messages bm
        join messages m on m.id = bm.message_id
        where bm.bundle_id = r.source_bundle_id
      ) bundle_preview on true
      left join clarification_requests cr
        on cr.source_kind = coalesce(r.metadata->>'sourceKind', case when r.source_bundle_id is null then 'message' else 'bundle' end)
        and cr.source_id = coalesce(r.metadata->>'sourceId', r.source_message_id::text, r.source_bundle_id::text)::uuid
        and cr.status = 'pending'
      where r.status = 'proposed'
      order by r.updated_at asc, r.created_at asc
      limit ${safeLimit}
    `);
    return result.rows;
  }

  async act(recordId: string, action: Exclude<ReviewActionKind, "correct">, telegramUserId: number) {
    const targetStatus = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "rejected";
    const auditAction = action === "ignore" ? "ignore" : action;
    const result = await this.db.execute<{ id: string; previous_status: string }>(sql`
      update records
      set
        status = ${targetStatus}::review_status,
        metadata = metadata || jsonb_build_object('status', ${targetStatus}, 'reviewAction', ${auditAction}),
        updated_at = now()
      where id = ${recordId}
        and status = 'proposed'
      returning id, ${"proposed"} as previous_status
    `);
    if (!result.rows[0]) return false;
    await this.audit("record", recordId, auditAction, { status: "proposed" }, { status: targetStatus }, telegramUserId);
    return true;
  }

  async answerClarification(
    clarificationRequestId: string,
    answer: string,
    telegramUserId: number,
    telegramMessageId: number,
  ) {
    const existing = await this.db.execute<{
      id: string;
      source_kind: "message" | "bundle";
      source_id: string;
      provider: string;
      model: string;
      generation_key: string;
      question: string;
      status: string;
    }>(sql`
      select
        id,
        source_kind,
        source_id,
        provider,
        model,
        generation_key,
        question,
        status
      from clarification_requests
      where id = ${clarificationRequestId}
      limit 1
    `);
    const row = existing.rows[0];
    if (!row || row.status !== "pending") return false;

    const trimmedAnswer = answer.trim();
    if (!trimmedAnswer) return false;

    await this.db.execute(sql`
      update clarification_requests
      set
        status = 'answered',
        answer = ${trimmedAnswer},
        answer_telegram_message_id = ${telegramMessageId},
        answered_by_telegram_user_id = ${telegramUserId},
        answered_at = now(),
        updated_at = now()
      where id = ${clarificationRequestId}
        and status = 'pending'
    `);

    await this.audit(
      "clarification_request",
      clarificationRequestId,
      "answer",
      { status: "pending", question: row.question },
      { status: "answered", answer: trimmedAnswer },
      telegramUserId,
    );

    await this.reopenClassificationForClarification(row);
    return true;
  }

  async correctedAccept(recordId: string, titleOrBody: string, telegramUserId: number) {
    const existing = await this.db.execute<{
      id: string;
      title: string | null;
      body: string | null;
      status: string;
    }>(sql`
      select id, title, body, status
      from records
      where id = ${recordId}
      limit 1
    `);
    const row = existing.rows[0];
    if (!row || row.status !== "proposed") return false;
    await this.db.execute(sql`
      update records
      set
        status = 'accepted',
        title = ${titleOrBody},
        metadata = metadata || jsonb_build_object('status', 'accepted', 'reviewAction', 'correct', 'manualCorrection', true),
        updated_at = now()
      where id = ${recordId}
        and status = 'proposed'
    `);
    await this.audit(
      "record",
      recordId,
      "correct",
      { status: row.status, title: row.title, body: row.body },
      { status: "accepted", title: titleOrBody },
      telegramUserId,
    );
    return true;
  }

  private async audit(
    targetKind: string,
    targetId: string,
    action: string,
    previousValues: Record<string, unknown>,
    newValues: Record<string, unknown>,
    telegramUserId: number,
  ) {
    await this.db.execute(sql`
      insert into review_actions (
        target_kind,
        target_id,
        action,
        previous_values,
        new_values,
        telegram_user_id
      )
      values (
        ${targetKind},
        ${targetId},
        ${action},
        ${JSON.stringify(previousValues)}::jsonb,
        ${JSON.stringify(newValues)}::jsonb,
        ${telegramUserId}
      )
    `);
  }

  private async reopenClassificationForClarification(row: {
    source_kind: "message" | "bundle";
    source_id: string;
    provider: string;
    model: string;
    generation_key: string;
  }) {
    const source = await buildClassificationSource(
      this.db,
      row.source_id,
      this.options.llmMaxInputChars,
      row.source_kind,
    );
    if (!source?.text) return;

    await this.db.execute(sql`
      insert into processing_jobs (
        type,
        subject_kind,
        subject_id,
        generation_key,
        input_hash,
        payload,
        max_attempts,
        status,
        run_after,
        updated_at
      )
      values (
        ${LLM_CLASSIFICATION_JOB},
        ${row.source_kind},
        ${row.source_id},
        ${row.generation_key},
        ${source.contentHash},
        ${JSON.stringify({
          phase: 7,
          provider: row.provider,
          model: row.model,
          sourceKind: row.source_kind,
          trigger: "clarification_answer",
        })}::jsonb,
        3,
        'pending',
        now(),
        now()
      )
      on conflict (type, subject_kind, subject_id)
      do update set
        generation_key = excluded.generation_key,
        input_hash = excluded.input_hash,
        payload = processing_jobs.payload || excluded.payload,
        status = 'pending',
        attempts = 0,
        locked_by = null,
        locked_at = null,
        last_error = null,
        run_after = now(),
        completed_at = null,
        updated_at = now()
    `);
  }
}

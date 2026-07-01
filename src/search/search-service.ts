import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";

export interface SearchResult extends Record<string, unknown> {
  id: string;
  telegramChatId: number;
  telegramMessageId: number;
  telegramDate: Date | string;
  currentText: string | null;
  messageType: string;
  attachmentNames: string | null;
  acceptedRecordTitle: string | null;
  acceptedRecordType: string | null;
  matchReasons: string[];
  rank: number;
}

export class SearchService {
  constructor(private readonly db: Database) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const result = await this.db.execute<SearchResult>(sql`
      with search_query as (
        select plainto_tsquery('simple', ${query}) as tsq,
               ${`%${query}%`} as like_query
      ),
      message_context as (
        select
          m.id,
          string_agg(distinct da.content::text, E'\n') filter (
            where da.artifact_type in ('normalized_text', 'ocr_text', 'transcript', 'image_description')
          ) as derived_text,
          string_agg(distinct bm.bundle_id::text, ',') as bundle_ids,
          string_agg(distinct bundle_text.current_text, E'\n') filter (where bundle_text.id is not null) as bundle_text
        from messages m
        left join attachments a on a.message_id = m.id
        left join derived_artifacts da
          on (
            (da.source_kind = 'message' and da.source_id = m.id)
            or (da.source_kind = 'attachment' and da.source_id = a.id)
          )
        left join bundle_messages bm on bm.message_id = m.id
        left join bundle_messages bm_peer on bm_peer.bundle_id = bm.bundle_id
        left join messages bundle_text on bundle_text.id = bm_peer.message_id and bundle_text.id <> m.id
        group by m.id
      ),
      accepted_records as (
        select
          coalesce(r.source_message_id, bm.message_id) as message_id,
          string_agg(r.title, ', ' order by r.updated_at desc) as titles,
          string_agg(r.type::text, ', ' order by r.updated_at desc) as types,
          string_agg(concat_ws(' ', r.type::text, r.title, r.body), E'\n') as record_text
        from records r
        left join bundle_messages bm on bm.bundle_id = r.source_bundle_id
        where r.status = 'accepted'
        group by coalesce(r.source_message_id, bm.message_id)
      )
      select
        m.id,
        m.telegram_chat_id as "telegramChatId",
        m.telegram_message_id as "telegramMessageId",
        m.telegram_date as "telegramDate",
        m.current_text as "currentText",
        m.message_type as "messageType",
        string_agg(a.original_file_name, ', ' order by a.original_file_name) as "attachmentNames",
        max(ar.titles) as "acceptedRecordTitle",
        max(ar.types) as "acceptedRecordType",
        array_remove(array[
          case when to_tsvector('simple', coalesce(m.current_text, '')) @@ search_query.tsq or m.current_text ilike search_query.like_query then 'source text' end,
          case when max(a.original_file_name) ilike search_query.like_query then 'file name' end,
          case when coalesce(max(mc.derived_text), '') ilike search_query.like_query then 'derived text' end,
          case when coalesce(max(mc.bundle_text), '') ilike search_query.like_query then 'bundle context' end,
          case when coalesce(max(ar.record_text), '') ilike search_query.like_query then 'accepted record' end
        ], null) as "matchReasons",
        (
          case
            when to_tsvector('simple', coalesce(m.current_text, '')) @@ search_query.tsq
              then ts_rank(to_tsvector('simple', coalesce(m.current_text, '')), search_query.tsq) * 2
            else 0
          end
          + coalesce(max(
            case
              when to_tsvector('simple', coalesce(a.original_file_name, '')) @@ search_query.tsq
                then ts_rank(to_tsvector('simple', coalesce(a.original_file_name, '')), search_query.tsq)
              else 0
            end
          ), 0)
          + case when m.current_text ilike ${`%${query}%`} then 0.05 else 0 end
          + coalesce(max(case when a.original_file_name ilike ${`%${query}%`} then 0.03 else 0 end), 0)
          + case when coalesce(max(mc.derived_text), '') ilike search_query.like_query then 0.25 else 0 end
          + case when coalesce(max(mc.bundle_text), '') ilike search_query.like_query then 0.15 else 0 end
          + case when coalesce(max(ar.record_text), '') ilike search_query.like_query then 0.4 else 0 end
        )::float as "rank"
      from messages m
      left join attachments a on a.message_id = m.id
      left join message_context mc on mc.id = m.id
      left join accepted_records ar on ar.message_id = m.id
      cross join search_query
      where
        to_tsvector('simple', coalesce(m.current_text, '')) @@ search_query.tsq
        or to_tsvector('simple', coalesce(a.original_file_name, '')) @@ search_query.tsq
        or m.current_text ilike search_query.like_query
        or a.original_file_name ilike search_query.like_query
        or coalesce(mc.derived_text, '') ilike search_query.like_query
        or coalesce(mc.bundle_text, '') ilike search_query.like_query
        or coalesce(ar.record_text, '') ilike search_query.like_query
      group by m.id, search_query.tsq, search_query.like_query
      order by "rank" desc, m.telegram_date desc
      limit ${limit}
    `);
    return result.rows;
  }
}

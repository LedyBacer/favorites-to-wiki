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
  rank: number;
}

export class SearchService {
  constructor(private readonly db: Database) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const result = await this.db.execute<SearchResult>(sql`
      with search_query as (
        select plainto_tsquery('simple', ${query}) as tsq
      )
      select
        m.id,
        m.telegram_chat_id as "telegramChatId",
        m.telegram_message_id as "telegramMessageId",
        m.telegram_date as "telegramDate",
        m.current_text as "currentText",
        m.message_type as "messageType",
        string_agg(a.original_file_name, ', ' order by a.original_file_name) as "attachmentNames",
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
        )::float as "rank"
      from messages m
      left join attachments a on a.message_id = m.id
      cross join search_query
      where
        to_tsvector('simple', coalesce(m.current_text, '')) @@ search_query.tsq
        or to_tsvector('simple', coalesce(a.original_file_name, '')) @@ search_query.tsq
        or m.current_text ilike ${`%${query}%`}
        or a.original_file_name ilike ${`%${query}%`}
      group by m.id, search_query.tsq
      order by "rank" desc, m.telegram_date desc
      limit ${limit}
    `);
    return result.rows;
  }
}

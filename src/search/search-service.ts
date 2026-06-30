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
}

export class SearchService {
  constructor(private readonly db: Database) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const result = await this.db.execute<SearchResult>(sql`
      select
        m.id,
        m.telegram_chat_id as "telegramChatId",
        m.telegram_message_id as "telegramMessageId",
        m.telegram_date as "telegramDate",
        m.current_text as "currentText",
        m.message_type as "messageType",
        string_agg(a.original_file_name, ', ') as "attachmentNames"
      from messages m
      left join attachments a on a.message_id = m.id
      where
        to_tsvector('simple', coalesce(m.current_text, '')) @@ plainto_tsquery('simple', ${query})
        or to_tsvector('simple', coalesce(a.original_file_name, '')) @@ plainto_tsquery('simple', ${query})
        or m.current_text ilike ${`%${query}%`}
        or a.original_file_name ilike ${`%${query}%`}
      group by m.id
      order by m.telegram_date desc
      limit ${limit}
    `);
    return result.rows;
  }
}

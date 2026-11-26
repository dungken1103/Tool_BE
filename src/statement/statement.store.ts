import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../database/database.service';

export const fileHash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Lưu tệp sao kê gốc và kết quả Gemini đọc từng lô trang (theo mã băm tệp + khoảng trang),
 * để tải lại cùng tệp không phải gọi AI lại; lô lỗi không được lưu nên lần sau chỉ đọc lại lô đó.
 */
@Injectable()
export class StatementStore implements OnModuleInit {
  private readonly logger = new Logger(StatementStore.name);

  constructor(private readonly database: DatabaseService) {}

  private get pool() {
    return this.database.pool;
  }

  async onModuleInit() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS statement_files (
          hash TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          page_count INTEGER NOT NULL,
          data BYTEA NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS extraction_chunks (
          file_hash TEXT NOT NULL REFERENCES statement_files(hash) ON DELETE CASCADE,
          start_page INTEGER NOT NULL,
          end_page INTEGER NOT NULL,
          response JSONB NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (file_hash, start_page, end_page)
        );
      `);
    } catch (error) {
      this.logger.error(`Không tạo được bảng lưu sao kê (kiểm tra DATABASE_URL): ${error instanceof Error ? error.message : error}`);
    }
  }

  async saveFile(hash: string, name: string, mimeType: string, pageCount: number, data: Buffer) {
    await this.pool.query(
      `INSERT INTO statement_files (hash, name, mime_type, size, page_count, data) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (hash) DO NOTHING`,
      [hash, name, mimeType, data.length, pageCount, data],
    );
  }

  async getFile(hash: string) {
    const { rows } = await this.pool.query<{ name: string; mime_type: string; data: Buffer }>(
      'SELECT name, mime_type, data FROM statement_files WHERE hash = $1',
      [hash],
    );
    if (!rows[0]) throw new NotFoundException('Không tìm thấy tệp sao kê đã lưu.');
    return { name: rows[0].name, mimeType: rows[0].mime_type, data: rows[0].data };
  }

  async getChunk<T>(hash: string, startPage: number, endPage: number): Promise<T | null> {
    const { rows } = await this.pool.query<{ response: T }>(
      'SELECT response FROM extraction_chunks WHERE file_hash = $1 AND start_page = $2 AND end_page = $3',
      [hash, startPage, endPage],
    );
    return rows[0]?.response ?? null;
  }

  async saveChunk(hash: string, startPage: number, endPage: number, response: unknown, model: string) {
    await this.pool.query(
      `INSERT INTO extraction_chunks (file_hash, start_page, end_page, response, model) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (file_hash, start_page, end_page) DO UPDATE SET response = EXCLUDED.response, model = EXCLUDED.model, created_at = now()`,
      [hash, startPage, endPage, JSON.stringify(response), model],
    );
  }
}

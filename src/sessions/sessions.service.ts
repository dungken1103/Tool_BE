import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';

/** Một lưu ý cần sửa, chụp lại lúc lưu (lệch số dư, ô AI không chắc, thiếu TK…). */
export interface SessionIssue {
  level: 'error' | 'warning';
  message: string;
  /** STT giao dịch trong bảng (nếu lưu ý gắn với một dòng). */
  row?: number | null;
}

/** Dữ liệu phiên do frontend gửi (tệp sao kê, giao dịch đã sửa, hạch toán, hóa đơn…), lưu nguyên dạng JSON. */
export interface SessionInput {
  name?: string;
  companyId?: string | null;
  /** Ghi chú người dùng tự ghi ("còn thiếu TK tháng 2, hỏi lại khách khoản 9tr…"). */
  note?: string;
  issues?: SessionIssue[];
  data?: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  name: string;
  company_id: string | null;
  note: string;
  issues: SessionIssue[];
  data: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const MAX_ISSUES = 500;

const summary = (row: SessionRow) => {
  const data = row.data || {};
  const files = Array.isArray(data.statements) ? (data.statements as { name?: string }[]) : [];
  const issues = Array.isArray(row.issues) ? row.issues : [];
  return {
    id: row.id,
    name: row.name,
    companyId: row.company_id,
    note: row.note || '',
    issues,
    errorCount: issues.filter((issue) => issue.level === 'error').length,
    warningCount: issues.filter((issue) => issue.level !== 'error').length,
    fileNames: files.map((file) => file.name || ''),
    transactionCount: Array.isArray(data.transactions) ? data.transactions.length : 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
};

/**
 * Phiên làm việc (bản nháp) lưu trong PostgreSQL để mở lại mà không phải bóc tách lại.
 * Mỗi phiên thuộc về tài khoản tạo ra nó: chỉ chủ phiên xem / mở / sửa / xóa được.
 */
@Injectable()
export class SessionsService implements OnModuleInit {
  private readonly logger = new Logger(SessionsService.name);

  constructor(private readonly database: DatabaseService) {}

  private get pool() {
    return this.database.pool;
  }

  async onModuleInit() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS work_sessions (
          id UUID PRIMARY KEY,
          owner_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          company_id TEXT,
          note TEXT NOT NULL DEFAULT '',
          issues JSONB NOT NULL DEFAULT '[]',
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS work_sessions_owner_updated ON work_sessions (owner_id, updated_at DESC);
      `);
    } catch (error) {
      this.logger.error(`Không tạo được bảng phiên làm việc (kiểm tra DATABASE_URL): ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Danh sách phiên của chính tài khoản (không kèm dữ liệu giao dịch). */
  async list(ownerId: number, limit = 50) {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT id, name, company_id, note, issues,
              jsonb_build_object('statements', data->'statements', 'transactions', data->'transactions') AS data,
              created_at, updated_at
       FROM work_sessions WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [ownerId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map(summary);
  }

  async get(ownerId: number, id: string) {
    const { rows } = await this.pool.query<SessionRow>('SELECT * FROM work_sessions WHERE id = $1 AND owner_id = $2', [this.checkId(id), ownerId]);
    if (!rows[0]) throw new NotFoundException('Không tìm thấy phiên làm việc.');
    return { ...summary(rows[0]), data: rows[0].data };
  }

  async create(ownerId: number, input: SessionInput) {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO work_sessions (id, owner_id, name, company_id, note, issues, data) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        ownerId,
        this.name(input.name),
        input.companyId || null,
        this.note(input.note),
        JSON.stringify(this.issues(input.issues)),
        JSON.stringify(this.data(input.data)),
      ],
    );
    return this.summaryOf(ownerId, id);
  }

  /** Chỉ cập nhật các trường được gửi lên. */
  async update(ownerId: number, id: string, input: SessionInput) {
    const result = await this.pool.query(
      `UPDATE work_sessions SET
         name = COALESCE($3, name),
         company_id = CASE WHEN $4::boolean THEN $5 ELSE company_id END,
         note = COALESCE($6, note),
         issues = COALESCE($7::jsonb, issues),
         data = COALESCE($8::jsonb, data),
         updated_at = now()
       WHERE id = $1 AND owner_id = $2`,
      [
        this.checkId(id),
        ownerId,
        input.name === undefined ? null : this.name(input.name),
        input.companyId !== undefined,
        input.companyId || null,
        input.note === undefined ? null : this.note(input.note),
        input.issues === undefined ? null : JSON.stringify(this.issues(input.issues)),
        input.data === undefined ? null : JSON.stringify(this.data(input.data)),
      ],
    );
    if (!result.rowCount) throw new NotFoundException('Không tìm thấy phiên làm việc.');
    return this.summaryOf(ownerId, id);
  }

  async remove(ownerId: number, id: string) {
    const result = await this.pool.query('DELETE FROM work_sessions WHERE id = $1 AND owner_id = $2', [this.checkId(id), ownerId]);
    if (!result.rowCount) throw new NotFoundException('Không tìm thấy phiên làm việc.');
    return { ok: true };
  }

  private async summaryOf(ownerId: number, id: string) {
    const { data: _data, ...rest } = await this.get(ownerId, id);
    return rest;
  }

  private checkId(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('Mã phiên không hợp lệ.');
    return id;
  }

  private name(value: string | undefined) {
    return (value || '').trim().slice(0, 200) || 'Phiên làm việc';
  }

  private note(value: string | undefined) {
    return (value || '').slice(0, 5000);
  }

  private issues(value: unknown): SessionIssue[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_ISSUES).flatMap((item) => {
      if (!item || typeof item !== 'object' || typeof (item as SessionIssue).message !== 'string') return [];
      const issue = item as SessionIssue;
      return [{
        level: issue.level === 'error' ? 'error' : 'warning',
        message: issue.message.slice(0, 500),
        row: Number.isInteger(issue.row) ? issue.row : null,
      }];
    });
  }

  private data(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Dữ liệu phiên không hợp lệ.');
    return value;
  }
}

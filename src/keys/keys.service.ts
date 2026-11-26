import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { databaseUrl } from '../database/database-url';

export type KeyStatus = 'ACTIVE' | 'EXHAUSTED' | 'INVALID' | 'DISABLED';
export type KeyEventType = 'ADDED' | 'REMOVED' | 'EXHAUSTED' | 'INVALID' | 'RESTORED' | 'ENABLED' | 'DISABLED' | 'SWITCHED' | 'NO_KEY';

export interface KeyView {
  id: number;
  label: string;
  maskedKey: string;
  status: KeyStatus;
  exhaustedUntil: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  callsToday: number;
  callsTotal: number;
  createdAt: string;
}

export interface KeyEvent {
  id: number;
  at: string;
  type: KeyEventType;
  keyLabel: string;
  message: string;
}

/** Key dùng để gọi API (chỉ dùng trong backend, không trả ra ngoài). */
export interface ActiveKey {
  id: number;
  label: string;
  apiKey: string;
}

const PACIFIC = 'America/Los_Angeles';

/** Hạn mức ngày của Gemini được đặt lại lúc nửa đêm giờ Thái Bình Dương. */
function pacificParts(now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: PACIFIC,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    secondsSinceMidnight: (Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
  };
}

export const nextQuotaReset = (now = new Date()) =>
  new Date(now.getTime() + (86400 - pacificParts(now).secondsSinceMidnight) * 1000);

const quotaDay = (now = new Date()) => pacificParts(now).day;

const maskKey = (apiKey: string) =>
  apiKey.length <= 12 ? '••••' : `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

@Injectable()
export class KeysService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeysService.name);
  private readonly pool: Pool;
  private readonly envKeys: string;

  constructor(configService: ConfigService) {
    this.pool = new Pool({ connectionString: databaseUrl(configService) });
    this.envKeys = configService.get<string>('GEMINI_API_KEY') || '';
  }

  async onModuleInit() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id SERIAL PRIMARY KEY,
          label TEXT NOT NULL,
          api_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'ACTIVE',
          exhausted_until TIMESTAMPTZ,
          last_error TEXT,
          last_used_at TIMESTAMPTZ,
          calls_today INTEGER NOT NULL DEFAULT 0,
          calls_day TEXT,
          calls_total INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS key_events (
          id SERIAL PRIMARY KEY,
          at TIMESTAMPTZ NOT NULL DEFAULT now(),
          type TEXT NOT NULL,
          key_label TEXT NOT NULL,
          message TEXT NOT NULL
        );
      `);
      for (const apiKey of this.splitKeys(this.envKeys)) await this.insert(apiKey, undefined, false);
    } catch (error) {
      this.logger.error(
        `Không kết nối được PostgreSQL (kiểm tra DATABASE_URL trong backend/.env): ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  private splitKeys(text: string) {
    return [...new Set(text.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
  }

  /** Thêm key; trả false nếu đã có. Nhãn mặc định "Key <số>". */
  private async insert(apiKey: string, label?: string, log = true) {
    const result = await this.pool.query<{ label: string }>(
      `INSERT INTO api_keys (label, api_key)
       VALUES (COALESCE($2, 'Key ' || ((SELECT COUNT(*) FROM api_keys) + 1)), $1)
       ON CONFLICT (api_key) DO NOTHING
       RETURNING label`,
      [apiKey, label ?? null],
    );
    if (!result.rowCount) return false;
    if (log) await this.logEvent('ADDED', result.rows[0].label, `Đã thêm key ${maskKey(apiKey)}.`);
    return true;
  }

  private async logEvent(type: KeyEventType, keyLabel: string, message: string) {
    await this.pool.query('INSERT INTO key_events (type, key_label, message) VALUES ($1, $2, $3)', [type, keyLabel, message]);
    if (['EXHAUSTED', 'INVALID', 'SWITCHED', 'NO_KEY'].includes(type)) this.logger.warn(`[${keyLabel}] ${message}`);
  }

  /** Key hết hạn mức mà đã qua giờ đặt lại thì dùng lại được. */
  private async restoreExpired() {
    const restored = await this.pool.query<{ label: string }>(
      `UPDATE api_keys SET status = 'ACTIVE', exhausted_until = NULL, last_error = NULL
       WHERE status = 'EXHAUSTED' AND exhausted_until <= now() RETURNING label`,
    );
    for (const row of restored.rows) await this.logEvent('RESTORED', row.label, 'Đã sang ngày mới, key dùng lại được.');
  }

  /** Key khả dụng đầu tiên theo thứ tự thêm vào, hoặc null khi hết key. */
  async acquire(): Promise<ActiveKey | null> {
    await this.restoreExpired();
    const result = await this.pool.query<{ id: number; label: string; apiKey: string }>(
      `SELECT id, label, api_key AS "apiKey" FROM api_keys WHERE status = 'ACTIVE' ORDER BY id LIMIT 1`,
    );
    return result.rows[0] || null;
  }

  async hasKeys() {
    const result = await this.pool.query<{ count: string }>('SELECT COUNT(*) FROM api_keys');
    return Number(result.rows[0].count) > 0;
  }

  async recordCall(id: number) {
    const today = quotaDay();
    await this.pool.query(
      `UPDATE api_keys SET
         calls_today = CASE WHEN calls_day = $2 THEN calls_today + 1 ELSE 1 END,
         calls_day = $2, calls_total = calls_total + 1, last_used_at = now()
       WHERE id = $1`,
      [id, today],
    );
  }

  /** Đánh dấu key hết hạn mức ngày (chỉ ghi log một lần dù nhiều lời gọi song song cùng báo lỗi). */
  async markExhausted(id: number, detail: string) {
    await this.retire(id, 'EXHAUSTED', detail, nextQuotaReset());
  }

  async markInvalid(id: number, detail: string) {
    await this.retire(id, 'INVALID', detail, null);
  }

  private async retire(id: number, status: 'EXHAUSTED' | 'INVALID', detail: string, until: Date | null) {
    const updated = await this.pool.query<{ label: string }>(
      `UPDATE api_keys SET status = $2, exhausted_until = $3, last_error = $4
       WHERE id = $1 AND status = 'ACTIVE' RETURNING label`,
      [id, status, until, detail],
    );
    if (!updated.rowCount) return; // lời gọi song song khác đã xử lý
    const label = updated.rows[0].label;
    await this.logEvent(
      status,
      label,
      status === 'EXHAUSTED' ? `Hết hạn mức trong ngày. Tự dùng lại sau ${until!.toISOString()}.` : `Key không dùng được: ${detail}`,
    );
    const next = await this.acquire();
    if (next) await this.logEvent('SWITCHED', label, `Chuyển sang key "${next.label}".`);
    else await this.logEvent('NO_KEY', label, 'Không còn key nào khả dụng. Thêm key mới ở mục API key.');
  }

  async list(): Promise<KeyView[]> {
    await this.restoreExpired();
    const today = quotaDay();
    const result = await this.pool.query(`SELECT * FROM api_keys ORDER BY id`);
    return result.rows.map((row) => ({
      id: row.id,
      label: row.label,
      maskedKey: maskKey(row.api_key),
      status: row.status,
      exhaustedUntil: iso(row.exhausted_until),
      lastError: row.last_error,
      lastUsedAt: iso(row.last_used_at),
      callsToday: row.calls_day === today ? row.calls_today : 0,
      callsTotal: row.calls_total,
      createdAt: iso(row.created_at)!,
    }));
  }

  async events(limit = 100): Promise<KeyEvent[]> {
    const result = await this.pool.query(
      `SELECT id, at, type, key_label, message FROM key_events ORDER BY id DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      at: iso(row.at)!,
      type: row.type,
      keyLabel: row.key_label,
      message: row.message,
    }));
  }

  /** Thêm một hoặc nhiều key (mỗi dòng / cách nhau bằng dấu phẩy). */
  async add(text: string, label?: string) {
    const keys = this.splitKeys(text);
    if (!keys.length) throw new BadRequestException('Chưa nhập key.');
    let added = 0;
    for (const apiKey of keys) {
      if (await this.insert(apiKey, keys.length === 1 ? label?.trim() || undefined : undefined)) added += 1;
    }
    if (!added) throw new BadRequestException('Key đã có trong danh sách.');
    return { added };
  }

  private async labelOf(id: number) {
    const result = await this.pool.query<{ label: string; status: KeyStatus }>('SELECT label, status FROM api_keys WHERE id = $1', [id]);
    if (!result.rowCount) throw new NotFoundException('Không tìm thấy key.');
    return result.rows[0];
  }

  async update(id: number, patch: { label?: string; status?: 'ACTIVE' | 'DISABLED' }) {
    const current = await this.labelOf(id);
    if (patch.label?.trim()) await this.pool.query('UPDATE api_keys SET label = $2 WHERE id = $1', [id, patch.label.trim()]);
    if (patch.status === 'DISABLED' && current.status !== 'DISABLED') {
      await this.pool.query(`UPDATE api_keys SET status = 'DISABLED', exhausted_until = NULL WHERE id = $1`, [id]);
      await this.logEvent('DISABLED', current.label, 'Đã tắt key.');
    }
    if (patch.status === 'ACTIVE' && current.status !== 'ACTIVE') {
      await this.pool.query(`UPDATE api_keys SET status = 'ACTIVE', exhausted_until = NULL, last_error = NULL WHERE id = $1`, [id]);
      await this.logEvent('ENABLED', current.label, 'Đã bật lại key.');
    }
  }

  async remove(id: number) {
    const current = await this.labelOf(id);
    await this.pool.query('DELETE FROM api_keys WHERE id = $1', [id]);
    await this.logEvent('REMOVED', current.label, 'Đã xóa key.');
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { Pool } from 'pg';
import { promisify } from 'util';
import { databaseUrl } from '../database/database-url';
import { UserRole, UserStatus, UserView } from './auth.types';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;

interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string | null;
  google_id: string | null;
  role: UserRole;
  status: UserStatus;
  created_at: Date;
  last_login_at: Date | null;
}

const toView = (row: UserRow): UserView => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  status: row.status,
  hasPassword: !!row.password_hash,
  hasGoogle: !!row.google_id,
  createdAt: row.created_at.toISOString(),
  lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
});

const normalizeEmail = (email: string) => (email || '').trim().toLowerCase();
/** Chỉ lưu băm của token phiên: lộ CSDL cũng không dùng lại được phiên. */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string | null) {
  const [scheme, saltHex, hashHex] = (stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  private readonly pool: Pool;
  private readonly adminEmail: string;
  private readonly adminPassword: string;

  constructor(configService: ConfigService) {
    this.pool = new Pool({ connectionString: databaseUrl(configService) });
    this.adminEmail = normalizeEmail(configService.get<string>('ADMIN_EMAIL') || '');
    this.adminPassword = configService.get<string>('ADMIN_PASSWORD') || '';
  }

  async onModuleInit() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL DEFAULT '',
          password_hash TEXT,
          google_id TEXT UNIQUE,
          role TEXT NOT NULL DEFAULT 'USER',
          status TEXT NOT NULL DEFAULT 'PENDING',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_login_at TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ NOT NULL
        );
        DELETE FROM sessions WHERE expires_at < now();
      `);
      await this.ensureEnvAdmin();
    } catch (error) {
      this.logger.error(
        `Không tạo được bảng người dùng (kiểm tra DATABASE_URL trong backend/.env): ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  /**
   * Tài khoản admin khai báo trong .env (ADMIN_EMAIL / ADMIN_PASSWORD): tạo nếu chưa có; nếu đã có thì
   * đảm bảo là admin đang hoạt động và mật khẩu khớp .env (đổi mật khẩu admin bằng cách sửa .env rồi khởi động lại).
   */
  private async ensureEnvAdmin() {
    if (!this.adminEmail && !this.adminPassword) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(this.adminEmail) || this.adminPassword.length < MIN_PASSWORD) {
      this.logger.warn(`ADMIN_EMAIL / ADMIN_PASSWORD trong .env không hợp lệ (email đúng dạng, mật khẩu ≥ ${MIN_PASSWORD} ký tự) — bỏ qua.`);
      return;
    }
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [this.adminEmail]);
    const existing = rows[0];
    if (!existing) {
      await this.pool.query(
        `INSERT INTO users (email, name, password_hash, role, status) VALUES ($1, 'Quản trị viên', $2, 'ADMIN', 'ACTIVE')`,
        [this.adminEmail, await hashPassword(this.adminPassword)],
      );
      this.logger.log(`Đã tạo tài khoản admin ${this.adminEmail} từ .env.`);
      return;
    }
    const passwordChanged = !(await verifyPassword(this.adminPassword, existing.password_hash));
    await this.pool.query(
      `UPDATE users SET role = 'ADMIN', status = 'ACTIVE', password_hash = COALESCE($2, password_hash) WHERE id = $1`,
      [existing.id, passwordChanged ? await hashPassword(this.adminPassword) : null],
    );
    // Đổi mật khẩu → đăng xuất các phiên cũ của admin.
    if (passwordChanged) await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [existing.id]);
  }

  /** Tài khoản đầu tiên tự là admin đã duyệt (khi .env không khai báo admin); các tài khoản sau chờ admin duyệt. */
  private async firstUserDefaults(): Promise<{ role: UserRole; status: UserStatus }> {
    const { rows } = await this.pool.query<{ count: string }>('SELECT count(*) FROM users');
    return Number(rows[0].count) === 0 ? { role: 'ADMIN', status: 'ACTIVE' } : { role: 'USER', status: 'PENDING' };
  }

  async register(emailInput: string, password: string, nameInput: string) {
    const email = normalizeEmail(emailInput);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException('Email không hợp lệ.');
    if ((password || '').length < MIN_PASSWORD) throw new BadRequestException(`Mật khẩu cần ít nhất ${MIN_PASSWORD} ký tự.`);
    const existing = await this.pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
    if (existing.rows[0]) {
      throw new ConflictException(
        existing.rows[0].google_id && !existing.rows[0].password_hash
          ? 'Email này đã đăng ký bằng Google — hãy bấm "Đăng nhập bằng Google".'
          : 'Email này đã được đăng ký.',
      );
    }
    const { role, status } = await this.firstUserDefaults();
    const { rows } = await this.pool.query<UserRow>(
      'INSERT INTO users (email, name, password_hash, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [email, (nameInput || '').trim() || email.split('@')[0], await hashPassword(password), role, status],
    );
    return toView(rows[0]);
  }

  async login(emailInput: string, password: string) {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [normalizeEmail(emailInput)]);
    const user = rows[0];
    if (!user || !(await verifyPassword(password || '', user.password_hash))) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng.');
    }
    return this.checkCanLogin(user);
  }

  /** Đăng nhập Google: tìm theo Google ID, rồi theo email đã xác minh (liên kết vào tài khoản cũ), không có thì tạo mới. */
  async loginWithGoogle(profile: { sub: string; email: string; name: string }) {
    const email = normalizeEmail(profile.email);
    let { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE google_id = $1', [profile.sub]);
    if (!rows[0]) {
      ({ rows } = await this.pool.query<UserRow>(
        'UPDATE users SET google_id = $1 WHERE email = $2 AND google_id IS NULL RETURNING *',
        [profile.sub, email],
      ));
    }
    if (!rows[0]) {
      const { role, status } = await this.firstUserDefaults();
      ({ rows } = await this.pool.query<UserRow>(
        'INSERT INTO users (email, name, google_id, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [email, profile.name || email.split('@')[0], profile.sub, role, status],
      ));
    }
    return this.checkCanLogin(rows[0]);
  }

  /** Tài khoản bị khóa không đăng nhập được; tài khoản chờ duyệt vẫn đăng nhập để thấy thông báo chờ duyệt. */
  private checkCanLogin(user: UserRow) {
    if (user.status === 'DISABLED') throw new ForbiddenException('Tài khoản đã bị khóa. Liên hệ quản trị viên.');
    return toView(user);
  }

  async createSession(userId: number) {
    const token = randomBytes(32).toString('hex');
    await this.pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
      [hashToken(token), userId],
    );
    await this.pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
    return { token, maxAgeMs: SESSION_DAYS * 24 * 60 * 60 * 1000 };
  }

  async userForSession(token: string | undefined) {
    if (!token) return null;
    const { rows } = await this.pool.query<UserRow>(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)],
    );
    return rows[0] ? toView(rows[0]) : null;
  }

  async logout(token: string | undefined) {
    if (token) await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  }

  async listUsers() {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT * FROM users ORDER BY CASE status WHEN 'PENDING' THEN 0 WHEN 'ACTIVE' THEN 1 ELSE 2 END, created_at`,
    );
    return rows.map(toView);
  }

  /** Admin duyệt / khóa / đổi quyền. Không cho tự hạ quyền hay tự khóa, và luôn còn ít nhất một admin hoạt động. */
  async updateUser(actorId: number, id: number, patch: { role?: UserRole; status?: UserStatus }) {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    const user = rows[0];
    if (!user) throw new NotFoundException('Không tìm thấy người dùng.');
    this.assertNotEnvAdmin(user.email);
    const role = patch.role ?? user.role;
    const status = patch.status ?? user.status;
    if (id === actorId && (role !== 'ADMIN' || status !== 'ACTIVE')) {
      throw new BadRequestException('Không thể tự hạ quyền hoặc tự khóa tài khoản của mình.');
    }
    await this.pool.query('UPDATE users SET role = $1, status = $2 WHERE id = $3', [role, status, id]);
    // Khóa tài khoản → đăng xuất mọi phiên của tài khoản đó.
    if (status === 'DISABLED') await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    return this.listUsers();
  }

  private assertNotEnvAdmin(email: string) {
    if (this.adminEmail && email === this.adminEmail) {
      throw new BadRequestException('Đây là tài khoản admin khai báo trong backend/.env — sửa trong .env thay vì trên web.');
    }
  }

  async removeUser(actorId: number, id: number) {
    if (id === actorId) throw new BadRequestException('Không thể tự xóa tài khoản của mình.');
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    if (rows[0]) this.assertNotEnvAdmin(rows[0].email);
    const result = await this.pool.query('DELETE FROM users WHERE id = $1', [id]);
    if (!result.rowCount) throw new NotFoundException('Không tìm thấy người dùng.');
    return this.listUsers();
  }
}

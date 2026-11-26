import type { Request } from 'express';

export type UserRole = 'ADMIN' | 'USER';
/** PENDING: đã đăng ký, chờ admin duyệt; DISABLED: bị khóa. */
export type UserStatus = 'PENDING' | 'ACTIVE' | 'DISABLED';

export interface UserView {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  /** Cách đăng nhập đã liên kết. */
  hasPassword: boolean;
  hasGoogle: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthRequest extends Request {
  user?: UserView;
  sessionToken?: string;
}

export const SESSION_COOKIE = 'sid';
export const OAUTH_STATE_COOKIE = 'oauth_state';

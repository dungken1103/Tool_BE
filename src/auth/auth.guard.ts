import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthRequest, SESSION_COOKIE, UserView } from './auth.types';

const PUBLIC_KEY = 'auth:public';
const ALLOW_PENDING_KEY = 'auth:allowPending';
const ADMIN_KEY = 'auth:admin';

/** API không cần đăng nhập (đăng nhập, đăng ký, OAuth). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Cho phép tài khoản chờ duyệt (để biết mình đang chờ duyệt). */
export const AllowPending = () => SetMetadata(ALLOW_PENDING_KEY, true);
/** Chỉ admin. */
export const AdminOnly = () => SetMetadata(ADMIN_KEY, true);

export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): UserView => context.switchToHttp().getRequest<AuthRequest>().user!,
);

export function readCookie(header: string | undefined, name: string) {
  for (const part of (header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/** Áp cho mọi API: phải đăng nhập, tài khoản đã được duyệt; API đánh dấu AdminOnly chỉ admin gọi được. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const flag = (key: string) => this.reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]);
    if (flag(PUBLIC_KEY)) return true;

    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const user = await this.auth.userForSession(token);
    if (!user) throw new UnauthorizedException('Vui lòng đăng nhập.');
    if (user.status === 'DISABLED') throw new UnauthorizedException('Tài khoản đã bị khóa.');
    if (user.status === 'PENDING' && !flag(ALLOW_PENDING_KEY)) {
      throw new ForbiddenException('Tài khoản đang chờ quản trị viên duyệt.');
    }
    if (flag(ADMIN_KEY) && user.role !== 'ADMIN') throw new ForbiddenException('Chỉ quản trị viên được thực hiện thao tác này.');

    request.user = user;
    request.sessionToken = token;
    return true;
  }
}

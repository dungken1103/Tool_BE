import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { randomBytes } from 'crypto';
import type { CookieOptions, Response } from 'express';
import { AdminOnly, AllowPending, CurrentUser, Public, readCookie } from './auth.guard';
import { AuthService } from './auth.service';
import { AuthRequest, OAUTH_STATE_COOKIE, SESSION_COOKIE, UserRole, UserStatus, UserView } from './auth.types';

class RegisterDto {
  @IsEmail({}, { message: 'Email không hợp lệ.' })
  email!: string;

  @IsString()
  @MaxLength(200)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}

class LoginDto {
  @IsString()
  email!: string;

  @IsString()
  password!: string;
}

class UpdateUserDto {
  @IsOptional()
  @IsIn(['ADMIN', 'USER'])
  role?: UserRole;

  @IsOptional()
  @IsIn(['PENDING', 'ACTIVE', 'DISABLED'])
  status?: UserStatus;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

@Controller('auth')
export class AuthController {
  private readonly frontendOrigin: string;
  private readonly googleClientId: string;
  private readonly googleClientSecret: string;
  private readonly googleRedirectUri: string;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService,
  ) {
    this.frontendOrigin = config.get<string>('FRONTEND_ORIGIN') || 'http://localhost:5173';
    this.googleClientId = config.get<string>('GOOGLE_CLIENT_ID') || '';
    this.googleClientSecret = config.get<string>('GOOGLE_CLIENT_SECRET') || '';
    this.googleRedirectUri =
      config.get<string>('GOOGLE_REDIRECT_URI') || `http://localhost:${config.get<string>('PORT') || 3000}/api/auth/google/callback`;
  }

  private cookieOptions(maxAge?: number): CookieOptions {
    return { httpOnly: true, sameSite: 'lax', secure: this.frontendOrigin.startsWith('https://'), path: '/', maxAge };
  }

  private async startSession(response: Response, user: UserView) {
    const { token, maxAgeMs } = await this.auth.createSession(user.id);
    response.cookie(SESSION_COOKIE, token, this.cookieOptions(maxAgeMs));
  }

  @Public()
  @Get('config')
  config() {
    return { googleEnabled: !!(this.googleClientId && this.googleClientSecret) };
  }

  @Public()
  @Post('register')
  async register(@Body() body: RegisterDto, @Res({ passthrough: true }) response: Response) {
    const user = await this.auth.register(body.email, body.password, body.name || '');
    await this.startSession(response, user);
    return user;
  }

  @Public()
  @Post('login')
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) response: Response) {
    const user = await this.auth.login(body.email, body.password);
    await this.startSession(response, user);
    return user;
  }

  @Public()
  @Post('logout')
  async logout(@Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(readCookie(request.headers.cookie, SESSION_COOKIE));
    response.clearCookie(SESSION_COOKIE, this.cookieOptions());
    return { ok: true };
  }

  @AllowPending()
  @Get('me')
  me(@CurrentUser() user: UserView) {
    return user;
  }

  /** Bước 1 OAuth: chuyển sang trang đăng nhập Google, kèm state chống giả mạo. */
  @Public()
  @Get('google')
  google(@Res() response: Response) {
    if (!this.googleClientId || !this.googleClientSecret) {
      return response.redirect(`${this.frontendOrigin}/?authError=${encodeURIComponent('Chưa cấu hình đăng nhập Google (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).')}`);
    }
    const state = randomBytes(16).toString('hex');
    response.cookie(OAUTH_STATE_COOKIE, state, this.cookieOptions(10 * 60 * 1000));
    const params = new URLSearchParams({
      client_id: this.googleClientId,
      redirect_uri: this.googleRedirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    return response.redirect(`${GOOGLE_AUTH_URL}?${params}`);
  }

  /** Bước 2 OAuth: Google trả về mã → đổi lấy thông tin tài khoản → tạo phiên → về trang web. */
  @Public()
  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() request: AuthRequest,
    @Res() response: Response,
  ) {
    const fail = (message: string) => response.redirect(`${this.frontendOrigin}/?authError=${encodeURIComponent(message)}`);
    const expectedState = readCookie(request.headers.cookie, OAUTH_STATE_COOKIE);
    response.clearCookie(OAUTH_STATE_COOKIE, this.cookieOptions());
    if (error) return fail('Đã hủy đăng nhập Google.');
    if (!code || !state || state !== expectedState) return fail('Phiên đăng nhập Google không hợp lệ, vui lòng thử lại.');

    try {
      const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.googleClientId,
          client_secret: this.googleClientSecret,
          redirect_uri: this.googleRedirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = (await tokenResponse.json()) as { access_token?: string; error_description?: string };
      if (!tokenResponse.ok || !tokens.access_token) throw new Error(tokens.error_description || 'Không lấy được mã truy cập Google.');

      const profileResponse = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const profile = (await profileResponse.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
      if (!profile.sub || !profile.email) throw new Error('Google không trả về email.');
      if (!profile.email_verified) throw new Error('Email Google chưa được xác minh.');

      const user = await this.auth.loginWithGoogle({ sub: profile.sub, email: profile.email, name: profile.name || '' });
      await this.startSession(response, user);
      return response.redirect(`${this.frontendOrigin}/`);
    } catch (caught) {
      return fail(caught instanceof Error ? caught.message : 'Đăng nhập Google thất bại.');
    }
  }

  @AdminOnly()
  @Get('users')
  users() {
    return this.auth.listUsers();
  }

  @AdminOnly()
  @Patch('users/:id')
  updateUser(@CurrentUser() actor: UserView, @Param('id', ParseIntPipe) id: number, @Body() body: UpdateUserDto) {
    return this.auth.updateUser(actor.id, id, body);
  }

  @AdminOnly()
  @Delete('users/:id')
  removeUser(@CurrentUser() actor: UserView, @Param('id', ParseIntPipe) id: number) {
    return this.auth.removeUser(actor.id, id);
  }
}

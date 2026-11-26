import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.guard';
import { UserView } from '../auth/auth.types';
import { SessionInput, SessionsService } from './sessions.service';

/** Phiên làm việc của chính tài khoản đang đăng nhập. */
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(@CurrentUser() user: UserView, @Query('limit') limit?: string) {
    return this.sessions.list(user.id, Number(limit) || 50);
  }

  @Get(':id')
  get(@CurrentUser() user: UserView, @Param('id') id: string) {
    return this.sessions.get(user.id, id);
  }

  @Post()
  create(@CurrentUser() user: UserView, @Body() body: SessionInput) {
    return this.sessions.create(user.id, body || {});
  }

  @Put(':id')
  update(@CurrentUser() user: UserView, @Param('id') id: string, @Body() body: SessionInput) {
    return this.sessions.update(user.id, id, body || {});
  }

  @Delete(':id')
  remove(@CurrentUser() user: UserView, @Param('id') id: string) {
    return this.sessions.remove(user.id, id);
  }
}

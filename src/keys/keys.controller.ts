import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AdminOnly } from '../auth/auth.guard';
import { KeysService } from './keys.service';

class AddKeysDto {
  /** Một hoặc nhiều key, cách nhau bằng dòng mới hoặc dấu phẩy. */
  @IsString()
  @MinLength(10)
  apiKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;
}

class UpdateKeyDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

@Controller('keys')
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  @Get()
  list() {
    return this.keys.list();
  }

  // Người dùng chỉ xem danh sách key và trạng thái; nhật ký, thêm/sửa/xóa dành cho admin.
  @AdminOnly()
  @Get('events')
  events(@Query('limit') limit?: string) {
    return this.keys.events(Number(limit) || 100);
  }

  @AdminOnly()
  @Post()
  add(@Body() body: AddKeysDto) {
    return this.keys.add(body.apiKey, body.label);
  }

  @AdminOnly()
  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateKeyDto) {
    await this.keys.update(id, body);
    return this.keys.list();
  }

  @AdminOnly()
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.keys.remove(id);
    return this.keys.list();
  }
}

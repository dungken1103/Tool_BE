import { ConfigService } from '@nestjs/config';

/** Chuỗi kết nối PostgreSQL bắt buộc lấy từ .env, không có giá trị mặc định (tránh để mật khẩu mặc định nằm trong mã nguồn). */
export function databaseUrl(configService: ConfigService): string {
  const url = configService.get<string>('DATABASE_URL')?.trim();
  if (!url) throw new Error('Thiếu DATABASE_URL trong backend/.env (xem backend/.env.example).');
  return url;
}

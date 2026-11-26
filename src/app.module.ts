import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { CompanyModule } from './company/company.module';
import { DatabaseModule } from './database/database.service';
import { ExportModule } from './export/export.module';
import { GeminiModule } from './gemini/gemini.module';
import { InvoiceModule } from './invoice/invoice.module';
import { KeysModule } from './keys/keys.module';
import { SessionsModule } from './sessions/sessions.module';
import { StatementModule } from './statement/statement.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    KeysModule,
    GeminiModule,
    StatementModule,
    InvoiceModule,
    CompanyModule,
    ExportModule,
    SessionsModule,
  ],
})
export class AppModule {}

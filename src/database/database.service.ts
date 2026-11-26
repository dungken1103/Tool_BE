import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

import { databaseUrl } from './database-url';

/** Kết nối PostgreSQL dùng chung cho dữ liệu bóc tách và phiên làm việc. */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(configService: ConfigService) {
    this.pool = new Pool({ connectionString: databaseUrl(configService) });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}

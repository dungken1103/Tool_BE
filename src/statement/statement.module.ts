import { Module } from '@nestjs/common';
import { StatementController } from './statement.controller';
import { StatementService } from './statement.service';
import { StatementStore } from './statement.store';

@Module({
  controllers: [StatementController],
  providers: [StatementService, StatementStore],
})
export class StatementModule {}

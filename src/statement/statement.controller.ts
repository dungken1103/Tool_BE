import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { StatementService } from './statement.service';
import { ExtractionJob } from './statement.types';

const ACCEPTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

@Controller('statement')
export class StatementController {
  constructor(private readonly statementService: StatementService) {}

  @Post('extract')
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024, files: 20 },
    }),
  )
  async extract(@UploadedFiles() files: Express.Multer.File[], @Body() body: { force?: string }) {
    if (!files?.length) {
      throw new BadRequestException('Vui lòng tải lên ít nhất một tệp.');
    }

    const unsupported = files.find((file) => !ACCEPTED_MIME_TYPES.has(file.mimetype));
    if (unsupported) {
      throw new BadRequestException(
        `Định dạng tệp không được hỗ trợ: ${unsupported.originalname}`,
      );
    }

    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new BadRequestException('Tổng dung lượng tải lên không được vượt quá 100 MB.');
    }

    files.forEach((file) => {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    });

    try {
      const job = await this.statementService.startExtraction(files, body?.force === 'true');
      return { jobId: job.id, totalChunks: job.totalChunks, cachedChunks: job.cachedChunks };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(
        `Không đọc được tệp PDF: ${error instanceof Error ? error.message : 'lỗi không xác định'}`,
      );
    }
  }

  @Get('extract/:jobId')
  getJob(@Param('jobId') jobId: string) {
    return this.view(this.statementService.getJob(jobId));
  }

  /** action: pause | resume | cancel */
  @Post('extract/:jobId/:action')
  control(@Param('jobId') jobId: string, @Param('action') action: string) {
    if (action !== 'pause' && action !== 'resume' && action !== 'cancel') throw new BadRequestException('Thao tác không hợp lệ.');
    return this.view(this.statementService.control(jobId, action));
  }

  private view({ id, status, totalChunks, doneChunks, cachedChunks, result, error }: ExtractionJob) {
    return { id, status, totalChunks, doneChunks, cachedChunks, result, error };
  }

  /** Tệp sao kê gốc đã lưu (để xem trang khi mở lại phiên làm việc). */
  @Get('files/:hash')
  async file(@Param('hash') hash: string, @Res() response: Response) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new BadRequestException('Mã tệp không hợp lệ.');
    const file = await this.statementService.getFile(hash);
    response.set({
      'Content-Type': file.mimeType,
      'Content-Length': file.data.length,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'private, max-age=86400',
    });
    response.end(file.data);
  }
}

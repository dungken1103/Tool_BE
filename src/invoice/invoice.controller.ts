import {
  BadRequestException,
  Controller,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { InvoiceService } from './invoice.service';

const ACCEPTED_EXTENSIONS = /\.(xml|pdf|jpe?g|png|webp)$/i;

@Controller('invoices')
export class InvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  @Post('extract')
  @UseInterceptors(
    FilesInterceptor('files', 100, {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024, files: 100 },
    }),
  )
  async extract(@UploadedFiles() files: Express.Multer.File[]) {
    if (!files?.length) {
      throw new BadRequestException('Vui lòng tải lên ít nhất một hóa đơn.');
    }
    files.forEach((file) => {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    });
    const unsupported = files.find((file) => !ACCEPTED_EXTENSIONS.test(file.originalname));
    if (unsupported) {
      throw new BadRequestException(`Định dạng hóa đơn không được hỗ trợ: ${unsupported.originalname}`);
    }
    return this.invoiceService.extractInvoices(files);
  }
}

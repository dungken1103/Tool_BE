import { Body, Controller, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { ExportService } from './export.service';
import { ExportBundle, ObjectRow, StatementReport, VoucherRow } from './export.types';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function sendXlsx(response: Response, buffer: Buffer, fileName: string, contentType = XLSX_MIME) {
  response.set({
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Content-Length': buffer.length,
  });
  response.end(buffer);
}

@Controller('export')
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Post('receipts')
  async receipts(@Body() body: { rows: VoucherRow[] }, @Res() response: Response) {
    sendXlsx(response, await this.exportService.receipts(body?.rows), 'Phieu_thu_tien_gui.xlsx');
  }

  @Post('payments')
  async payments(@Body() body: { rows: VoucherRow[] }, @Res() response: Response) {
    sendXlsx(response, await this.exportService.payments(body?.rows), 'Phieu_chi_tien_gui.xlsx');
  }

  @Post('new-objects')
  async newObjects(@Body() body: { objects: ObjectRow[] }, @Res() response: Response) {
    sendXlsx(response, await this.exportService.newObjects(body?.objects), 'Danh_sach_doi_tuong_moi.xlsx');
  }

  @Post('statement')
  async statement(@Body() body: StatementReport, @Res() response: Response) {
    sendXlsx(response, await this.exportService.statementReport(body), 'Sao_ke_tai_khoan.xlsx');
  }

  @Post('all')
  async all(@Body() body: ExportBundle, @Res() response: Response) {
    sendXlsx(response, await this.exportService.bundle(body), 'Sao_ke_va_chung_tu.zip', 'application/zip');
  }
}

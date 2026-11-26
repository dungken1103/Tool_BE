import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as path from 'path';
import { parseVnDate } from '../common/values';
import {
  CellValue,
  ObjectRow,
  ExportBundle,
  StatementReport,
  TemplateColumn,
  VoucherRow,
} from './export.types';
import { buildStatementReport } from './statement-report';
import { writeWithArialDefault } from './workbook-text';
import { PAYMENT_TEMPLATE, RECEIPT_EXTRA_COLUMNS, RECEIPT_TEMPLATE, TEMPLATE_HEADER_ROW } from './templates';

const TEMPLATE_DIR = path.resolve(__dirname, '..', '..', 'templates');
const MONEY_FORMAT = '#,##0';
const DATE_FORMAT = 'dd/mm/yyyy';

@Injectable()
export class ExportService {
  receipts(rows: VoucherRow[]) {
    return this.fillTemplate(RECEIPT_TEMPLATE.file, RECEIPT_TEMPLATE.columns, rows, RECEIPT_EXTRA_COLUMNS);
  }

  payments(rows: VoucherRow[]) {
    return this.fillTemplate(PAYMENT_TEMPLATE.file, PAYMENT_TEMPLATE.columns, rows);
  }

  /** Điền dữ liệu vào chính file mẫu: giữ dòng 1–8, xóa dòng ví dụ, ghi từ dòng 9 với định dạng của dòng ví dụ. */
  private async fillTemplate(fileName: string, columns: TemplateColumn[], rows: VoucherRow[], extraColumns: TemplateColumn[] = []) {
    if (!Array.isArray(rows) || !rows.length) {
      throw new BadRequestException('Không có dòng dữ liệu để xuất.');
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(TEMPLATE_DIR, fileName));
    const sheet = workbook.worksheets[0];

    const headerRow = sheet.getRow(TEMPLATE_HEADER_ROW);
    columns.forEach((column, index) => {
      const actual = headerRow.getCell(index + 1).text.trim();
      if (actual !== column.header) {
        throw new InternalServerErrorException(
          `File mẫu ${fileName} đã thay đổi: cột ${index + 1} là "${actual}", cần "${column.header}".`,
        );
      }
    });

    const firstDataRow = TEMPLATE_HEADER_ROW + 1;
    const sampleStyles = columns.map((_, index) =>
      JSON.parse(JSON.stringify(sheet.getRow(firstDataRow).getCell(index + 1).style || {})) as Partial<ExcelJS.Style>,
    );
    // Cột phụ (chỉ để kế toán đối chiếu) nằm sau cột cuối của mẫu, dùng lại kiểu của cột cuối.
    const allColumns = [...columns, ...extraColumns];
    const lastHeaderStyle = JSON.parse(JSON.stringify(headerRow.getCell(columns.length).style || {})) as Partial<ExcelJS.Style>;
    extraColumns.forEach((column, index) => {
      const cell = headerRow.getCell(columns.length + index + 1);
      cell.value = column.header;
      cell.style = JSON.parse(JSON.stringify(lastHeaderStyle));
      sheet.getColumn(columns.length + index + 1).width = 42;
      sampleStyles.push(JSON.parse(JSON.stringify(sampleStyles[columns.length - 1] || {})));
    });
    headerRow.commit();
    // Xóa trắng các dòng ví dụ minh họa của mẫu (spliceRows của ExcelJS không xóa hết).
    const templateLastRow = sheet.rowCount;
    for (let rowNumber = firstDataRow; rowNumber <= templateLastRow; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.value = null;
        cell.style = {};
      });
      row.commit();
    }

    rows.forEach((data, rowIndex) => {
      const row = sheet.getRow(firstDataRow + rowIndex);
      allColumns.forEach((column, columnIndex) => {
        const cell = row.getCell(columnIndex + 1);
        cell.style = JSON.parse(JSON.stringify(sampleStyles[columnIndex]));
        this.writeCell(cell, column, data[column.key]);
      });
      row.commit();
    });

    return writeWithArialDefault(workbook);
  }

  private writeCell(cell: ExcelJS.Cell, column: TemplateColumn, value: CellValue) {
    if (value === null || value === undefined || value === '') {
      cell.value = null;
      return;
    }
    switch (column.type) {
      case 'date': {
        const date = parseVnDate(String(value));
        cell.value = date ?? String(value);
        cell.numFmt = DATE_FORMAT;
        break;
      }
      case 'number': {
        const number = Number(value);
        cell.value = Number.isFinite(number) ? number : String(value);
        if (column.key !== 'vatRate' && column.key !== 'otherTaxRate') cell.numFmt = MONEY_FORMAT;
        break;
      }
      case 'account':
        cell.value = /^\d+$/.test(String(value)) ? Number(value) : String(value);
        break;
      default:
        cell.value = String(value);
        cell.numFmt = '@';
    }
  }

  /** Danh sách đối tượng mới, cùng bố cục với file "Danh sách khách hàng / nhà cung cấp". */
  async newObjects(objects: ObjectRow[]) {
    if (!Array.isArray(objects) || !objects.length) {
      throw new BadRequestException('Không có đối tượng mới.');
    }
    const workbook = new ExcelJS.Workbook();
    const groups: [string, string, string, ObjectRow[]][] = [
      ['Khach_hang_moi', 'Danh sách khách hàng mới', 'khách hàng', objects.filter((item) => item.kind === 'CUSTOMER')],
      ['Nha_cung_cap_moi', 'Danh sách nhà cung cấp mới', 'nhà cung cấp', objects.filter((item) => item.kind === 'SUPPLIER')],
    ];
    for (const [sheetName, title, label, items] of groups) {
      if (!items.length) continue;
      const sheet = workbook.addWorksheet(sheetName);
      sheet.mergeCells('A1:G1');
      sheet.getCell('A1').value = title;
      sheet.getCell('A1').font = { bold: true, size: 14 };
      sheet.getCell('A1').alignment = { horizontal: 'center' };
      const header = sheet.getRow(3);
      header.values = ['STT', `Mã ${label}`, `Tên ${label}`, 'Địa chỉ', 'Công nợ', 'Mã số thuế', 'Điện thoại'];
      header.font = { bold: true };
      items.forEach((item, index) => {
        const row = sheet.getRow(4 + index);
        row.values = [index + 1, item.code, item.name, item.address || '', 0, item.taxCode || '', item.phone || ''];
        [2, 6, 7].forEach((column) => (row.getCell(column).numFmt = '@'));
      });
      [6, 24, 50, 40, 12, 16, 14].forEach((width, index) => (sheet.getColumn(index + 1).width = width));
    }
    return writeWithArialDefault(workbook);
  }

  /** File sao kê chi tiết + tổng hợp, đúng bố cục file mẫu Sao_ke_tai_khoan. */
  statementReport(report: StatementReport) {
    if (!report || !Array.isArray(report.transactions) || !report.transactions.length || !Array.isArray(report.categories)) {
      throw new BadRequestException('Không có giao dịch để xuất sao kê.');
    }
    return buildStatementReport(report);
  }

  /** Gói mọi file vào một .zip; từng file bên trong giữ nguyên mẫu để import được. */
  async bundle(body: ExportBundle) {
    const files: [string, Promise<Buffer>][] = [];
    if (body?.statement?.transactions?.length) files.push(['Sao_ke_tai_khoan.xlsx', this.statementReport(body.statement)]);
    if (body?.receipts?.length) files.push(['Phieu_thu_tien_gui.xlsx', this.receipts(body.receipts)]);
    if (body?.payments?.length) files.push(['Phieu_chi_tien_gui.xlsx', this.payments(body.payments)]);
    if (body?.newObjects?.length) files.push(['Danh_sach_doi_tuong_moi.xlsx', this.newObjects(body.newObjects)]);
    if (!files.length) throw new BadRequestException('Không có dữ liệu để xuất.');
    const zip = new JSZip();
    for (const [name, content] of files) zip.file(name, await content);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
}

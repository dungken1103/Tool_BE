export type CellValue = string | number | null | undefined;

export type ColumnType = 'date' | 'text' | 'number' | 'account';

export interface TemplateColumn {
  key: string;
  header: string;
  type: ColumnType;
}

/** Dòng dữ liệu đã dựng sẵn ở frontend, key theo `TemplateColumn.key`. */
export type VoucherRow = Record<string, CellValue>;

export interface ObjectRow {
  code: string;
  name: string;
  address?: string;
  taxCode?: string;
  phone?: string;
  kind: 'CUSTOMER' | 'SUPPLIER';
}

export interface StatementReportTransaction {
  date: string;
  documentNo: string;
  category: string;
  debit: number | null;
  credit: number | null;
  description: string;
}

/** Dữ liệu cho file "Sao kê tài khoản" theo mẫu Sao_ke_tai_khoan_do gemini chuyen sang.xlsx. */
export interface StatementReport {
  bankName: string;
  branch: string;
  accountName: string;
  address: string;
  accountNumber: string;
  cif: string;
  currency: string;
  statementDate: string;
  periodFrom: string;
  periodTo: string;
  openingBalance: number | null;
  /** Các nhóm "Phân loại GD", theo thứ tự hiển thị ở sheet tổng hợp. */
  categories: string[];
  transactions: StatementReportTransaction[];
}

export interface ExportBundle {
  statement?: StatementReport;
  receipts?: VoucherRow[];
  payments?: VoucherRow[];
  newObjects?: ObjectRow[];
}

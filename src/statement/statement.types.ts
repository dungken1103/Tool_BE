export interface StatementHeader {
  bankName: string | null;
  branch: string | null;
  accountNumber: string | null;
  accountName: string | null;
  address: string | null;
  cif: string | null;
  currency: string | null;
  /** Ngày thực hiện / ngày in sao kê. */
  statementDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  totalDebit: number | null;
  totalCredit: number | null;
}

export interface ExtractedTransaction {
  id: string;
  transactionDate: string;
  documentNo: string;
  description: string;
  /** null = AI không đọc được, cần người dùng nhập. */
  debitAmount: number | null;
  creditAmount: number | null;
  /** null = ô số dư trống trên sao kê (VCB chỉ in số dư cuối ngày). */
  balance: number | null;
  pageNumber: number;
  sourceFileIndex: number;
  uncertainFields: string[];
}

export interface StatementFileResult {
  /** Vị trí tệp theo thứ tự người dùng tải lên. */
  index: number;
  name: string;
  pageCount: number;
  /** SHA-256 của tệp gốc (tải lại tệp đã lưu: GET /statement/files/:hash). */
  hash: string;
  header: StatementHeader;
  failedPages: { startPage: number; endPage: number; error: string }[];
}

export interface ExtractionResult {
  /** Đã sắp xếp theo kỳ sao kê (periodFrom) nếu đọc được. */
  files: StatementFileResult[];
  transactions: ExtractedTransaction[];
  warnings: string[];
}

export interface ExtractionJob {
  id: string;
  /** WAITING: đang chờ vài giây trước khi gửi AI (để kịp hủy); PAUSED / CANCELLED do người dùng bấm. */
  status: 'WAITING' | 'RUNNING' | 'PAUSED' | 'CANCELLED' | 'DONE' | 'FAILED';
  totalChunks: number;
  doneChunks: number;
  /** Số lô lấy từ kết quả đã lưu (không gọi AI). */
  cachedChunks: number;
  result?: ExtractionResult;
  error?: string;
  createdAt: number;
  /** Thời điểm bắt đầu được gửi AI (ms). */
  startAt: number;
}

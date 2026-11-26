export type ObjectKind = 'CUSTOMER' | 'SUPPLIER';

export interface CatalogObject {
  code: string;
  name: string;
  address: string;
  taxCode: string;
  phone: string;
  kind: ObjectKind;
  /** Đối tượng do công cụ tự thêm (chưa có trong danh mục của phần mềm kế toán). */
  isNew?: boolean;
  createdAt?: string;
}

export interface AccountingRule {
  id: string;
  /** Từ khóa tìm trong diễn giải (không phân biệt hoa thường, dấu); nhiều từ khóa cách nhau bằng `|`. */
  keyword: string;
  direction: 'IN' | 'OUT' | 'ANY';
  debitAccount: string;
  creditAccount: string;
  objectCode: string;
  reason: string;
}

/** Một dòng trong danh sách chứng từ Bán hàng / Mua hàng hóa, dịch vụ xuất từ phần mềm kế toán. */
export interface LedgerEntry {
  /** DD/MM/YYYY */
  date: string;
  voucherNo: string;
  invoiceNo: string;
  /** Tên khách hàng (bán hàng) hoặc nhà cung cấp (mua hàng). */
  name: string;
  total: number;
}

/** Viết tắt trong diễn giải → tên nhà cung cấp / khách hàng ("nop vj" → CÔNG TY CỔ PHẦN HÀNG KHÔNG VIETJET). */
export interface NameAlias {
  id: string;
  /** Nhiều từ khóa cách nhau bằng `|`. */
  keyword: string;
  name: string;
}

export interface NumberingSettings {
  /** FROM_ONE: bắt đầu từ 0001; CUSTOM: bắt đầu từ số người dùng nhập. */
  startMode: 'FROM_ONE' | 'CUSTOM';
  receiptStart: number;
  paymentStart: number;
  /** CONTINUOUS: PT0001, PT0002…; MONTHLY: đánh lại từ đầu mỗi tháng. */
  resetMode: 'CONTINUOUS' | 'MONTHLY';
}

export interface CompanySettings {
  bankAccountCode: string;
  vatAccountCode: string;
  paymentMethod: string;
  purchaseGroup: string;
  numbering: NumberingSettings;
  /** Giao dịch chỉ khớp số tiền với sổ bán/mua hàng (không có tên): SUGGEST = chỉ gợi ý để chọn, AUTO = tự điền. */
  amountOnlyMatch: 'SUGGEST' | 'AUTO';
  /** Cột "Khớp sổ bán hàng" của khoản thu: hóa đơn cùng số tiền, ngày hạch toán lệch tối đa bấy nhiêu ngày (0 = cùng ngày). */
  sameDayAmountToleranceDays: number;
}

export const MAX_TOLERANCE_DAYS = 60;

export interface Company {
  id: string;
  name: string;
  createdAt: string;
  customers: CatalogObject[];
  suppliers: CatalogObject[];
  rules: AccountingRule[];
  settings: CompanySettings;
  sales: LedgerEntry[];
  purchases: LedgerEntry[];
  aliases: NameAlias[];
  /** Phiên bản bảng viết tắt mặc định đã áp dụng. */
  aliasDefaultsVersion?: number;
  /**
   * Mã người dùng đã chọn cho một tên khớp nhiều mã (danh mục có mã trùng tên, vd HKVIETJET / VIETJET).
   * Khóa: tên đã chuẩn hóa (nameKey ở frontend) → mã đối tượng.
   */
  preferredCodes: Record<string, string>;
}

/** Giá trị mặc định lấy theo file mẫu MISA (TK 1121, TK thuế 1331, "Ủy nhiệm chi", nhóm HHDV 1). */
export const DEFAULT_SETTINGS: CompanySettings = {
  bankAccountCode: '1121',
  vatAccountCode: '1331',
  paymentMethod: 'Ủy nhiệm chi',
  purchaseGroup: '1',
  numbering: { startMode: 'FROM_ONE', receiptStart: 1, paymentStart: 1, resetMode: 'CONTINUOUS' },
  amountOnlyMatch: 'SUGGEST',
  sameDayAmountToleranceDays: 5,
};

/**
 * Viết tắt chắc chắn, chỉ thêm khi nhà cung cấp có trong file Mua hàng (so tên không dấu, viết hoa).
 * Các viết tắt chưa chắc (MDL…, VNPT) để người dùng tự thêm.
 */
export const DEFAULT_ALIASES: { keyword: string; nameContains: string }[] = [
  // GENVJT: cổng thanh toán Vietjet ("MBBIZ.…GENVJT.CTY HK VINH.37391782…").
  { keyword: 'nop vj|noo vj|nop vietjet|noo vietjet|thuong vj|genvjt', nameContains: 'VIETJET' },
  { keyword: 'bamboo|banboo', nameContains: 'TRE VIET' },
  { keyword: 'fcvn|f.c vn', nameContains: 'F.C VIET NAM' },
  // Nộp tiền báo cáo bán vé Vietnam Airlines: "#TKP#VCBVNAHVI…#… MDL 37961814 nop tien bao cao ky".
  { keyword: 'tkp|mdl|bao cao ky|ky bao cao|nop tien bao cao', nameContains: 'HANG KHONG VIET NAM' },
  // "TT BGT", "HKVII TT BGT": thanh toán Du lịch Bảo Gia Trần (có trong danh mục NCC và sổ mua hàng).
  { keyword: 'bgt', nameContains: 'BAO GIA TRAN' },
];

/** Tăng khi thêm viết tắt mặc định mới → công ty đã nhập sổ mua hàng được bổ sung (không ghi đè dòng người dùng đã sửa). */
export const DEFAULT_ALIASES_VERSION = 4;

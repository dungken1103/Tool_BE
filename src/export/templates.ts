import { TemplateColumn } from './export.types';

/** Dòng tiêu đề cột trong file mẫu MISA (dòng 8); dữ liệu bắt đầu từ dòng 9. */
export const TEMPLATE_HEADER_ROW = 8;

export const RECEIPT_TEMPLATE = {
  file: 'Phieu_thu_tien_gui.xlsx',
  downloadName: 'Phieu_thu_tien_gui.xlsx',
  columns: [
    { key: 'postingDate', header: 'Ngày hạch toán (*)', type: 'date' },
    { key: 'documentDate', header: 'Ngày chứng từ (*)', type: 'date' },
    { key: 'voucherNo', header: 'Số chứng từ (*)', type: 'text' },
    { key: 'objectCode', header: 'Đối tượng', type: 'text' },
    { key: 'bankAccountNo', header: 'Nộp vào TK', type: 'text' },
    { key: 'bankName', header: 'Mở tại ngân hàng', type: 'text' },
    { key: 'reason', header: 'Lý do thu', type: 'text' },
    { key: 'reasonDescription', header: 'Diễn giải lý do thu', type: 'text' },
    { key: 'description', header: 'Diễn giải (hạch toán)', type: 'text' },
    { key: 'debitAccount', header: 'TK Nợ (*)', type: 'account' },
    { key: 'creditAccount', header: 'TK Có (*)', type: 'account' },
    { key: 'amount', header: 'Số tiền', type: 'number' },
    { key: 'lineObjectCode', header: 'Mã đối tượng (hạch toán)', type: 'text' },
  ] as TemplateColumn[],
};

/** Cột phụ sau cột cuối của mẫu Phiếu thu, để kế toán đối chiếu; không thuộc mẫu import MISA (xóa cột này nếu MISA từ chối file). */
export const RECEIPT_EXTRA_COLUMNS: TemplateColumn[] = [
  { key: 'sameDayAmountObject', header: 'Đối tượng khớp sổ bán hàng (cùng số tiền, lệch ngày trong hạn)', type: 'text' },
];

export const PAYMENT_TEMPLATE = {
  file: 'Phieu_chi_tien_gui.xlsx',
  downloadName: 'Phieu_chi_tien_gui.xlsx',
  columns: [
    { key: 'paymentMethod', header: 'Phương thức thanh toán', type: 'text' },
    { key: 'postingDate', header: 'Ngày hạch toán (*)', type: 'date' },
    { key: 'documentDate', header: 'Ngày chứng từ (*)', type: 'date' },
    { key: 'voucherNo', header: 'Số chứng từ (*)', type: 'text' },
    { key: 'reason', header: 'Lý do chi', type: 'text' },
    { key: 'paymentContent', header: 'Nội dung thanh toán', type: 'text' },
    { key: 'bankAccountNo', header: 'Số tài khoản chi', type: 'text' },
    { key: 'bankName', header: 'Tên ngân hàng chi', type: 'text' },
    { key: 'objectCode', header: 'Đối tượng', type: 'text' },
    { key: 'receiverAccountNo', header: 'Số tài khoản nhận', type: 'text' },
    { key: 'receiverBankName', header: 'Tên ngân hàng nhận', type: 'text' },
    { key: 'description', header: 'Diễn giải (hạch toán)', type: 'text' },
    { key: 'debitAccount', header: 'TK Nợ (*)', type: 'account' },
    { key: 'creditAccount', header: 'TK Có (*)', type: 'account' },
    { key: 'amount', header: 'Số tiền', type: 'number' },
    { key: 'lineObjectCode', header: 'Mã đối tượng (hạch toán)', type: 'text' },
    { key: 'multiInvoice', header: 'Hạch toán gộp nhiều hóa đơn', type: 'text' },
    { key: 'taxDescription', header: 'Diễn giải thuế', type: 'text' },
    { key: 'hasInvoice', header: 'Có hóa đơn', type: 'text' },
    { key: 'amountBeforeTax', header: 'Giá trị HHDV chưa thuế', type: 'number' },
    { key: 'vatRate', header: '% thuế GTGT', type: 'number' },
    { key: 'otherTaxRate', header: '% thuế suất KHAC', type: 'number' },
    { key: 'vatAmount', header: 'Tiền thuế GTGT', type: 'number' },
    { key: 'vatAccount', header: 'TK thuế GTGT', type: 'account' },
    { key: 'invoiceDate', header: 'Ngày hóa đơn', type: 'date' },
    { key: 'invoiceNo', header: 'Số hóa đơn', type: 'text' },
    { key: 'purchaseGroup', header: 'Nhóm HHDV mua vào', type: 'account' },
    { key: 'supplierCode', header: 'Mã NCC', type: 'text' },
    { key: 'supplierName', header: 'Tên NCC', type: 'text' },
    { key: 'supplierTaxCode', header: 'Mã số thuế NCC', type: 'text' },
  ] as TemplateColumn[],
};

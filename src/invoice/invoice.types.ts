export interface Invoice {
  id: string;
  fileName: string;
  /** XML: đọc trực tiếp từ hóa đơn điện tử; AI: đọc bằng Gemini từ PDF/ảnh. */
  source: 'XML' | 'AI';
  invoiceNo: string | null;
  invoiceSeries: string | null;
  invoiceDate: string | null;
  sellerName: string | null;
  sellerTaxCode: string | null;
  buyerName: string | null;
  buyerTaxCode: string | null;
  amountBeforeTax: number | null;
  /** % thuế GTGT; null khi hóa đơn có nhiều thuế suất hoặc không chịu thuế. */
  vatRate: number | null;
  vatAmount: number | null;
  totalAmount: number | null;
  uncertainFields: string[];
  notes: string[];
}

import { Injectable } from '@nestjs/common';
import { Part, Schema, Type } from '@google/genai';
import { XMLParser } from 'fast-xml-parser';
import { randomUUID } from 'crypto';
import { mapWithConcurrency } from '../common/concurrency';
import { toNumberOrNull, toStringOrNull } from '../common/values';
import { GeminiService } from '../gemini/gemini.service';
import { Invoice } from './invoice.types';

const SYSTEM_INSTRUCTION = `Bạn là kế toán viên Việt Nam, đọc hóa đơn GTGT / hóa đơn bán hàng.
Tài liệu có thể chứa một hoặc nhiều hóa đơn; trả về từng hóa đơn.
- invoiceNo: số hóa đơn, giữ nguyên số 0 ở đầu. invoiceSeries: ký hiệu (mẫu số + ký hiệu, vd 1C25TAA).
- invoiceDate: ngày lập DD/MM/YYYY.
- seller*/buyer*: tên và mã số thuế đơn vị bán / người mua, giữ nguyên như bản in.
- amountBeforeTax: cộng tiền hàng chưa thuế; vatAmount: tiền thuế GTGT; totalAmount: tổng tiền thanh toán. Số nguyên VND, bỏ dấu phân cách.
- vatRate: thuế suất GTGT dạng số (10, 8, 5, 0). Nhiều thuế suất hoặc không chịu thuế (KCT) thì trả null và ghi chú trong notes.
- TUYỆT ĐỐI KHÔNG SUY ĐOÁN: trường không có trên hóa đơn trả null; trường đọc không chắc chắn thì liệt kê tên trường trong uncertainFields.`;

const nullableString: Schema = { type: Type.STRING, nullable: true };
const nullableNumber: Schema = { type: Type.NUMBER, nullable: true };

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    invoices: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          invoiceNo: nullableString,
          invoiceSeries: nullableString,
          invoiceDate: nullableString,
          sellerName: nullableString,
          sellerTaxCode: nullableString,
          buyerName: nullableString,
          buyerTaxCode: nullableString,
          amountBeforeTax: nullableNumber,
          vatRate: nullableNumber,
          vatAmount: nullableNumber,
          totalAmount: nullableNumber,
          uncertainFields: { type: Type.ARRAY, items: { type: Type.STRING } },
          notes: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: [
          'invoiceNo', 'invoiceSeries', 'invoiceDate', 'sellerName', 'sellerTaxCode', 'buyerName',
          'buyerTaxCode', 'amountBeforeTax', 'vatRate', 'vatAmount', 'totalAmount', 'uncertainFields', 'notes',
        ],
      },
    },
  },
  required: ['invoices'],
};

type InvoiceFields = Omit<Invoice, 'id' | 'fileName'>;

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  removeNSPrefix: true,
  trimValues: true,
});

/** Tìm node đầu tiên có tên `key` ở bất kỳ độ sâu nào. */
function findNode(node: unknown, key: string): unknown {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findNode(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (key in record) return record[key];
  for (const value of Object.values(record)) {
    const found = findNode(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function collectValues(node: unknown, key: string, output: string[] = []): string[] {
  if (!node || typeof node !== 'object') return output;
  if (Array.isArray(node)) {
    node.forEach((item) => collectValues(item, key, output));
    return output;
  }
  for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
    if (name === key && (typeof value === 'string' || typeof value === 'number')) output.push(String(value).trim());
    else collectValues(value, key, output);
  }
  return output;
}

const text = (node: unknown, key: string) => {
  const value = findNode(node, key);
  return typeof value === 'string' || typeof value === 'number' ? toStringOrNull(value) : null;
};

/** 2025-01-31 → 31/01/2025 */
const isoToVnDate = (value: string | null) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
};

@Injectable()
export class InvoiceService {
  constructor(private readonly gemini: GeminiService) {}

  async extractInvoices(files: Express.Multer.File[]) {
    if (!files.every((file) => this.isXml(file))) await this.gemini.assertConfigured();
    const perFile = await mapWithConcurrency(files, this.gemini.concurrency, async (file) => {
      try {
        const fields = this.isXml(file) ? await this.fromXml(file) : await this.fromAi(file);
        return {
          invoices: fields.map((field): Invoice => ({ id: randomUUID(), fileName: file.originalname, ...field })),
        };
      } catch (error) {
        return { error: `${file.originalname}: ${error instanceof Error ? error.message : 'Không đọc được hóa đơn.'}` };
      }
    });
    return {
      invoices: perFile.flatMap((item) => item.invoices || []),
      errors: perFile.flatMap((item) => (item.error ? [item.error] : [])),
    };
  }

  isXml(file: Express.Multer.File) {
    return /\.xml$/i.test(file.originalname) || /xml/.test(file.mimetype);
  }

  /** Hóa đơn điện tử theo chuẩn TT78 (HDon/DLHDon). Thiếu trường chính thì chuyển sang AI đọc nội dung XML. */
  private async fromXml(file: Express.Multer.File): Promise<InvoiceFields[]> {
    const xml = file.buffer.toString('utf8');
    const root = xmlParser.parse(xml);
    const seller = findNode(root, 'NBan');
    const buyer = findNode(root, 'NMua');
    const payment = findNode(root, 'TToan');

    const invoice: InvoiceFields = {
      source: 'XML',
      invoiceNo: text(root, 'SHDon'),
      invoiceSeries: [text(root, 'KHMSHDon'), text(root, 'KHHDon')].filter(Boolean).join('') || null,
      invoiceDate: isoToVnDate(text(root, 'NLap')),
      sellerName: text(seller, 'Ten'),
      sellerTaxCode: text(seller, 'MST'),
      buyerName: text(buyer, 'Ten'),
      buyerTaxCode: text(buyer, 'MST'),
      amountBeforeTax: toNumberOrNull(text(payment, 'TgTCThue')),
      vatRate: null,
      vatAmount: toNumberOrNull(text(payment, 'TgTThue')),
      totalAmount: toNumberOrNull(text(payment, 'TgTTTBSo')),
      uncertainFields: [],
      notes: [],
    };

    const rates = [...new Set(collectValues(root, 'TSuat'))];
    const numericRate = rates.length === 1 ? /^(\d+(?:[.,]\d+)?)\s*%?$/.exec(rates[0]) : null;
    if (numericRate) invoice.vatRate = Number(numericRate[1].replace(',', '.'));
    else if (rates.length) invoice.notes.push(`Thuế suất trên hóa đơn: ${rates.join(', ')} — cần kiểm tra.`);

    if (!invoice.invoiceNo || invoice.totalAmount === null || !invoice.sellerName) {
      const aiInvoices = await this.askAi([
        { text: `Nội dung XML hóa đơn điện tử (không theo chuẩn TT78 hoặc thiếu trường):\n${this.stripSignature(xml)}` },
      ]);
      aiInvoices.forEach((item) => item.notes.push('XML không theo chuẩn TT78, đã đọc bằng AI — cần kiểm tra.'));
      return aiInvoices;
    }
    return [invoice];
  }

  private async fromAi(file: Express.Multer.File): Promise<InvoiceFields[]> {
    return this.askAi([
      { inlineData: { mimeType: file.mimetype, data: file.buffer.toString('base64') } },
      { text: 'Trích xuất thông tin các hóa đơn trong tài liệu này.' },
    ]);
  }

  private async askAi(parts: Part[]): Promise<InvoiceFields[]> {
    const response = await this.gemini.generateJson<{ invoices?: Record<string, unknown>[] }>(
      parts,
      RESPONSE_SCHEMA,
      SYSTEM_INSTRUCTION,
    );
    if (!Array.isArray(response.invoices) || !response.invoices.length) {
      throw new Error('Không tìm thấy hóa đơn trong tệp.');
    }
    return response.invoices.map((raw): InvoiceFields => ({
      source: 'AI',
      invoiceNo: toStringOrNull(raw.invoiceNo),
      invoiceSeries: toStringOrNull(raw.invoiceSeries),
      invoiceDate: toStringOrNull(raw.invoiceDate),
      sellerName: toStringOrNull(raw.sellerName),
      sellerTaxCode: toStringOrNull(raw.sellerTaxCode),
      buyerName: toStringOrNull(raw.buyerName),
      buyerTaxCode: toStringOrNull(raw.buyerTaxCode),
      amountBeforeTax: toNumberOrNull(raw.amountBeforeTax),
      vatRate: toNumberOrNull(raw.vatRate),
      vatAmount: toNumberOrNull(raw.vatAmount),
      totalAmount: toNumberOrNull(raw.totalAmount),
      uncertainFields: Array.isArray(raw.uncertainFields) ? raw.uncertainFields.map(String) : [],
      notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
    }));
  }

  private stripSignature(xml: string) {
    return xml.replace(/<([\w:]*)Signature[\s\S]*?<\/\1Signature>/g, '').slice(0, 200_000);
  }
}

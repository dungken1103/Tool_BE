import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Part, Schema, Type } from '@google/genai';
import { randomUUID } from 'crypto';
import { mapWithConcurrency } from '../common/concurrency';
import { splitPdf } from '../common/pdf';
import { parseVnDate, toNumberOrNull, toStringOrNull } from '../common/values';
import { GeminiService } from '../gemini/gemini.service';
import { StatementStore, fileHash } from './statement.store';
import {
  ExtractedTransaction,
  ExtractionJob,
  ExtractionResult,
  StatementFileResult,
  StatementHeader,
} from './statement.types';

const SYSTEM_INSTRUCTION = `Bạn là chuyên gia kế toán ngân hàng Việt Nam, đọc bản scan sao kê tài khoản.
Tài liệu được gửi là MỘT PHẦN (một vài trang) của bản sao kê. Yêu cầu:
1. Trích xuất MỌI dòng giao dịch trong các trang này theo đúng thứ tự từ trên xuống dưới, không bỏ sót, không thêm.
2. page: số thứ tự trang trong tài liệu được gửi (bắt đầu từ 1).
3. transactionDate dạng DD/MM/YYYY. documentNo giữ nguyên từng ký tự như bản in (kể cả số 0 ở đầu, dấu chấm), dạng chuỗi; không có thì chuỗi rỗng.
4. description: gộp các dòng diễn giải của cùng một giao dịch thành một chuỗi, giữ nguyên chữ hoa/thường và ký tự như bản in, không dịch, không sửa chính tả.
5. Số tiền là số nguyên VND, bỏ dấu phân cách hàng nghìn. Cột không có số thì trả 0. balance chỉ điền khi ô Số dư của chính dòng đó có in số; ô trống trả null.
6. Không coi dòng tiêu đề cột, số dư đầu kỳ, dòng Tổng số, số dư cuối kỳ là giao dịch.
7. header: chỉ điền thông tin thực sự xuất hiện trong các trang này (tên ngân hàng, chi nhánh, số tài khoản, tên tài khoản, địa chỉ, CIF, loại tiền, ngày thực hiện/ngày in sao kê, Từ ngày/Đến ngày, số dư đầu kỳ, tổng số ghi nợ, tổng số ghi có, số dư cuối kỳ); không thấy thì trả null.
8. TUYỆT ĐỐI KHÔNG SUY ĐOÁN. Ký tự hoặc số bị mờ, bị dấu mộc/nếp gấp che: ghi giá trị đọc được tốt nhất VÀ liệt kê tên trường đó trong uncertainFields. Hoàn toàn không đọc được số tiền thì trả null và liệt kê trong uncertainFields.`;

const nullableString = (description: string): Schema => ({ type: Type.STRING, nullable: true, description });
const nullableNumber = (description: string): Schema => ({ type: Type.NUMBER, nullable: true, description });

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    header: {
      type: Type.OBJECT,
      properties: {
        bankName: nullableString('Tên ngân hàng như bản in, không gồm chi nhánh'),
        branch: nullableString('Chi nhánh thực hiện / Branch, như bản in'),
        accountNumber: nullableString('Số tài khoản'),
        accountName: nullableString('Tên tài khoản / chủ tài khoản'),
        address: nullableString('Địa chỉ chủ tài khoản'),
        cif: nullableString('Số CIF'),
        currency: nullableString('Loại tiền'),
        statementDate: nullableString('Ngày thực hiện / ngày in sao kê, DD/MM/YYYY'),
        periodFrom: nullableString('Từ ngày, DD/MM/YYYY'),
        periodTo: nullableString('Đến ngày, DD/MM/YYYY'),
        openingBalance: nullableNumber('Số dư đầu kỳ'),
        closingBalance: nullableNumber('Số dư cuối kỳ'),
        totalDebit: nullableNumber('Tổng số tiền ghi nợ'),
        totalCredit: nullableNumber('Tổng số tiền ghi có'),
      },
      required: [
        'bankName', 'branch', 'accountNumber', 'accountName', 'address', 'cif', 'currency', 'statementDate',
        'periodFrom', 'periodTo', 'openingBalance', 'closingBalance', 'totalDebit', 'totalCredit',
      ],
    },
    transactions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          page: { type: Type.INTEGER, description: 'Trang trong tài liệu được gửi, từ 1' },
          transactionDate: { type: Type.STRING, description: 'Ngày giao dịch DD/MM/YYYY' },
          documentNo: { type: Type.STRING, description: 'Số chứng từ ngân hàng, giữ nguyên ký tự' },
          description: { type: Type.STRING, description: 'Nội dung chi tiết đầy đủ' },
          debitAmount: nullableNumber('Số tiền ghi nợ (tiền ra), không có trả 0'),
          creditAmount: nullableNumber('Số tiền ghi có (tiền vào), không có trả 0'),
          balance: nullableNumber('Số dư in trên dòng này, ô trống trả null'),
          uncertainFields: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Tên các trường đọc không chắc chắn',
          },
        },
        required: [
          'page', 'transactionDate', 'documentNo', 'description',
          'debitAmount', 'creditAmount', 'balance', 'uncertainFields',
        ],
      },
    },
  },
  required: ['header', 'transactions'],
};

const EMPTY_HEADER: StatementHeader = {
  bankName: null,
  branch: null,
  accountNumber: null,
  accountName: null,
  address: null,
  cif: null,
  currency: null,
  statementDate: null,
  periodFrom: null,
  periodTo: null,
  openingBalance: null,
  closingBalance: null,
  totalDebit: null,
  totalCredit: null,
};

/** Các trường lấy từ phần đầu sao kê (giá trị đầu tiên), còn lại lấy từ phần cuối (giá trị cuối cùng). */
const LEADING_HEADER_FIELDS: (keyof StatementHeader)[] = [
  'bankName', 'branch', 'accountNumber', 'accountName', 'address', 'cif', 'currency', 'statementDate',
  'periodFrom', 'periodTo', 'openingBalance',
];

const UNCERTAIN_FIELD_NAMES = new Set([
  'transactionDate', 'documentNo', 'description', 'debitAmount', 'creditAmount', 'balance',
]);

const JOB_TTL_MS = 60 * 60 * 1000;

interface ChunkResponse {
  header?: Partial<Record<keyof StatementHeader, unknown>>;
  transactions?: {
    page?: number;
    transactionDate?: string;
    documentNo?: string;
    description?: string;
    debitAmount?: unknown;
    creditAmount?: unknown;
    balance?: unknown;
    uncertainFields?: string[];
  }[];
}

interface WorkItem {
  fileIndex: number;
  fileHash: string;
  startPage: number;
  endPage: number;
  mimeType: string;
  data: Buffer;
}

@Injectable()
export class StatementService {
  private readonly jobs = new Map<string, ExtractionJob>();
  private readonly pagesPerChunk: number;
  private readonly startDelayMs: number;

  constructor(
    private readonly gemini: GeminiService,
    private readonly store: StatementStore,
    configService: ConfigService,
  ) {
    this.pagesPerChunk = Number(configService.get<string>('PAGES_PER_CHUNK')) || 3;
    const delay = Number(configService.get<string>('EXTRACT_START_DELAY_SECONDS'));
    this.startDelayMs = (Number.isFinite(delay) && delay >= 0 ? delay : 8) * 1000;
  }

  /** `force`: bỏ qua kết quả đã lưu, đọc lại toàn bộ bằng AI. */
  async startExtraction(files: Express.Multer.File[], force = false): Promise<ExtractionJob> {
    this.cleanupJobs();
    const workItems: WorkItem[] = [];
    const fileResults: StatementFileResult[] = [];

    for (const [fileIndex, file] of files.entries()) {
      const hash = fileHash(file.buffer);
      if (file.mimetype === 'application/pdf') {
        const { pageCount, chunks } = await splitPdf(file.buffer, this.pagesPerChunk);
        chunks.forEach((chunk) =>
          workItems.push({ fileIndex, fileHash: hash, ...chunk, mimeType: 'application/pdf' }),
        );
        fileResults.push(this.emptyFileResult(fileIndex, file.originalname, pageCount, hash));
        await this.store.saveFile(hash, file.originalname, file.mimetype, pageCount, file.buffer);
      } else {
        workItems.push({ fileIndex, fileHash: hash, startPage: 1, endPage: 1, mimeType: file.mimetype, data: file.buffer });
        fileResults.push(this.emptyFileResult(fileIndex, file.originalname, 1, hash));
        await this.store.saveFile(hash, file.originalname, file.mimetype, 1, file.buffer);
      }
    }

    // Chỉ cần key Gemini khi còn lô chưa có kết quả đã lưu.
    const cached = new Map<WorkItem, ChunkResponse>();
    if (!force) {
      for (const item of workItems) {
        const response = await this.store.getChunk<ChunkResponse>(item.fileHash, item.startPage, item.endPage);
        if (response) cached.set(item, response);
      }
    }
    if (cached.size < workItems.length) await this.gemini.assertConfigured();

    const job: ExtractionJob = {
      id: randomUUID(),
      status: 'RUNNING',
      totalChunks: workItems.length,
      doneChunks: 0,
      cachedChunks: cached.size,
      createdAt: Date.now(),
      // Chờ vài giây trước khi gửi AI để người dùng kịp hủy nếu tải nhầm tệp (không cần chờ khi mọi phần đã có kết quả lưu).
      startAt: Date.now() + (cached.size < workItems.length ? this.startDelayMs : 0),
    };
    if (job.startAt > Date.now()) job.status = 'WAITING';
    this.jobs.set(job.id, job);

    void this.runJob(job, workItems, fileResults, cached).catch((error) => {
      job.status = 'FAILED';
      job.error = error instanceof Error ? error.message : 'Lỗi không xác định khi bóc tách.';
    });
    return job;
  }

  getJob(id: string): ExtractionJob {
    const job = this.jobs.get(id);
    if (!job) {
      throw new NotFoundException('Không tìm thấy phiên bóc tách (có thể đã hết hạn).');
    }
    return job;
  }

  /** Tạm dừng / tiếp tục / hủy: chỉ chặn các phần chưa gửi AI; phần đang gửi chạy nốt và được lưu lại. */
  control(id: string, action: 'pause' | 'resume' | 'cancel') {
    const job = this.getJob(id);
    if (job.status === 'DONE' || job.status === 'FAILED' || job.status === 'CANCELLED') return job;
    if (action === 'cancel') job.status = 'CANCELLED';
    else if (action === 'pause') job.status = 'PAUSED';
    else job.status = Date.now() < job.startAt ? 'WAITING' : 'RUNNING';
    return job;
  }

  /** Đợi tới lượt gửi AI: hết thời gian chờ và không tạm dừng. Trả false nếu đã hủy. */
  private async gate(job: ExtractionJob) {
    for (;;) {
      if (job.status === 'CANCELLED') return false;
      if (job.status !== 'PAUSED' && Date.now() >= job.startAt) {
        if (job.status === 'WAITING') job.status = 'RUNNING';
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  private async runJob(
    job: ExtractionJob,
    workItems: WorkItem[],
    fileResults: StatementFileResult[],
    cached: Map<WorkItem, ChunkResponse>,
  ) {
    type ChunkResult = { item: WorkItem; response?: ChunkResponse; error?: string; skipped?: boolean };
    const chunkResults = await mapWithConcurrency(workItems, this.gemini.concurrency, async (item): Promise<ChunkResult> => {
      const saved = cached.get(item);
      if (saved) {
        job.doneChunks += 1;
        return { item, response: saved };
      }
      if (!(await this.gate(job))) return { item, skipped: true };
      try {
        const response = await this.extractChunk(item);
        await this.store.saveChunk(item.fileHash, item.startPage, item.endPage, response, this.gemini.model);
        return { item, response };
      } catch (error) {
        return { item, error: error instanceof Error ? error.message : 'Lỗi dịch vụ Gemini.' };
      } finally {
        job.doneChunks += 1;
      }
    });

    if (job.status === 'CANCELLED') {
      const read = chunkResults.filter((result) => result.response).length;
      job.error = read
        ? `Đã hủy. ${read}/${workItems.length} phần đã đọc được lưu lại — bóc tách lại cùng tệp sẽ không tốn AI cho các phần này.`
        : 'Đã hủy trước khi gửi cho AI — không tốn lượt gọi nào.';
      return;
    }

    const firstError = chunkResults.find((result) => result.error)?.error;
    if (chunkResults.every((result) => result.error || !result.response)) {
      throw new Error(`Không đọc được trang nào. ${firstError || ''}`.trim());
    }

    const transactionsByFile = fileResults.map(() => [] as ExtractedTransaction[]);
    for (const { item, response, error } of chunkResults) {
      const fileResult = fileResults[item.fileIndex];
      if (error || !response) {
        fileResult.failedPages.push({ startPage: item.startPage, endPage: item.endPage, error: error || '' });
        continue;
      }
      this.mergeHeader(fileResult.header, response.header);
      const pageSpan = item.endPage - item.startPage + 1;
      for (const raw of response.transactions || []) {
        const relativePage = Number(raw.page);
        const pageNumber =
          relativePage >= 1 && relativePage <= pageSpan ? item.startPage + relativePage - 1 : item.startPage;
        const list = transactionsByFile[item.fileIndex];
        list.push({
          id: `${item.fileIndex}-${list.length + 1}`,
          transactionDate: String(raw.transactionDate || '').trim(),
          documentNo: String(raw.documentNo ?? '').trim(),
          description: String(raw.description || '').trim(),
          debitAmount: toNumberOrNull(raw.debitAmount),
          creditAmount: toNumberOrNull(raw.creditAmount),
          balance: toNumberOrNull(raw.balance),
          pageNumber,
          sourceFileIndex: item.fileIndex,
          uncertainFields: (raw.uncertainFields || []).filter((field) => UNCERTAIN_FIELD_NAMES.has(field)),
        });
      }
    }

    const warnings: string[] = [];
    const sortable = fileResults.every((file) => parseVnDate(file.header.periodFrom));
    if (fileResults.length > 1 && !sortable) {
      warnings.push('Không đọc được kỳ sao kê của tất cả các tệp; giữ nguyên thứ tự tải lên.');
    }
    const ordered = sortable
      ? [...fileResults].sort(
          (a, b) => parseVnDate(a.header.periodFrom)!.getTime() - parseVnDate(b.header.periodFrom)!.getTime(),
        )
      : fileResults;

    job.result = {
      files: ordered,
      transactions: ordered.flatMap((file) => transactionsByFile[file.index]),
      warnings,
    };
    job.status = 'DONE';
  }

  private async extractChunk(item: WorkItem): Promise<ChunkResponse> {
    const pages =
      item.startPage === item.endPage ? `trang ${item.startPage}` : `các trang ${item.startPage}–${item.endPage}`;
    const parts: Part[] = [
      { inlineData: { mimeType: item.mimeType, data: item.data.toString('base64') } },
      { text: `Đây là ${pages} của bản sao kê. Trích xuất thông tin theo đúng yêu cầu.` },
    ];
    const response = await this.gemini.generateJson<ChunkResponse>(parts, RESPONSE_SCHEMA, SYSTEM_INSTRUCTION);
    if (!Array.isArray(response.transactions)) {
      throw new Error('Dữ liệu giao dịch trả về không hợp lệ.');
    }
    return response;
  }

  private mergeHeader(target: StatementHeader, source: ChunkResponse['header']) {
    if (!source) return;
    for (const key of Object.keys(EMPTY_HEADER) as (keyof StatementHeader)[]) {
      const isNumeric = ['openingBalance', 'closingBalance', 'totalDebit', 'totalCredit'].includes(key);
      const value = isNumeric ? toNumberOrNull(source[key]) : toStringOrNull(source[key]);
      if (value === null) continue;
      if (LEADING_HEADER_FIELDS.includes(key) && target[key] !== null) continue;
      (target as unknown as Record<string, unknown>)[key] = value;
    }
  }

  private emptyFileResult(index: number, name: string, pageCount: number, hash: string): StatementFileResult {
    return { index, name, pageCount, hash, header: { ...EMPTY_HEADER }, failedPages: [] };
  }

  getFile(hash: string) {
    return this.store.getFile(hash);
  }

  private cleanupJobs() {
    const expiredBefore = Date.now() - JOB_TTL_MS;
    for (const [id, job] of this.jobs) {
      if (job.createdAt < expiredBefore) this.jobs.delete(id);
    }
  }
}

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI, Part, Schema, ThinkingLevel } from '@google/genai';
import { ActiveKey, KeysService } from '../keys/keys.service';

const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const statusOf = (error: unknown) =>
  error && typeof error === 'object' && 'status' in error ? Number((error as { status: unknown }).status) : NaN;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : '');

const isDailyQuota = (error: unknown) => statusOf(error) === 429 && /per ?day/i.test(messageOf(error));

/** Key sai, bị thu hồi hoặc project bị khóa: key này không dùng được nữa, nhưng key khác có thể vẫn tốt. */
const isBadKey = (error: unknown) =>
  [401, 403].includes(statusOf(error)) || /API key not valid|API_KEY_INVALID|suspended/i.test(messageOf(error));

/** Lỗi key / quyền / yêu cầu sai / hết hạn mức ngày: thử lại cùng key cũng không qua. */
const isPermanent = (error: unknown) =>
  [400, 401, 403, 404].includes(statusOf(error)) || isDailyQuota(error) || isBadKey(error);

const shorten = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

function describeError(error: unknown) {
  const status = statusOf(error);
  const raw = messageOf(error);
  if (error instanceof SyntaxError) return 'Không đọc được phản hồi có cấu trúc từ Gemini.';
  if (status === 429) return 'Gemini báo vượt hạn mức (429). Đợi một lúc hoặc giảm GEMINI_CONCURRENCY.';
  if (status === 503) return 'Model Gemini đang quá tải (503). Thử lại sau ít phút hoặc đổi GEMINI_MODEL.';
  if (status === 404) return `Không tìm thấy model Gemini — kiểm tra GEMINI_MODEL. (${raw})`;
  return raw || 'Lỗi dịch vụ Gemini.';
}

@Injectable()
export class GeminiService {
  private readonly clients = new Map<string, GoogleGenAI>();
  readonly model: string;
  readonly concurrency: number;
  /** Mức "suy nghĩ" của Gemini 3.x; đọc sao kê là việc chép số, suy nghĩ nhiều chỉ làm chậm. */
  private readonly thinkingLevel?: ThinkingLevel;

  constructor(
    configService: ConfigService,
    private readonly keys: KeysService,
  ) {
    this.model = configService.get<string>('GEMINI_MODEL') || 'gemini-3.6-flash';
    this.concurrency = Number(configService.get<string>('GEMINI_CONCURRENCY')) || 4;
    const level = (configService.get<string>('GEMINI_THINKING_LEVEL') || '').trim().toUpperCase();
    this.thinkingLevel = level && level in ThinkingLevel ? ThinkingLevel[level as keyof typeof ThinkingLevel] : undefined;
  }

  /** Báo lỗi sớm khi không còn key nào dùng được — các chức năng không cần AI (danh mục, xuất file) vẫn chạy. */
  async assertConfigured() {
    if (!(await this.keys.acquire())) throw new InternalServerErrorException(await this.noKeyMessage());
  }

  private async noKeyMessage() {
    return (await this.keys.hasKeys())
      ? 'Tất cả API key đã hết hạn mức hoặc không dùng được. Thêm key mới ở mục "API key" trên trang web.'
      : 'Chưa có API key. Thêm key ở mục "API key" trên trang web hoặc đặt GEMINI_API_KEY trong backend/.env.';
  }

  private clientFor(apiKey: string) {
    let client = this.clients.get(apiKey);
    if (!client) {
      client = new GoogleGenAI({ apiKey });
      this.clients.set(apiKey, client);
    }
    return client;
  }

  /**
   * Gọi Gemini trả về JSON theo schema. Key hết hạn mức ngày hoặc không hợp lệ được đánh dấu trong DB
   * (kèm nhật ký) rồi tự chuyển sang key kế tiếp; lỗi mạng hoặc JSON hỏng thì thử lại tối đa 3 lần.
   */
  async generateJson<T>(parts: Part[], schema: Schema, systemInstruction: string): Promise<T> {
    for (;;) {
      const key = await this.keys.acquire();
      if (!key) throw new Error(await this.noKeyMessage());
      try {
        return await this.callWithRetry<T>(key, parts, schema, systemInstruction);
      } catch (error) {
        if (isDailyQuota(error)) {
          await this.keys.markExhausted(key.id, shorten(messageOf(error)));
        } else if (isBadKey(error)) {
          await this.keys.markInvalid(key.id, shorten(messageOf(error)));
        } else {
          throw new Error(describeError(error));
        }
      }
    }
  }

  private async callWithRetry<T>(key: ActiveKey, parts: Part[], schema: Schema, systemInstruction: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.keys.recordCall(key.id);
        const result = await this.clientFor(key.apiKey).models.generateContent({
          model: this.model,
          contents: [{ role: 'user', parts }],
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: schema,
            temperature: 0,
            maxOutputTokens: 65536,
            ...(this.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.thinkingLevel } } : {}),
          },
        });
        const text = result.text;
        if (!text) {
          throw new Error('Gemini không trả về nội dung.');
        }
        return JSON.parse(text) as T;
      } catch (error) {
        lastError = error;
        if (isPermanent(error)) break;
        if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
      }
    }
    throw lastError;
  }
}

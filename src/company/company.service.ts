import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ExcelJS from 'exceljs';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  AccountingRule,
  CatalogObject,
  Company,
  CompanySettings,
  DEFAULT_ALIASES,
  DEFAULT_ALIASES_VERSION,
  DEFAULT_SETTINGS,
  LedgerEntry,
  MAX_TOLERANCE_DAYS,
  NameAlias,
  ObjectKind,
} from './company.types';

type CatalogField = 'code' | 'name' | 'address' | 'taxCode' | 'phone';

/** Nhận diện cột theo tiêu đề của file "Danh sách khách hàng / nhà cung cấp" (thứ tự kiểm tra quan trọng). */
const HEADER_PATTERNS: [CatalogField, RegExp][] = [
  ['taxCode', /^(mã số thuế|mst)/i],
  ['code', /^mã/i],
  ['name', /^tên/i],
  ['address', /địa chỉ/i],
  ['phone', /điện thoại/i],
];

/** Dòng tổng cuối danh mục ("Tổng"); không nhầm với tên "TỔNG CÔNG TY …". */
const TOTAL_ROW = /^tổng( cộng)?$/i;

type LedgerField = 'date' | 'voucherNo' | 'invoiceNo' | 'name' | 'total';
export type LedgerKind = 'SALES' | 'PURCHASES';

/** Cột của file "Bán hàng" / "Mua hàng hóa, dịch vụ" xuất từ MISA. */
const LEDGER_PATTERNS: [LedgerField, RegExp][] = [
  ['date', /^ngày hạch toán/i],
  ['voucherNo', /^số chứng từ/i],
  ['invoiceNo', /^số hóa đơn/i],
  ['name', /^(khách hàng|nhà cung cấp|tên khách hàng|tên nhà cung cấp)$/i],
  ['total', /^tổng tiền thanh toán/i],
];

const plainUpper = (value: string) =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase();

const pad = (value: number) => String(value).padStart(2, '0');

const sameCode =(a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/** ExcelJS ném lỗi khi đọc text của ô gộp trống, nên bọc lại. */
const cellText = (cell: ExcelJS.Cell) => {
  try {
    return cell.text.trim();
  } catch {
    return '';
  }
};

/** Ô ngày có thể là Date (UTC) hoặc chuỗi DD/MM/YYYY. */
const cellDate = (cell: ExcelJS.Cell) => {
  const value = cell.value;
  if (value instanceof Date) return `${pad(value.getUTCDate())}/${pad(value.getUTCMonth() + 1)}/${value.getUTCFullYear()}`;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(cellText(cell));
  return match ? `${pad(Number(match[1]))}/${pad(Number(match[2]))}/${match[3]}` : '';
};

const cellNumber = (cell: ExcelJS.Cell) => {
  const value = cell.value as unknown;
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'result' in value) return Number((value as { result: unknown }).result) || 0;
  return Number(cellText(cell).replace(/[.,\s]/g, '')) || 0;
};

@Injectable()
export class CompanyService {
  private readonly dataDir: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(configService: ConfigService) {
    this.dataDir = path.resolve(configService.get<string>('DATA_DIR') || 'data', 'companies');
  }

  async list() {
    await fs.mkdir(this.dataDir, { recursive: true });
    const files = (await fs.readdir(this.dataDir)).filter((file) => file.endsWith('.json'));
    const companies = await Promise.all(files.map((file) => this.read(path.basename(file, '.json'))));
    return companies
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
      .map(({ id, name, customers, suppliers, rules }) => ({
        id,
        name,
        customerCount: customers.length,
        supplierCount: suppliers.length,
        newObjectCount: [...customers, ...suppliers].filter((item) => item.isNew).length,
        ruleCount: rules.length,
      }));
  }

  async create(name: string) {
    if (!name?.trim()) throw new BadRequestException('Vui lòng nhập tên công ty.');
    const company: Company = {
      id: randomUUID(),
      name: name.trim(),
      createdAt: new Date().toISOString(),
      customers: [],
      suppliers: [],
      rules: [],
      settings: structuredClone(DEFAULT_SETTINGS),
      sales: [],
      purchases: [],
      aliases: [],
      preferredCodes: {},
    };
    await this.write(company);
    return company;
  }

  async get(id: string) {
    const company = await this.read(id);
    if ((company.aliasDefaultsVersion || 0) < DEFAULT_ALIASES_VERSION && company.purchases.length) {
      return this.update(id, (current) => void this.applyDefaultAliases(current));
    }
    return company;
  }

  async rename(id: string, name: string) {
    if (!name?.trim()) throw new BadRequestException('Vui lòng nhập tên công ty.');
    return this.update(id, (company) => {
      company.name = name.trim();
    });
  }

  /** Nhập danh mục từ file Excel; đối tượng tự thêm trước đó mà chưa có trong file vẫn được giữ lại. */
  async importCatalog(id: string, kind: ObjectKind, file: Express.Multer.File) {
    if (!/\.xlsx$/i.test(Buffer.from(file.originalname, 'latin1').toString('utf8'))) {
      throw new BadRequestException('Vui lòng dùng file .xlsx (mở file .xls bằng Excel rồi lưu lại dạng .xlsx).');
    }
    const imported = await this.parseCatalog(file.buffer, kind);
    return this.update(id, (company) => {
      const key = kind === 'CUSTOMER' ? 'customers' : 'suppliers';
      const keptNew = company[key].filter(
        (item) => item.isNew && !imported.some((other) => sameCode(other.code, item.code)),
      );
      company[key] = [...imported, ...keptNew];
    });
  }

  /** Thêm đối tượng mới (bỏ qua mã đã tồn tại ở cả hai danh mục). */
  async addObjects(id: string, objects: CatalogObject[]) {
    if (!Array.isArray(objects)) throw new BadRequestException('Danh sách đối tượng không hợp lệ.');
    return this.update(id, (company) => {
      for (const object of objects) {
        if (!object?.code?.trim() || !object.name?.trim()) continue;
        const exists = [...company.customers, ...company.suppliers].some((item) => sameCode(item.code, object.code));
        if (exists) continue;
        const entry: CatalogObject = {
          code: object.code.trim(),
          name: object.name.trim(),
          address: object.address || '',
          taxCode: object.taxCode || '',
          phone: object.phone || '',
          kind: object.kind === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER',
          isNew: true,
          createdAt: new Date().toISOString(),
        };
        (entry.kind === 'CUSTOMER' ? company.customers : company.suppliers).push(entry);
      }
    });
  }

  async saveRules(id: string, rules: AccountingRule[]) {
    if (!Array.isArray(rules)) throw new BadRequestException('Danh sách quy tắc không hợp lệ.');
    return this.update(id, (company) => {
      company.rules = rules
        .filter((rule) => rule?.keyword?.trim())
        .map((rule) => ({
          id: rule.id || randomUUID(),
          keyword: rule.keyword.trim(),
          direction: ['IN', 'OUT'].includes(rule.direction) ? rule.direction : 'ANY',
          debitAccount: (rule.debitAccount || '').trim(),
          creditAccount: (rule.creditAccount || '').trim(),
          objectCode: (rule.objectCode || '').trim(),
          reason: (rule.reason || '').trim(),
        }));
    });
  }

  /** Nhập danh sách chứng từ Bán hàng / Mua hàng (thay toàn bộ danh sách cũ cùng loại). */
  async importLedger(id: string, kind: LedgerKind, file: Express.Multer.File) {
    if (!/\.xlsx$/i.test(Buffer.from(file.originalname, 'latin1').toString('utf8'))) {
      throw new BadRequestException('Vui lòng dùng file .xlsx (mở file .xls bằng Excel rồi lưu lại dạng .xlsx).');
    }
    const entries = await this.parseLedger(file.buffer);
    return this.update(id, (company) => {
      if (kind === 'SALES') {
        company.sales = entries;
        return;
      }
      company.purchases = entries;
      company.aliasDefaultsVersion = 0;
      this.applyDefaultAliases(company);
    });
  }

  /**
   * Thêm viết tắt mặc định cho nhà cung cấp có trong sổ mua hàng mà bảng viết tắt chưa có dòng nào trỏ tới.
   * Chỉ chạy một lần cho mỗi phiên bản mặc định, nên dòng người dùng đã xóa không tự quay lại.
   */
  private applyDefaultAliases(company: Company) {
    if ((company.aliasDefaultsVersion || 0) >= DEFAULT_ALIASES_VERSION || !company.purchases.length) return false;
    const suppliers = [...new Set(company.purchases.map((entry) => entry.name))];
    for (const { keyword, nameContains } of DEFAULT_ALIASES) {
      const name = suppliers.find((supplier) => plainUpper(supplier).includes(nameContains));
      if (!name) continue;
      const existing = company.aliases.find((alias) => alias.name === name);
      if (!existing) {
        company.aliases.push({ id: randomUUID(), keyword, name });
        continue;
      }
      // Dòng đã có (người dùng có thể đã sửa): chỉ bổ sung từ khóa mặc định mới, không xóa từ khóa nào.
      const current = existing.keyword.split('|').map((item) => item.trim()).filter(Boolean);
      const added = keyword.split('|').filter((item) => !current.some((value) => value.toLowerCase() === item.toLowerCase()));
      if (added.length) existing.keyword = [...current, ...added].join('|');
    }
    company.aliasDefaultsVersion = DEFAULT_ALIASES_VERSION;
    return true;
  }

  /** Nhớ mã đã chọn cho một tên (code rỗng = bỏ ghi nhớ). */
  async setPreferredCode(id: string, nameKey: string, code: string) {
    const key = (nameKey || '').trim().toUpperCase();
    if (!key) throw new BadRequestException('Thiếu tên đối tượng.');
    return this.update(id, (company) => {
      const exists = [...company.customers, ...company.suppliers].some((item) => sameCode(item.code, code || ''));
      if (code && !exists) throw new BadRequestException(`Mã "${code}" không có trong danh mục.`);
      if (code) company.preferredCodes[key] = code.trim();
      else delete company.preferredCodes[key];
    });
  }

  async saveAliases(id: string, aliases: NameAlias[]) {
    if (!Array.isArray(aliases)) throw new BadRequestException('Danh sách viết tắt không hợp lệ.');
    return this.update(id, (company) => {
      company.aliases = aliases
        .filter((alias) => alias?.keyword?.trim() && alias.name?.trim())
        .map((alias) => ({ id: alias.id || randomUUID(), keyword: alias.keyword.trim(), name: alias.name.trim() }));
    });
  }

  async saveSettings(id: string, settings: CompanySettings) {
    return this.update(id, (company) => {
      company.settings = {
        ...DEFAULT_SETTINGS,
        ...settings,
        numbering: { ...DEFAULT_SETTINGS.numbering, ...settings?.numbering },
      };
      const days = Math.round(Number(company.settings.sameDayAmountToleranceDays));
      company.settings.sameDayAmountToleranceDays = Number.isFinite(days)
        ? Math.min(Math.max(days, 0), MAX_TOLERANCE_DAYS)
        : DEFAULT_SETTINGS.sameDayAmountToleranceDays;
    });
  }

  private async parseCatalog(buffer: Buffer, kind: ObjectKind): Promise<CatalogObject[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('File không có sheet dữ liệu.');

    let headerRow = 0;
    const columns = new Map<CatalogField, number>();
    for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 15) && !headerRow; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const found = new Map<CatalogField, number>();
      row.eachCell((cell, column) => {
        const title = cellText(cell);
        const match = HEADER_PATTERNS.find(([, pattern]) => pattern.test(title));
        if (match && !found.has(match[0])) found.set(match[0], column);
      });
      if (found.has('code') && found.has('name')) {
        headerRow = rowNumber;
        found.forEach((column, field) => columns.set(field, column));
      }
    }
    if (!headerRow) {
      throw new BadRequestException('Không tìm thấy dòng tiêu đề có cột "Mã …" và "Tên …".');
    }

    const objects: CatalogObject[] = [];
    for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const read = (field: CatalogField) => (columns.has(field) ? cellText(row.getCell(columns.get(field)!)) : '');
      const code = read('code');
      const name = read('name');
      if (!code || !name || TOTAL_ROW.test(code) || TOTAL_ROW.test(name)) continue;
      objects.push({ code, name, address: read('address'), taxCode: read('taxCode'), phone: read('phone'), kind });
    }
    if (!objects.length) throw new BadRequestException('File không có dòng đối tượng nào.');
    return objects;
  }

  private async parseLedger(buffer: Buffer): Promise<LedgerEntry[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('File không có sheet dữ liệu.');

    let headerRow = 0;
    const columns = new Map<LedgerField, number>();
    for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 15) && !headerRow; rowNumber += 1) {
      const found = new Map<LedgerField, number>();
      sheet.getRow(rowNumber).eachCell((cell, column) => {
        const match = LEDGER_PATTERNS.find(([, pattern]) => pattern.test(cellText(cell)));
        if (match && !found.has(match[0])) found.set(match[0], column);
      });
      if (found.has('date') && found.has('name') && found.has('total')) {
        headerRow = rowNumber;
        found.forEach((column, field) => columns.set(field, column));
      }
    }
    if (!headerRow) {
      throw new BadRequestException('Không tìm thấy dòng tiêu đề có cột "Ngày hạch toán", "Khách hàng/Nhà cung cấp", "Tổng tiền thanh toán".');
    }

    const entries: LedgerEntry[] = [];
    for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const cell = (field: LedgerField) => row.getCell(columns.get(field) || 0);
      const date = cellDate(cell('date'));
      const name = cellText(cell('name'));
      if (!date || !name) continue;
      entries.push({
        date,
        voucherNo: columns.has('voucherNo') ? cellText(cell('voucherNo')) : '',
        invoiceNo: columns.has('invoiceNo') ? cellText(cell('invoiceNo')) : '',
        name,
        total: cellNumber(cell('total')),
      });
    }
    if (!entries.length) throw new BadRequestException('File không có dòng chứng từ nào.');
    return entries;
  }

  private async update(id: string, mutate: (company: Company) => void) {
    const task = this.writeQueue.then(async () => {
      const company = await this.read(id);
      mutate(company);
      await this.write(company);
      return company;
    });
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  private async read(id: string): Promise<Company> {
    if (!/^[\w-]+$/.test(id)) throw new NotFoundException('Không tìm thấy công ty.');
    try {
      const company = JSON.parse(await fs.readFile(this.filePath(id), 'utf8')) as Company;
      company.settings = {
        ...DEFAULT_SETTINGS,
        ...company.settings,
        numbering: { ...DEFAULT_SETTINGS.numbering, ...company.settings?.numbering },
      };
      company.sales ??= [];
      company.purchases ??= [];
      company.aliases ??= [];
      company.preferredCodes ??= {};
      return company;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException('Không tìm thấy công ty.');
      throw error;
    }
  }

  private async write(company: Company) {
    await fs.mkdir(this.dataDir, { recursive: true });
    const target = this.filePath(company.id);
    await fs.writeFile(`${target}.tmp`, JSON.stringify(company, null, 2), 'utf8');
    await fs.rename(`${target}.tmp`, target);
  }

  private filePath(id: string) {
    return path.join(this.dataDir, `${id}.json`);
  }
}

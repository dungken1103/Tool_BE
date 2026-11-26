import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { CompanyService } from './company.service';
import { AccountingRule, CatalogObject, CompanySettings, NameAlias } from './company.types';

@Controller('companies')
export class CompanyController {
  constructor(private readonly companyService: CompanyService) {}

  @Get()
  list() {
    return this.companyService.list();
  }

  @Post()
  create(@Body() body: { name: string }) {
    return this.companyService.create(body?.name);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.companyService.get(id);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() body: { name: string }) {
    return this.companyService.rename(id, body?.name);
  }

  @Post(':id/catalog/:kind')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }))
  importCatalog(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Vui lòng chọn file danh mục.');
    if (kind !== 'customers' && kind !== 'suppliers') throw new BadRequestException('Loại danh mục không hợp lệ.');
    return this.companyService.importCatalog(id, kind === 'customers' ? 'CUSTOMER' : 'SUPPLIER', file);
  }

  @Post(':id/ledger/:kind')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }))
  importLedger(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Vui lòng chọn file.');
    if (kind !== 'sales' && kind !== 'purchases') throw new BadRequestException('Loại sổ không hợp lệ.');
    return this.companyService.importLedger(id, kind === 'sales' ? 'SALES' : 'PURCHASES', file);
  }

  @Put(':id/preferred-codes')
  setPreferredCode(@Param('id') id: string, @Body() body: { nameKey: string; code: string }) {
    return this.companyService.setPreferredCode(id, body?.nameKey, body?.code);
  }

  @Put(':id/aliases')
  saveAliases(@Param('id') id: string, @Body() body: { aliases: NameAlias[] }) {
    return this.companyService.saveAliases(id, body?.aliases);
  }

  @Post(':id/objects')
  addObjects(@Param('id') id: string, @Body() body: { objects: CatalogObject[] }) {
    return this.companyService.addObjects(id, body?.objects);
  }

  @Put(':id/rules')
  saveRules(@Param('id') id: string, @Body() body: { rules: AccountingRule[] }) {
    return this.companyService.saveRules(id, body?.rules);
  }

  @Put(':id/settings')
  saveSettings(@Param('id') id: string, @Body() body: { settings: CompanySettings }) {
    return this.companyService.saveSettings(id, body?.settings);
  }
}

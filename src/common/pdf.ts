import { PDFDocument } from 'pdf-lib';

export interface PdfChunk {
  startPage: number;
  endPage: number;
  data: Buffer;
}

/** Tách PDF thành các file nhỏ, mỗi file `pagesPerChunk` trang (đánh số trang từ 1). */
export async function splitPdf(
  buffer: Buffer,
  pagesPerChunk: number,
): Promise<{ pageCount: number; chunks: PdfChunk[] }> {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pageCount = source.getPageCount();
  const chunks: PdfChunk[] = [];
  for (let start = 0; start < pageCount; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, pageCount);
    const target = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
    const pages = await target.copyPages(source, indices);
    pages.forEach((page) => target.addPage(page));
    chunks.push({ startPage: start + 1, endPage: end, data: Buffer.from(await target.save()) });
  }
  return { pageCount, chunks };
}

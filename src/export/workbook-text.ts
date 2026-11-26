import ExcelJS from 'exceljs';
import JSZip from 'jszip';

export const EXPORT_FONT = 'Arial';

const nfc = (value: string) => value.normalize('NFC');

/** Chữ tiếng Việt ở dạng tách dấu (e + ̂ + ̣) chuyển về dạng dựng sẵn ("ệ"), để không bị vẽ sai thành "ẹ" kèm dấu khác. */
function normalizeValue(value: ExcelJS.CellValue): ExcelJS.CellValue {
  if (typeof value === 'string') return nfc(value);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if ('richText' in value) return { ...value, richText: value.richText.map((part) => ({ ...part, text: nfc(part.text) })) };
    if ('formula' in value && typeof value.result === 'string') return { ...value, result: nfc(value.result) };
    if ('text' in value && 'hyperlink' in value) return { ...value, text: nfc(String(value.text)) };
  }
  return value;
}

/** Ghi workbook ra buffer với font mặc định của file (ô trống, ô gõ thêm sau này) là Arial thay vì Calibri. */
export async function writeWithArialDefault(workbook: ExcelJS.Workbook) {
  const zip = await JSZip.loadAsync(Buffer.from(await finalizeWorkbook(workbook).xlsx.writeBuffer()));
  const styles = await zip.file('xl/styles.xml')?.async('string');
  if (styles) zip.file('xl/styles.xml', styles.replace(/<name val="Calibri"\/>/g, `<name val="${EXPORT_FONT}"/>`).replace(/<scheme val="minor"\/>/g, ''));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Trước khi ghi file: mọi chữ về dạng dựng sẵn (NFC) và mọi ô dùng font Arial (giữ cỡ chữ, đậm, màu…). */
export function finalizeWorkbook(workbook: ExcelJS.Workbook) {
  for (const sheet of workbook.worksheets) {
    sheet.name = nfc(sheet.name);
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      sheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell) => {
        // Ô phụ của vùng gộp trỏ về ô chính: chỉ đặt font, không ghi lại giá trị.
        if (!cell.isMerged || cell.master === cell) {
          const normalized = normalizeValue(cell.value);
          if (normalized !== cell.value) cell.value = normalized;
        }
        cell.font = { ...(cell.font || {}), name: EXPORT_FONT };
      });
    }
  }
  return workbook;
}

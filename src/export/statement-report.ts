import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { parseVnDate } from '../common/values';
import { StatementReport } from './export.types';
import { EXPORT_FONT, writeWithArialDefault } from './workbook-text';

/*
 * Dựng file "Sao kê tài khoản" theo đúng bố cục file mẫu
 * THU MUC SAO KE/Sao_ke_tai_khoan_do gemini chuyen sang.xlsx:
 * sheet Sao_ke_chi_tiet (bảng giao dịch) + sheet Tong_hop_phan_tich (theo tháng, theo nhóm, biểu đồ).
 */

const DETAIL = 'Sao_ke_chi_tiet';
const SUMMARY = 'Tong_hop_phan_tich';
const FIRST_ROW = 12;

const font = (size: number, color: string, extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({
  name: EXPORT_FONT, size, color: { argb: `FF${color}` }, ...extra,
});
const FONT = {
  bank: font(12, '2C5282', { bold: true }),
  title: font(15, '1B365D', { bold: true }),
  label: font(11, '1A202C', { bold: true }),
  text: font(11, '1A202C'),
  accent: font(11, '1B365D', { bold: true }),
  note: font(11, '4A5568', { italic: true }),
  header: font(11, 'FFFFFF', { bold: true }),
  cardLabel: font(10, '4A5568', { bold: true }),
  cardValue: font(13, '1B365D', { bold: true }),
};

const fill = (color: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${color}` }, bgColor: { argb: `FF${color}` } });
const FILL = { grey: fill('EDF2F7'), navy: fill('1B365D'), stripe: fill('F7FAFC'), total: fill('EBF8FF'), blue: fill('2C5282') };

const line = (style: ExcelJS.BorderStyle, color: string): Partial<ExcelJS.Border> => ({ style, color: { argb: `FF${color}` } });
const THIN = line('thin', 'CBD5E0');
const BORDER: Record<string, Partial<ExcelJS.Borders>> = {
  grid: { left: THIN, right: THIN, top: THIN, bottom: THIN },
  header: { left: THIN, right: THIN, top: line('medium', '1B365D'), bottom: line('medium', '1B365D') },
  total: { left: THIN, right: THIN, top: THIN, bottom: line('double', '1B365D') },
  card: { left: line('medium', '1B365D'), right: THIN, top: THIN, bottom: THIN },
};

const MONEY = '#,##0';
const DATE = 'DD/MM/YYYY';
const PERCENT = '0.0%';

interface CellStyle {
  font?: Partial<ExcelJS.Font>;
  fill?: ExcelJS.Fill;
  border?: Partial<ExcelJS.Borders>;
  align?: 'left' | 'center' | 'right';
  numFmt?: string;
}

function put(sheet: ExcelJS.Worksheet, address: string, value: ExcelJS.CellValue, style: CellStyle) {
  const cell = sheet.getCell(address);
  cell.value = value;
  if (style.font) cell.font = style.font;
  if (style.fill) cell.fill = style.fill;
  if (style.border) cell.border = style.border;
  if (style.numFmt) cell.numFmt = style.numFmt;
  if (style.align) cell.alignment = { horizontal: style.align, vertical: 'middle', wrapText: true };
}

/** Ghi giá trị vào ô đầu, định dạng toàn vùng rồi gộp ô. */
function merged(sheet: ExcelJS.Worksheet, range: string, value: ExcelJS.CellValue, style: CellStyle, restStyle: CellStyle = style) {
  const [start, end] = range.split(':');
  const startCol = sheet.getCell(start).col;
  const endCol = sheet.getCell(end).col;
  const row = sheet.getCell(start).row;
  for (let col = startCol; col <= endCol; col += 1) {
    const address = sheet.getCell(row, col).address;
    put(sheet, address, col === startCol ? value : null, col === startCol ? style : restStyle);
  }
  sheet.mergeCells(range);
}

const formula = (text: string, result?: number | string): ExcelJS.CellFormulaValue => ({ formula: text, result });

const monthOf = (date: string) => {
  const parsed = parseVnDate(date);
  return parsed ? `${String(parsed.getUTCMonth() + 1).padStart(2, '0')}/${parsed.getUTCFullYear()}` : '';
};

export async function buildStatementReport(report: StatementReport) {
  const transactions = report.transactions;
  const last = FIRST_ROW + transactions.length - 1;
  const totalRow = last + 1;
  const opening = report.openingBalance ?? 0;
  const dates = transactions.map((item) => item.date).filter((date) => parseVnDate(date));
  const dataFrom = dates[0] || '';
  const dataTo = dates[dates.length - 1] || '';

  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = true;

  // ---------------- Sheet Sao_ke_chi_tiet ----------------
  const detail = workbook.addWorksheet(DETAIL, {
    views: [{ state: 'frozen', ySplit: 11, topLeftCell: 'A12', activeCell: 'A1' }],
  });
  [7, 14, 11, 18, 28, 20, 20, 22, 68].forEach((width, index) => (detail.getColumn(index + 1).width = width));

  const bankTitle = [report.bankName, report.branch && !/CHI NH[ÁA]NH/i.test(report.bankName || '') ? `CHI NHÁNH ${report.branch}` : '']
    .filter(Boolean)
    .join(' - ');
  merged(detail, 'A1:I1', bankTitle, { font: FONT.bank, align: 'left' });
  merged(detail, 'A2:I2', 'SAO KÊ TÀI KHOẢN CHI TIẾT (ACCOUNT STATEMENT)', { font: FONT.title, align: 'center' });

  const period = [report.periodFrom, report.periodTo].filter(Boolean).join(' - ');
  const infoRows: [string, string, string, string][] = [
    ['Tên tài khoản / Account name:', report.accountName, 'Ngày thực hiện / Date:', report.statementDate],
    ['Địa chỉ / Address:', report.address, 'Chi nhánh thực hiện / Branch:', report.branch],
    ['Số tài khoản / Account number:', report.accountNumber, 'Loại tiền / Currency:', report.currency],
    ['CIF:', report.cif, 'Kỳ sao kê / Period:', dataFrom ? `${period} (Dữ liệu phát sinh: ${dataFrom} - ${dataTo})` : period],
  ];
  infoRows.forEach(([leftLabel, leftValue, rightLabel, rightValue], index) => {
    const row = 4 + index;
    put(detail, `A${row}`, leftLabel, { font: FONT.label, align: 'left' });
    merged(detail, `B${row}:D${row}`, leftValue || '', { font: FONT.text, align: 'left' });
    merged(detail, `E${row}:F${row}`, rightLabel, { font: FONT.label, align: 'left' });
    merged(detail, `G${row}:I${row}`, rightValue || '', { font: FONT.text, align: 'left' });
  });

  merged(detail, 'A9:G9', 'SỐ DƯ ĐẦU KỲ (CARRIED BALANCE)',
    { font: FONT.accent, fill: FILL.grey, border: BORDER.grid, align: 'right' }, { border: BORDER.grid });
  put(detail, 'H9', report.openingBalance, { font: FONT.label, fill: FILL.grey, border: BORDER.grid, align: 'right', numFmt: MONEY });
  put(detail, 'I9', 'Số dư đầu kỳ theo sao kê gốc', { font: FONT.note, fill: FILL.grey, border: BORDER.grid, align: 'left' });

  const headers = [
    'STT', 'Ngày GD\n(TNX Date)', 'Tháng', 'Số CT\n(Doc No)', 'Phân loại GD\n(Category)', 'Số tiền ghi nợ\n(Debit / Chi)',
    'Số tiền ghi có\n(Credit / Thu)', 'Số dư tính toán\n(Calculated Balance)', 'Nội dung chi tiết\n(Transactions in detail)',
  ];
  headers.forEach((text, index) =>
    put(detail, detail.getCell(11, index + 1).address, text, { font: FONT.header, fill: FILL.navy, border: BORDER.header, align: 'center' }),
  );
  detail.getRow(11).height = 30;

  let balance = opening;
  transactions.forEach((transaction, index) => {
    const row = FIRST_ROW + index;
    const base: CellStyle = { font: FONT.text, border: BORDER.grid, fill: index % 2 ? FILL.stripe : undefined };
    const date = parseVnDate(transaction.date);
    balance = balance - (transaction.debit || 0) + (transaction.credit || 0);
    put(detail, `A${row}`, index + 1, { ...base, align: 'center', numFmt: MONEY });
    put(detail, `B${row}`, date ?? transaction.date, { ...base, align: 'center', numFmt: DATE });
    put(detail, `C${row}`, formula(`TEXT(B${row},"MM/YYYY")`, monthOf(transaction.date)), { ...base, align: 'center' });
    put(detail, `D${row}`, transaction.documentNo, { ...base, align: 'left' });
    put(detail, `E${row}`, transaction.category, { ...base, align: 'left' });
    put(detail, `F${row}`, transaction.debit, { ...base, align: 'right', numFmt: MONEY });
    put(detail, `G${row}`, transaction.credit, { ...base, align: 'right', numFmt: MONEY });
    put(detail, `H${row}`, formula(`H${index ? row - 1 : 9}-F${row}+G${row}`, balance), { ...base, font: FONT.label, align: 'right', numFmt: MONEY });
    put(detail, `I${row}`, transaction.description, { ...base, align: 'left' });
    detail.getRow(row).height = 24;
    detail.getCell(`E${row}`).dataValidation = {
      type: 'list', allowBlank: true, showErrorMessage: false, formulae: [`"${report.categories.join(',')}"`],
    };
  });

  const totalDebit = transactions.reduce((sum, item) => sum + (item.debit || 0), 0);
  const totalCredit = transactions.reduce((sum, item) => sum + (item.credit || 0), 0);
  const totalStyle: CellStyle = { font: FONT.accent, fill: FILL.total, border: BORDER.total, align: 'right', numFmt: MONEY };
  merged(detail, `A${totalRow}:E${totalRow}`, 'TỔNG CỘNG PHÁT SINH & SỐ DƯ CUỐI KỲ',
    { font: FONT.accent, fill: FILL.total, border: BORDER.total, align: 'right' }, { fill: FILL.total, border: BORDER.total });
  put(detail, `F${totalRow}`, formula(`SUM(F${FIRST_ROW}:F${last})`, totalDebit), totalStyle);
  put(detail, `G${totalRow}`, formula(`SUM(G${FIRST_ROW}:G${last})`, totalCredit), totalStyle);
  put(detail, `H${totalRow}`, formula(`H${last}`, balance), totalStyle);
  put(detail, `I${totalRow}`, formula(`"Tổng số giao dịch: " & COUNTA(A${FIRST_ROW}:A${last}) & " bút toán"`, `Tổng số giao dịch: ${transactions.length} bút toán`),
    { ...totalStyle, align: 'left', numFmt: undefined });
  detail.getRow(totalRow).height = 26;

  detail.autoFilter = `A11:I${last}`;
  detail.addConditionalFormatting({
    ref: `H${FIRST_ROW}:H${last}`,
    rules: [{
      type: 'cellIs', operator: 'lessThan', formulae: ['0'], priority: 1,
      style: { font: { name: EXPORT_FONT, size: 11, bold: true, color: { argb: 'FF742A2A' } }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFF5F5' } } },
    }],
  });

  // ---------------- Sheet Tong_hop_phan_tich ----------------
  const summary = workbook.addWorksheet(SUMMARY);
  [34, 15, 22, 15, 24, 22, 18, 22].forEach((width, index) => (summary.getColumn(index + 1).width = width));
  const detailRange = (col: string) => `${DETAIL}!$${col}$${FIRST_ROW}:$${col}$${last}`;

  merged(summary, 'A1:H1', 'BÁO CÁO TỔNG HỢP & PHÂN TÍCH DÒNG TIỀN SAO KÊ NGÂN HÀNG', { font: FONT.title, align: 'center' });
  const bankShort = /\(([^)]+)\)/.exec(report.bankName || '')?.[1] || report.bankName || '';
  const account = [report.accountNumber, [bankShort, report.branch].filter(Boolean).join(' ')].filter(Boolean).join(' - ');
  merged(summary, 'A2:H2', `Đơn vị: ${report.accountName || ''} | TK: ${account} | Dữ liệu: ${dataFrom} - ${dataTo}`, { font: FONT.note, align: 'center' });

  const cards: [string, string, string, number][] = [
    ['A', 'B', 'SỐ DƯ ĐẦU KỲ (VND)', opening],
    ['C', 'D', 'TỔNG PHÁT SINH GHI NỢ / CHI (VND)', totalDebit],
    ['E', 'F', 'TỔNG PHÁT SINH GHI CÓ / THU (VND)', totalCredit],
    ['G', 'H', 'SỐ DƯ CUỐI KỲ (VND)', balance],
  ];
  const cardFormulas = [`${DETAIL}!H9`, `${DETAIL}!F${totalRow}`, `${DETAIL}!G${totalRow}`, `${DETAIL}!H${totalRow}`];
  cards.forEach(([from, to, label, value], index) => {
    merged(summary, `${from}4:${to}4`, label, { font: FONT.cardLabel, fill: FILL.stripe, border: BORDER.card, align: 'center' }, { fill: FILL.stripe, border: BORDER.card });
    merged(summary, `${from}5:${to}5`, formula(cardFormulas[index], value),
      { font: FONT.cardValue, fill: FILL.stripe, border: BORDER.card, align: 'center', numFmt: MONEY }, { fill: FILL.stripe, border: BORDER.card });
  });
  summary.getRow(4).height = 20;
  summary.getRow(5).height = 28;

  // 1. Theo tháng
  put(summary, 'A8', '1. TỔNG HỢP DÒNG TIỀN THEO THÁNG', { font: FONT.accent });
  ['Tháng', 'Số bút toán', 'Tổng Ghi Nợ (Chi)', 'Tổng Ghi Có (Thu)', 'Chênh lệch ròng (Thu - Chi)', 'Số dư cuối tháng'].forEach((text, index) =>
    put(summary, summary.getCell(9, index + 1).address, text, { font: FONT.header, fill: FILL.navy, border: BORDER.header, align: 'center' }),
  );
  summary.getRow(9).height = 26;

  const months: string[] = [];
  transactions.forEach((item) => {
    const month = monthOf(item.date);
    if (month && !months.includes(month)) months.push(month);
  });
  const monthStart = 10;
  let runningBalance = opening;
  months.forEach((month, index) => {
    const row = monthStart + index;
    const rows = transactions.filter((item) => monthOf(item.date) === month);
    const debit = rows.reduce((sum, item) => sum + (item.debit || 0), 0);
    const credit = rows.reduce((sum, item) => sum + (item.credit || 0), 0);
    runningBalance += credit - debit;
    const base: CellStyle = { font: FONT.text, border: BORDER.grid, fill: index % 2 ? FILL.stripe : undefined };
    const money: CellStyle = { ...base, align: 'right', numFmt: MONEY };
    put(summary, `A${row}`, month, { ...base, align: 'center' });
    put(summary, `B${row}`, formula(`COUNTIF(${detailRange('C')}, A${row})`, rows.length), money);
    put(summary, `C${row}`, formula(`SUMIF(${detailRange('C')}, A${row}, ${detailRange('F')})`, debit), money);
    put(summary, `D${row}`, formula(`SUMIF(${detailRange('C')}, A${row}, ${detailRange('G')})`, credit), money);
    put(summary, `E${row}`, formula(`D${row}-C${row}`, credit - debit), money);
    put(summary, `F${row}`, formula(index ? `F${row - 1}+E${row}` : `${DETAIL}!$H$9+E${row}`, runningBalance), money);
    summary.getRow(row).height = 22;
  });
  const monthEnd = monthStart + months.length - 1;
  const monthTotal = monthEnd + 1;
  const sumStyle: CellStyle = { font: FONT.accent, fill: FILL.total, border: BORDER.total, align: 'right', numFmt: MONEY };
  put(summary, `A${monthTotal}`, 'Tổng cộng', { font: FONT.accent, fill: FILL.total, border: BORDER.total, align: 'center' });
  put(summary, `B${monthTotal}`, formula(`SUM(B${monthStart}:B${monthEnd})`, transactions.length), sumStyle);
  put(summary, `C${monthTotal}`, formula(`SUM(C${monthStart}:C${monthEnd})`, totalDebit), sumStyle);
  put(summary, `D${monthTotal}`, formula(`SUM(D${monthStart}:D${monthEnd})`, totalCredit), sumStyle);
  put(summary, `E${monthTotal}`, formula(`SUM(E${monthStart}:E${monthEnd})`, totalCredit - totalDebit), sumStyle);
  put(summary, `F${monthTotal}`, formula(`F${monthEnd}`, runningBalance), sumStyle);
  summary.getRow(monthTotal).height = 24;

  // 2. Theo nhóm nội dung
  const groupTitle = monthTotal + 3;
  const groupHeader = groupTitle + 1;
  const groupStart = groupHeader + 1;
  const groupEnd = groupStart + report.categories.length - 1;
  const groupTotal = groupEnd + 1;
  put(summary, `A${groupTitle}`, '2. TỔNG HỢP THEO NHÓM NỘI DUNG GIAO DỊCH', { font: FONT.accent });
  ['Nhóm nội dung giao dịch', 'Số bút toán', 'Tổng Ghi Nợ (Chi)', 'Tỷ trọng Chi', 'Tổng Ghi Có (Thu)', 'Tỷ trọng Thu'].forEach((text, index) =>
    put(summary, summary.getCell(groupHeader, index + 1).address, text, { font: FONT.header, fill: FILL.blue, border: BORDER.header, align: 'center' }),
  );
  summary.getRow(groupHeader).height = 26;
  report.categories.forEach((category, index) => {
    const row = groupStart + index;
    const rows = transactions.filter((item) => item.category === category);
    const debit = rows.reduce((sum, item) => sum + (item.debit || 0), 0);
    const credit = rows.reduce((sum, item) => sum + (item.credit || 0), 0);
    const base: CellStyle = { font: FONT.text, border: BORDER.grid, fill: index % 2 ? FILL.stripe : undefined };
    const money: CellStyle = { ...base, align: 'right', numFmt: MONEY };
    const percent: CellStyle = { ...base, align: 'right', numFmt: PERCENT };
    put(summary, `A${row}`, category, { ...base, align: 'left' });
    put(summary, `B${row}`, formula(`COUNTIF(${detailRange('E')}, A${row})`, rows.length), money);
    put(summary, `C${row}`, formula(`SUMIF(${detailRange('E')}, A${row}, ${detailRange('F')})`, debit), money);
    put(summary, `D${row}`, formula(`IF($C$${groupTotal}>0, C${row}/$C$${groupTotal}, 0)`, totalDebit ? debit / totalDebit : 0), percent);
    put(summary, `E${row}`, formula(`SUMIF(${detailRange('E')}, A${row}, ${detailRange('G')})`, credit), money);
    put(summary, `F${row}`, formula(`IF($E$${groupTotal}>0, E${row}/$E$${groupTotal}, 0)`, totalCredit ? credit / totalCredit : 0), percent);
    summary.getRow(row).height = 22;
  });
  const categorized = transactions.filter((item) => report.categories.includes(item.category));
  const categorizedDebit = categorized.reduce((sum, item) => sum + (item.debit || 0), 0);
  const categorizedCredit = categorized.reduce((sum, item) => sum + (item.credit || 0), 0);
  put(summary, `A${groupTotal}`, 'Tổng cộng', { font: FONT.accent, fill: FILL.total, border: BORDER.total, align: 'left' });
  put(summary, `B${groupTotal}`, formula(`SUM(B${groupStart}:B${groupEnd})`, categorized.length), sumStyle);
  put(summary, `C${groupTotal}`, formula(`SUM(C${groupStart}:C${groupEnd})`, categorizedDebit), sumStyle);
  put(summary, `D${groupTotal}`, formula(`SUM(D${groupStart}:D${groupEnd})`, categorizedDebit ? 1 : 0), { ...sumStyle, numFmt: PERCENT });
  put(summary, `E${groupTotal}`, formula(`SUM(E${groupStart}:E${groupEnd})`, categorizedCredit), sumStyle);
  put(summary, `F${groupTotal}`, formula(`SUM(F${groupStart}:F${groupEnd})`, categorizedCredit ? 1 : 0), { ...sumStyle, numFmt: PERCENT });
  summary.getRow(groupTotal).height = 24;

  const buffer = await writeWithArialDefault(workbook);
  return months.length ? addMonthlyChart(buffer, monthStart, monthEnd) : buffer;
}

/** ExcelJS không ghi được biểu đồ: chèn biểu đồ cột Ghi Nợ / Ghi Có theo tháng vào sheet 2 như file mẫu. */
async function addMonthlyChart(buffer: Buffer, monthStart: number, monthEnd: number) {
  const zip = await JSZip.loadAsync(buffer);
  const sheetPath = 'xl/worksheets/sheet2.xml';
  const relsPath = 'xl/worksheets/_rels/sheet2.xml.rels';
  const relId = 'rIdMonthlyChart';
  const range = (col: string) => `'${SUMMARY}'!$${col}$${monthStart}:$${col}$${monthEnd}`;
  const series = (index: number, col: string, color: string) => `
      <c:ser><c:idx val="${index}"/><c:order val="${index}"/>
        <c:tx><c:strRef><c:f>'${SUMMARY}'!$${col}$9</c:f></c:strRef></c:tx>
        <c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr>
        <c:invertIfNegative val="0"/>
        <c:cat><c:strRef><c:f>${range('A')}</c:f></c:strRef></c:cat>
        <c:val><c:numRef><c:f>${range(col)}</c:f></c:numRef></c:val>
      </c:ser>`;
  const axisTitle = (text: string) =>
    `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;

  zip.file('xl/charts/chart1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:roundedCorners val="0"/><c:style val="10"/>
  <c:chart>
    ${axisTitle('Biến động Ghi Nợ (Chi) &amp; Ghi Có (Thu) theo Tháng')}
    <c:autoTitleDeleted val="0"/>
    <c:plotArea><c:layout/>
      <c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series(0, 'C', '1B365D')}${series(1, 'D', '2B6CB0')}
        <c:gapWidth val="150"/><c:overlap val="-15"/><c:axId val="10"/><c:axId val="100"/>
      </c:barChart>
      <c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${axisTitle('Tháng')}
        <c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="100"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>
      <c:valAx><c:axId val="100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/>${axisTitle('Số tiền (VND)')}
        <c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="10"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>
    <c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>
  </c:chart>
</c:chartSpace>`);

  zip.file('xl/drawings/drawing1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <xdr:oneCellAnchor>
    <xdr:from><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:ext cx="5760000" cy="3600000"/>
    <xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:oneCellAnchor>
</xdr:wsDr>`);
  zip.file('xl/drawings/_rels/drawing1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`);

  const drawingRel = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>`;
  const existingRels = await zip.file(relsPath)?.async('string');
  zip.file(relsPath, existingRels
    ? existingRels.replace('</Relationships>', `${drawingRel}</Relationships>`)
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRel}</Relationships>`);

  // <drawing> phải đứng trước legacyDrawing / tableParts / extLst theo thứ tự của chuẩn OOXML.
  const sheetXml = await zip.file(sheetPath)!.async('string');
  const drawingTag = `<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${relId}"/>`;
  const anchor = /<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/.exec(sheetXml)!;
  zip.file(sheetPath, sheetXml.slice(0, anchor.index) + drawingTag + sheetXml.slice(anchor.index));

  const types = await zip.file('[Content_Types].xml')!.async('string');
  zip.file('[Content_Types].xml', types.replace('</Types>',
    '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>' +
    '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

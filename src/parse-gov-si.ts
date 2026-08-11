/**
 * Deterministic GOV.SI regulated fuel-price parser (SoT).
 * Mirror into workflows/si-scrape-regulated-prices.ts Code node when changing.
 *
 * Source: https://www.gov.si/teme/cene-naftnih-derivatov/
 */

export type PricePeriod = {
  from: string; // YYYY-MM-DD
  to: string;
  petrol: number;
  diesel: number;
};

export type SelectedPeriods = {
  today: string;
  current: PricePeriod;
  next: PricePeriod | null;
  periods: PricePeriod[];
};

const SOURCE_URL = 'https://www.gov.si/teme/cene-naftnih-derivatov/';

const PERIOD_RE =
  /od\s+(\d{1,2})\.\s+(\d{1,2})\.(?:\s+(\d{4}))?\s+do\s+(\d{1,2})\.\s+(\d{1,2})\.\s+(\d{4})/i;

const PRICE_RE = /(\d+),(\d+)/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Calendar date in Europe/Ljubljana (YYYY-MM-DD). */
export function todayLjubljana(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Ljubljana',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function parseSiPrice(cell: string): number | null {
  const m = cell.replace(/\s/g, '').match(PRICE_RE);
  if (!m) return null;
  return Number(`${m[1]}.${m[2]}`);
}

function parseValidity(cell: string): { from: string; to: string } | null {
  const m = cell.replace(/\u00a0/g, ' ').match(PERIOD_RE);
  if (!m) return null;
  const fromDay = Number(m[1]);
  const fromMonth = Number(m[2]);
  const toDay = Number(m[4]);
  const toMonth = Number(m[5]);
  const toYear = Number(m[6]);
  let fromYear = m[3] ? Number(m[3]) : toYear;
  if (!m[3] && fromMonth > toMonth) {
    fromYear = toYear - 1;
  }
  return {
    from: isoDate(fromYear, fromMonth, fromDay),
    to: isoDate(toYear, toMonth, toDay),
  };
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTables(html: string): string[] {
  const tables: string[] = [];
  const re = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    tables.push(m[0]);
  }
  return tables;
}

function isNmbDieselTable(tableHtml: string): boolean {
  const head = tableHtml.slice(0, 1500).toLowerCase();
  const hasNmb = head.includes('nmb');
  const hasDiesel = head.includes('dizel');
  const hasKoelOnly =
    head.includes('koel') && !hasNmb && !hasDiesel;
  return hasNmb && hasDiesel && !hasKoelOnly;
}

function parseRowCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const re = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml)) !== null) {
    cells.push(stripTags(m[1]));
  }
  return cells;
}

/** Extract NMB-95 / diesel validity periods from GOV.SI HTML. */
export function parseGovSiPeriods(html: string): PricePeriod[] {
  const table = extractTables(html).find(isNmbDieselTable);
  if (!table) {
    throw new Error('GOV.SI: NMB-95/diesel validity table not found');
  }

  const periods: PricePeriod[] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(table)) !== null) {
    const cells = parseRowCells(rowMatch[1]);
    if (cells.length < 3) continue;
    if (/datum\s+veljavnosti/i.test(cells[0])) continue;

    const range = parseValidity(cells[0]);
    const petrol = parseSiPrice(cells[1]);
    const diesel = parseSiPrice(cells[2]);
    if (!range || petrol === null || diesel === null) continue;

    periods.push({
      from: range.from,
      to: range.to,
      petrol,
      diesel,
    });
  }

  if (periods.length === 0) {
    throw new Error('GOV.SI: no NMB-95/diesel periods parsed');
  }

  periods.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return periods;
}

/** Pick current (today in [from,to]) and next (earliest from > today). */
export function selectCurrentAndNext(
  periods: PricePeriod[],
  today: string = todayLjubljana(),
): SelectedPeriods {
  const current = periods.find((p) => p.from <= today && today <= p.to);
  if (!current) {
    throw new Error(`GOV.SI: no period covers today ${today}`);
  }
  const next =
    periods
      .filter((p) => p.from > today)
      .sort((a, b) => (a.from < b.from ? -1 : 1))[0] ?? null;

  return { today, current, next, periods };
}

export function parseGovSi(html: string, today?: string): SelectedPeriods {
  return selectCurrentAndNext(parseGovSiPeriods(html), today ?? todayLjubljana());
}

export { SOURCE_URL };

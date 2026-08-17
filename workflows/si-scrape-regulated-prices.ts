import {
  workflow,
  node,
  trigger,
  sticky,
  newCredential,
  ifElse,
  expr,
} from '@n8n/workflow-sdk';

/**
 * CF – SI Scrape regulated prices
 *
 * SoT for parse logic: src/parse-gov-si.ts — keep jsCode below in sync.
 *
 * scheduleTrigger v1.3 has no timezone parameter; times resolve against the
 * workflow timezone (Europe/Ljubljana). Daily 18:00 always scrapes. Monday
 * hourly 09–17 & 19–21 skips GOV.SI once next_* is already in Neon.
 *
 * Postgres: Neon Postgres Carburanti FVG (sbf6GBft9YYQNdqi)
 * Revalidate: httpBearerAuth "CarburantiFVG Revalidate" = REVALIDATE_SECRET
 *   POST https://carburantifvg.it/api/revalidate  { tags: ["regulated-prices"] }
 *   Only runs when upsert RETURNING has rows (price/date fields actually changed).
 */

const SOURCE_URL = 'https://www.gov.si/teme/cene-naftnih-derivatov/';

// Mirrored from src/parse-gov-si.ts (n8n Code sandbox cannot import this repo).
const PARSE_JS_CODE = `
const SOURCE_URL = '${SOURCE_URL}';
const PERIOD_RE = /od\\s+(\\d{1,2})\\.\\s+(\\d{1,2})\\.(?:\\s+(\\d{4}))?\\s+do\\s+(\\d{1,2})\\.\\s+(\\d{1,2})\\.\\s+(\\d{4})/i;
const PRICE_RE = /(\\d+),(\\d+)/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDate(year, month, day) {
  return year + '-' + pad2(month) + '-' + pad2(day);
}

function todayLjubljana(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Ljubljana',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now || new Date());
}

function parseSiPrice(cell) {
  const m = String(cell).replace(/\\s/g, '').match(PRICE_RE);
  if (!m) return null;
  return Number(m[1] + '.' + m[2]);
}

function parseValidity(cell) {
  const m = String(cell).replace(/\\u00a0/g, ' ').match(PERIOD_RE);
  if (!m) return null;
  const fromDay = Number(m[1]);
  const fromMonth = Number(m[2]);
  const toDay = Number(m[4]);
  const toMonth = Number(m[5]);
  const toYear = Number(m[6]);
  let fromYear = m[3] ? Number(m[3]) : toYear;
  if (!m[3] && fromMonth > toMonth) fromYear = toYear - 1;
  return { from: isoDate(fromYear, fromMonth, fromDay), to: isoDate(toYear, toMonth, toDay) };
}

function stripTags(html) {
  return String(html)
    .replace(/<script[\\s\\S]*?<\\/script>/gi, '')
    .replace(/<style[\\s\\S]*?<\\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function extractTables(html) {
  const tables = [];
  const re = /<table\\b[^>]*>[\\s\\S]*?<\\/table>/gi;
  let m;
  while ((m = re.exec(html)) !== null) tables.push(m[0]);
  return tables;
}

function isNmbDieselTable(tableHtml) {
  const head = tableHtml.slice(0, 1500).toLowerCase();
  return head.includes('nmb') && head.includes('dizel') && !(head.includes('koel') && !head.includes('nmb'));
}

function parseRowCells(rowHtml) {
  const cells = [];
  const re = /<t[dh]\\b[^>]*>([\\s\\S]*?)<\\/t[dh]>/gi;
  let m;
  while ((m = re.exec(rowHtml)) !== null) cells.push(stripTags(m[1]));
  return cells;
}

function parseGovSiPeriods(html) {
  const table = extractTables(html).find(isNmbDieselTable);
  if (!table) throw new Error('GOV.SI: NMB-95/diesel validity table not found');
  const periods = [];
  const rowRe = /<tr\\b[^>]*>([\\s\\S]*?)<\\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(table)) !== null) {
    const cells = parseRowCells(rowMatch[1]);
    if (cells.length < 3) continue;
    if (/datum\\s+veljavnosti/i.test(cells[0])) continue;
    const range = parseValidity(cells[0]);
    const petrol = parseSiPrice(cells[1]);
    const diesel = parseSiPrice(cells[2]);
    if (!range || petrol === null || diesel === null) continue;
    periods.push({ from: range.from, to: range.to, petrol, diesel });
  }
  if (periods.length === 0) throw new Error('GOV.SI: no NMB-95/diesel periods parsed');
  periods.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return periods;
}

function selectCurrentAndNext(periods, today) {
  const current = periods.find((p) => p.from <= today && today <= p.to);
  if (!current) throw new Error('GOV.SI: no period covers today ' + today);
  const future = periods.filter((p) => p.from > today).sort((a, b) => (a.from < b.from ? -1 : 1));
  return { today, current, next: future[0] || null, periods };
}

const htmlItem = $input.first().json;
const html =
  typeof htmlItem === 'string'
    ? htmlItem
    : htmlItem.data || htmlItem.body || htmlItem.html || '';
if (!html || typeof html !== 'string') {
  throw new Error('Expected HTML string from Fetch GOV.SI (data/body)');
}

const regimeId = Number($('Get Regime Id').first().json.id);
if (!Number.isFinite(regimeId)) {
  throw new Error('Missing regulated_price_regimes.id for SLO off_motorway');
}

const selected = selectCurrentAndNext(parseGovSiPeriods(html), todayLjubljana());
const retrievedAt = new Date().toISOString();

function rowForFuel(fuelId, priceKey) {
  return {
    json: {
      country_id: 0,
      regime_id: regimeId,
      fuel_id: fuelId,
      current_reference: selected.current[priceKey],
      current_effective_from: selected.current.from,
      next_reference: selected.next ? selected.next[priceKey] : null,
      next_effective_from: selected.next ? selected.next.from : null,
      source_url: SOURCE_URL,
      source_retrieved_at: retrievedAt,
      today: selected.today,
    },
  };
}

return [rowForFuel(0, 'petrol'), rowForFuel(1, 'diesel')];
`.trim();

const dailySchedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Daily 18:00 Ljubljana',
    parameters: {
      rule: {
        interval: [
          {
            field: 'days',
            daysInterval: 1,
            triggerAtHour: 18,
            triggerAtMinute: 0,
          },
        ],
      },
    },
    position: [220, 300],
  },
  output: [{}],
});

const mondayHourly = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Monday hourly Ljubljana',
    parameters: {
      rule: {
        interval: [
          {
            field: 'cronExpression',
            expression: '0 9-17,19-21 * * 1',
          },
        ],
      },
    },
    position: [220, 540],
  },
  output: [{}],
});

const checkNextPublished = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Check Next Published',
    parameters: {
      operation: 'executeQuery',
      query:
        'SELECT EXISTS (\n' +
        '  SELECT 1\n' +
        '  FROM regulated_prices rp\n' +
        '  JOIN regulated_price_regimes r ON r.id = rp.regime_id\n' +
        "  WHERE rp.country_id = 0\n" +
        "    AND r.code = 'off_motorway'\n" +
        '    AND rp.next_reference IS NOT NULL\n' +
        ') AS already_announced;',
    },
    credentials: {
      postgres: newCredential('Neon Postgres Carburanti FVG'),
    },
    position: [460, 540],
  },
  output: [{ already_announced: false }],
});

const alreadyAnnounced = ifElse({
  version: 2.3,
  config: {
    name: 'Already Announced?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'loose',
          version: 2,
        },
        conditions: [
          {
            id: 'announced',
            leftValue: expr('{{ $json.already_announced }}'),
            operator: { type: 'boolean', operation: 'equals' },
            rightValue: true,
          },
        ],
      },
    },
    position: [700, 540],
  },
});

const getRegimeId = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Get Regime Id',
    parameters: {
      operation: 'executeQuery',
      query:
        "SELECT id FROM regulated_price_regimes WHERE country_id = 0 AND code = 'off_motorway' LIMIT 1;",
    },
    credentials: {
      postgres: newCredential('Neon Postgres Carburanti FVG'),
    },
    position: [460, 300],
  },
  output: [{ id: 1 }],
});

const fetchGovSi = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch GOV.SI',
    parameters: {
      method: 'GET',
      url: SOURCE_URL,
      options: {
        response: {
          response: {
            responseFormat: 'text',
            outputPropertyName: 'data',
          },
        },
        timeout: 30000,
      },
    },
    position: [700, 300],
  },
  output: [{ data: '<table><!-- NMB 95 / dizel --></table>' }],
});

const parsePeriods = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Periods',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: PARSE_JS_CODE,
    },
    position: [940, 300],
  },
  output: [
    {
      country_id: 0,
      regime_id: 1,
      fuel_id: 0,
      current_reference: 1.519,
      current_effective_from: '2026-08-11',
      next_reference: null,
      next_effective_from: null,
      source_url: SOURCE_URL,
      source_retrieved_at: '2026-08-11T16:00:00.000Z',
      today: '2026-08-11',
    },
    {
      country_id: 0,
      regime_id: 1,
      fuel_id: 1,
      current_reference: 1.753,
      current_effective_from: '2026-08-11',
      next_reference: null,
      next_effective_from: null,
      source_url: SOURCE_URL,
      source_retrieved_at: '2026-08-11T16:00:00.000Z',
      today: '2026-08-11',
    },
  ],
});

const upsertPrices = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Upsert Regulated Prices',
    parameters: {
      operation: 'executeQuery',
      query:
        'INSERT INTO regulated_prices (\n' +
        '  country_id, regime_id, fuel_id,\n' +
        '  current_reference, current_effective_from,\n' +
        '  next_reference, next_effective_from,\n' +
        '  currency, unit, source_url, source_retrieved_at, updated_at\n' +
        ') VALUES (\n' +
        '  $1::int, $2::int, $3::int,\n' +
        '  $4::numeric, $5::date,\n' +
        // ::text first — pg-promise inlines $n literals, so a bare NULLIF($6, '')
        // resolves to numeric once next_reference is a real number and ''::numeric fails.
        "  NULLIF($6::text, '')::numeric, NULLIF($7::text, '')::date,\n" +
        "  'EUR', 'EUR/L', $8, $9::timestamptz, now()\n" +
        ')\n' +
        'ON CONFLICT (country_id, regime_id, fuel_id) DO UPDATE SET\n' +
        '  current_reference = EXCLUDED.current_reference,\n' +
        '  current_effective_from = EXCLUDED.current_effective_from,\n' +
        '  next_reference = EXCLUDED.next_reference,\n' +
        '  next_effective_from = EXCLUDED.next_effective_from,\n' +
        '  source_url = EXCLUDED.source_url,\n' +
        '  source_retrieved_at = EXCLUDED.source_retrieved_at,\n' +
        '  updated_at = now()\n' +
        'WHERE regulated_prices.current_reference IS DISTINCT FROM EXCLUDED.current_reference\n' +
        '   OR regulated_prices.current_effective_from IS DISTINCT FROM EXCLUDED.current_effective_from\n' +
        '   OR regulated_prices.next_reference IS DISTINCT FROM EXCLUDED.next_reference\n' +
        '   OR regulated_prices.next_effective_from IS DISTINCT FROM EXCLUDED.next_effective_from\n' +
        'RETURNING *;',
      options: {
        // Pass array (not join) — empty next_* must not collapse $n slots.
        queryReplacement: expr(
          '={{ [\n' +
            '  $json.country_id,\n' +
            '  $json.regime_id,\n' +
            '  $json.fuel_id,\n' +
            '  $json.current_reference,\n' +
            '  $json.current_effective_from,\n' +
            '  $json.next_reference ?? "",\n' +
            '  $json.next_effective_from ?? "",\n' +
            '  $json.source_url,\n' +
            '  $json.source_retrieved_at\n' +
            '] }}',
        ),
      },
    },
    credentials: {
      postgres: newCredential('Neon Postgres Carburanti FVG'),
    },
    position: [1180, 300],
  },
  output: [
    {
      country_id: 0,
      regime_id: 1,
      fuel_id: 0,
      current_reference: '1.5190',
      current_effective_from: '2026-08-11',
      next_reference: null,
      next_effective_from: null,
    },
  ],
});

// Collapses 1–2 RETURNING rows into one item so revalidate fires once.
// 0 RETURNING rows (no price change) → Aggregate skipped → no revalidate.
const aggregateChanged = node({
  type: 'n8n-nodes-base.aggregate',
  version: 1,
  config: {
    name: 'Aggregate Changed Rows',
    parameters: {
      aggregate: 'aggregateAllItemData',
      destinationFieldName: 'changed',
      include: 'allFields',
    },
    position: [1420, 300],
  },
  output: [{ changed: [{ fuel_id: 0 }] }],
});

const revalidateCache = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Revalidate regulated-prices',
    parameters: {
      method: 'POST',
      url: 'https://carburantifvg.it/api/revalidate',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBearerAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: { tags: ['regulated-prices'] },
      options: {
        timeout: 30000,
        response: {
          response: {
            neverError: true,
          },
        },
      },
    },
    credentials: {
      httpBearerAuth: newCredential('CarburantiFVG Revalidate'),
    },
    position: [1660, 300],
  },
  output: [{ revalidated: true }],
});

const note = sticky(
  '## SI scrape\n' +
    '- Daily **18:00 Europe/Ljubljana** (always fetch)\n' +
    '- Monday **09–17 & 19–21** hourly until `next_*` is set, then skip HTTP\n' +
    '- Parser SoT: `src/parse-gov-si.ts` (mirrored in Parse Periods)\n' +
    '- Postgres: `Neon Postgres Carburanti FVG`\n' +
    '- After real price/date change → POST `/api/revalidate` tag `regulated-prices`',
  [dailySchedule, revalidateCache],
  { color: 4 },
);

export default workflow(
  'cf-si-scrape-regulated-prices',
  'CF – SI Scrape regulated prices',
)
  .add(dailySchedule)
  .to(getRegimeId)
  .to(fetchGovSi)
  .to(parsePeriods)
  .to(upsertPrices)
  .to(aggregateChanged)
  .to(revalidateCache)
  .add(mondayHourly)
  .to(checkNextPublished)
  .to(alreadyAnnounced.onFalse!(getRegimeId))
  .add(note);

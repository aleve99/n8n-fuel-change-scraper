import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseGovSi, parseGovSiPeriods } from './parse-gov-si.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(__dirname, '../fixtures/gov-si-nmb-diesel.html'),
  'utf8',
);

describe('parseGovSiPeriods', () => {
  it('parses NMB-95 / diesel table from fixture', () => {
    const periods = parseGovSiPeriods(fixture);
    assert.ok(periods.length > 10);
    assert.deepEqual(periods.find((p) => p.from === '2026-08-11'), {
      from: '2026-08-11',
      to: '2026-08-17',
      petrol: 1.519,
      diesel: 1.753,
    });
  });

  it('handles year-crossing validity strings', () => {
    // Re-export not needed — exercise via full HTML row shape in select
    const periods = parseGovSiPeriods(`
      <table>
        <thead><tr>
          <th>Datum veljavnosti</th>
          <th>Maloprodajna cena NMB 95 (evro/liter)</th>
          <th>Maloprodajna cena dizel goriva (evro/liter)</th>
        </tr></thead>
        <tbody>
          <tr>
            <td>od 30. 12. 2025 do 12. 1. 2026</td>
            <td>1,381</td>
            <td>1,407</td>
          </tr>
        </tbody>
      </table>
    `);
    assert.deepEqual(periods[0], {
      from: '2025-12-30',
      to: '2026-01-12',
      petrol: 1.381,
      diesel: 1.407,
    });
  });
});

describe('parseGovSi select current/next', () => {
  it('current window on 2026-08-11 is petrol 1.519 / diesel 1.753', () => {
    const selected = parseGovSi(fixture, '2026-08-11');
    assert.equal(selected.today, '2026-08-11');
    assert.deepEqual(selected.current, {
      from: '2026-08-11',
      to: '2026-08-17',
      petrol: 1.519,
      diesel: 1.753,
    });
    assert.equal(selected.next, null);
  });

  it('picks earliest future period as next when present', () => {
    const html = `
      <table>
        <thead><tr>
          <th>Datum veljavnosti</th>
          <th>NMB 95</th>
          <th>dizel</th>
        </tr></thead>
        <tbody>
          <tr><td>od 18. 8. do 24. 8. 2026</td><td>1,500</td><td>1,700</td></tr>
          <tr><td>od 11. 8. do 17. 8. 2026</td><td>1,519</td><td>1,753</td></tr>
          <tr><td>od 25. 8. do 31. 8. 2026</td><td>1,510</td><td>1,710</td></tr>
        </tbody>
      </table>
    `;
    const selected = parseGovSi(html, '2026-08-11');
    assert.deepEqual(selected.next, {
      from: '2026-08-18',
      to: '2026-08-24',
      petrol: 1.5,
      diesel: 1.7,
    });
  });
});

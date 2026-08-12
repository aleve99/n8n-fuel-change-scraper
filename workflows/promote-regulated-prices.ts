import {
  workflow,
  node,
  trigger,
  sticky,
  newCredential,
} from '@n8n/workflow-sdk';

/**
 * CF – Promote regulated prices
 *
 * Rolls next_* → current_* when next_effective_from <= CURRENT_DATE.
 * Country-agnostic; scrape owns discovering next_*.
 *
 * Postgres: Neon Postgres Carburanti FVG (sbf6GBft9YYQNdqi)
 * On actual promote (RETURNING rows) → revalidate tag regulated-prices
 * Bearer: CarburantiFVG Revalidate (= REVALIDATE_SECRET)
 */

const dailySchedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Daily 00:05 Ljubljana',
    parameters: {
      rule: {
        interval: [
          {
            field: 'days',
            daysInterval: 1,
            triggerAtHour: 0,
            triggerAtMinute: 5,
          },
        ],
      },
      timezone: 'Europe/Ljubljana',
    },
    position: [220, 300],
  },
  output: [{}],
});

const promoteNext = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Promote Next References',
    parameters: {
      operation: 'executeQuery',
      query:
        'UPDATE regulated_prices\n' +
        'SET\n' +
        '  current_reference = next_reference,\n' +
        '  current_effective_from = next_effective_from,\n' +
        '  next_reference = NULL,\n' +
        '  next_effective_from = NULL,\n' +
        '  updated_at = now()\n' +
        'WHERE next_reference IS NOT NULL\n' +
        '  AND next_effective_from <= CURRENT_DATE\n' +
        'RETURNING country_id, regime_id, fuel_id, current_reference, current_effective_from;',
    },
    credentials: {
      postgres: newCredential('Neon Postgres Carburanti FVG'),
    },
    position: [520, 300],
  },
  output: [],
});

const aggregatePromoted = node({
  type: 'n8n-nodes-base.aggregate',
  version: 1,
  config: {
    name: 'Aggregate Promoted Rows',
    parameters: {
      aggregate: 'aggregateAllItemData',
      destinationFieldName: 'promoted',
      include: 'allFields',
    },
    position: [760, 300],
  },
  output: [{ promoted: [{ fuel_id: 0 }] }],
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
    position: [1000, 300],
  },
  output: [{ revalidated: true }],
});

const note = sticky(
  '## Promote\n' +
    '- Schedule: daily **00:05 Europe/Ljubljana**\n' +
    '- No-op when no due `next_*` rows (skips revalidate)\n' +
    '- On promote → POST `/api/revalidate` tag `regulated-prices`\n' +
    '- Bearer: `CarburantiFVG Revalidate`',
  [dailySchedule, revalidateCache],
  { color: 5 },
);

export default workflow(
  'cf-promote-regulated-prices',
  'CF – Promote regulated prices',
)
  .add(dailySchedule)
  .to(promoteNext)
  .to(aggregatePromoted)
  .to(revalidateCache)
  .add(note);

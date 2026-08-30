/**
 * Connectivity and data check. Verifies the token, both board IDs, column
 * resolution and normalisation without starting the web app.
 *
 *   npx tsx scripts/check-monday.ts
 */

import { MondayClient } from '../src/lib/monday/client';
import { fetchBoard } from '../src/lib/monday/fetch';
import { normalizeDeals, normalizeWorkOrders } from '../src/lib/normalize';
import { pipelineMetrics, operationalMetrics } from '../src/lib/analytics';

async function main() {
  const token = process.env.MONDAY_API_TOKEN?.trim();
  const dealsId = process.env.MONDAY_DEALS_BOARD_ID?.trim();
  const woId = process.env.MONDAY_WORK_ORDERS_BOARD_ID?.trim();

  const missing = [
    !token && 'MONDAY_API_TOKEN',
    !dealsId && 'MONDAY_DEALS_BOARD_ID',
    !woId && 'MONDAY_WORK_ORDERS_BOARD_ID',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const client = new MondayClient({ token: token!, apiVersion: '2024-10' });

  console.log('Fetching boards…\n');
  const [dealsBoard, woBoard] = await Promise.all([
    fetchBoard(client, dealsId!),
    fetchBoard(client, woId!),
  ]);

  const deals = normalizeDeals(dealsBoard);
  const wos = normalizeWorkOrders(woBoard);

  for (const [label, ds] of [['DEALS', deals.quality], ['WORK ORDERS', wos.quality]] as const) {
    console.log(`${label}  (board ${ds.boardId})`);
    console.log(`  items fetched      ${ds.totalItemsFetched}`);
    console.log(`  header rows        ${ds.headerRowsDropped}`);
    console.log(`  duplicates         ${ds.duplicateRowsDropped}`);
    console.log(`  usable records     ${ds.usableRecords}`);
    if (ds.unresolvedColumns.length) console.log(`  UNRESOLVED         ${ds.unresolvedColumns.join(', ')}`);
    if (ds.unmappedColumns.length) console.log(`  unmapped columns   ${ds.unmappedColumns.length}`);
    console.log('  least complete fields:');
    for (const f of ds.fields.slice(0, 5)) {
      console.log(`    ${f.completeness.toFixed(1).padStart(5)}%  ${f.field}`);
    }
    console.log('');
  }

  const p = pipelineMetrics(deals.deals);
  const o = operationalMetrics(wos.workOrders);
  console.log('SANITY METRICS (all time)');
  console.log(`  open deals         ${p.openDeals}`);
  console.log(`  open pipeline      ${p.openPipelineValue.toLocaleString('en-IN')}`);
  console.log(`     covering        ${p.openPipelineCoverage.counted}/${p.openPipelineCoverage.matched} deals`);
  console.log(`  work orders        ${o.totalWorkOrders}`);
  console.log(`  order book         ${o.orderBookValue.toLocaleString('en-IN')}`);
  console.log(`  billed             ${o.billedValue.toLocaleString('en-IN')}`);
  console.log('\nConnection OK.');
}

main().catch((err) => {
  console.error('\nCheck failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

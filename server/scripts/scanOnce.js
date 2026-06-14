import { initStore } from '../src/db/store.js';
import { runScan, getDashboard } from '../src/services/scanner.js';

await initStore();
const run = await runScan('cli');
console.log('\nScan result:', JSON.stringify({ status: run.status, source: run.source, kept: run.kept, rejected: run.rejected, reasons: run.reasonCounts, ms: run.durationMs }, null, 2));
const dash = await getDashboard('day');
console.log(`\nTop 5 (day mode) from ${dash.dataSource}:`);
dash.opportunities.slice(0, 5).forEach((o, i) =>
  console.log(`  ${i + 1}. ${o.symbol.padEnd(6)} ${o.direction.padEnd(5)} conv ${o.conviction}  zone ${o.display.buyZone}`));
process.exit(0);

// Mine history for NEW setups. Reads the research rows written by scripts/research-long.mjs (every coin, every 2 hours: structure features + forward returns), searches single features and
// pairs of features for combinations that beat the same-hour average of all coins by more than costs, validates them on the unseen later 40% of time, and writes the survivors to
// logs/discovered-setups.json (the engine loads it; the Brain then treats a match as a 'discovered' setup, and the live journal measures it like any other).
// The bar is deliberately high (see src/discovery.js): searching thousands of combinations always finds something that looks good by chance. Finding nothing is a normal, honest result.
// Usage: node scripts/discover-setups.mjs [days=240]   (run  npm run research  first to build the rows)
import fs from 'node:fs';
import path from 'node:path';
process.env.PAPER_TRADING ??= 'true';
const { config } = await import('../src/config.js');
const { discover, saveDiscovered } = await import('../src/discovery.js');
const DAYS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 240;
const file = path.join(config.root, 'logs', 'backtest-cache', `long-rows-${DAYS}d.json`);
if (!fs.existsSync(file)) { console.error(`no research rows at ${file}: run  npm run research  first`); process.exit(1); }
const rows = JSON.parse(fs.readFileSync(file, 'utf8')).filter((r) => r.ex?.r24 != null && r.fw?.r24 != null);
console.log(`${rows.length} coin-hour rows over ${DAYS} days; searching single features and pairs...`);
const t0 = Date.now(), res = discover(rows);
console.log(`tested ${res.tested.toLocaleString('en-US')} combinations in ${((Date.now() - t0) / 1000).toFixed(0)}s; ${res.candidatesPassingTrain} looked good on the earlier ${res.trainRows.toLocaleString('en-US')} rows; ${res.rules.length} survived the unseen ${res.testRows.toLocaleString('en-US')} rows (bar: out-of-sample t >= ${res.thresholds.tTest}, excess >= ${(res.thresholds.minEx * 100).toFixed(2)}% after costs, positive in 3 of 4 time chunks).`);
for (const r of res.rules) console.log(`  RULE ${r.label}\n    train n=${r.train.n} excess ${(r.train.excess * 100).toFixed(2)}% t=${r.train.t} | unseen n=${r.test.n} excess ${(r.test.excess * 100).toFixed(2)}% t=${r.test.t} net raw ${(r.test.rawNet * 100).toFixed(2)}% | quarters ${JSON.stringify(r.quarters)}`);
if (!res.rules.length) console.log('No combination survived. That is the expected outcome when there is no real edge in these features: nothing is added to the Brain.');
saveDiscovered({ builtAt: Date.now(), days: DAYS, tested: res.tested, candidatesPassingTrain: res.candidatesPassingTrain, thresholds: res.thresholds, rules: res.rules });
console.log('written to logs/discovered-setups.json');

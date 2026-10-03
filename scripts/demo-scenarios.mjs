// Shows how the Brain treats the three situations that matter for entry quality. Usage: node scripts/demo-scenarios.mjs [--json]
// The markets are synthetic (tests/scenarios.mjs) but run through the real structure engine and decision code. "history" below is a FIXTURE standing in for measured results
// (setup reached 2.5R ~40% of the time); with no history at all the Brain's probability is the zero-drift prior and it will not claim an edge.
const { pumped, fresh, lateGrind, decideOn, fixtureModel } = await import('../tests/scenarios.mjs');
const { buildModel } = await import('../src/empirical.js');
const json = process.argv.includes('--json');
const out = [];
for (const [name, mk] of [['1. Already pumped (chasing)', pumped], ['2. Fresh entry at the retest', fresh], ['3. Bullish, but bad timing', lateGrind]]) {
  const c5 = mk();
  for (const [hist, model] of [['with measured-style history (fixture)', fixtureModel()], ['no history (zero-drift prior)', buildModel({}, [])]]) {
    const { d, chg24h } = decideOn(c5, { empirical: model });
    out.push({ scenario: name, history: hist, verdict: d.verdict, action: d.action, direction: d.scores.direction, timing: d.scores.timing, geometry: d.scores.geometry, overall: d.score, chase: d.chase && { verdict: d.chase.verdict, score: d.chase.score, moveAtr: d.chase.moveAtr, distLevelAtr: d.chase.distLevelAtr, used: d.chase.expectedMoveUsed, spikeSpent: d.chase.spikeSpent, stretched: d.chase.stretched },
      setup: d.setup?.label ?? null, pUp: d.pUp, ev: d.ev, rr: d.rr, vetoes: d.vetoes.map((v) => `${v.code}${v.hard ? '*' : ''}`), why: d.why, waitingFor: d.waitingFor, chg24h: +(chg24h * 100).toFixed(1) });
  }
}
if (json) console.log(JSON.stringify(out, null, 2));
else for (const o of out) {
  console.log(`\n=== ${o.scenario}  [${o.history}]`);
  console.log(`VERDICT ${o.verdict}   direction ${o.direction} | timing ${o.timing} | geometry ${o.geometry} | composite ${o.overall}   24h move ${o.chg24h}%`);
  console.log(`setup: ${o.setup ?? 'none'}   P(target first) ${(o.pUp * 100).toFixed(0)}%   EV ${o.ev ?? '-'}R   R:R ${o.rr ?? '-'}`);
  if (o.chase) console.log(`anti-chasing: ${o.chase.verdict} (score ${o.chase.score}): ${o.chase.moveAtr} ATR moved, ${o.chase.distLevelAtr} ATR from the level, ${(o.chase.used * 100).toFixed(0)}% of move used, volume spike spent: ${o.chase.spikeSpent}, stretched: ${o.chase.stretched}`);
  console.log(`blocked by: ${o.vetoes.join(', ') || 'nothing'}`);
  const w = o.why;
  if (w) { console.log(`  Why this coin: ${w.coin.join(' | ')}`); console.log(`  Why this direction: ${w.direction.join(' | ')}`); console.log(`  Why this price: ${w.price.join(' | ')}`); console.log(`  Why NOW: ${w.now.length ? w.now.join(' | ') : 'NO concrete reason to enter at this price right now'}`); if (w.confirms.length) console.log(`  Confirms: ${w.confirms.join(' | ')}`); if (w.invalidates.length) console.log(`  Invalidates: ${w.invalidates.join(' | ')}`); console.log(`  Could fail because: ${w.failure.join(' | ')}`); }
  if (o.waitingFor.length) console.log(`  WAITING FOR: ${o.waitingFor.join(' | ')}`);
}
process.exit(0);

#!/usr/bin/env node
/* Mutation check: break the page logic in known ways; the test suite must fail on every mutant. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const ffcalc = argv.indexOf('--ffcalc') >= 0 ? argv[argv.indexOf('--ffcalc') + 1] : (process.env.FFCALC || '');
const html = fs.readFileSync(path.join(ROOT, 'fuseplan.html'), 'utf8');
const MUTANTS = [
  ['Gen3 speed field on bit 1 instead of bit 9', "2, 39 * 16 + 9, 1, 'pcie'", "2, 39 * 16 + 1, 1, 'pcie'"],
  ['old block values assumed 0 (no replay)', 'var pending = cloneBlocks(base);', 'var pending = new Map();'],
  ['ffcalc block order instead of the lab order', 'if (idx >= 0) { inG.push(inG.splice(idx, 1)[0]); }', ''],
  ['no live-mask check', 'checkLive(card, report.current, rep.blocks, report.refusals, report.warnings, info);', ''],
  ['no bit-5 check in the simulation', "if (hasBit5(w)) { fail(tag + 'word '", "if (false) { fail(tag + 'word '"],
  ['no defective cross-check for memory', 'if (groups.memory && targets.fbp_disable !== undefined) {', 'if (false) {'],
  ['partial reads accepted', "return { state: missing.length ? 'partial' : 'complete'", "return { state: 'complete'"],
  ['rows start at max(used) instead of max(used) + 1', 'report.lastUsed + 1;', 'report.lastUsed;'],
  ['vfi_snap rows_match ignored', 'if (obj.rows_match !== true) {', 'if (false) {'],
  ['record word encodes block << 5', 'return data * 65536 + block * 64 + chain;', 'return data * 65536 + block * 32 + chain;'],
];
let killed = 0;
MUTANTS.forEach(([name, from, to]) => {
  if (html.indexOf(from) < 0) { console.log('  MUTANT NOT APPLIED (pattern missing): ' + name); return; }
  const p = path.join(os.tmpdir(), 'fuseplan-mutant-' + process.pid + '.html');
  fs.writeFileSync(p, html.replace(from, to));
  const r = cp.spawnSync('node', [path.join(__dirname, 'run_tests.js'), '--ffcalc', ffcalc, '--html', p], { encoding: 'utf8' });
  fs.unlinkSync(p);
  const m = /TOTAL:\s+(\d+) passed, (\d+) failed/.exec(r.stdout || '');
  const dead = r.status !== 0;
  if (dead) { killed++; }
  console.log('  ' + (dead ? 'caught ' : 'MISSED ') + name + (m ? ' (' + m[2] + ' checks failed)' : ' (suite crashed: ' + String(r.stderr).split('\n')[0] + ')'));
});
console.log('mutants caught: ' + killed + ' of ' + MUTANTS.length);
process.exit(killed === MUTANTS.length ? 0 : 1);

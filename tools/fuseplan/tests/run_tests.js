#!/usr/bin/env node
/* Test harness: loads the planner logic out of fuseplan.html and checks it against upstream ffcalc.
   Usage: node tests/run_tests.js [--ffcalc PATH_TO_FFCALC_SRC] */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const FFCALC = path.resolve(argv[argv.indexOf('--ffcalc') + 1] && argv.indexOf('--ffcalc') >= 0
  ? argv[argv.indexOf('--ffcalc') + 1] : (process.env.FFCALC || ''));
const HTML_PATH = argv.indexOf('--html') >= 0 ? path.resolve(argv[argv.indexOf('--html') + 1]) : path.join(ROOT, 'fuseplan.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fuseplan-test-'));

function loadCore() {
  const m = HTML.match(/<script id="fuseplan-core">([\s\S]*?)<\/script>/);
  if (!m) { throw new Error('no fuseplan-core script block in fuseplan.html'); }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(m[1], ctx, { filename: 'fuseplan-core' });
  return ctx.FusePlan;
}
const FP = loadCore();

/* ---------- tiny test framework ---------- */
const results = { pass: 0, fail: 0, bySection: {}, failures: [] };
let section = 'misc';
function sec(name) { section = name; results.bySection[name] = results.bySection[name] || { pass: 0, fail: 0 }; }
function check(name, cond, detail) {
  const s = results.bySection[section];
  if (cond) { results.pass++; s.pass++; } else {
    results.fail++; s.fail++;
    results.failures.push(section + ' :: ' + name + (detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
  }
  return !!cond;
}
function canon(v) {
  if (Array.isArray(v)) { return v.map(canon); }
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).sort().forEach((k) => { o[k] = canon(v[k]); }); return o; }
  return v;
}
function eq(a, b) { return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); }
function setEq(a, b) { return eq([...a].sort(), [...b].sort()); }

/* ---------- reference runner ---------- */
function ref(cmd, files) {
  const out = cp.execFileSync('python3', ['-I', path.join(HERE, 'ref_runner.py'), '--ffcalc', FFCALC, cmd].concat(files),
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}
function tmpFile(name, content) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}
function refPlanFor(dump, groups) { return ref('plan', [tmpFile('case-' + Math.random().toString(36).slice(2) + '.json', { dump, groups: groups || {} })]); }
function refSim(dump, planJson) {
  return ref('simulate', [tmpFile('d-' + Math.random().toString(36).slice(2) + '.json', dump), tmpFile('p-' + Math.random().toString(36).slice(2) + '.json', planJson)]);
}
function refRows(text) { return ref('rows', [tmpFile('rows-' + Math.random().toString(36).slice(2) + '.txt', text)]); }

/* ---------- helpers ---------- */
function rowsOfDump(dump) {
  const m = new Map();
  Object.keys(dump.ff_rows || {}).forEach((k) => m.set(parseInt(k, 10), parseInt(dump.ff_rows[k], 16)));
  return m;
}
function finalBlocksOf(rows, records) {
  const r = new Map();
  rows.forEach((v, k) => { if (k >= FP.FF_ROW_MIN && k <= FP.FF_ROW_MAX) { r.set(k, v); } });
  records.forEach((rec) => r.set(rec.row, rec.word));
  const rep = FP.replayRows(r);
  const out = {};
  rep.blocks.forEach((cb, c) => cb.forEach((v, b) => { out[c + ':' + b] = v; }));
  return out;
}
function recKey(chain, block, oldV, newV, word) { return [chain, block, oldV, newV, word >>> 0].join(':'); }
function plannerRecs(rep) { return rep.plan ? rep.plan.records : []; }
function rowsText(dump) {
  return Object.keys(dump.ff_rows).map((k) => parseInt(k, 10)).sort((a, b) => a - b)
    .map((r) => r + ' ' + dump.ff_rows[String(r)]).join('\n') + '\n';
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function loadCase(name) { return JSON.parse(fs.readFileSync(path.join(HERE, 'cases', name + '.json'), 'utf8')); }
function hasMsg(list, sub) { return (list || []).some((m) => m.indexOf(sub) >= 0); }

/* ======================================================================= */
sec('codec');
{
  const d = FP.decode(0x0fe805c1);
  check('decode 0x0fe805c1 = chain 1 block 23 data 0x0fe8 (ffcalc test vector)', d.chain === 1 && d.block === 23 && d.data === 0x0fe8);
  check('encode(1, 23, 0x0fe8) = 0x0fe805c1', FP.encode(1, 23, 0x0fe8) === 0x0fe805c1);
  let threw = false;
  try { FP.decode(0x12340021); } catch (e) { threw = e.code === 'bit5'; }
  check('decode refuses a word with bit 5 set (ffcalc test vector 0x12340021)', threw);
  const rows = new Map([[222, FP.encode(1, 5, 0xffff)], [223, FP.encode(1, 5, 0x0f0f)]]);
  const rb = FP.replayRows(rows).blocks;
  check('replay: the later record for a block wins', rb.has(1) && rb.get(1).get(5) === 0x0f0f);
  let all = true;
  for (let i = 0; i < 2000; i++) {
    const c = (i * 7) % 32; const b = (i * 131) % 1024; const v = (i * 40503) & 0xffff;
    const w = FP.encode(c, b, v);
    const dd = FP.decode(w);
    if (FP.hasBit5(w) || dd.chain !== c || dd.block !== b || dd.data !== v || w > 0xffffffff) { all = false; break; }
  }
  check('encode/decode round trip on 2000 words, bit 5 always clear', all);
  ['chain', 'block', 'data'].forEach((what, i) => {
    let t = false;
    try { FP.encode(i === 0 ? 32 : 1, i === 1 ? 1024 : 1, i === 2 ? 0x10000 : 1); } catch (e) { t = true; }
    check('encode refuses an out-of-range ' + what, t);
  });
}

/* ======================================================================= */
sec('parity');
const PARITY = fs.readdirSync(path.join(HERE, 'cases')).filter((f) => /^C\d+/.test(f)).map((f) => f.replace(/\.json$/, '')).sort();
const parityRuns = {};
PARITY.forEach((name) => {
  const c = loadCase(name);
  const rep = FP.run(JSON.stringify(c.dump), { groups: c.groups });
  const r = ref('plan', [path.join(HERE, 'cases', name + '.json')]);
  parityRuns[name] = { c, rep, r };
  const tag = name + ': ';
  if (!check(tag + 'planner accepts and plans', rep.ok && (rep.planState === 'ok' || rep.planState === 'noop'), { state: rep.planState, refusals: rep.refusals, errors: rep.errors })) { return; }
  if (!check(tag + 'ffcalc loads, analyzes and plans', !r.load_error && !r.analysis_error && !r.plan_error, r)) { return; }
  /* targets */
  const refKeys = Object.keys(r.analysis.targets).filter((k) => r.skip.indexOf(k) < 0);
  check(tag + 'same target keys', setEq(refKeys, rep.selectedKeys), { ffcalc: refKeys, page: rep.selectedKeys });
  const tDiff = rep.selectedKeys.filter((k) => rep.targets[k] !== r.analysis.targets[k]);
  check(tag + 'identical targets', tDiff.length === 0, tDiff.map((k) => [k, rep.targets[k], r.analysis.targets[k]]));
  /* analysis */
  const a = rep.analysis;
  check(tag + 'SM ceiling = ffcalc sm_count', a.sm.ceiling && a.sm.ceiling.total === r.analysis.sm_count, [a.sm.ceiling && a.sm.ceiling.total, r.analysis.sm_count]);
  check(tag + 'SM per GPC = ffcalc sm_per_gpc', a.sm.ceiling && eq(a.sm.ceiling.perGpc, r.analysis.sm_per_gpc), [a.sm.ceiling && a.sm.ceiling.perGpc, r.analysis.sm_per_gpc]);
  check(tag + 'FBPs after = ffcalc usable_fbp', a.fbp.ceilActive === r.analysis.usable_fbp, [a.fbp.ceilActive, r.analysis.usable_fbp]);
  check(tag + 'GiB after = ffcalc fb_gib', a.fbp.ceilGib === r.analysis.fb_gib, [a.fbp.ceilGib, r.analysis.fb_gib]);
  check(tag + 'GiB now = ffcalc fb_now_gib', a.fbp.nowGib === r.analysis.fb_now_gib, [a.fbp.nowGib, r.analysis.fb_now_gib]);
  check(tag + 'used and blank FF rows = ffcalc', rep.used === r.analysis.ff_rows_used && rep.blank === r.analysis.ff_rows_free,
    [rep.used, rep.blank, r.analysis.ff_rows_used, r.analysis.ff_rows_free]);
  const curDiff = FP.FIELDS.filter((f) => rep.current[f.key] !== r.analysis.current[f.key]).map((f) => f.key);
  check(tag + 'current field values decoded from the FF rows = ffcalc decode_current', curDiff.length === 0, curDiff);
  /* records */
  const mine = plannerRecs(rep);
  const theirs = r.plan.burn;
  const mk = mine.map((x) => recKey(x.chain, x.block, x.oldValue, x.newValue, x.word));
  const tk = theirs.map((x) => recKey(x.chain, x.block, parseInt(x.old, 16), parseInt(x.new, 16), parseInt(x.record, 16)));
  check(tag + 'same set of (chain, block, old, new, word): ' + mk.length + ' records', setEq(mk, tk) && mk.length === tk.length, { page: mk, ffcalc: tk });
  const fDiff = mine.filter((x) => {
    const t = theirs.filter((y) => y.chain === x.chain && y.block === x.block)[0];
    return !t || !eq(t.fields, x.fields);
  }).map((x) => x.chain + ':' + x.block);
  check(tag + 'same fields per record', fDiff.length === 0, fDiff);
  check(tag + 'same row numbers used (order may differ)', setEq(mine.map((x) => x.row), theirs.map((x) => x.row)));
  const rows = rowsOfDump(c.dump);
  check(tag + 'identical final replayed state', eq(finalBlocksOf(rows, mine), r.final_blocks));
  check(tag + "planner's own simulation passed", !rep.plan || (rep.simulation && rep.simulation.ok), rep.simulation && rep.simulation.errors);
  if (rep.plan) {
    const exported = JSON.parse(FP.exportPlan(rep));
    const s = refSim(c.dump, exported);
    check(tag + 'ffcalc simulate on the exported plan: 0 errors', s.errors.length === 0, s.errors);
    check(tag + 'ffcalc simulate: nothing pending among the planned fields', s.pending.filter((k) => rep.selectedKeys.indexOf(k) >= 0).length === 0, s.pending);
    /* rows consecutive from last used + 1 */
    const start = rep.lastUsed + 1;
    check(tag + 'rows run consecutively from max(used row) + 1', mine.every((x, i) => x.row === start + i));
    /* lab order */
    const groupsSeq = mine.map((x) => x.placedIn);
    const order = FP.GROUP_ORDER;
    check(tag + 'group order compute, memory, PCIe, NVLink, SYS_PIPE', groupsSeq.every((g, i) => i === 0 || order.indexOf(groupsSeq[i - 1]) <= order.indexOf(g)), groupsSeq);
    const comp = mine.filter((x) => x.placedIn === 'compute');
    const memr = mine.filter((x) => x.placedIn === 'memory');
    if (comp.some((x) => x.chain === 1 && x.block === 8)) { check(tag + 'compute ends with chain 1 block 8', comp[comp.length - 1].block === 8); }
    if (memr.some((x) => x.chain === 1 && x.block === 19)) { check(tag + 'memory ends with chain 1 block 19', memr[memr.length - 1].block === 19); }
  }
});

/* case-specific expectations */
{
  const p = parityRuns['C03-published-full'];
  if (p && p.rep.plan) {
    const ex = p.c.expect;
    const memr = p.rep.plan.records.filter((x) => x.placedIn === 'memory');
    check('C03: memory set is exactly the published words in the published order', eq(memr.map((x) => x.word), ex.memory_words), memr.map((x) => FP.hex(x.word, 8)));
    check('C03: memory old block values are the published ones', eq(memr.map((x) => x.oldValue), ex.memory_old));
    const pc = p.rep.plan.records.filter((x) => x.placedIn === 'pcie');
    check('C03: PCIe set is exactly 0x00510BC2, 0x058209C2, 0x00240C42', setEq(pc.map((x) => x.word), ex.pcie_words) && pc.length === 3, pc.map((x) => FP.hex(x.word, 8)));
    check('C03: PCIe old blocks are stock 0x0059 (47), 0x0782 (39), 0x00E4 (49)',
      eq(pc.map((x) => [x.block, x.oldValue]).sort((a, b) => a[0] - b[0]), [[39, 0x0782], [47, 0x0059], [49, 0x00E4]]));
    check('C03: compute set comes first and ends with chain 1 block 8', p.rep.plan.records[0].placedIn === 'compute' &&
      p.rep.plan.records.filter((x) => x.placedIn === 'compute').slice(-1)[0].block === 8);
    check('C03: 80 GB layout verdict', p.rep.analysis.layout.verdict === '80gb');
    check('C03: SM now 70, ceiling 126', p.rep.analysis.sm.now.total === 70 && p.rep.analysis.sm.ceiling.total === 126);
  }
  const q = parityRuns['C04-published-mem-pcie'];
  if (q && q.rep.plan) {
    const ch1 = q.rep.plan.records.filter((x) => x.chain === 1).map((x) => x.word);
    const ch2 = q.rep.plan.records.filter((x) => x.chain === 2).map((x) => x.word);
    check('C04: exactly these chain-1 words in this order: 0x80070141 0x06010181 0x018001C1 0x18000501 0x420004C1',
      eq(ch1, q.c.expect.memory_words), ch1.map((w) => FP.hex(w, 8)));
    check('C04: exactly these chain-2 words: 0x00510BC2 0x058209C2 0x00240C42', setEq(ch2, q.c.expect.pcie_words) && ch2.length === 3, ch2.map((w) => FP.hex(w, 8)));
    check('C04: nothing else', q.rep.plan.records.length === 8);
  }
  const s16 = parityRuns['C16-shared-block-8'];
  if (s16 && s16.rep.plan) {
    const b8 = s16.rep.plan.records.filter((x) => x.chain === 1 && x.block === 8);
    check('C16: block 8 written once, in the compute set', b8.length === 1 && b8[0].placedIn === 'compute' && eq(b8[0].groups, ['compute', 'memory']));
    check('C16: warning names the shared block', hasMsg(s16.rep.warnings, 'Chain 1 block 8 carries changes for compute and memory'));
  }
  const s02 = parityRuns['C02-sample-all-groups'];
  if (s02 && s02.rep.plan) {
    const b23 = s02.rep.plan.records.filter((x) => x.chain === 1 && x.block === 23);
    check('C02: block 23 (NVLink and SYS_PIPE) written once with a warning', b23.length === 1 && hasMsg(s02.rep.warnings, 'block 23 carries changes for nvlink and sys_pipe'));
  }
  const s12 = parityRuns['C12-few-free-rows'];
  if (s12) { check('C12: warns that fewer than 16 blank rows remain', hasMsg(s12.rep.warnings, 'blank FF rows would remain')); }
  const s09 = parityRuns['C09-four-fbp-defective'];
  if (s09) {
    check('C09: 64 GB card verdict', s09.rep.analysis.layout.verdict === 'dud64');
    check('C09: no memory records', plannerRecs(s09.rep).every((x) => x.placedIn !== 'memory'));
  }
  const s10 = parityRuns['C10-pcie-already-cleared'];
  if (s10) { check('C10: no PCIe records', plannerRecs(s10.rep).every((x) => x.placedIn !== 'pcie')); }
  const s11 = parityRuns['C11-nvlink-defective'];
  if (s11) { check('C11: NVLink target is its defective mask 0x2', s11.rep.targets.nvlink_disable === 2 && plannerRecs(s11.rep).some((x) => x.placedIn === 'nvlink')); }
  const s05 = parityRuns['C05-defective-gpc'];
  if (s05) {
    check('C05: GPC 7 stays off (GPC target 0x80), SM ceiling 98', s05.rep.targets.gpc_disable === 0x80 && s05.rep.analysis.sm.ceiling.total === 98 && s05.rep.analysis.sm.ceiling.perGpc[7] === 0);
    check('C05: warns about TPC fields inside the defective GPC', hasMsg(s05.rep.warnings, 'GPC 7 is marked defective'));
  }
  const s14 = parityRuns['C14-10gb'];
  if (s14) { check('C14: 10 GB card uses 4 GiB per FBP', s14.rep.sku === '10gb' && s14.rep.analysis.fbp.ceilGib === 40); }
  const s01 = parityRuns['C01-sample'];
  if (s01) {
    check('C01: sample keeps bit 1 of chain 2 block 39 (no block 39 record)', plannerRecs(s01.rep).every((x) => !(x.chain === 2 && x.block === 39)));
    check('C01: sample flags masks that are not the pair expansion', hasMsg(s01.rep.warnings, 'not the pair expansion'));
  }
}

/* ======================================================================= */
sec('vfi_snap');
{
  const c = loadCase('C03-published-full');
  const base = FP.run(JSON.stringify(c.dump), {});
  const snap = FP.run(JSON.stringify(c.vfi_snap), {});
  check('snapshot accepted and planned', snap.ok && snap.planState === 'ok', snap.refusals);
  if (snap.plan && base.plan) {
    check('snapshot plan = dump plan (rows, words, order)', eq(snap.plan.records.map((x) => [x.row, x.word]), base.plan.records.map((x) => [x.row, x.word])));
  }
  const w = snap.card.words;
  const map = { gpc_disable: 0x13, gpc_defective: 0, pes_disable: 0x703F, pes_defective: 0, fbp_disable: 0x852, fbp_defective: 0x840,
    fbpa_disable: 0xC0330C, fbpa_defective: 0xC03000, fbio_disable: 0xC0330C, fbio_defective: 0xC03000, rop_l2_disable: 0xC0330C,
    rop_l2_defective: 0xC03000, tpc_gpc0_disable: 0xFF, tpc_gpc5_defective: 0x01 };
  check('register names map onto ffcalc option-word keys', Object.keys(map).every((k) => w[k] === map[k]), Object.keys(map).filter((k) => w[k] !== map[k]));
  check('no NVLink or SYS_PIPE words invented', !('nvlink_disable' in w) && !('nvlink_defective' in w) && !('sys_pipe_disable' in w) && !('sys_pipe_defective' in w));
  check('live PCIe registers read at the right bits (stock: all four 1)', snap.pcie.every((p) => p.live === 1 && p.ff === 1));
  check('every floorsweep and PCIe field was checked against the FF rows', ['fbp_disable', 'fbpa_disable', 'gpc_disable', 'pes_disable', 'disable_gen3_speed_bit9',
    'pcie_magic_gen4_dis', 'pcie_boot_gen23_dis', 'pcie_boot_gen3_dis'].every((k) => snap.liveChecked.indexOf(k) >= 0), snap.liveChecked);
  check("SM now / ceiling agree with the snapshot's own counts", snap.analysis.sm.now.total === c.vfi_snap.sm_status_now && snap.analysis.sm.ceiling.total === c.vfi_snap.sm_ceiling_nondefective);
  const rc = FP.run(JSON.stringify(c.vfi_snap_reconfig), {});
  check('status differing from fused (RECONFIG): SM now from status, plan unchanged', rc.planState === 'ok' && rc.analysis.sm.now.total === 68 &&
    rc.analysis.sm.fused && rc.analysis.sm.fused.total === 70 && eq(rc.plan.records.map((x) => x.word), base.plan.records.map((x) => x.word)));
  check('status differing from fused is stored as ffcalc does (key__fused)', rc.card.words.tpc_gpc3_disable === 0x03 && rc.card.words.tpc_gpc3_disable__fused === 0x01);
  const noRows = clone(c.vfi_snap);
  delete noRows.rows; delete noRows.rows_match; delete noRows.rows_nonzero; delete noRows.state_unchanged_by_row_read;
  const nr = FP.run(JSON.stringify(noRows), {});
  check('snapshot without --rows: analysis works, plan refused', nr.ok && nr.planState === 'refused' && nr.analysis.sm.ceiling.total === 126 && nr.analysis.fbp.ceilGib === 80 &&
    hasMsg(nr.refusals, 'No FF rows'));
  const s10 = clone(c.vfi_snap); s10.identity.device = '0x2082';
  check('device 0x2082 is read as the 10 GB SKU', FP.run(JSON.stringify(s10), {}).sku === '10gb');
}

/* ======================================================================= */
sec('rows file');
{
  const c = loadCase('C03-published-full');
  const text = rowsText(c.dump);
  const rep = FP.run(text, {});
  check('rows file accepted as a decoded view with no targets', rep.ok && rep.planState === 'none' && !rep.targets && !rep.plan);
  const r = refRows(text);
  const nz = Object.keys(r.rows).filter((k) => +k >= 222 && +k <= 486 && r.rows[k] !== 0).length;
  check('decoded record count = nonzero FF rows', rep.decoded.length === nz, [rep.decoded.length, nz]);
  const diff = FP.FIELDS.filter((f) => rep.current[f.key] !== r.current[f.key]).map((f) => f.key);
  check('decoded field values = ffcalc decode_current', diff.length === 0, diff);
  check('superseded records are marked', rep.decoded.filter((x) => x.supersededBy).length === 4);
  const samples = [
    '# comment\n222 0x0fe805c1\n0xde 0xfe805c1\nFFROW 223 141\n[ 1569.145419] FFROW 224 0x19801c1   # trailing comment\n486 0\n',
    '222 1\n222 0x1\n',
    '  300   0X0FE805C1  \r\n301\t0\r\n',
  ];
  samples.forEach((s, i) => {
    let mine;
    try { mine = Object.fromEntries([...FP.parseRowsText(s)].map(([k, v]) => [String(k), v])); } catch (e) { mine = { error: e.message }; }
    const theirs = refRows(s);
    check('rows parse parity with ffcalc parse_rows #' + (i + 1), !theirs.error && eq(Object.keys(mine).sort(), Object.keys(theirs.rows).sort()) &&
      Object.keys(mine).every((k) => mine[k] === theirs.rows[k]), { mine, theirs: theirs.rows || theirs.error });
  });
}

/* ======================================================================= */
sec('refusals');
function expectRefused(name, rep, sub) {
  const ok = rep.ok && (rep.planState === 'refused' || rep.planState === 'sim-failed') && !rep.plan && hasMsg(rep.refusals.concat(rep.simulation ? rep.simulation.errors : []), sub);
  return check(name + ': refused, no records ("' + sub + '")', ok, { state: rep.planState, refusals: rep.refusals, errors: rep.errors });
}
function expectError(name, rep, sub) {
  return check(name + ': input rejected ("' + sub + '")', !rep.ok && hasMsg(rep.errors, sub) && !rep.plan, { errors: rep.errors, state: rep.planState });
}
const ffcalcNotes = [];
function noteFfcalc(name, r) {
  let s;
  if (r.load_error) { s = 'ffcalc refuses to load: ' + r.load_error; } else if (r.plan_error) { s = 'ffcalc refuses: ' + r.plan_error.type + ': ' + r.plan_error.message.split('\n')[0]; } else {
    s = 'ffcalc plans ' + r.plan.burn.length + ' records' + (r.plan.warnings.length ? ' (warnings: ' + r.plan.warnings.length + ')' : ', no warning');
  }
  ffcalcNotes.push(name + ': ' + s);
  return r;
}
{
  /* case files R* */
  fs.readdirSync(path.join(HERE, 'cases')).filter((f) => /^R\d+/.test(f)).sort().forEach((f) => {
    const c = JSON.parse(fs.readFileSync(path.join(HERE, 'cases', f), 'utf8'));
    const rep = FP.run(JSON.stringify(c.dump), { groups: c.groups });
    expectRefused(c.name, rep, c.refuse);
    noteFfcalc(c.name, ref('plan', [path.join(HERE, 'cases', f)]));
  });
  /* coverage */
  const s = loadCase('C01-sample').dump;
  const d1 = clone(s); d1.ff_rows = {};
  expectRefused('R01 ff_rows empty', FP.run(JSON.stringify(d1), {}), 'No FF rows in the input');
  check('R01 ffcalc also refuses (FFRowsNotRead)', noteFfcalc('R01', refPlanFor(d1)).plan_error.type === 'FFRowsNotRead');
  const d2 = clone(s); delete d2.ff_rows['486'];
  expectRefused('R02 row 486 missing', FP.run(JSON.stringify(d2), {}), 'covers only 264 of 265');
  check('R02 ffcalc also refuses (FFRowsNotRead)', noteFfcalc('R02', refPlanFor(d2)).plan_error.type === 'FFRowsNotRead');
  const d3 = clone(s); Object.keys(d3.ff_rows).forEach((k) => { if (parseInt(d3.ff_rows[k], 16) === 0) { delete d3.ff_rows[k]; } });
  expectRefused('R03 only the nonzero rows listed', FP.run(JSON.stringify(d3), {}), 'Unburnt rows must be listed as 0');
  check('R03 ffcalc also refuses (FFRowsNotRead)', noteFfcalc('R03', refPlanFor(d3)).plan_error.type === 'FFRowsNotRead');
  const rf = Object.keys(s.ff_rows).filter((k) => parseInt(d3.ff_rows[k] || '0', 16)).map((k) => k + ' ' + s.ff_rows[k]).join('\n');
  const rr = FP.run(rf, {});
  check('R03b partial rows file: decoded view, coverage partial, no plan', rr.ok && rr.planState === 'none' && rr.coverage.state === 'partial');

  /* vfi_snap refusals */
  const c3 = loadCase('C03-published-full');
  const v = c3.vfi_snap;
  const v1 = clone(v); v1.rows_match = false;
  expectRefused('R04 vfi_snap rows_match false', FP.run(JSON.stringify(v1), {}), 'did not match');
  const v1b = clone(v); delete v1b.rows_match;
  expectRefused('R04b vfi_snap rows without rows_match', FP.run(JSON.stringify(v1b), {}), 'did not match');
  const v2 = clone(v); v2.rows.pop();
  expectRefused('R05 vfi_snap with 511 rows', FP.run(JSON.stringify(v2), {}), 'not 512');
  const v3 = clone(v); v3.rows_error = 'CMD_READ timeout at row 300';
  expectRefused('R06a vfi_snap rows_error', FP.run(JSON.stringify(v3), {}), 'failed row read');
  const v4 = clone(v); v4.state_unchanged_by_row_read = false;
  expectRefused('R06b vfi_snap state changed during the read', FP.run(JSON.stringify(v4), {}), 'changed during the row read');
  const v5 = clone(v); v5.die_id_match = false;
  expectRefused('R26 vfi_snap die ID mismatch', FP.run(JSON.stringify(v5), {}), 'die ID differs');
  const v6 = clone(v); v6.sm_status_now = 72;
  expectRefused("R27 vfi_snap SM counts disagree with its registers", FP.run(JSON.stringify(v6), {}), 'may have been edited');
  expectRefused('R20 vfi_snap with NVLink ticked', FP.run(JSON.stringify(v), { groups: { nvlink: true } }), 'lacks nvlink_defective, nvlink_disable');
  const v7 = clone(v); delete v7.regs.FBP_DEFECTIVE;
  expectRefused('R19b vfi_snap without FBP_DEFECTIVE, memory ticked', FP.run(JSON.stringify(v7), {}), 'lacks fbp_defective');
  const v7r = FP.run(JSON.stringify(v7), { groups: { memory: false } });
  check('R19b ... and plans the rest once memory is unticked', v7r.planState === 'ok' && v7r.plan.records.every((x) => x.placedIn !== 'memory'));
  const v8 = clone(v); v8.identity.device = '0x1234';
  expectError('R22 vfi_snap device 0x1234', FP.run(JSON.stringify(v8), {}), 'is not a CMP 170HX');
  const v9 = clone(v); v9.regs.OPT_DISABLE_GEN3_SPEED = '0x00000000';
  expectRefused('R28 live Gen3 register 0 but block 39 bit 9 set', FP.run(JSON.stringify(v9), {}), 'do not explain the live PCIe state');
  const v10 = clone(v); v10.regs.OPT_PCIE_MAGIC_BITS_D = '0x12680000';
  expectRefused('R29 MAGIC_BITS_D bits 22 to 31 differ from block 47', FP.run(JSON.stringify(v10), {}), 'cannot be rewritten safely');
  const v11 = clone(v); v11.regs.FBP_DISABLE = '0x00001852';
  expectRefused('R30 live FBP register wider than the field', FP.run(JSON.stringify(v11), {}), 'outside the 12-bit field');
  const v12 = clone(v); v12.regs.FBP_R_820368 = '0x00c03000';
  expectRefused('R31 FBPA register (0x820368) not reproduced by the FF rows', FP.run(JSON.stringify(v12), {}), 'OPT_FBPA_DISABLE: the card reports 0xc03000');
  const v13 = clone(v); v13.rows[300] = '0x00000021';
  expectRefused('R32 vfi_snap with a bit-5 word at row 300', FP.run(JSON.stringify(v13), {}), 'bit 5 set');
  const v14 = clone(v); v14.regs.GPC_STATUS = '0x00000013'; v14.regs.GPC_DISABLE = '0x00000011';
  expectRefused('R33 fused GPC mask not reproduced by the FF rows', FP.run(JSON.stringify(v14), {}), 'OPT_GPC_DISABLE: the card reports 0x11');

  /* dump-level input errors, with ffcalc's behaviour */
  const e1 = clone(s); e1.ff_rows['512'] = '0x0';
  expectError('R11 dump row 512', FP.run(JSON.stringify(e1), {}), 'fuse row out of range');
  check('R11 ffcalc also refuses to load it', !!noteFfcalc('R11', refPlanFor(e1)).load_error);
  const e2 = clone(s); e2.ff_rows['-1'] = '0x0';
  expectError('R13 dump row -1', FP.run(JSON.stringify(e2), {}), 'fuse row out of range');
  check('R13 ffcalc also refuses to load it', !!noteFfcalc('R13', refPlanFor(e2)).load_error);
  const e3 = clone(s); e3.sku = '12gb';
  expectError('R21 sku 12gb', FP.run(JSON.stringify(e3), {}), 'sku must be');
  check('R21 ffcalc also refuses to load it', !!noteFfcalc('R21', refPlanFor(e3)).load_error);
  const e4 = clone(s); e4.ff_rows['300'] = '0x100000000';
  expectError('R15b dump value wider than 32 bits', FP.run(JSON.stringify(e4), {}), 'wider than 32 bits');
  noteFfcalc('R15b (dump value 0x100000000)', refPlanFor(e4));
  const e5 = clone(s); e5.regs = {};
  expectError('R23 JSON with fields of both formats', FP.run(JSON.stringify(e5), {}), 'refusing to guess');
  expectError('R23b unrecognised JSON', FP.run('{"hello": 1}', {}), 'Unrecognised JSON');
  expectError('R23c broken JSON', FP.run('{"sku": "8gb", ', {}), 'does not parse');
  expectError('R34 SKU selector disagrees with the read', FP.run(JSON.stringify(s), { sku: '10gb' }), 'Set the selector to match');
  expectRefused('R35 no group ticked', FP.run(JSON.stringify(s), { groups: { compute: false, memory: false, pcie: false } }), 'No group is ticked');

  /* rows-file input errors, each checked against ffcalc parse_rows */
  [['R12 rows file row 600', '222 0\n600 0x0\n', 'out of range 0 to 511'],
    ['R15 rows file value above 32 bits', '222 0x100000000\n', 'wider than 32 bits'],
    ['R16 rows file row twice with different values', '222 1\n222 2\n', 'given twice'],
    ['R36 rows file line without a value', '222\n', "expected '<row> <value>'"],
    ['R37 rows file decimal with a leading zero', '0222 0\n', 'leading zero']].forEach(([name, text, sub]) => {
    expectError(name, FP.run(text, {}), sub);
    const t = refRows(text);
    check(name + ': ffcalc parse_rows also refuses', !!t.error, t);
  });
}

/* ======================================================================= */
sec('simulation tamper');
(function () {
  const c = loadCase('C03-published-full');
  const rep = FP.run(JSON.stringify(c.dump), {});
  const rows = rowsOfDump(c.dump);
  const good = rep.plan ? rep.plan.records : null;
  if (!check('C03 plans (needed for the tamper tests)', !!good, rep.refusals)) { return; }
  function tamper(name, fn, sub, ffcalcMust) {
    const recs = good.map((r) => Object.assign({}, r));
    fn(recs);
    const sim = FP.simulatePlan(rows, recs, rep.targets, rep.selectedKeys);
    check(name + ': page simulation fails ("' + sub + '")', !sim.ok && hasMsg(sim.errors, sub), sim.errors);
    if (ffcalcMust) {
      const ex = JSON.parse(FP.exportPlan(rep));
      ex.burn = recs.map((r) => ({ row: r.row, chain: r.chain, block: r.block, old: FP.hex(r.oldValue, 4), new: FP.hex(r.newValue, 4), record: FP.hex(r.word, 8), fields: r.fields }));
      const s = refSim(c.dump, ex);
      check(name + ': ffcalc simulate also reports an error', s.errors.length > 0, s);
    }
  }
  check('untampered plan passes the page simulation', FP.simulatePlan(rows, good, rep.targets, rep.selectedKeys).ok);
  tamper('T1 word with bit 5 set', (r) => { r[0].word = (r[0].word | 0x20) >>> 0; }, 'has bit 5 set', true);
  tamper('T2 wrong old value', (r) => { r[1].oldValue ^= 1; }, 'is not the replayed', true);
  tamper('T3 row already burned', (r) => { r[0].row = 250; }, 'is not blank in the read', true);
  tamper('T4 row past 486', (r) => { r[r.length - 1].row = 487; }, 'outside the FF rows', true);
  tamper('T5 word that does not encode its chain/block/data', (r) => { r[2].word = FP.encode(1, r[2].block + 1, r[2].newValue); }, 'does not encode', true);
  tamper('T6 two records on one row', (r) => { r[3].row = r[2].row; }, 'used by two records', true);
  tamper('T7 change to a bit no planned field owns (block 39 bit 1)', (r) => {
    const x = r.filter((y) => y.chain === 2 && y.block === 39)[0];
    x.newValue ^= 2; x.word = FP.encode(2, 39, x.newValue);
  }, 'not a planned field', true);
  tamper('T8 target not reached', (r) => { const x = r.filter((y) => y.block === 19)[0]; x.newValue ^= 0x0200; x.word = FP.encode(1, 19, x.newValue); }, 'target', true);
  tamper('T9 two records for one block', (r) => { r.push(Object.assign({}, r[0], { row: r[r.length - 1].row + 1 })); }, 'second record', false);
  tamper('T10 a record that changes nothing', (r) => { r[0].newValue = r[0].oldValue; r[0].word = FP.encode(r[0].chain, r[0].block, r[0].newValue); }, 'changes nothing', false);
  tamper('T11 row before the last used row', (r) => { r[0].row = 240; }, 'not after the last used row', false);
})();

/* ======================================================================= */
sec('after the burn');
(function () {
  const c = loadCase('C03-published-full');
  const rep = FP.run(JSON.stringify(c.dump), {});
  if (!check('C03 plans (needed for the after-the-burn test)', !!rep.plan, rep.refusals)) { return; }
  const d = clone(c.dump);
  rep.plan.records.forEach((r) => { d.ff_rows[String(r.row)] = FP.hex(r.word, 8); });
  Object.keys(rep.targets).forEach((k) => { if (FP.BY_KEY[k].group !== 'pcie') { d.option_words[k] = FP.pyHex(rep.targets[k]); } });
  const again = FP.run(JSON.stringify(d), {});
  check('read after the burn: nothing left to burn (no-op)', again.ok && again.planState === 'noop', { state: again.planState, refusals: again.refusals });
  const r = refPlanFor(d);
  check('ffcalc agrees: empty plan after the burn', !r.plan_error && r.plan.burn.length === 0, r.plan_error || r.plan.burn.length);
  check('PCIe fields all read 0 from the new FF rows', again.pcie.every((p) => p.ff === 0));
  check('MAGIC_BITS_D from the new rows is 0x14680000', again.magicFromRows === 0x14680000);
})();

/* ======================================================================= */
sec('page rules');
{
  const nonAscii = [...HTML].filter((ch) => ch.charCodeAt(0) > 127);
  check('fuseplan.html is plain ASCII (no em or en dashes)', nonAscii.length === 0, nonAscii.slice(0, 5));
  check('no dash entities', !/&(m|n)dash;|&#821[12];|&#x201[34];/i.test(HTML));
  check('no " -- " used as a dash in page text', !/\s--\s/.test(HTML.replace(/<script[\s\S]*?<\/script>/g, '')));
  check('content security policy blocks the network', /http-equiv="Content-Security-Policy" content="default-src 'none'/.test(HTML));
  check('no external scripts, styles or fonts', !/<script[^>]+src=|<link\b|@import|url\(|@font-face/i.test(HTML));
  check('no http(s) URLs anywhere', !/https?:\/\//i.test(HTML));
  check('no network APIs in the code', !/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|\bimport\(/.test(HTML));
  check('no storage APIs', !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(HTML));
  check('upstream credit present', HTML.indexOf('field map and record format from cmp170hx-ffcalc (github.com/sayhellotojungle/cmp170hx-ffcalc)'.replace(/^f/, 'F')) >= 0);
  check('says nothing leaves the browser', HTML.indexOf('Nothing leaves this browser') >= 0);
  check('top warning: permanent, own cold read, ffcalc sim, second person', /Burns are permanent/.test(HTML) && /your own cold read/.test(HTML) && /ffcalc sim/.test(HTML) && /second person/.test(HTML));
  check('no burn or register-write commands', !/burntool|CMD_WRITE|setpci|FUSEWDATA|reg w |writel|devmem|FUSECTRL/i.test(HTML));
  check('no owner names, hostnames or IPs', !/darkmaniac|ivan|\b192\.168\.|\b10\.\d+\.\d+\.\d+|localhost/i.test(HTML));
  check('no AI or tool credit', !/\bclaude\b|anthropic|chatgpt|generated by|\bAI\b|copilot/i.test(HTML));
  check('light and dark mode via prefers-color-scheme', /@media \(prefers-color-scheme: dark\)/.test(HTML));
  check('viewport meta for phone width', /name="viewport" content="width=device-width, initial-scale=1"/.test(HTML));
  check('MAGIC_D whole-word rewrite, device ID and Gen3 bit 1 are not targets', FP.FIELDS.every((f) => !/magic_d$|devid|bit1/.test(f.key)));
}

/* ======================================================================= */
let total = 0;
console.log('fuseplan test results (ffcalc at ' + FFCALC + ')');
Object.keys(results.bySection).forEach((k) => {
  const s = results.bySection[k];
  total += s.pass + s.fail;
  console.log('  ' + (k + ':').padEnd(20) + s.pass + ' passed, ' + s.fail + ' failed');
});
console.log('  ' + 'TOTAL:'.padEnd(20) + results.pass + ' passed, ' + results.fail + ' failed (' + total + ' checks)');
console.log('\nffcalc on the same refusal inputs:');
ffcalcNotes.forEach((n) => console.log('  ' + n));
if (results.failures.length) {
  console.log('\nFAILURES:');
  results.failures.forEach((f) => console.log('  ' + f));
}
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(results.fail ? 1 : 0);

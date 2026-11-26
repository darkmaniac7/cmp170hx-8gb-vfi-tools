/* fuseplan core: pure planning logic, no DOM, no network. Field map and record format from cmp170hx-ffcalc. */
(function (root) {
  'use strict';

  var FF_ROW_MIN = 222;
  var FF_ROW_MAX = 486;
  var N_FF_ROWS = FF_ROW_MAX - FF_ROW_MIN + 1;
  var N_ROWS = 512;
  var RESERVE_ROWS = 16;
  var TOTAL_GPC = 8;
  var TPC_PER_GPC = 8;
  var SM_PER_TPC = 2;
  var TOTAL_FBP = 12;
  var PES_PER_GPC = 3;

  var SKUS = {
    '8gb': { id: '8gb', label: '8 GB', pci: '10de:20c2', device: 0x20c2, gibPerFbp: 8 },
    '10gb': { id: '10gb', label: '10 GB', pci: '10de:2082', device: 0x2082, gibPerFbp: 4 }
  };

  var GROUP_ORDER = ['compute', 'memory', 'pcie', 'nvlink', 'sys_pipe'];
  var GROUPS = {
    compute: { id: 'compute', label: 'Compute', detail: 'TPC, PES and GPC disables', def: true },
    memory: { id: 'memory', label: 'Memory', detail: 'FBIO, FBPA, ROP_L2 and FBP disables', def: true },
    pcie: { id: 'pcie', label: 'PCIe link speed', def: true,
      detail: 'Gen3 speed (block 39 bit 9), MAGIC_D bit 25, BOOT_GEN3, BOOT_GEN23' },
    nvlink: { id: 'nvlink', label: 'NVLink', def: false,
      detail: 'Clearing these bits has not been shown to turn NVLink on. NVLink also needs board parts and bridges.' },
    sys_pipe: { id: 'sys_pipe', label: 'SYS_PIPE', def: false,
      detail: 'Clearing these bits has not been shown to turn the feature on.' }
  };
  /* Within a group, this block is written last (the lab's order). */
  var LAST_BLOCK = { compute: '1:8', memory: '1:19' };

  function Field(key, name, chain, bit, width, group, defectKey, extra) {
    var f = { key: key, name: name, chain: chain, bit: bit, width: width, group: group, defectKey: defectKey || '' };
    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { f[k] = extra[k]; } } }
    return f;
  }

  /* Same order as ffcalc optionmap.FIELDS, without the fields this page leaves out. */
  var FIELDS = [
    Field('fbio_disable', 'OPT_FBIO_DISABLE', 1, 83, 24, 'memory', 'fbio_defective'),
    Field('fbpa_disable', 'OPT_FBPA_DISABLE', 1, 107, 24, 'memory', 'fbpa_defective'),
    Field('gpc_disable', 'OPT_GPC_DISABLE', 1, 131, 8, 'compute', 'gpc_defective')
  ];
  (function () {
    for (var i = 0; i < TOTAL_GPC; i++) {
      FIELDS.push(Field('tpc_gpc' + i + '_disable', 'OPT_TPC_GPC' + i + '_DISABLE', 1, 187 + 8 * i, 8, 'compute',
        'tpc_gpc' + i + '_defective'));
    }
  })();
  FIELDS.push(
    Field('pes_disable', 'OPT_PES_DISABLE', 1, 251, 24, 'compute', 'pes_defective'),
    Field('fbp_disable', 'OPT_FBP_DISABLE', 1, 307, 12, 'memory', 'fbp_defective'),
    Field('rop_l2_disable', 'OPT_ROP_L2_DISABLE', 1, 319, 24, 'memory', 'rop_l2_defective'),
    Field('nvlink_disable', 'OPT_NVLINK_DISABLE', 1, 368, 3, 'nvlink', 'nvlink_defective'),
    Field('sys_pipe_disable', 'OPT_SYS_PIPE_DISABLE', 1, 372, 8, 'sys_pipe', 'sys_pipe_defective'),
    Field('disable_gen3_speed_bit9', 'OPT_DISABLE_GEN3_SPEED', 2, 39 * 16 + 9, 1, 'pcie', '',
      { reg: '0x820250', regBit: 0, loc: 'chain 2 block 39 bit 9' }),
    Field('pcie_magic_gen4_dis', 'PCIE_MAGIC_BITS_D bit 25 (Gen4 disable)', 2, 47 * 16 + 3, 1, 'pcie', '',
      { reg: '0x820520', regBit: 25, loc: 'chain 2 block 47 bit 3' }),
    Field('pcie_boot_gen23_dis', 'OPT_PCIE_BOOT_GEN23_DIS', 2, 49 * 16 + 6, 1, 'pcie', '',
      { reg: '0x82057C', regBit: 0, loc: 'chain 2 block 49 bit 6' }),
    Field('pcie_boot_gen3_dis', 'OPT_PCIE_BOOT_GEN3_DIS', 2, 49 * 16 + 7, 1, 'pcie', '',
      { reg: '0x820580', regBit: 0, loc: 'chain 2 block 49 bit 7' })
  );
  /* Never targeted. A plan must leave them exactly as they are (checked in the simulation). */
  var KEEP_FIELDS = [
    Field('keep_c2_593_16', 'chain 2 bits 593 to 608', 2, 593, 16, 'keep'),
    Field('keep_c2_609_16', 'chain 2 bits 609 to 624', 2, 609, 16, 'keep'),
    Field('keep_c2_b39_bit1', 'chain 2 block 39 bit 1', 2, 39 * 16 + 1, 1, 'keep')
  ];
  var BY_KEY = {};
  var BIT_OWNER = {};
  FIELDS.forEach(function (f) {
    BY_KEY[f.key] = f;
    for (var i = 0; i < f.width; i++) { BIT_OWNER[f.chain + ':' + (f.bit + i)] = { field: f, index: i }; }
  });
  var PCIE_KEYS = FIELDS.filter(function (f) { return f.group === 'pcie'; }).map(function (f) { return f.key; });

  /* ---------- small helpers ---------- */

  function FPError(code, message) {
    var e = new Error(message);
    e.code = code;
    e.fp = true;
    return e;
  }
  function hex(v, width) {
    var s = (v >>> 0).toString(16);
    while (width && s.length < width) { s = '0' + s; }
    return '0x' + s;
  }
  function hexU(v, width) { return '0x' + hex(v, width).slice(2).toUpperCase(); }
  function pyHex(v) { return '0x' + (v >>> 0).toString(16); }
  function pow2(i) { return Math.pow(2, i); }
  function fieldMask(width) { return pow2(width) - 1; }
  function popcount(v) {
    var c = 0;
    v = v >>> 0;
    while (v) { c += v & 1; v = v >>> 1; }
    return c;
  }
  function bitsOf(v, width) {
    var out = [];
    for (var i = 0; i < width; i++) { if (Math.floor(v / pow2(i)) % 2 === 1) { out.push(i); } }
    return out;
  }
  function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }
  function andNot(a, b) { /* a & ~b for values up to 32 bits */ return (a & ~b) >>> 0; }
  function blockKey(chain, block) { return chain + ':' + block; }
  function sortNum(a, b) { return a - b; }
  function fmtRows(rows, limit) {
    limit = limit || 8;
    var s = rows.slice(0, limit).join(', ');
    if (rows.length > limit) { s += ' and ' + (rows.length - limit) + ' more'; }
    return s;
  }

  /* Strict integer parsing: a JSON number, or a string in decimal or 0x hex. Stricter than Python int(x, 0). */
  function parseUInt(v, what, max) {
    var n;
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0) { throw FPError('bad-number', what + ': ' + v + ' is not a non-negative integer'); }
      n = v;
    } else if (typeof v === 'string') {
      var s = v.trim();
      if (/^0[xX][0-9a-fA-F]+$/.test(s)) {
        if (s.replace(/^0[xX]0*/, '').length > 8) { throw FPError('bad-number', what + ': ' + s + ' is wider than 32 bits'); }
        n = parseInt(s.slice(2), 16);
      } else if (/^(0+|[1-9][0-9]*)$/.test(s)) {
        if (s.length > 10) { throw FPError('bad-number', what + ': ' + s + ' is out of range'); }
        n = parseInt(s, 10);
      } else {
        throw FPError('bad-number', what + ': "' + v + '" is not a decimal or 0x hex number');
      }
    } else {
      throw FPError('bad-number', what + ': expected a number or a hex string, got ' + (v === null ? 'null' : typeof v));
    }
    if (max !== undefined && n > max) { throw FPError('bad-number', what + ': ' + pyHex(n) + ' is above ' + pyHex(max)); }
    return n;
  }

  /* ---------- FF record format (ffcalc ffrecord.py) ---------- */

  function encode(chain, block, data) {
    if (!isInt(chain) || chain < 0 || chain > 31) { throw FPError('encode', 'chain out of range: ' + chain); }
    if (!isInt(block) || block < 0 || block > 1023) { throw FPError('encode', 'block out of range: ' + block); }
    if (!isInt(data) || data < 0 || data > 0xffff) { throw FPError('encode', 'data out of range: ' + data); }
    return data * 65536 + block * 64 + chain;
  }
  function hasBit5(word) { return ((word >>> 5) & 1) === 1; }
  function decode(word) {
    if (hasBit5(word)) { throw FPError('bit5', 'not an FF record (bit 5 set): ' + hex(word, 8)); }
    return { chain: word & 0x1f, block: (word >>> 6) & 0x3ff, data: (word >>> 16) & 0xffff };
  }

  function cloneBlocks(blocks) {
    var out = new Map();
    blocks.forEach(function (cb, chain) { out.set(chain, new Map(cb)); });
    return out;
  }
  function getBlock(blocks, chain, block) {
    var cb = blocks.get(chain);
    return cb && cb.has(block) ? cb.get(block) : 0;
  }
  function hasBlock(blocks, chain, block) {
    var cb = blocks.get(chain);
    return !!(cb && cb.has(block));
  }
  function setBlock(blocks, chain, block, value) {
    if (!blocks.has(chain)) { blocks.set(chain, new Map()); }
    blocks.get(chain).set(block, value);
  }
  function getBits(blocks, chain, bit, width) {
    var value = 0;
    for (var i = 0; i < width; i++) {
      var b = bit + i;
      var blk = getBlock(blocks, chain, Math.floor(b / 16));
      if ((blk >>> (b % 16)) & 1) { value += pow2(i); }
    }
    return value;
  }
  function setBits(blocks, chain, bit, width, value) {
    for (var i = 0; i < width; i++) {
      var b = bit + i;
      var k = Math.floor(b / 16);
      var blk = getBlock(blocks, chain, k);
      var v = Math.floor(value / pow2(i)) % 2;
      blk = ((blk & ~(1 << (b % 16))) | (v << (b % 16))) & 0xffff;
      setBlock(blocks, chain, k, blk);
    }
  }
  function blocksTouched(f) {
    var s = {};
    for (var i = 0; i < f.width; i++) { s[Math.floor((f.bit + i) / 16)] = true; }
    return Object.keys(s).map(Number).sort(sortNum);
  }
  function decodeField(blocks, f) { return getBits(blocks, f.chain, f.bit, f.width); }
  function decodeAll(blocks, fields) {
    var out = {};
    (fields || FIELDS).forEach(function (f) { out[f.key] = decodeField(blocks, f); });
    return out;
  }
  function magicFromBlocks(blocks) {
    return (getBlock(blocks, 2, 47) & 0x3ff) * pow2(22) + getBlock(blocks, 2, 46) * 64;
  }

  /* Replay the FF region: rows in order, the last record per (chain, block) wins. Refuses a bit-5 word. */
  function replayRows(rows) {
    var blocks = new Map();
    var origin = {};
    var records = [];
    var bad = null;
    var nums = [];
    rows.forEach(function (_v, r) { if (r >= FF_ROW_MIN && r <= FF_ROW_MAX) { nums.push(r); } });
    nums.sort(sortNum);
    for (var i = 0; i < nums.length; i++) {
      var row = nums[i];
      var word = rows.get(row);
      if (word === 0) { continue; }
      if (hasBit5(word)) { bad = { row: row, word: word }; break; }
      var d = decode(word);
      setBlock(blocks, d.chain, d.block, d.data);
      var k = blockKey(d.chain, d.block);
      if (origin[k] !== undefined) {
        records[origin[k].index].supersededBy = row;
      }
      origin[k] = { row: row, index: records.length };
      records.push({ row: row, word: word, chain: d.chain, block: d.block, data: d.data, supersededBy: null });
    }
    return { blocks: blocks, origin: origin, records: records, bit5: bad };
  }

  /* ---------- input parsing ---------- */

  /* ffcalc ffrows.parse_rows: '<row> <value>' lines, '#' comments, optional dmesg prefix and FFROW tag. */
  var ROW_LINE = /^\s*(?:\[[^\]]*\]\s*)?(?:FFROW\s+)?(0[xX][0-9a-fA-F]+|[0-9]+)\s+(0[xX][0-9a-fA-F]+|[0-9]+)\s*$/;
  function pyIntBase0(s, lineno, raw) {
    if (/^[0-9]+$/.test(s) && /^0[0-9]*[1-9]/.test(s)) {
      throw FPError('rows-parse', 'rows line ' + lineno + ': "' + s + '" has a leading zero (write it in decimal without one, or as 0x hex): ' + raw.trim());
    }
    return parseUInt(s, 'rows line ' + lineno);
  }
  function parseRowsText(text) {
    var out = new Map();
    var lines = String(text).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
    if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.split('#')[0];
      if (!line.trim()) { continue; }
      var m = ROW_LINE.exec(line);
      if (!m) { throw FPError('rows-parse', "rows line " + (i + 1) + ": expected '<row> <value>', got \"" + raw.trim().slice(0, 80) + '"'); }
      var row = pyIntBase0(m[1], i + 1, raw);
      var value = pyIntBase0(m[2], i + 1, raw);
      if (row > 511) { throw FPError('row-range', 'rows line ' + (i + 1) + ': physical row ' + row + ' out of range 0 to 511'); }
      if (value > 0xffffffff) { throw FPError('value-range', 'rows line ' + (i + 1) + ': value ' + pyHex(value) + ' out of 32-bit range'); }
      if (out.has(row) && out.get(row) !== value) {
        throw FPError('rows-dup', 'rows line ' + (i + 1) + ': row ' + row + ' given twice with different values (' + hex(out.get(row), 8) + ' and ' + hex(value, 8) + ')');
      }
      out.set(row, value);
    }
    if (out.size === 0) { throw FPError('rows-parse', 'no rows found in the input'); }
    return out;
  }

  function parseRowKey(k) {
    var row;
    try {
      row = parseUInt(k, 'ff_rows key');
    } catch (e) {
      if (/^\s*-/.test(String(k))) { throw FPError('row-range', 'fuse row out of range: ' + k); }
      throw e;
    }
    if (row > 511) { throw FPError('row-range', 'fuse row out of range: ' + k + ' (physical rows are 0 to 511)'); }
    return row;
  }

  function fromFfcalc(obj) {
    var card = { format: 'ffcalc', formatLabel: 'ffcalc card dump', notes: [], inputRefusals: [], ids: {} };
    var sku = obj.sku === undefined ? '8gb' : obj.sku;
    if (sku !== '8gb' && sku !== '10gb') { throw FPError('sku', 'sku must be "8gb" or "10gb", got ' + JSON.stringify(sku)); }
    card.sku = sku;
    card.skuFromInput = obj.sku !== undefined;
    if (obj.ff_rows !== undefined && obj.ff_rows !== null && (typeof obj.ff_rows !== 'object' || Array.isArray(obj.ff_rows))) {
      throw FPError('shape', 'ff_rows must be an object of "row": value pairs');
    }
    if (obj.option_words !== undefined && obj.option_words !== null && (typeof obj.option_words !== 'object' || Array.isArray(obj.option_words))) {
      throw FPError('shape', 'option_words must be an object');
    }
    var rows = new Map();
    var ffr = obj.ff_rows || {};
    Object.keys(ffr).forEach(function (k) {
      var row = parseRowKey(k);
      var v = parseUInt(ffr[k], 'ff_rows[' + k + ']', 0xffffffff);
      if (rows.has(row) && rows.get(row) !== v) { throw FPError('rows-dup', 'row ' + row + ' appears twice with different values'); }
      rows.set(row, v);
    });
    card.rows = rows.size ? rows : null;
    var words = {};
    var ow = obj.option_words || {};
    Object.keys(ow).forEach(function (k) { words[k] = parseUInt(ow[k], 'option_words.' + k, 0xffffffff); });
    card.words = words;
    var ignored = PCIE_KEYS.concat(['disable_gen3_speed_bit1', 'magic_d', 'pcie_devida', 'pcie_devidb']).filter(function (k) { return k in words; });
    if (ignored.length) {
      card.notes.push('Ignored option words: ' + ignored.join(', ') + '. ffcalc reads the PCIe registers at the chain bit position, which is not where these registers hold the field, so the PCIe state is read from the FF rows instead.');
    }
    if (typeof obj.uuid === 'string') { card.ids.uuid = obj.uuid; }
    if (typeof obj.fingerprint === 'string') { card.ids.fingerprint = obj.fingerprint; }
    card.pcieLive = null;
    return card;
  }

  /* vfi_snap.py register names -> ffcalc option-word keys (by register address, see ga100-fuses.json). */
  var VFI_MAP = [
    /* [ffcalc key, status reg name or null, fused reg name] */
    ['gpc_disable', 'GPC_STATUS', 'GPC_DISABLE'],
    ['pes_disable', null, 'PES_DISABLE'],
    ['fbp_disable', 'FBP_STATUS', 'FBP_DISABLE'],
    ['fbpa_disable', null, 'FBP_R_820368'],
    ['fbio_disable', null, 'FBIO_DISABLE'],
    ['rop_l2_disable', null, 'ROP_L2_DISABLE']
  ];
  var VFI_DEFECTIVE = [
    ['gpc_defective', 'GPC_DEFECTIVE'],
    ['pes_defective', 'PES_DEFECTIVE'],
    ['fbp_defective', 'FBP_DEFECTIVE'],
    ['fbpa_defective', 'FBPA_DEFECTIVE'],
    ['fbio_defective', 'FBIO_DEFECTIVE'],
    ['rop_l2_defective', 'ROP_L2_DEFECTIVE']
  ];
  var VFI_PCIE = [
    ['disable_gen3_speed_bit9', 'OPT_DISABLE_GEN3_SPEED', 0],
    ['pcie_magic_gen4_dis', 'OPT_PCIE_MAGIC_BITS_D', 25],
    ['pcie_boot_gen23_dis', 'OPT_PCIE_BOOT_GEN23_DIS', 0],
    ['pcie_boot_gen3_dis', 'OPT_PCIE_BOOT_GEN3_DIS', 0]
  ];

  function fromVfiSnap(obj) {
    var card = { format: 'vfi_snap', formatLabel: 'vfi_snap snapshot', notes: [], inputRefusals: [], ids: {} };
    var ident = obj.identity;
    if (!ident || typeof ident !== 'object') { throw FPError('shape', 'snapshot has no identity block'); }
    var vendor = parseUInt(ident.vendor, 'identity.vendor');
    var device = parseUInt(ident.device, 'identity.device');
    if (vendor !== 0x10de) { throw FPError('sku', 'identity.vendor ' + pyHex(vendor) + ' is not NVIDIA (0x10de)'); }
    if (device === SKUS['8gb'].device) { card.sku = '8gb'; } else if (device === SKUS['10gb'].device) { card.sku = '10gb'; } else {
      throw FPError('sku', 'identity.device ' + pyHex(device) + ' is not a CMP 170HX (0x20c2 for 8 GB, 0x2082 for 10 GB)');
    }
    card.skuFromInput = true;
    var regs = obj.regs;
    if (!regs || typeof regs !== 'object') { throw FPError('shape', 'snapshot has no regs block'); }
    function reg(name) {
      if (regs[name] === undefined) { return undefined; }
      return parseUInt(regs[name], 'regs.' + name, 0xffffffff);
    }
    var words = {};
    function put(key, status, fused) {
      if (status === undefined && fused === undefined) { return; }
      var cur = status !== undefined ? status : fused;
      words[key] = cur;
      if (status !== undefined && fused !== undefined && status !== fused) { words[key + '__fused'] = fused; }
    }
    VFI_MAP.forEach(function (m) { put(m[0], m[1] ? reg(m[1]) : undefined, reg(m[2])); });
    VFI_DEFECTIVE.forEach(function (m) { var v = reg(m[1]); if (v !== undefined) { words[m[0]] = v; } });
    var pg = obj.per_gpc || {};
    function gpcList(name) {
      var a = pg[name];
      if (a === undefined) { return null; }
      if (!Array.isArray(a) || a.length !== TOTAL_GPC) { throw FPError('shape', 'per_gpc.' + name + ' must list 8 values'); }
      return a.map(function (v, i) { return parseUInt(v, 'per_gpc.' + name + '[' + i + ']', 0xffffffff); });
    }
    var tStatus = gpcList('tpc_status');
    var tFused = gpcList('tpc_disable');
    var tDef = gpcList('tpc_defective');
    for (var i = 0; i < TOTAL_GPC; i++) {
      put('tpc_gpc' + i + '_disable', tStatus ? tStatus[i] : undefined, tFused ? tFused[i] : undefined);
      if (tDef) { words['tpc_gpc' + i + '_defective'] = tDef[i]; }
    }
    card.words = words;
    var live = {};
    var haveLive = false;
    VFI_PCIE.forEach(function (m) {
      var v = reg(m[1]);
      if (v === undefined) { return; }
      haveLive = true;
      live[m[0]] = { raw: v, value: Math.floor(v / pow2(m[2])) % 2, regBit: m[2], reg: m[1] };
    });
    card.pcieLive = haveLive ? live : null;

    if (obj.die_id_match === false) {
      card.inputRefusals.push('The snapshot says the die ID differs from the dump it was compared with (die_id_match false): this may not be the card you think it is.');
    }
    if (obj.rows !== undefined) {
      if (!Array.isArray(obj.rows)) { throw FPError('shape', 'rows must be a list of 512 values'); }
    }
    if (obj.rows_error) {
      card.inputRefusals.push('The snapshot reports a failed row read (rows_error). Read the card again.');
    }
    if (obj.state_unchanged_by_row_read === false) {
      card.inputRefusals.push('The gate or status registers changed during the row read (state_unchanged_by_row_read false). Read the card again.');
    }
    card.rows = null;
    if (Array.isArray(obj.rows)) {
      if (obj.rows_match !== true) {
        card.inputRefusals.push('The two passes of the 512-row read did not match (rows_match is ' + JSON.stringify(obj.rows_match) + '). The FF rows from this snapshot are not used. Read the card again.');
      } else if (obj.rows.length !== N_ROWS) {
        card.inputRefusals.push('The snapshot lists ' + obj.rows.length + ' rows, not 512. The FF rows from this snapshot are not used.');
      } else {
        var rows = new Map();
        obj.rows.forEach(function (v, r) { rows.set(r, parseUInt(v, 'rows[' + r + ']', 0xffffffff)); });
        card.rows = rows;
      }
    } else if (!obj.rows_error) {
      card.notes.push('No FF rows in this snapshot (it was not taken with --rows): analysis only, no records.');
    }
    if (isInt(obj.sm_status_now) && isInt(obj.sm_ceiling_nondefective)) {
      card.snapCheck = { smNow: obj.sm_status_now, smCeiling: obj.sm_ceiling_nondefective };
    }
    card.notes.push('NVLink and SYS_PIPE masks are not in a vfi_snap snapshot, so those groups cannot be planned from it.');
    return card;
  }

  function parseInput(text) {
    var t = String(text || '');
    if (!t.trim()) { throw FPError('empty', 'Nothing to read: paste a read or drop a file.'); }
    var first = t.replace(/^\uFEFF/, '').trim().charAt(0);
    if (first === '{' || first === '[') {
      var obj;
      try { obj = JSON.parse(t.replace(/^\uFEFF/, '')); } catch (e) { throw FPError('json', 'The input looks like JSON but does not parse: ' + e.message); }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { throw FPError('json', 'Expected a JSON object (an ffcalc card dump or a vfi_snap snapshot).'); }
      var isSnap = 'regs' in obj || 'per_gpc' in obj || 'rows_match' in obj;
      var isDump = 'option_words' in obj || 'ff_rows' in obj;
      if (isSnap && isDump) { throw FPError('json', 'The JSON has fields of both an ffcalc dump and a vfi_snap snapshot; refusing to guess which it is.'); }
      if (isSnap) { return fromVfiSnap(obj); }
      if (isDump) { return fromFfcalc(obj); }
      throw FPError('json', 'Unrecognised JSON: an ffcalc card dump has option_words and ff_rows; a vfi_snap snapshot has regs, per_gpc and rows.');
    }
    var rows = parseRowsText(t);
    return { format: 'rows', formatLabel: 'rows file', sku: null, skuFromInput: false, rows: rows, words: null,
      pcieLive: null, notes: ['A rows file has no defective masks: this is a decoded view of the current FF records only, with no targets.'],
      inputRefusals: [], ids: {} };
  }

  /* ---------- analysis ---------- */

  function coverageOf(rows) {
    if (!rows) { return { state: 'missing', missing: N_FF_ROWS }; }
    var missing = [];
    var any = false;
    for (var r = FF_ROW_MIN; r <= FF_ROW_MAX; r++) { if (rows.has(r)) { any = true; } else { missing.push(r); } }
    if (!any) { return { state: 'missing', missing: missing.length, missingRows: missing }; }
    return { state: missing.length ? 'partial' : 'complete', missing: missing.length, missingRows: missing };
  }

  function pairExpand(fbp) {
    var v = 0;
    for (var n = 0; n < TOTAL_FBP; n++) { if (Math.floor(fbp / pow2(n)) % 2) { v += pow2(2 * n) + pow2(2 * n + 1); } }
    return v;
  }

  function smFrom(gpcMask, tpcMasks) {
    var per = [];
    var total = 0;
    for (var i = 0; i < TOTAL_GPC; i++) {
      if ((gpcMask >>> i) & 1) { per.push(0); continue; }
      var t = TPC_PER_GPC - popcount(tpcMasks[i] & 0xff);
      per.push(t * SM_PER_TPC);
      total += t * SM_PER_TPC;
    }
    return { perGpc: per, total: total };
  }

  function wordOr(words, key) { return words && Object.prototype.hasOwnProperty.call(words, key) ? words[key] : undefined; }
  function liveWord(words, key) {
    var f = wordOr(words, key + '__fused');
    return f !== undefined ? f : wordOr(words, key);
  }

  function computeAnalysis(card, sku) {
    var w = card.words;
    var a = { sm: null, fbp: null, masks: null, layout: null };
    if (!w) { return a; }
    var gib = SKUS[sku].gibPerFbp;
    var i;
    var tpcNow = [];
    var tpcFused = [];
    var tpcDef = [];
    var nowOk = wordOr(w, 'gpc_disable') !== undefined;
    var defOk = wordOr(w, 'gpc_defective') !== undefined;
    for (i = 0; i < TOTAL_GPC; i++) {
      var k = 'tpc_gpc' + i;
      tpcNow.push(wordOr(w, k + '_disable'));
      tpcFused.push(liveWord(w, k + '_disable'));
      tpcDef.push(wordOr(w, k + '_defective'));
      if (tpcNow[i] === undefined) { nowOk = false; }
      if (tpcDef[i] === undefined) { defOk = false; }
    }
    var sm = { now: null, fused: null, ceiling: null, gpcDefective: null, gpcDisabledNow: null };
    if (nowOk) {
      sm.now = smFrom(w.gpc_disable, tpcNow);
      sm.gpcDisabledNow = [];
      for (i = 0; i < TOTAL_GPC; i++) { sm.gpcDisabledNow.push(((w.gpc_disable >>> i) & 1) === 1); }
      var fusedSm = smFrom(liveWord(w, 'gpc_disable'), tpcFused);
      if (fusedSm.total !== sm.now.total || fusedSm.perGpc.join() !== sm.now.perGpc.join()) { sm.fused = fusedSm; }
    }
    if (defOk) {
      sm.ceiling = smFrom(w.gpc_defective, tpcDef);
      sm.gpcDefective = [];
      for (i = 0; i < TOTAL_GPC; i++) { sm.gpcDefective.push(((w.gpc_defective >>> i) & 1) === 1); }
    }
    a.sm = sm;

    var fbp = { gibPerFbp: gib };
    var fNow = wordOr(w, 'fbp_disable');
    var fDef = wordOr(w, 'fbp_defective');
    if (fNow !== undefined) {
      fbp.nowMask = fNow;
      fbp.nowActive = TOTAL_FBP - popcount(fNow & 0xfff);
      fbp.nowGib = fbp.nowActive * gib;
    }
    if (fDef !== undefined) {
      fbp.defMask = fDef;
      fbp.defCount = popcount(fDef & 0xfff);
      fbp.ceilActive = TOTAL_FBP - fbp.defCount;
      fbp.ceilGib = fbp.ceilActive * gib;
    }
    a.fbp = fbp;

    var masks = { now: [], target: [] };
    ['fbio_disable', 'fbpa_disable', 'rop_l2_disable'].forEach(function (key) {
      var f = BY_KEY[key];
      var now = wordOr(w, key);
      var def = wordOr(w, f.defectKey);
      if (now !== undefined && fNow !== undefined) {
        masks.now.push({ key: key, name: f.name, value: now, expected: pairExpand(fNow & 0xfff), equal: now === pairExpand(fNow & 0xfff) });
      } else {
        masks.now.push({ key: key, name: f.name, value: now, expected: fNow !== undefined ? pairExpand(fNow & 0xfff) : undefined, equal: null });
      }
      if (def !== undefined && fDef !== undefined) {
        masks.target.push({ key: key, name: f.name, value: def, expected: pairExpand(fDef & 0xfff), equal: def === pairExpand(fDef & 0xfff) });
      } else {
        masks.target.push({ key: key, name: f.name, value: def, expected: fDef !== undefined ? pairExpand(fDef & 0xfff) : undefined, equal: null });
      }
    });
    a.masks = masks;

    var layout = { verdict: 'unknown', text: 'The FBP defective mask is missing, so the memory layout after a burn is unknown.' };
    if (fDef !== undefined) {
      var targetPairs = masks.target.every(function (m) { return m.equal === true; });
      if (sku === '10gb') {
        layout = { verdict: 'na', text: 'The 80 GB rule is for the 8 GB card. On the 10 GB card each FBP is 4 GiB: ' + fbp.ceilActive + ' of 12 FBPs is ' + fbp.ceilGib + ' GiB at most.' };
      } else if (fbp.defCount === 4) {
        layout = { verdict: 'dud64', text: '64 GB card: 4 FBPs are marked defective, so the card stays at 64 GiB (8 of 12 FBPs) whatever you burn. It can still gain SMs and PCIe.' };
      } else if (fbp.ceilActive === 10 && targetPairs) {
        layout = { verdict: '80gb', text: '80 GB layout: exactly 10 of 12 FBPs active after the burn, and the FBIO, FBPA and ROP_L2 targets equal the pair expansion of the FBP target.' };
      } else if (fbp.ceilActive === 10) {
        layout = { verdict: 'pairs', text: '10 of 12 FBPs after the burn, but the FBIO, FBPA or ROP_L2 target is not the pair expansion of the FBP target: this is not the tested 80 GB layout.' };
      } else {
        layout = { verdict: 'other', text: fbp.ceilActive + ' of 12 FBPs after the burn (' + fbp.ceilGib + ' GiB): neither the tested 80 GB layout (exactly 10 of 12) nor the 64 GB case (4 marked defective).' };
      }
    }
    a.layout = layout;
    return a;
  }

  function pcieState(card, blocks) {
    return PCIE_KEYS.map(function (key) {
      var f = BY_KEY[key];
      var ff = blocks ? decodeField(blocks, f) : null;
      var live = card.pcieLive && card.pcieLive[key] ? card.pcieLive[key] : null;
      return { key: key, name: f.name, loc: f.loc, reg: f.reg, ff: ff, live: live ? live.value : null, liveRaw: live ? live.raw : null };
    });
  }

  /* ---------- planning ---------- */

  function normGroups(groups) {
    var g = {};
    GROUP_ORDER.forEach(function (id) {
      g[id] = groups && Object.prototype.hasOwnProperty.call(groups, id) ? !!groups[id] : GROUPS[id].def;
    });
    return g;
  }

  /* Targets by ffcalc's rule: each floorsweep field's target is its defective word; the four PCIe fields go to 0. */
  function resolveTargets(card, groups) {
    var targets = {};
    var missing = [];
    var w = card.words || {};
    FIELDS.forEach(function (f) {
      if (!groups[f.group]) { return; }
      if (f.group === 'pcie') { targets[f.key] = 0; return; }
      var def = wordOr(w, f.defectKey);
      var cur = wordOr(w, f.key);
      if (def === undefined) { missing.push(f.defectKey); }
      if (cur === undefined) { missing.push(f.key); }
      if (def !== undefined) { targets[f.key] = def; }
    });
    return { targets: targets, missing: missing };
  }

  function ownerOf(chain, bitIndex) { return BIT_OWNER[chain + ':' + bitIndex] || null; }

  function describeChanges(chain, block, oldV, newV) {
    var out = [];
    for (var b = 0; b < 16; b++) {
      var o = (oldV >>> b) & 1;
      var n = (newV >>> b) & 1;
      if (o === n) { continue; }
      var own = ownerOf(chain, block * 16 + b);
      out.push({ bit: b, from: o, to: n, field: own ? own.field.key : null, fieldName: own ? own.field.name : null,
        fieldBit: own ? own.index : null, group: own ? own.field.group : null });
    }
    return out;
  }

  function orderBlocks(changed) {
    var seq = [];
    var placed = {};
    GROUP_ORDER.forEach(function (g) {
      var inG = changed.filter(function (c) { return c.groups.indexOf(g) >= 0; });
      inG.sort(function (x, y) { return x.chain - y.chain || x.block - y.block; });
      var last = LAST_BLOCK[g];
      if (last) {
        var idx = -1;
        inG.forEach(function (c, i) { if (blockKey(c.chain, c.block) === last) { idx = i; } });
        if (idx >= 0) { inG.push(inG.splice(idx, 1)[0]); }
      }
      inG.forEach(function (c) {
        var k = blockKey(c.chain, c.block);
        if (placed[k]) { return; }
        placed[k] = g;
        c.placedIn = g;
        seq.push(c);
      });
    });
    return seq;
  }

  function sharedBlockWarning(c) {
    return 'Chain ' + c.chain + ' block ' + c.block + ' carries changes for ' +
      c.groups.map(function (g) { return GROUPS[g].label.toLowerCase(); }).join(' and ') +
      '. It is written once, at row ' + c.row + ' in the ' + GROUPS[c.placedIn].label.toLowerCase() +
      ' set (its earlier position), with all of those changes; the later set does not repeat it.';
  }

  function checkLive(card, current, blocks, refusals, warnings, info) {
    var w = card.words;
    if (w) {
      FIELDS.forEach(function (f) {
        if (f.group === 'pcie') { return; }
        var live = liveWord(w, f.key);
        if (live === undefined) { return; }
        if (live > fieldMask(f.width)) {
          refusals.push(f.name + ': the live register reads ' + pyHex(live) + ', which has bits outside the ' + f.width + '-bit field. The read does not fit the field map.');
          return;
        }
        info.checked.push(f.key);
        if (live !== current[f.key]) {
          refusals.push(f.name + ': the card reports ' + pyHex(live) + ' but the FF rows replay to ' + pyHex(current[f.key]) +
            '. The existing records do not explain the live mask, so the old block values cannot be trusted.');
        }
      });
    }
    if (card.pcieLive) {
      PCIE_KEYS.forEach(function (key) {
        var l = card.pcieLive[key];
        if (!l) { return; }
        var f = BY_KEY[key];
        info.checked.push(key);
        if (l.value !== current[key]) {
          refusals.push(f.name + ': the register reads ' + l.value + ' but ' + f.loc + ' replays to ' + current[key] + '. The FF rows do not explain the live PCIe state.');
        }
        if (l.regBit === 0 && l.raw > 1) {
          warnings.push(f.name + ' (' + f.reg + ') reads ' + hex(l.raw, 8) + ': bits other than bit 0 are set, which the lab has not seen.');
        }
      });
      var m = card.pcieLive.pcie_magic_gen4_dis;
      if (m) {
        var b47 = getBlock(blocks, 2, 47) & 0x3ff;
        if (Math.floor(m.raw / pow2(22)) !== b47) {
          refusals.push('PCIE_MAGIC_BITS_D reads ' + hex(m.raw, 8) + ': bits 22 to 31 should equal chain 2 block 47 bits 0 to 9 (' + hex(b47, 3) + ' from the FF rows) and do not. Block 47 cannot be rewritten safely.');
        } else if (m.raw !== magicFromBlocks(blocks)) {
          warnings.push('PCIE_MAGIC_BITS_D reads ' + hex(m.raw, 8) + ' but (block47 << 22) | (block46 << 6) from the FF rows gives ' + hex(magicFromBlocks(blocks), 8) + '. The plan never writes block 46; check your read.');
        }
      }
    }
  }

  function checkDefective(card, groups, targets, current, refusals, warnings) {
    var w = card.words || {};
    FIELDS.forEach(function (f) {
      if (!groups[f.group] || f.group === 'pcie' || targets[f.key] === undefined) { return; }
      var def = w[f.defectKey];
      var tgt = targets[f.key];
      var cur = current[f.key];
      if (def > fieldMask(f.width)) {
        refusals.push(f.defectKey + ' reads ' + pyHex(def) + ', wider than the ' + f.width + '-bit ' + f.name + ' field. The read does not fit the field map.');
        return;
      }
      if ((tgt & def) !== def) {
        refusals.push(f.name + ': target ' + pyHex(tgt) + ' does not contain the defective mask ' + pyHex(def) + ' and would enable a unit marked defective.');
      }
      var enabling = andNot(cur, tgt);
      if (enabling & def) {
        refusals.push(f.name + ': the plan would clear bits ' + bitsOf(enabling & def, f.width).join(', ') + ', which are marked defective.');
      }
      var disabling = andNot(tgt, cur);
      if (disabling) {
        warnings.push(f.name + ': the target sets bits ' + bitsOf(disabling, f.width).join(', ') + ' that are clear now, so the plan turns off units that are on now (they are marked defective).');
      }
    });
    if (groups.memory && targets.fbp_disable !== undefined) {
      var fbpDef = w.fbp_defective & 0xfff;
      ['fbio_disable', 'fbpa_disable', 'rop_l2_disable'].forEach(function (key) {
        var f = BY_KEY[key];
        if (targets[key] === undefined) { return; }
        var en = andNot(current[key], targets[key]);
        bitsOf(en, 24).forEach(function (k) {
          var n = Math.floor(k / 2);
          if ((fbpDef >>> n) & 1) {
            refusals.push(f.name + ': the plan would enable bit ' + k + ', which belongs to FBP ' + n + ', and FBP ' + n + ' is marked defective.');
          }
        });
      });
      var fbpEn = andNot(current.fbp_disable, targets.fbp_disable) & 0xfff;
      bitsOf(fbpEn, 12).forEach(function (n) {
        ['fbio_defective', 'fbpa_defective', 'rop_l2_defective'].forEach(function (dk) {
          var d = w[dk];
          if (d === undefined) { return; }
          if (((d >>> (2 * n)) & 1) || ((d >>> (2 * n + 1)) & 1)) {
            refusals.push('OPT_FBP_DISABLE: the plan would enable FBP ' + n + ', but ' + dk + ' marks its bits ' + (2 * n) + '/' + (2 * n + 1) + ' defective.');
          }
        });
      });
    }
    if (groups.compute && targets.gpc_disable !== undefined) {
      var gdef = w.gpc_defective;
      for (var g = 0; g < TOTAL_GPC; g++) {
        var tk = 'tpc_gpc' + g + '_disable';
        if ((gdef >>> g) & 1) {
          var tEn = targets[tk] !== undefined ? andNot(current[tk], targets[tk]) & 0xff : 0;
          var pEn = targets.pes_disable !== undefined ? (andNot(current.pes_disable, targets.pes_disable) >>> (PES_PER_GPC * g)) & 7 : 0;
          if (tEn || pEn) {
            warnings.push('GPC ' + g + ' is marked defective and stays disabled. The plan still sets its TPC and PES fields to their defective words, as ffcalc does; that has no effect while the GPC is off.');
          }
        } else if (targets[tk] !== undefined && (targets[tk] & 0xff) === 0xff && !((targets.gpc_disable >>> g) & 1)) {
          warnings.push('GPC ' + g + ' stays enabled but all 8 of its TPCs are marked defective.');
        }
      }
    }
  }

  /* The plan's own simulation: replay existing rows plus the plan and check every rule. */
  function simulatePlan(rows, records, targets, selectedKeys) {
    var errors = [];
    var warnings = [];
    var checks = 0;
    function fail(msg) { errors.push(msg); }
    var cov = coverageOf(rows);
    checks++;
    if (cov.state !== 'complete') {
      fail('FF rows ' + FF_ROW_MIN + ' to ' + FF_ROW_MAX + ' are not all present (' + cov.missing + ' missing).');
      return { ok: false, errors: errors, warnings: warnings, checks: checks };
    }
    var base;
    try { base = replayRows(rows); } catch (e) { fail('Replay failed: ' + e.message); return { ok: false, errors: errors, warnings: warnings, checks: checks }; }
    checks++;
    if (base.bit5) { fail('Row ' + base.bit5.row + ' has bit 5 set.'); return { ok: false, errors: errors, warnings: warnings, checks: checks }; }
    var used = [];
    rows.forEach(function (v, r) { if (r >= FF_ROW_MIN && r <= FF_ROW_MAX && v !== 0) { used.push(r); } });
    var maxUsed = used.length ? Math.max.apply(null, used) : FF_ROW_MIN - 1;
    var after = cloneBlocks(base.blocks);
    var seenRows = {};
    var seenBlocks = {};
    var merged = new Map(rows);
    records.forEach(function (rec) {
      var row = rec.row;
      var tag = 'row ' + row + ': ';
      checks += 10;
      if (!isInt(row) || row < FF_ROW_MIN || row > FF_ROW_MAX) { fail(tag + 'outside the FF rows ' + FF_ROW_MIN + ' to ' + FF_ROW_MAX + '.'); }
      if (!rows.has(row) || rows.get(row) !== 0) { fail(tag + 'is not blank in the read (' + (rows.has(row) ? hex(rows.get(row), 8) : 'missing') + ').'); }
      if (isInt(row) && row <= maxUsed) { fail(tag + 'is not after the last used row ' + maxUsed + '.'); }
      if (seenRows[row]) { fail(tag + 'used by two records.'); }
      seenRows[row] = true;
      var w = rec.word;
      if (!isInt(w) || w < 0 || w > 0xffffffff) { fail(tag + 'word is not a 32-bit value.'); return; }
      if (hasBit5(w)) { fail(tag + 'word ' + hex(w, 8) + ' has bit 5 set: inside the FF rows that ends the FF pool.'); }
      var enc;
      try { enc = encode(rec.chain, rec.block, rec.newValue); } catch (e) { fail(tag + e.message); return; }
      if (enc !== w) { fail(tag + 'word ' + hex(w, 8) + ' does not encode chain ' + rec.chain + ' block ' + rec.block + ' data ' + hex(rec.newValue, 4) + ' (' + hex(enc, 8) + ').'); }
      if (!hasBit5(w)) {
        var d = decode(w);
        if (d.chain !== rec.chain || d.block !== rec.block || d.data !== rec.newValue) { fail(tag + 'decode of the word does not give back chain, block and data.'); }
        if (encode(d.chain, d.block, d.data) !== w) { fail(tag + 'encode of the decoded word does not give the word back.'); }
      }
      var k = blockKey(rec.chain, rec.block);
      if (seenBlocks[k]) { fail(tag + 'second record for chain ' + rec.chain + ' block ' + rec.block + '.'); }
      seenBlocks[k] = true;
      var oldReplayed = getBlock(base.blocks, rec.chain, rec.block);
      if (rec.oldValue !== oldReplayed) { fail(tag + 'planned old value ' + hex(rec.oldValue, 4) + ' is not the replayed ' + hex(oldReplayed, 4) + '.'); }
      if (rec.newValue === rec.oldValue) { fail(tag + 'record changes nothing.'); }
      setBlock(after, rec.chain, rec.block, rec.newValue);
      merged.set(row, w);
    });
    var rep;
    checks++;
    try { rep = replayRows(merged); } catch (e) { fail('Replay of the read plus the plan failed: ' + e.message); }
    if (rep) {
      if (rep.bit5) { fail('Replay of the read plus the plan stops at row ' + rep.bit5.row + ' (bit 5).'); }
      var allKeys = {};
      [rep.blocks, after].forEach(function (bl) { bl.forEach(function (cb, c) { cb.forEach(function (_v, b) { allKeys[blockKey(c, b)] = [c, b]; }); }); });
      Object.keys(allKeys).forEach(function (k) {
        var cb = allKeys[k];
        if (getBlock(rep.blocks, cb[0], cb[1]) !== getBlock(after, cb[0], cb[1])) { fail('Chain ' + cb[0] + ' block ' + cb[1] + ': replaying the rows gives a different value than applying the plan.'); }
      });
      var before = decodeAll(base.blocks, FIELDS.concat(KEEP_FIELDS));
      var now = decodeAll(rep.blocks, FIELDS.concat(KEEP_FIELDS));
      FIELDS.concat(KEEP_FIELDS).forEach(function (f) {
        checks++;
        if (selectedKeys.indexOf(f.key) >= 0) {
          if (now[f.key] !== targets[f.key]) { fail(f.name + ': after the plan it decodes to ' + pyHex(now[f.key]) + ', target ' + pyHex(targets[f.key]) + '.'); }
        } else if (now[f.key] !== before[f.key]) {
          fail(f.name + ': changed from ' + pyHex(before[f.key]) + ' to ' + pyHex(now[f.key]) + ' but it is not a planned field.');
        }
      });
      checks++;
      var magicDelta = (magicFromBlocks(base.blocks) ^ magicFromBlocks(rep.blocks)) >>> 0;
      var allowed = selectedKeys.indexOf('pcie_magic_gen4_dis') >= 0 ? (1 << 25) : 0;
      if (andNot(magicDelta, allowed)) { fail('PCIE_MAGIC_BITS_D would change outside bit 25.'); }
      records.forEach(function (rec) {
        describeChanges(rec.chain, rec.block, rec.oldValue, rec.newValue).forEach(function (c) {
          checks++;
          if (!c.field || selectedKeys.indexOf(c.field) < 0) { fail('row ' + rec.row + ': bit ' + c.bit + ' of chain ' + rec.chain + ' block ' + rec.block + ' changes but belongs to no planned field.'); }
        });
      });
    }
    var lastRow = records.length ? records[records.length - 1].row : maxUsed;
    var remaining = FF_ROW_MAX - Math.max(lastRow, maxUsed);
    if (records.length && remaining < RESERVE_ROWS) {
      warnings.push('Only ' + remaining + ' blank FF rows would remain after row ' + lastRow + '. The lab keeps 16 in reserve for corrections.');
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings, checks: checks, remaining: remaining, maxUsed: maxUsed };
  }

  function run(text, opts) {
    opts = opts || {};
    var report = { ok: true, errors: [], refusals: [], warnings: [], notes: [], card: null, sku: null, groups: normGroups(opts.groups) };
    var card;
    try {
      card = parseInput(text);
    } catch (e) {
      if (!e.fp) { throw e; }
      report.ok = false;
      report.errors.push(e.message);
      report.errorCode = e.code;
      return report;
    }
    report.card = card;
    report.notes = card.notes.slice();
    var skuChoice = opts.sku || 'auto';
    var sku = card.sku;
    if (skuChoice !== 'auto') {
      if (!SKUS[skuChoice]) { report.ok = false; report.errors.push('Unknown SKU ' + skuChoice); return report; }
      if (card.skuFromInput && card.sku !== skuChoice) {
        report.ok = false;
        report.errors.push('The input says ' + SKUS[card.sku].label + ' but the SKU selector says ' + SKUS[skuChoice].label + '. Set the selector to match your card.');
        return report;
      }
      sku = skuChoice;
    }
    if (!sku) { sku = '8gb'; }
    report.sku = sku;
    var groups = report.groups;

    report.coverage = coverageOf(card.rows);
    var rep = null;
    if (card.rows) {
      rep = replayRows(card.rows);
      report.decoded = rep.records;
      if (rep.bit5) {
        report.bit5 = rep.bit5;
        report.refusals.push('Row ' + rep.bit5.row + ' holds ' + hex(rep.bit5.word, 8) + ', which has bit 5 set. Inside the FF rows that word ends the FF pool for the boot parser, so later rows are ignored; ffcalc\'s replay refuses it too. The FF state cannot be read past it.');
        rep = null;
      }
    }
    var used = [];
    if (card.rows) { card.rows.forEach(function (v, r) { if (r >= FF_ROW_MIN && r <= FF_ROW_MAX && v !== 0) { used.push(r); } }); }
    used.sort(sortNum);
    report.used = used.length;
    report.lastUsed = used.length ? used[used.length - 1] : null;
    if (card.rows && report.coverage.state === 'complete') {
      report.blank = N_FF_ROWS - used.length;
      report.appendable = FF_ROW_MAX - (report.lastUsed === null ? FF_ROW_MIN - 1 : report.lastUsed);
      var gap = [];
      for (var r = FF_ROW_MIN; r < (report.lastUsed || FF_ROW_MIN); r++) { if (card.rows.get(r) === 0) { gap.push(r); } }
      if (gap.length) {
        var run8 = 0;
        var best = 0;
        for (var g = FF_ROW_MIN; g < report.lastUsed; g++) { if (card.rows.get(g) === 0) { run8++; best = Math.max(best, run8); } else { run8 = 0; } }
        report.warnings.push(gap.length + ' blank row(s) sit before the last used row ' + report.lastUsed + ' (first: ' + fmtRows(gap, 4) + ', longest run ' + best + '). New records go after row ' + report.lastUsed + ' as ffcalc does. Where the boot parser stops on blank rows has not been settled, so check that the records after the gap are applied on your card.');
      }
    }
    report.current = rep ? decodeAll(rep.blocks) : null;
    report.pcie = pcieState(card, rep ? rep.blocks : null);
    if (rep) { report.magicFromRows = magicFromBlocks(rep.blocks); }
    if (card.pcieLive && card.pcieLive.pcie_magic_gen4_dis) { report.magicLive = card.pcieLive.pcie_magic_gen4_dis.raw; }
    report.analysis = computeAnalysis(card, sku);

    if (card.snapCheck && report.analysis.sm) {
      var sm = report.analysis.sm;
      if ((sm.now && sm.now.total !== card.snapCheck.smNow) || (sm.ceiling && sm.ceiling.total !== card.snapCheck.smCeiling)) {
        report.refusals.push('The snapshot\'s own SM counts (now ' + card.snapCheck.smNow + ', ceiling ' + card.snapCheck.smCeiling + ') differ from what this page computes from the same registers (now ' +
          (sm.now ? sm.now.total : '?') + ', ceiling ' + (sm.ceiling ? sm.ceiling.total : '?') + '). The file may have been edited.');
      }
    }

    /* Planning */
    report.plan = null;
    card.inputRefusals.forEach(function (m) { report.refusals.push(m); });
    if (!card.words) {
      report.planState = 'none';
      return finish(report);
    }
    var tg = resolveTargets(card, groups);
    report.targets = tg.targets;
    if (tg.missing.length) {
      var byGroup = {};
      tg.missing.forEach(function (k) {
        var f = BY_KEY[k] || FIELDS.filter(function (x) { return x.defectKey === k; })[0];
        var gname = f ? f.group : '?';
        (byGroup[gname] = byGroup[gname] || []).push(k);
      });
      Object.keys(byGroup).forEach(function (gname) {
        report.refusals.push((GROUPS[gname] ? GROUPS[gname].label : gname) + ' is ticked but the input lacks ' + byGroup[gname].join(', ') + '. Untick ' + (GROUPS[gname] ? GROUPS[gname].label : gname) + ' to plan the rest.');
      });
    }
    var anyGroup = GROUP_ORDER.some(function (id) { return groups[id]; });
    if (!anyGroup) { report.refusals.push('No group is ticked.'); }
    if (report.coverage.state !== 'complete') {
      report.refusals.push(report.coverage.state === 'missing'
        ? 'No FF rows in the input: the current FF records of this card were never read. No records without a complete read of rows ' + FF_ROW_MIN + ' to ' + FF_ROW_MAX + '.'
        : 'The read covers only ' + (N_FF_ROWS - report.coverage.missing) + ' of ' + N_FF_ROWS + ' FF rows (missing ' + fmtRows(report.coverage.missingRows) + '). Unburnt rows must be listed as 0. No records without a complete read.');
    }
    if (!rep || report.refusals.length) {
      report.planState = 'refused';
      return finish(report);
    }

    var info = { checked: [] };
    checkLive(card, report.current, rep.blocks, report.refusals, report.warnings, info);
    report.liveChecked = info.checked;
    checkDefective(card, groups, tg.targets, report.current, report.refusals, report.warnings);
    if (report.analysis.layout && groups.memory && ['pairs', 'other'].indexOf(report.analysis.layout.verdict) >= 0) {
      report.warnings.push(report.analysis.layout.text);
    }
    if (sku === '10gb' && groups.pcie) {
      report.warnings.push('The PCIe fuse facts on this page were measured on 8 GB cards.');
    }

    var base = rep.blocks;
    var pending = cloneBlocks(base);
    var selected = [];
    FIELDS.forEach(function (f) {
      if (!groups[f.group] || tg.targets[f.key] === undefined) { return; }
      var cur = getBits(pending, f.chain, f.bit, f.width);
      if (cur === tg.targets[f.key]) { return; }
      setBits(pending, f.chain, f.bit, f.width, tg.targets[f.key]);
      selected.push(f);
    });
    var changed = [];
    pending.forEach(function (cb, chain) {
      cb.forEach(function (nv, block) {
        var ov = getBlock(base, chain, block);
        if (ov === nv) { return; }
        var ch = describeChanges(chain, block, ov, nv);
        var gs = [];
        ch.forEach(function (c) { if (c.group && gs.indexOf(c.group) < 0) { gs.push(c.group); } });
        gs.sort(function (a, b) { return GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b); });
        if (!hasBlock(base, chain, block)) {
          report.refusals.push('Chain ' + chain + ' block ' + block + ' needs a change, but no FF row holds a record for it, so its other bits are unknown (ffcalc would assume 0). Not planning it.');
        }
        changed.push({ chain: chain, block: block, oldValue: ov, newValue: nv, changes: ch, groups: gs,
          fields: selected.filter(function (f) { return f.chain === chain && blocksTouched(f).indexOf(block) >= 0; }).map(function (f) { return f.key; }) });
      });
    });
    var seq = orderBlocks(changed);
    var next = report.lastUsed === null ? FF_ROW_MIN : report.lastUsed + 1;
    seq.forEach(function (c) {
      c.row = next;
      next += 1;
      c.word = encode(c.chain, c.block, c.newValue);
    });
    if (seq.length && seq[seq.length - 1].row > FF_ROW_MAX) {
      report.refusals.push('The plan needs ' + seq.length + ' rows starting at row ' + seq[0].row + ', past the last FF row ' + FF_ROW_MAX + '. Ran out of free FF rows.');
    }
    seq.forEach(function (c) { if (c.groups.length > 1) { report.warnings.push(sharedBlockWarning(c)); } });
    var selectedKeys = FIELDS.filter(function (f) { return groups[f.group] && tg.targets[f.key] !== undefined; }).map(function (f) { return f.key; });
    report.selectedKeys = selectedKeys;
    if (report.refusals.length) {
      report.planState = 'refused';
      return finish(report);
    }
    var sim = simulatePlan(card.rows, seq, tg.targets, selectedKeys);
    report.simulation = sim;
    sim.warnings.forEach(function (m) { report.warnings.push(m); });
    if (!sim.ok) {
      report.planState = 'sim-failed';
      return finish(report);
    }
    report.planState = seq.length ? 'ok' : 'noop';
    report.plan = { records: seq, start: seq.length ? seq[0].row : null, lastRow: seq.length ? seq[seq.length - 1].row : null, remaining: sim.remaining };
    return finish(report);
  }

  function finish(report) {
    report.ok = report.errors.length === 0;
    return report;
  }

  /* Plan JSON in ffcalc's format, so `ffcalc sim card.json plan.json` can check it. */
  function exportPlan(report) {
    if (!report || !report.plan) { return null; }
    var card = report.card;
    var a = report.analysis || {};
    var targets = {};
    report.selectedKeys.forEach(function (k) { targets[k] = pyHex(report.targets[k]); });
    var obj = {
      sku: report.sku,
      source: 'fuseplan.html (' + card.formatLabel + ')',
      uuid: card.ids.uuid || null,
      fingerprint: card.ids.fingerprint || null,
      order: 'compute (chain 1 block 8 last), memory (chain 1 block 19 last), PCIe, NVLink, SYS_PIPE',
      groups: GROUP_ORDER.filter(function (g) { return report.groups[g]; }),
      burn: report.plan.records.map(function (r) {
        return { row: r.row, chain: r.chain, block: r.block, old: hex(r.oldValue, 4), 'new': hex(r.newValue, 4), record: hex(r.word, 8), fields: r.fields.slice() };
      }),
      targets: targets,
      analysis: {
        usable_fbp: a.fbp && a.fbp.ceilActive !== undefined ? a.fbp.ceilActive : null,
        fb_gib: a.fbp && a.fbp.ceilGib !== undefined ? a.fbp.ceilGib : null,
        sm_count: a.sm && a.sm.ceiling ? a.sm.ceiling.total : null,
        sm_per_gpc: a.sm && a.sm.ceiling ? a.sm.ceiling.perGpc.slice() : []
      },
      warnings: report.warnings.slice()
    };
    return JSON.stringify(obj, null, 2);
  }

  root.FusePlan = {
    FF_ROW_MIN: FF_ROW_MIN, FF_ROW_MAX: FF_ROW_MAX, N_FF_ROWS: N_FF_ROWS, RESERVE_ROWS: RESERVE_ROWS,
    SKUS: SKUS, GROUPS: GROUPS, GROUP_ORDER: GROUP_ORDER, FIELDS: FIELDS, KEEP_FIELDS: KEEP_FIELDS, BY_KEY: BY_KEY,
    encode: encode, decode: decode, hasBit5: hasBit5, replayRows: replayRows, parseRowsText: parseRowsText,
    parseInput: parseInput, pairExpand: pairExpand, decodeField: decodeField, getBits: getBits, setBits: setBits,
    simulatePlan: simulatePlan, run: run, exportPlan: exportPlan, hex: hex, hexU: hexU, pyHex: pyHex, popcount: popcount,
    describeChanges: describeChanges, magicFromBlocks: magicFromBlocks, getBlock: getBlock
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* fuseplan UI: renders FusePlan reports. No network, no storage. */
(function () {
  'use strict';
  var FP = window.FusePlan;
  var $ = function (id) { return document.getElementById(id); };
  var lastReport = null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function h(v, w) { return '<code>' + esc(FP.hex(v, w)) + '</code>'; }
  function hp(v) { return v === undefined || v === null ? '<span class="muted">not in the read</span>' : '<code>' + esc(FP.pyHex(v)) + '</code>'; }
  function list(items, cls) {
    if (!items || !items.length) { return ''; }
    return '<ul class="' + (cls || '') + '">' + items.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>';
  }
  function section(title, body, id) {
    return '<section class="card"' + (id ? ' id="' + id + '"' : '') + '><h2>' + esc(title) + '</h2>' + body + '</section>';
  }
  function yesno(v) {
    if (v === null || v === undefined) { return '<span class="muted">unknown</span>'; }
    return v ? '<span class="ok">yes</span>' : '<span class="bad">no</span>';
  }

  function buildGroups() {
    var fs = $('groups');
    var html = '<legend>What to plan</legend>';
    FP.GROUP_ORDER.forEach(function (id) {
      var g = FP.GROUPS[id];
      html += '<label class="grp"><input type="checkbox" id="g-' + id + '"' + (g.def ? ' checked' : '') + '> <span><strong>' +
        esc(g.label) + '</strong>' + (g.def ? '' : ' <span class="tag">off by default</span>') + '<br><span class="muted">' + esc(g.detail) + '</span></span></label>';
    });
    fs.innerHTML = html;
    FP.GROUP_ORDER.forEach(function (id) { $('g-' + id).addEventListener('change', rerun); });
  }
  function groupsFromUI() {
    var g = {};
    FP.GROUP_ORDER.forEach(function (id) { g[id] = $('g-' + id).checked; });
    return g;
  }

  function banner(rep) {
    if (!rep.ok) {
      return '<div class="banner bad" role="alert"><strong>The read was not accepted.</strong>' + list(rep.errors) + '</div>';
    }
    var s = rep.planState;
    if (s === 'ok') {
      return '<div class="banner good"><strong>Plan ready: ' + rep.plan.records.length + ' record' + (rep.plan.records.length === 1 ? '' : 's') +
        ', rows ' + rep.plan.start + ' to ' + rep.plan.lastRow + '.</strong> The simulation passed. The words are under Records below. Check them with ffcalc and a second person before any burn.</div>';
    }
    if (s === 'noop') {
      return '<div class="banner good"><strong>Nothing to burn.</strong> Every ticked field already equals its target on this read.</div>';
    }
    if (s === 'none') {
      return '<div class="banner info"><strong>Decoded view only.</strong> A rows file has no defective masks, so there are no targets and no records.</div>';
    }
    if (s === 'sim-failed') {
      return '<div class="banner bad" role="alert"><strong>No records: the simulation failed.</strong>' + list(rep.simulation.errors) + '</div>';
    }
    return '<div class="banner bad" role="alert"><strong>No records.</strong> The page refuses to plan from this read:' + list(rep.refusals) + '</div>';
  }

  function readSection(rep) {
    var c = rep.card;
    var cov = rep.coverage;
    var rows = [];
    rows.push(['Format', esc(c.formatLabel)]);
    rows.push(['SKU', esc(FP.SKUS[rep.sku].label) + ' (' + esc(FP.SKUS[rep.sku].pci) + ', ' + FP.SKUS[rep.sku].gibPerFbp + ' GiB per FBP)' +
      (c.skuFromInput ? '' : ' <span class="muted">from the selector</span>')]);
    var covText = cov.state === 'complete' ? '<span class="ok">complete</span>: all ' + FP.N_FF_ROWS + ' FF rows (' + FP.FF_ROW_MIN + ' to ' + FP.FF_ROW_MAX + ') present'
      : cov.state === 'partial' ? '<span class="bad">partial</span>: ' + cov.missing + ' of ' + FP.N_FF_ROWS + ' FF rows missing'
        : '<span class="bad">not read</span>';
    rows.push(['FF rows', covText]);
    if (c.rows) {
      rows.push(['Used FF rows', String(rep.used) + (rep.lastUsed !== null ? ', last used row ' + rep.lastUsed : '')]);
      if (rep.appendable !== undefined) {
        rows.push(['Blank rows after the last used row', String(rep.appendable) + (rep.blank !== rep.appendable ? ' <span class="muted">(' + rep.blank + ' blank in all, the way ffcalc counts)</span>' : '')]);
      }
    }
    if (rep.liveChecked && rep.liveChecked.length) {
      rows.push(['Live masks against the FF rows', '<span class="ok">' + rep.liveChecked.length + ' fields match</span>']);
    }
    var body = '<dl class="kv">' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>';
    if (rep.notes.length) { body += list(rep.notes, 'notes'); }
    return section('The read', body, 'sec-read');
  }

  function computeSection(rep) {
    var a = rep.analysis;
    if (!a || !a.sm) { return ''; }
    var sm = a.sm;
    if (!sm.now && !sm.ceiling) {
      return section('Compute', '<p class="muted">The GPC and TPC masks are not in this read.</p>');
    }
    var head = '<tr><th>GPC</th><th>SM now</th><th>SM ceiling</th><th>State</th></tr>';
    var body = '';
    for (var i = 0; i < 8; i++) {
      var st = [];
      if (sm.gpcDefective && sm.gpcDefective[i]) { st.push('<span class="bad">marked defective, stays off</span>'); }
      else if (sm.gpcDisabledNow && sm.gpcDisabledNow[i]) { st.push('off now, can come back'); }
      body += '<tr><td>' + i + '</td><td>' + (sm.now ? sm.now.perGpc[i] : '?') + '</td><td>' + (sm.ceiling ? sm.ceiling.perGpc[i] : '?') + '</td><td>' + (st.join(', ') || '<span class="muted">on</span>') + '</td></tr>';
    }
    body += '<tr class="total"><td>All</td><td>' + (sm.now ? sm.now.total : '?') + '</td><td>' + (sm.ceiling ? sm.ceiling.total : '?') + '</td><td></td></tr>';
    var html = '<p class="lede">SM now <strong>' + (sm.now ? sm.now.total : '?') + '</strong>, ceiling <strong>' + (sm.ceiling ? sm.ceiling.total : '?') +
      '</strong>. 8 GPCs of 8 TPCs of 2 SMs; a disabled GPC gives 0. The ceiling keeps every GPC and TPC marked defective off.</p>';
    html += '<div class="scroll"><table class="num">' + head + body + '</table></div>';
    if (sm.fused) {
      html += '<p class="muted">SM now uses the status registers, as ffcalc does. The fused masks alone give ' + sm.fused.total + ' SMs (the difference is usually the RECONFIG override).</p>';
    }
    return section('Compute', html, 'sec-compute');
  }

  function memorySection(rep) {
    var a = rep.analysis;
    if (!a || !a.fbp) { return ''; }
    var f = a.fbp;
    var html = '<dl class="kv">';
    html += '<dt>FBPs active now</dt><dd>' + (f.nowActive !== undefined ? f.nowActive + ' of 12, ' + f.nowGib + ' GiB (FBP disable ' + hp(f.nowMask) + ')' : '<span class="muted">unknown</span>') + '</dd>';
    html += '<dt>FBPs active after (target)</dt><dd>' + (f.ceilActive !== undefined ? f.ceilActive + ' of 12, ' + f.ceilGib + ' GiB (FBP defective ' + hp(f.defMask) + ')' : '<span class="muted">unknown</span>') + '</dd>';
    html += '</dl>';
    var cls = { '80gb': 'good', dud64: 'info', na: 'info', pairs: 'warn', other: 'warn', unknown: 'info' }[a.layout.verdict] || 'info';
    html += '<div class="banner ' + cls + ' small">' + esc(a.layout.text) + '</div>';
    html += '<p class="muted">FBP n owns bits 2n and 2n+1 of the FBIO, FBPA and ROP_L2 masks. The pair expansion of the FBP mask is what each of them should equal.</p>';
    html += '<div class="scroll"><table><tr><th>Mask</th><th>Now</th><th>FBP now, paired</th><th>Match</th><th>Target</th><th>FBP target, paired</th><th>Match</th></tr>';
    a.masks.now.forEach(function (m, i) {
      var t = a.masks.target[i];
      html += '<tr><td>' + esc(m.name) + '</td><td>' + hp(m.value) + '</td><td>' + hp(m.expected) + '</td><td>' + yesno(m.equal) + '</td><td>' + hp(t.value) + '</td><td>' + hp(t.expected) + '</td><td>' + yesno(t.equal) + '</td></tr>';
    });
    html += '</table></div>';
    return section('Memory', html, 'sec-memory');
  }

  function pcieSection(rep) {
    if (!rep.pcie) { return ''; }
    var html = '<p class="muted">The lab\'s measured fuse locations. A cleared field reads 0. The planner clears bit 9 of chain 2 block 39 and leaves bit 1 as it is (bit 1 does nothing for the Gen3 speed disable).</p>';
    html += '<div class="scroll"><table><tr><th>Field</th><th>Fuse location</th><th>FF rows say</th><th>Live register</th><th>Target</th></tr>';
    rep.pcie.forEach(function (p) {
      var tgt = rep.targets && rep.targets[p.key] !== undefined ? String(rep.targets[p.key]) : '<span class="muted">not planned</span>';
      var live = p.live === null ? '<span class="muted">not in the read</span>' : String(p.live) + ' <span class="muted">(' + esc(p.reg) + ' = ' + esc(FP.hex(p.liveRaw, 8)) + ')</span>';
      var ff = p.ff === null ? '<span class="muted">unknown</span>' : (p.ff ? '1 (set)' : '0 (cleared)');
      html += '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.loc) + '</td><td>' + ff + '</td><td>' + live + '</td><td>' + tgt + '</td></tr>';
    });
    html += '</table></div>';
    if (rep.magicFromRows !== undefined || rep.magicLive !== undefined) {
      html += '<p>PCIE_MAGIC_BITS_D, the whole register: from the FF rows (block47 &lt;&lt; 22) | (block46 &lt;&lt; 6) = ' +
        (rep.magicFromRows !== undefined ? h(rep.magicFromRows, 8) : '<span class="muted">unknown</span>') +
        (rep.magicLive !== undefined ? ', live ' + h(rep.magicLive, 8) : '') + '. Stock reads <code>0x16680000</code>; with bit 25 cleared <code>0x14680000</code>. This page never rewrites the whole word.</p>';
    }
    return section('PCIe link speed', html, 'sec-pcie');
  }

  function recordsSection(rep) {
    if (rep.planState !== 'ok') { return ''; }
    var p = rep.plan;
    var html = '<p class="lede">Rows ' + p.start + ' to ' + p.lastRow + ', in this order: compute with the GPC block (chain 1 block 8) last, memory with the FBP block (chain 1 block 19) last, then PCIe. ' +
      p.remaining + ' blank FF rows remain after the plan. Each word replaces a whole 16-bit block; every other bit of the block keeps its current value.</p>';
    var lastGroup = null;
    p.records.forEach(function (r, i) {
      if (r.placedIn !== lastGroup) {
        html += '<h3>' + esc(FP.GROUPS[r.placedIn].label) + '</h3>';
        lastGroup = r.placedIn;
      }
      var ch = bitRuns(r.changes).map(function (g) {
        var a = g[0];
        var z = g[g.length - 1];
        var blockBits = g.length > 1 ? 'bits ' + a.bit + ' to ' + z.bit : 'bit ' + a.bit;
        var wide = FP.BY_KEY[a.field].width > 1;
        var fieldBits = !wide ? '' : (g.length > 1 ? ' bits ' + a.fieldBit + ' to ' + z.fieldBit : ' bit ' + a.fieldBit);
        return '<li>' + blockBits + ': ' + a.from + ' to ' + a.to + ', ' + esc(a.fieldName) + fieldBits + '</li>';
      }).join('');
      html += '<div class="rec"><div class="rec-head"><span class="rec-n">' + (i + 1) + '</span><span>Row <strong>' + r.row + '</strong></span>' +
        '<span class="word"><code>' + esc(FP.hexU(r.word, 8)) + '</code></span></div>' +
        '<div class="rec-body">Chain ' + r.chain + ' block ' + r.block + ': ' + h(r.oldValue, 4) + ' to ' + h(r.newValue, 4) +
        '<ul class="bits">' + ch + '</ul></div></div>';
    });
    html += '<div class="export"><button id="copy" class="primary">Copy plan as JSON</button> <span id="copied" class="muted" aria-live="polite"></span>' +
      '<p class="muted">ffcalc\'s plan format (<code>burn</code> list with row, chain, block, old, new, record, fields). Save it as plan.json and check it against the same read: <code>python3 -m ffcalc sim card.json plan.json</code>.</p>' +
      '<textarea id="planjson" readonly spellcheck="false"></textarea></div>';
    return section('Records', html, 'sec-records');
  }

  function decodedSection(rep) {
    if (!rep.decoded || !rep.decoded.length) { return ''; }
    var html = '<details><summary>' + rep.decoded.length + ' FF record' + (rep.decoded.length === 1 ? '' : 's') + ' on the card</summary>';
    html += '<div class="scroll"><table class="num"><tr><th>Row</th><th>Word</th><th>Chain</th><th>Block</th><th>Data</th><th>State</th></tr>';
    rep.decoded.forEach(function (r) {
      html += '<tr><td>' + r.row + '</td><td>' + h(r.word, 8) + '</td><td>' + r.chain + '</td><td>' + r.block + '</td><td>' + h(r.data, 4) + '</td><td>' +
        (r.supersededBy ? '<span class="muted">replaced by row ' + r.supersededBy + '</span>' : 'in force') + '</td></tr>';
    });
    if (rep.bit5) {
      html += '<tr class="badrow"><td>' + rep.bit5.row + '</td><td>' + h(rep.bit5.word, 8) + '</td><td colspan="4">bit 5 set: not an FF record</td></tr>';
    }
    html += '</table></div>';
    if (rep.current) {
      html += '<h3>Fields decoded from the FF rows</h3><p class="muted">A block with no record decodes as 0 here; on a card its value then comes from the regular fuse rows.</p>';
      html += '<div class="scroll"><table><tr><th>Field</th><th>Location</th><th>Value</th></tr>';
      FP.FIELDS.forEach(function (f) {
        html += '<tr><td>' + esc(f.name) + '</td><td>chain ' + f.chain + ' bits ' + f.bit + ' to ' + (f.bit + f.width - 1) + '</td><td>' + hp(rep.current[f.key]) + '</td></tr>';
      });
      html += '</table></div>';
    }
    html += '</details>';
    return section('FF records on the card', html, 'sec-decoded');
  }

  /* Consecutive changed bits of one field, same direction, become one line. */
  function bitRuns(changes) {
    var runs = [];
    changes.forEach(function (c) {
      var cur = runs[runs.length - 1];
      var prev = cur && cur[cur.length - 1];
      if (prev && prev.field === c.field && prev.bit + 1 === c.bit && prev.fieldBit + 1 === c.fieldBit && prev.from === c.from) {
        cur.push(c);
      } else {
        runs.push([c]);
      }
    });
    return runs;
  }

  function render(rep) {
    lastReport = rep;
    var out = banner(rep);
    if (rep.ok) {
      if (rep.warnings.length) {
        out += '<div class="banner warn"><strong>Warnings</strong>' + list(rep.warnings) + '</div>';
      }
      out += readSection(rep) + computeSection(rep) + memorySection(rep) + pcieSection(rep) + recordsSection(rep) + decodedSection(rep);
    }
    $('out').innerHTML = out;
    if (rep.planState === 'ok') {
      var json = FP.exportPlan(rep);
      $('planjson').value = json;
      $('copy').addEventListener('click', function () { copyText(json); });
    }
  }

  function copyText(text) {
    var done = function (ok) { $('copied').textContent = ok ? 'Copied.' : 'Copy failed: select the text below and copy it.'; };
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy()); });
        return;
      }
    } catch (e) { /* fall through */ }
    done(fallbackCopy());
  }
  function fallbackCopy() {
    var ta = $('planjson');
    ta.focus();
    ta.select();
    try { return document.execCommand('copy'); } catch (e) { return false; }
  }

  function analyze() {
    var text = $('input').value;
    if (!text.trim()) { $('out').innerHTML = ''; lastReport = null; return; }
    var rep;
    try {
      rep = FP.run(text, { sku: $('sku').value, groups: groupsFromUI() });
    } catch (e) {
      rep = { ok: false, errors: ['Unexpected error while reading the input: ' + (e && e.message ? e.message : e)], refusals: [], warnings: [], notes: [] };
    }
    render(rep);
  }
  function rerun() { if ($('input').value.trim()) { analyze(); } }

  function loadFile(file) {
    if (!file) { return; }
    if (file.size > 4 * 1024 * 1024) { $('out').innerHTML = '<div class="banner bad">That file is over 4 MB, which is far larger than any card read. Not loaded.</div>'; return; }
    var fr = new FileReader();
    fr.onload = function () { $('input').value = String(fr.result); analyze(); };
    fr.onerror = function () { $('out').innerHTML = '<div class="banner bad">The file could not be read.</div>'; };
    fr.readAsText(file);
  }

  function init() {
    buildGroups();
    $('go').addEventListener('click', analyze);
    $('sku').addEventListener('change', rerun);
    $('clear').addEventListener('click', function () { $('input').value = ''; $('file').value = ''; $('out').innerHTML = ''; lastReport = null; });
    $('file').addEventListener('change', function (e) { loadFile(e.target.files && e.target.files[0]); });
    $('input').addEventListener('paste', function () { setTimeout(analyze, 0); });
    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) { loadFile(f); } else if (e.dataTransfer) { $('input').value = e.dataTransfer.getData('text'); analyze(); }
    });
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();

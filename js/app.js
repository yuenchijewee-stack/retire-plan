/* js/app.js — UI 绑定与结果渲染。依赖 js/tax.js、js/engine.js。 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function num(id) {
    var el = $(id), v = el ? el.value : '';
    if (v === '' || v === null || v === undefined) return NaN;
    return parseFloat(v);
  }
  function num0(id) { var v = num(id); return isNaN(v) ? 0 : v; }
  function pct(id, dflt) { var v = num(id); return (isNaN(v) ? dflt : v) / 100; }
  function radio(name) {
    var els = document.getElementsByName(name), i;
    for (i = 0; i < els.length; i++) if (els[i].checked) return els[i].value;
    return null;
  }
  function fmtD(n) {
    if (!isFinite(n)) return '—';
    return (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  }
  function fmtAge(n) { return n === null || n === undefined ? '未达标' : n + ' 岁'; }

  function collectParams() {
    var preMAGI = $('preRetireMAGI').value.trim() === '' ? null : num0('preRetireMAGI');
    var P = {
      currentYear: 2026,
      selfAge: num0('selfAge'), spouseAge: num0('spouseAge'),
      horizonAge: num0('horizonAge'), buffer: num0('buffer'),
      balTaxable: num0('balTaxable'), balPretax: num0('balPretax'), balRoth: num0('balRoth'),
      pretaxSelfFrac: pct('pretaxSelfFrac', 0.5),
      salary: num0('salary'), salaryGrowth: pct('salaryGrowth', 0.03),
      c401k: num0('c401k'), cRoth: num0('cRoth'), cTaxable: num0('cTaxable'), match: num0('match'),
      preRetireMAGI: preMAGI,
      spendReal: num0('spendReal'),
      ssSelf: num0('ssSelf'), ssSelfAge: num0('ssSelfAge'),
      ssSpouse: num0('ssSpouse'), ssSpouseAge: num0('ssSpouseAge'),
      stateMode: radio('stateMode') || 'COMPARE',
      moveCost: num0('moveCost'),
      house: {
        enabled: $('houseEnabled').checked,
        price: num0('housePrice'), basis: num0('houseBasis'),
        costRate: pct('costRate', 0.06), twoYear: $('twoYear').checked,
        downsize: $('downsize').checked, newPrice: num0('newPrice'),
        saleMode: radio('saleMode') || 'retire',
        saleYear: num0('saleYear')
      },
      inflation: pct('inflation', 0.025),
      retTaxable: pct('retTaxable', 0.07), retPretax: pct('retPretax', 0.05),
      retRoth: pct('retRoth', 0.07),
      divYield: pct('divYield', 0.02), gainRatio: pct('gainRatio', 0.30)
    };
    return P;
  }

  // ------- 图表管理 -------
  var charts = {};
  function drawChart(key, canvasId, cfg) {
    var c = $(canvasId);
    if (!window.Chart) {
      c.parentNode.innerHTML = '<p class="hint">图表库（Chart.js）加载失败，请检查网络后刷新。</p>';
      return;
    }
    if (charts[key]) charts[key].destroy();
    charts[key] = new Chart(c, cfg);
  }

  // ------- 主流程 -------
  var last = null;   // {P, solves, detailYear/detailAge, decCache}
  var decCache = {};

  function getDec(P, R, strategy, stateId) {
    var key = [R, strategy, stateId].join('|');
    if (!decCache[key]) {
      var acc = Engine.accumulate(P, R);
      decCache[key] = Engine.decumulate(P, acc, R, strategy, stateId);
    }
    return decCache[key];
  }

  function run() {
    $('calcNote').style.display = 'block';
    setTimeout(function () {
      try {
        var P = collectParams();
        if (P.horizonAge <= P.selfAge) { alert('规划终点年龄需大于本人当前年龄。'); return; }
        if (P.selfAge > 75) { alert('本人年龄已超过 75，求解范围（50–75 岁）为空。'); return; }
        Tax.setInflation(P.inflation);
        decCache = {};
        var states = (P.stateMode === 'COMPARE') ? ['CA', 'NV'] : [P.stateMode];
        var solves = {}, i;
        for (i = 0; i < states.length; i++) solves[states[i]] = Engine.solveFor(P, states[i]);
        var earliest = {};
        for (i = 0; i < states.length; i++) earliest[states[i]] = Engine.earliestFeasible(solves[states[i]]);
        // 明细默认用各州最早可行年份（对比模式取 CA 的；失败则取 75）
        var e0 = earliest[states[0]];
        var detailYear = e0 ? e0.year : (P.currentYear + (75 - P.selfAge));
        var detailAge = e0 ? e0.R : 75;
        last = { P: P, states: states, solves: solves, earliest: earliest, detailYear: detailYear, detailAge: detailAge };

        $('results').style.display = 'block';
        renderHeadline();
        renderSolverTable();
        renderStratCards();
        buildTaxStratSel();
        renderCompare();
        renderNWChart();
        renderSensTable();
        renderTaxChart();
        renderYearTable();
        document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
      } finally {
        $('calcNote').style.display = 'none';
      }
    }, 30);
  }

  function stratLabel(s) { return Engine.STRATS[s].name; }

  function renderHeadline() {
    var h = $('headline'), i, html = '';
    for (i = 0; i < last.states.length; i++) {
      var sid = last.states[i], e = last.earliest[sid];
      var sname = Tax.STATES[sid].name;
      if (e) {
        html += '<div><span class="big">' + e.R + ' 岁</span>　' + sname +
          '方案最早可退休年龄（' + stratLabel(e.strategy) + '）</div>';
      } else {
        html += '<div class="fail">' + sname + '方案：按当前假设，在 75 岁前无法达到期末缓冲目标。</div>' +
          '<div class="hint">建议：提高年缴存、降低年支出、延长规划终点年龄，或调整回报假设后重试。</div>';
      }
    }
    h.innerHTML = html;
  }

  function renderSolverTable() {
    var sid = last.states[0];   // 求解器表格用第一个州（对比模式下为 CA）
    var out = last.solves[sid], html = '';
    var e = last.earliest[sid];
    html += '<tr><th>退休年龄</th><th>策略A 期末净资产</th><th>策略B 期末净资产</th><th>策略C 期末净资产</th></tr>';
    out.forEach(function (rec) {
      var cls = (e && rec.R === e.R) ? ' class="hl"' : '';
      html += '<tr' + cls + '><td>' + rec.R + ' 岁</td>' +
        Engine.STRAT_IDS.map(function (s) {
          var sm = rec[s];
          var c = sm.endNetWorth < 0 ? ' class="neg"' : '';
          var mark = (e && rec.R === e.R && s === e.strategy) ? ' ★' : '';
          return '<td' + c + '>' + fmtD(sm.endNetWorth) + mark + '</td>';
        }).join('') + '</tr>';
    });
    $('solverTable').innerHTML = html;
    $('stratTitle').textContent = '策略对比（' + Tax.STATES[sid].name + '，' + last.detailAge + ' 岁退休）';
  }

  function cardStats(sm) {
    return '<div class="stat"><span>期末净资产</span><b>' + fmtD(sm.endNetWorth) + '</b></div>' +
      '<div class="stat"><span>终身税（联邦+州+NIIT+IRMAA）</span><b>' + fmtD(sm.lifetimeTax) + '</b></div>' +
      '<div class="stat"><span>累计 Roth 转换</span><b>' + fmtD(sm.totalConv) + '</b></div>';
  }

  function renderStratCards() {
    var sid = last.states[0], R = last.detailYear, html = '';
    Engine.STRAT_IDS.forEach(function (s, idx) {
      var sm = getDec(last.P, R, s, sid).summary;
      var best = (last.earliest[sid] && last.earliest[sid].strategy === s) ? ' <span class="best">← 最早可行</span>' : '';
      html += '<div class="card"><h4>' + stratLabel(s) + best + '</h4>' +
        '<p class="hint">' + Engine.STRATS[s].desc + '</p>' + cardStats(sm) + '</div>';
    });
    $('stratCards').innerHTML = html;
  }

  function renderCompare() {
    var sec = $('compareSection');
    if (last.states.length < 2) { sec.style.display = 'none'; return; }
    sec.style.display = 'block';
    var R = last.detailYear, html = '';
    ['CA', 'NV'].forEach(function (sid) {
      html += '<div class="card"><h4>' + Tax.STATES[sid].name + '方案</h4>';
      Engine.STRAT_IDS.forEach(function (s) {
        var sm = getDec(last.P, R, s, sid).summary;
        html += '<p class="hint" style="margin-bottom:2px"><b>' + stratLabel(s) + '</b></p>' + cardStats(sm);
      });
      html += '</div>';
    });
    $('compareCards').innerHTML = html;

    // 逐年税差图（CA − NV），用选中的策略
    var s = $('taxStratSel').value || 'fill12';
    var ca = getDec(last.P, R, s, 'CA').rows, nv = getDec(last.P, R, s, 'NV').rows;
    var labels = ca.map(function (r) { return r.year; });
    var diff = ca.map(function (r, i) { return Math.round(r.totalTax - nv[i].totalTax); });
    drawChart('diff', 'diffChart', {
      type: 'bar',
      data: { labels: labels, datasets: [{ label: '加州 − 内华达 年度总税差', data: diff, backgroundColor: '#a3542f' }] },
      options: { responsive: true, plugins: { legend: { display: true } },
        scales: { y: { ticks: { callback: function (v) { return '$' + (v / 1000) + 'k'; } } } } }
    });
  }

  var PALETTE = { none: '#7a8a99', fill12: '#2f6f4f', fill22: '#b07d2b' };

  function renderNWChart() {
    var sid = last.states[0], R = last.detailYear;
    var first = getDec(last.P, R, 'none', sid).rows;
    var labels = first.map(function (r) { return r.year; });
    var ds = Engine.STRAT_IDS.map(function (s) {
      var rows = getDec(last.P, R, s, sid).rows;
      return { label: stratLabel(s), data: rows.map(function (r) { return Math.round(r.nw); }),
               borderColor: PALETTE[s], fill: false, tension: 0.1, pointRadius: 0 };
    });
    drawChart('nw', 'nwChart', {
      type: 'line',
      data: { labels: labels, datasets: ds },
      options: { responsive: true,
        scales: { y: { ticks: { callback: function (v) { return '$' + (v / 1000000).toFixed(1) + 'M'; } } } } }
    });
  }

  function buildTaxStratSel() {
    var sel = $('taxStratSel');
    sel.innerHTML = Engine.STRAT_IDS.map(function (s) {
      return '<option value="' + s + '">' + stratLabel(s) + '</option>';
    }).join('');
    sel.value = 'fill12';
    sel.onchange = function () { renderTaxChart(); renderYearTable(); renderCompare(); };
  }

  function renderTaxChart() {
    var sid = last.states[0], R = last.detailYear, s = $('taxStratSel').value || 'fill12';
    var rows = getDec(last.P, R, s, sid).rows;
    var labels = rows.map(function (r) { return r.year; });
    drawChart('tax', 'taxChart', {
      data: {
        labels: labels,
        datasets: [
          { type: 'bar', label: '联邦所得税', data: rows.map(function (r) { return Math.round(r.fed); }), backgroundColor: '#2f6f4f', stack: 't' },
          { type: 'bar', label: '州税', data: rows.map(function (r) { return Math.round(r.state); }), backgroundColor: '#4f86c6', stack: 't' },
          { type: 'bar', label: 'NIIT+IRMAA', data: rows.map(function (r) { return Math.round(r.niit + r.irmaa); }), backgroundColor: '#b07d2b', stack: 't' },
          { type: 'line', label: 'Roth 转换', data: rows.map(function (r) { return Math.round(r.conv); }),
            borderColor: '#a3542f', yAxisID: 'y2', pointRadius: 0, tension: 0.1 }
        ]
      },
      options: { responsive: true,
        scales: {
          y: { stacked: true, ticks: { callback: function (v) { return '$' + (v / 1000) + 'k'; } } },
          y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: function (v) { return '$' + (v / 1000) + 'k'; } } }
        } }
    });
  }

  function renderSensTable() {
    var sid = last.states[0];
    var rows = Engine.sensitivity(last.P, sid);
    var html = '<tr><th>情景</th><th>最早可行退休年龄</th><th>对应策略</th></tr>';
    rows.forEach(function (r) {
      html += '<tr><td>' + r.label + '</td><td>' + fmtAge(r.earliestR) + '</td><td>' +
        (r.strategy ? stratLabel(r.strategy) : '—') + '</td></tr>';
    });
    $('sensTable').innerHTML = html;
  }

  function renderYearTable() {
    var sid = last.states[0], R = last.detailYear, s = $('taxStratSel').value || 'fill12';
    var rows = getDec(last.P, R, s, sid).rows;
    var cols = ['年份', '年龄', '普通收入', '资本利得', 'AGI', '扣除', '应税收入', '应税SS',
      '联邦税', 'NIIT', '州税', 'IRMAA', '总税', 'Roth转换', 'RMD', '社安金', '支出',
      '卖房应税gain', '应税账户', '税前账户', 'Roth', '净资产'];
    var html = '<tr>' + cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr>';
    rows.forEach(function (r) {
      var tds = [r.year, r.selfAge + '/' + r.spAge,
        fmtD(r.ordinary), fmtD(r.ltcg), fmtD(r.agi), fmtD(r.ded), fmtD(r.ti), fmtD(r.tss),
        fmtD(r.fed), fmtD(r.niit), fmtD(r.state), fmtD(r.irmaa), fmtD(r.totalTax),
        fmtD(r.conv), fmtD(r.rmd), fmtD(r.ss), fmtD(r.spend),
        r.saleGain ? fmtD(r.saleGain) : '—',
        fmtD(r.taxable), fmtD(r.pretax), fmtD(r.roth), fmtD(r.nw)];
      html += '<tr>' + tds.map(function (t) {
        var neg = (typeof t === 'string' && t.charAt(0) === '−') ? ' class="neg"' : '';
        return '<td' + neg + '>' + t + '</td>';
      }).join('') + '</tr>';
    });
    $('yearTable').innerHTML = html;
  }

  // ------- 初始化 -------
  document.addEventListener('DOMContentLoaded', function () {
    $('houseEnabled').addEventListener('change', function () {
      $('houseFields').style.display = this.checked ? 'block' : 'none';
    });
    $('houseFields').style.display = 'none';
    $('runBtn').addEventListener('click', run);
  });
})();

/* js/engine.js — 规划引擎：累积期 → 退休后逐年账本 → 求解器 → 敏感性分析。
 * 全部 MFJ 口径。依赖 js/tax.js（全局 Tax）。
 */
(function (global) {
  'use strict';
  var T = global.Tax;

  var STRATS = {
    none:   { name: '策略A：不转换',  desc: '退休后不做 Roth 转换' },
    fill12: { name: '策略B：填满 12% 档', desc: '每年把 Roth 转换做到 12% 税档上限（应税收入口径）' },
    fill22: { name: '策略C：填满 22% 档', desc: '每年把 Roth 转换做到 22% 税档上限（应税收入口径）' }
  };
  var STRAT_IDS = ['none', 'fill12', 'fill22'];

  // P: 参数对象（见 app.js 默认值）。R: 退休年份。
  function accumulate(P, R) {
    var tax = P.balTaxable, pre = P.balPretax, roth = P.balRoth, sal = P.salary;
    for (var y = P.currentYear; y < R; y++) {
      tax  *= (1 + P.retTaxable);
      pre  *= (1 + P.retPretax);
      roth *= (1 + P.retRoth);
      var g = Math.pow(1 + P.salaryGrowth, y - P.currentYear);
      pre  += (P.c401k + P.match) * g;   // 税前缴存 + 公司 match 进税前账户
      roth += P.cRoth * g;
      tax  += P.cTaxable * g;
      sal  *= (1 + P.salaryGrowth);
    }
    return { taxable: tax, pretax: pre, roth: roth, salaryAtR: sal };
  }

  // 住房出售信息；saleMode='retire' 时出售年份跟随退休年份 R
  function planSale(P, R) {
    if (!P.house.enabled) return null;
    var sy = (P.house.saleMode === 'fixed') ? Math.max(P.house.saleYear, R) : R;
    var hg = T.homeSaleGain(P.house.price, P.house.basis, P.house.costRate, P.house.twoYear);
    return {
      year: sy, price: P.house.price, costs: hg.costs, gain: hg.gain,
      exclusion: hg.exclusion, taxableGain: hg.taxableGain,
      newCost: P.house.downsize ? P.house.newPrice : 0
    };
  }

  // 单次完整退休后模拟。返回 {rows, summary}。
  // stateId: 'CA' | 'NV'。NV 方案默认退休当年计入一次性搬家成本。
  function decumulate(P, start, R, strategy, stateId) {
    var selfBirth = P.currentYear - P.selfAge;
    var spBirth = P.currentYear - P.spouseAge;
    var endYear = selfBirth + P.horizonAge;
    var sale = planSale(P, R);
    var taxable = start.taxable, pretax = start.pretax, roth = start.roth;

    // IRMAA 两年回溯：退休前两年用输入的退休前 MAGI 估算（默认=当前工资）
    var preMAGI = (P.preRetireMAGI === null || P.preRetireMAGI === '' || P.preRetireMAGI === undefined)
      ? P.salary : +P.preRetireMAGI;
    var magiHist = {};
    magiHist[R - 2] = preMAGI; magiHist[R - 1] = preMAGI;

    var moveCostHere = (stateId === 'NV') ? P.moveCost : 0;
    var convTop = strategy === 'fill12' ? 100800 : (strategy === 'fill22' ? 211400 : 0);

    var rows = [], totalTax = 0, totalConv = 0, minNW = Infinity;

    for (var y = R; y <= endYear; y++) {
      var selfAge = y - selfBirth, spAge = y - spBirth;
      var n65 = (selfAge >= 65 ? 1 : 0) + (spAge >= 65 ? 1 : 0);

      // 账户增长（应税账户：股息部分先拿出计税，剩余按回报增长）
      var qdiv = taxable * P.divYield;
      taxable *= (1 + P.retTaxable - P.divYield);
      var rmd = T.rmd_for(pretax * P.pretaxSelfFrac, selfAge)
              + T.rmd_for(pretax * (1 - P.pretaxSelfFrac), spAge);
      pretax *= (1 + P.retPretax);
      roth   *= (1 + P.retRoth);
      rmd = Math.min(rmd, pretax);

      // 社安金（今日美元 → 名义美元）
      var ssTotal = 0;
      if (y >= selfBirth + P.ssSelfAge) ssTotal += P.ssSelf * T.infl(y);
      if (y >= spBirth + P.ssSpouseAge) ssTotal += P.ssSpouse * T.infl(y);

      var ordBase = rmd;                       // 退休后无工资
      var ltcgHouse = (sale && y === sale.year) ? sale.taxableGain : 0;

      // Roth 转换（转到本人 75 岁、RMD 开始为止）
      var conv = 0;
      if (strategy !== 'none' && convTop > 0 && y <= selfBirth + 74 && pretax - rmd > 0) {
        var t0 = T.taxable_ss(ordBase, ssTotal);
        t0 = T.taxable_ss(ordBase + t0, ssTotal);
        var agi0 = ordBase + t0 + qdiv + ltcgHouse;
        var dedEst = T.std_ded(y, n65) + T.senior_bonus(y, n65, agi0);
        conv = Math.max(0, Math.min(convTop * T.infl(y) + dedEst - agi0, pretax - rmd));
      }
      conv = Math.min(conv, Math.max(0, pretax - rmd));
      pretax -= (rmd + conv);
      roth += conv;
      totalConv += conv;
      var ordinary = ordBase + conv;

      var spend = P.spendReal * T.infl(y);
      if (y === R) spend += moveCostHere;

      // 当年税：卖股变现额与税前应急提取联立求解（8 轮迭代收敛）
      var settle = function (saleGuess, ordinaryIn, ltcgHouseIn) {
        var gainSale = saleGuess * P.gainRatio;
        var ltcg = qdiv + ltcgHouseIn + gainSale;
        var r = T.year_taxes(y, n65, ordinaryIn, ltcg, ssTotal);
        var nii = Math.max(0, qdiv + gainSale + ltcgHouseIn);
        var niit = 0.038 * Math.min(nii, Math.max(0, r.agi - T.NIIT_T));
        var fedTotal = r.fed + niit;
        var stTax = T.stateTax(stateId, y, n65, r.agi, r.tss);
        var irmaa = 0;
        var m2 = magiHist[y - 2] || 0;
        if (selfAge >= 65) irmaa += T.irmaa_annual(m2, y);
        if (spAge >= 65) irmaa += T.irmaa_annual(m2, y);
        var total = fedTotal + stTax + irmaa;
        return { r: r, niit: niit, fedTotal: fedTotal, stTax: stTax, irmaa: irmaa,
                 ltcg: ltcg, gainSale: gainSale, total: total };
      };

      taxable += qdiv;
      var cashAvail = taxable + rmd + ssTotal;
      var iraDraw = 0, rothDraw = 0, ordinaryF = ordinary, res = null, sale2 = 0;
      for (var k = 0; k < 8; k++) {
        var s1 = Math.min(Math.max(0, spend - cashAvail), taxable);
        var r1 = settle(s1, ordinaryF, ltcgHouse);
        var sale2n = Math.min(Math.max(0, spend + r1.total - cashAvail), taxable);
        res = settle(sale2n, ordinaryF, ltcgHouse);
        var short = spend + res.total - cashAvail - sale2n;
        var newDraw = Math.min(Math.max(0, short), pretax);
        sale2 = sale2n;
        if (Math.abs(newDraw - iraDraw) < 1) { iraDraw = newDraw; break; }
        iraDraw = newDraw;
        ordinaryF = ordinary + iraDraw;
      }

      // 执行资金流
      var saleExec = Math.min(sale2, taxable);
      taxable -= saleExec;
      pretax -= iraDraw;
      taxable += (rmd + ssTotal + saleExec + iraDraw);
      taxable -= (spend + res.total);

      // 卖房：税款差（有 gain vs 无 gain 两次 settle）+ 净到手
      var taxOnSale = 0, netProceeds = 0;
      if (sale && y === sale.year) {
        var rNoGain = settle(saleExec, ordinaryF, 0);
        taxOnSale = res.total - rNoGain.total;
        netProceeds = sale.price - sale.costs - taxOnSale - sale.newCost;
        taxable += netProceeds;   // 为正→进应税账户；为负→当年支出增加
      }

      if (taxable < 0) { var d = Math.min(-taxable, pretax); pretax -= d; taxable += d; }
      if (taxable < 0) { rothDraw = Math.min(-taxable, roth); roth -= rothDraw; taxable += rothDraw; }

      magiHist[y] = res.r.agi;   // 卖房 gain 已在 AGI 里 → 两年后影响 IRMAA
      var nw = taxable + pretax + roth;
      if (nw < minNW) minNW = nw;
      totalTax += res.total;

      rows.push({
        year: y, selfAge: selfAge, spAge: spAge,
        ordinary: ordinary, ltcg: res.ltcg, agi: res.r.agi, ded: res.r.ded, ti: res.r.ti,
        tss: res.r.tss, fed: res.fedTotal, niit: res.niit, state: res.stTax,
        irmaa: res.irmaa, totalTax: res.total,
        conv: conv, rmd: rmd, ss: ssTotal, spend: spend,
        saleGain: ltcgHouse, taxOnSale: taxOnSale, netProceeds: netProceeds,
        taxable: taxable, pretax: pretax, roth: roth, nw: nw
      });
    }

    var endNW = rows.length ? rows[rows.length - 1].nw : (start.taxable + start.pretax + start.roth);
    return {
      rows: rows,
      summary: {
        R: R, strategy: strategy, stateId: stateId,
        endNetWorth: endNW, minNetWorth: minNW,
        lifetimeTax: totalTax, totalConv: totalConv,
        ok: endNW >= P.buffer
      }
    };
  }

  // 求解器：退休年龄 A 从 max(本人当前年龄,50) 到 75；换算成退休年份 R 后每种策略各跑一遍
  function solveFor(P, stateId) {
    var startAge = Math.max(P.selfAge, 50);
    var out = [];
    for (var A = startAge; A <= 75; A++) {
      var R = P.currentYear + (A - P.selfAge);   // 退休年份
      var acc = accumulate(P, R);
      var rec = { R: A, year: R, salaryAtR: acc.salaryAtR };
      for (var i = 0; i < STRAT_IDS.length; i++) {
        var s = STRAT_IDS[i];
        var dec = decumulate(P, acc, R, s, stateId);
        rec[s] = dec.summary;
      }
      out.push(rec);
    }
    return out;
  }

  // 最早可行的 (退休年龄, 退休年份, 策略)
  function earliestFeasible(solverOut) {
    for (var i = 0; i < solverOut.length; i++) {
      for (var j = 0; j < STRAT_IDS.length; j++) {
        var s = STRAT_IDS[j];
        if (solverOut[i][s].ok) return { R: solverOut[i].R, year: solverOut[i].year, strategy: s };
      }
    }
    return null;
  }

  // 敏感性：变体 → 最早可行退休年份（取三策略中最早）
  function sensitivity(P, stateId) {
    var base = solveFor(P, stateId);
    var variants = [
      { key: 'base', label: '基准', apply: function () {} },
      { key: 'spendUp', label: '支出 +20%', apply: function (q) { q.spendReal *= 1.2; } },
      { key: 'spendDown', label: '支出 −20%', apply: function (q) { q.spendReal *= 0.8; } },
      { key: 'retUp', label: '回报 +1%', apply: function (q) { q.retTaxable += .01; q.retPretax += .01; q.retRoth += .01; } },
      { key: 'retDown', label: '回报 −1%', apply: function (q) { q.retTaxable -= .01; q.retPretax -= .01; q.retRoth -= .01; } }
    ];
    return variants.map(function (v) {
      var q = JSON.parse(JSON.stringify(P));
      v.apply(q);
      var out = (v.key === 'base') ? base : solveFor(q, stateId);
      var e = earliestFeasible(out);
      return { key: v.key, label: v.label, earliestR: e ? e.R : null, strategy: e ? e.strategy : null };
    });
  }

  global.Engine = {
    STRATS: STRATS, STRAT_IDS: STRAT_IDS,
    accumulate: accumulate, planSale: planSale,
    decumulate: decumulate, solveFor: solveFor,
    earliestFeasible: earliestFeasible, sensitivity: sensitivity
  };
})(typeof window !== 'undefined' ? window : globalThis);

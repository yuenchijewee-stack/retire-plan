/* js/tax.js
 * 联邦税引擎（MFJ 联合申报口径，直接移植自已验证的 tax_model.py）+ 州税模块（CA/NV，可扩展）。
 * 所有金额为名义美元；2026 年为基准年，税表按通胀指数化（IRMAA/NIIT/社安金阈值法定不指数化）。
 * 在浏览器和 Node 里都能用（挂在全局 Tax 上）。
 */
(function (global) {
  'use strict';

  var INF = Infinity;

  // ---------------- 2026 联邦基准（MFJ，IRS Rev. Proc. 2025-32） ----------------
  var ORD2026 = [[24800, .10], [100800, .12], [211400, .22], [403550, .24], [512450, .32], [768700, .35], [INF, .37]];
  var LTCG2026 = [[98900, 0], [613700, .15], [INF, .20]];
  var STD2026 = 32200;
  var ADD65_2026 = 1650;        // 每位 65+ 配偶，MFJ
  var SENIOR_BONUS = 6000;      // 每位 65+，仅 2025-2028；MAGI 超 $150K 按 6% 递减（法定不指数化）
  var NIIT_T = 250000;          // MFJ，法定不指数化
  var SS_T = [32000, 44000];    // MFJ provisional income，法定不指数化
  var IRMAA_MFJ = [             // (MAGI上限, PartB月费, PartD月附加)，2026年金额；阈值法定不指数化
    [218000, 202.90, 0.00],
    [274000, 284.10, 14.50],
    [342000, 405.80, 37.50],
    [410000, 527.50, 60.40],
    [750000, 649.20, 83.30],
    [INF,    689.90, 91.00]
  ];
  var ULT = {72:27.4,73:26.5,74:25.5,75:24.6,76:23.7,77:22.9,78:22.0,79:21.1,80:20.2,
    81:19.4,82:18.5,83:17.8,84:17.0,85:16.0,86:15.2,87:14.4,88:13.7,89:12.9,
    90:12.2,91:11.5,92:10.8,93:10.1,94:9.5,95:8.9,96:8.4,97:7.9,98:7.4,99:7.0,
    100:6.6,101:6.3,102:5.9,103:5.6,104:5.2,105:4.9,106:4.6,107:4.3,108:4.1,
    109:3.9,110:3.7,111:3.5,112:3.4,113:3.2,114:3.1,115:2.9,116:2.8,117:2.7,
    118:2.6,119:2.5,120:2.4};

  var BASE_YEAR = 2026;
  var inflRate = 0.025;
  function setInflation(r) { inflRate = r; }
  function getInflation() { return inflRate; }
  function infl(y) { return Math.pow(1 + inflRate, y - BASE_YEAR); }

  function bracket_tax(ti, brackets) {
    var tax = 0, lo = 0, i, hi, r;
    for (i = 0; i < brackets.length; i++) {
      hi = brackets[i][0]; r = brackets[i][1];
      if (ti <= lo) break;
      tax += (Math.min(ti, hi) - lo) * r; lo = hi;
    }
    return tax;
  }

  // LTCG/qualified dividends：堆叠在 ordinary 之上计税
  function ltcg_tax(ord_ti, total_ti, y) {
    if (total_ti <= ord_ti) return 0;
    var tax = 0, prev_hi = 0, i, hi, r, portion;
    for (i = 0; i < LTCG2026.length; i++) {
      hi = LTCG2026[i][0] * infl(y); r = LTCG2026[i][1];
      portion = Math.max(0, Math.min(total_ti, hi) - Math.max(ord_ti, prev_hi));
      tax += portion * r;
      prev_hi = hi;
    }
    return tax;
  }

  function std_ded(y, n65) {
    return STD2026 * infl(y) + ADD65_2026 * infl(y) * n65;
  }

  function senior_bonus(y, n65, magi) {
    if (y < 2025 || y > 2028 || n65 === 0) return 0;
    return Math.max(0, SENIOR_BONUS * n65 - 0.06 * Math.max(0, magi - 150000));
  }

  // 1040 社安金计税 worksheet，MFJ。other_agi = 不含应税SS的AGI。调用方做两遍迭代。
  function taxable_ss(other_agi, ss_total) {
    if (ss_total <= 0) return 0;
    var prov = other_agi + 0.5 * ss_total;
    var lo = SS_T[0], hi = SS_T[1];
    if (prov <= lo) return 0;
    var base = Math.min(12000, 0.5 * Math.max(0, prov - lo));
    var excess = 0.85 * Math.max(0, prov - hi);
    return Math.min(excess + base, 0.85 * ss_total);
  }

  // 单人全年 IRMAA 附加费（超出标准保费部分）；保费按通胀放大，阈值不变
  function irmaa_annual(magi2, y) {
    var s = infl(y) / infl(2026), i, cap, b, d;
    for (i = 0; i < IRMAA_MFJ.length; i++) {
      cap = IRMAA_MFJ[i][0]; b = IRMAA_MFJ[i][1]; d = IRMAA_MFJ[i][2];
      if (magi2 <= cap) return Math.max(0, 12 * ((b + d) - 202.90) * s);
    }
    return 0;
  }

  function rmd_for(balance, age) {
    if (age < 75 || age > 120 || balance <= 0) return 0;
    return balance / ULT[age];
  }

  // 给定 ordinary/ltcg，返回联邦所得税及中间量。NIIT 由调用方另算。
  function year_taxes(y, n65, ordinary, ltcg, ss_total) {
    var tss = taxable_ss(ordinary, ss_total);
    tss = taxable_ss(ordinary + tss, ss_total);   // 两遍迭代收敛
    var ord_all = ordinary + tss;
    var agi = ord_all + ltcg;
    var sb = senior_bonus(y, n65, agi);
    var ded = std_ded(y, n65) + sb;
    var ti = Math.max(0, agi - ded);
    var ord_ti = Math.max(0, ti - ltcg);
    var fed = bracket_tax(ord_ti, ORD2026.map(function (br) { return [br[0] * infl(y), br[1]]; }))
            + ltcg_tax(ord_ti, ti, y);
    return { fed: fed, agi: agi, ded: ded, ti: ti, tss: tss, sb: sb, ord_all: ord_all };
  }

  // ---------------- 州税模块（可扩展：加新州只需在 STATES 里加一项） ----------------
  // CA 2026 参数三重交叉验证一致：
  //  (1) 用户加州修正版测算器（artifact slug 2026-2）源码 longTermModel.ts/App.tsx，
  //      经 inspect 手算验证（CA 应税 $824,088 → $70,329 → 抵免 $306 → $70,023 与前端渲染一致）；
  //  (2) FTB 2026 540-ES 说明：标准扣除 MFJ $11,412；
  //  (3) FTB Schedule Y（MFJ）税率表。
  // CA 对社安金免税、资本利得按普通收入计税、不跟进联邦 $6,000 老年扣除；
  // $1M 以上 1% 为 MHSA（现名 BHSA）附加税，单独计征。
  var STATES = {
    CA: {
      id: 'CA', name: '加州',
      note: '累进税率 1%–12.3%，CA 应税收入超 $1M 部分另加 1%；资本利得按普通收入计税；社安金免州税。',
      brackets2026: [[22158, .01], [52528, .02], [82904, .04], [115084, .06], [145448, .08],
                     [742958, .093], [891542, .103], [1485906, .113], [INF, .123]],
      stdDed2026: 11412,          // MFJ
      exemptCredit2026: 153,      // 个人免税额（credit），每人；MFJ 按 2 人计
      seniorCredit2026: 153,      // 65+ 额外 credit，每人
      bhsaThreshold: 1000000, bhsaRate: 0.01,   // 法定不指数化
      compute: function (y, n65, agi, tss) {
        var S = STATES.CA;
        var caAGI = Math.max(0, agi - tss);              // CA 不对社安金征税
        var ti = Math.max(0, caAGI - S.stdDed2026 * infl(y));
        var br = S.brackets2026.map(function (b) { return [b[0] * infl(y), b[1]]; });
        var tax = bracket_tax(ti, br);
        // 免税额为 credit，直接抵税（高收入逐步取消，此处简化为全额；金额小，差额可忽略）
        var credits = (S.exemptCredit2026 * 2 + S.seniorCredit2026 * n65) * infl(y);
        tax = Math.max(0, tax - credits);
        tax += S.bhsaRate * Math.max(0, ti - S.bhsaThreshold);
        return tax;
      }
    },
    NV: {
      id: 'NV', name: '内华达',
      note: '无州个人所得税。',
      compute: function () { return 0; }
    }
    // 以后加 TX/FL/WA：在此加一项 {id, name, note, compute} 即可
  };

  function stateTax(stateId, y, n65, agi, tss) {
    var S = STATES[stateId];
    if (!S) throw new Error('未知州代码: ' + stateId);
    return S.compute(y, n65, agi, tss);
  }

  // ---------------- 住房出售税务（Section 121，MFJ 口径） ----------------
  // gain = 售价 − basis − 卖房费用；满足 2 年自住给 $500K 免税额；应税部分按 LTCG 计税并计入当年 MAGI。
  function homeSaleGain(price, basis, costRate, twoYear) {
    var costs = price * costRate;
    var gain = price - basis - costs;
    var exclusion = twoYear ? 500000 : 0;
    var taxableGain = Math.max(0, gain - exclusion);
    return { costs: costs, gain: gain, exclusion: exclusion, taxableGain: taxableGain };
  }

  global.Tax = {
    INF: INF, BASE_YEAR: BASE_YEAR,
    ORD2026: ORD2026, LTCG2026: LTCG2026, STD2026: STD2026, ADD65_2026: ADD65_2026,
    SENIOR_BONUS: SENIOR_BONUS, NIIT_T: NIIT_T, SS_T: SS_T, IRMAA_MFJ: IRMAA_MFJ, ULT: ULT,
    setInflation: setInflation, getInflation: getInflation, infl: infl,
    bracket_tax: bracket_tax, ltcg_tax: ltcg_tax, std_ded: std_ded,
    senior_bonus: senior_bonus, taxable_ss: taxable_ss,
    irmaa_annual: irmaa_annual, rmd_for: rmd_for, year_taxes: year_taxes,
    STATES: STATES, stateTax: stateTax, homeSaleGain: homeSaleGain
  };
})(typeof window !== 'undefined' ? window : globalThis);

// 融资试算：投前估值 + 投资额 + 期权池目标 → 整数股下的稀释结果。
// 期权池可在融资前（计入投前，原股东承担稀释）或融资后（全员共同稀释）补足，两种口径对照输出。
// 股数向下取整，实际认购额 = 股数 × 每股价格，尾差如实展示，不改动投资额。
import { Decimal, DecimalError } from './decimal.js';
import { percentString, ValidationError } from './ledger.js';

export class FinancingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FinancingError';
  }
}

function readNonNegInt(v) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (!/^\d+$/.test(t)) return null;
  return BigInt(t);
}

function parseInputs(inputs) {
  const errors = [];
  let preMoney = null;
  let investment = null;
  let target = null;
  try {
    preMoney = Decimal.parse(String(inputs?.preMoney ?? ''));
    if (!preMoney.isPositive()) errors.push('投前估值必须大于 0');
  } catch (e) {
    errors.push(`投前估值格式无效：${e instanceof DecimalError ? e.message : e}`);
  }
  try {
    investment = Decimal.parse(String(inputs?.investment ?? ''));
    if (!investment.isPositive()) errors.push('投资额必须大于 0');
  } catch (e) {
    errors.push(`投资额格式无效：${e instanceof DecimalError ? e.message : e}`);
  }
  try {
    target = Decimal.parse(String(inputs?.poolTargetPct ?? '0'));
    if (target.isNegative() || target.cmp(new Decimal(100n, 0)) >= 0) {
      errors.push('期权池目标需在 0（含）到 100%（不含）之间');
    }
  } catch (e) {
    errors.push(`期权池目标格式无效：${e instanceof DecimalError ? e.message : e}`);
  }
  const S = readNonNegInt(inputs?.currentShares);
  if (S === null || S <= 0n) errors.push('当前总股本必须为正整数');
  const P0 = readNonNegInt(inputs?.currentPoolShares ?? '0');
  if (P0 === null) errors.push('现有期权池股数必须为非负整数');
  if (S !== null && P0 !== null && P0 > S) errors.push('现有期权池股数不能超过当前总股本');
  if (errors.length) throw new ValidationError(errors.join('；'), errors);
  return { preMoney, investment, target, S, P0 };
}

/**
 * 期权池缺口：满足 (P0 + P) / (S + I + P) ≥ t 的最小整数 P（≥0）。
 * t 以百分数给出（如 "10" 表示 10%），换算为分数 T/K。
 */
function requiredPool(t, S, I, P0) {
  const T = t.m;
  const K = 10n ** BigInt(t.s) * 100n; // 百分数 → 分数
  const num = T * (S + I) - K * P0;
  const den = K - T; // t < 100% 保证为正
  if (num <= 0n) return 0n;
  return (num + den - 1n) / den;
}

const PRICE_SCALE = 6; // 每股价格保留 6 位小数

function computeScenario(inp, timing, holders) {
  let P = 0n; // 新增期权池股数
  let I = 0n; // 新投资人股数
  let price = null;
  let converged = false;
  // pre 口径下价格与池规模互相依赖：单调不动点迭代（通常 2–3 步收敛）
  for (let iter = 0; iter < 1000; iter++) {
    const base = timing === 'pre' ? inp.S + P : inp.S;
    price = inp.preMoney.div(new Decimal(base, 0), PRICE_SCALE);
    if (!price.isPositive()) {
      throw new FinancingError('投前估值相对当前股本过低，每股价格不足最小精度，无法试算');
    }
    I = inp.investment.floorDiv(price);
    const req = requiredPool(inp.target, inp.S, I, inp.P0);
    if (req === P) {
      converged = true;
      break;
    }
    P = req;
  }
  if (!converged) throw new FinancingError('试算未收敛，请检查参数');

  const actual = price.mul(new Decimal(I, 0));
  const remainder = inp.investment.sub(actual);
  const total = inp.S + P + I;
  const poolTotal = inp.P0 + P;
  const warnings = [];
  if (I === 0n) warnings.push('按当前参数，投资额不足认购 1 股');
  if (remainder.isPositive()) {
    warnings.push(`因股数必须为整数，存在未认购尾差 ¥${remainder.trimmed()}（投资额未被修改）`);
  }

  return {
    timing,
    pricePerShare: price.toString(),
    investorShares: I.toString(),
    actualInvestment: actual.toString(),
    remainder: remainder.toString(),
    newPoolShares: P.toString(),
    totalPoolShares: poolTotal.toString(),
    postTotalShares: total.toString(),
    postMoneyValuation: inp.preMoney.add(inp.investment).toString(),
    investorPct: percentString(I, total),
    poolPct: percentString(poolTotal, total),
    othersPct: percentString(inp.S - inp.P0, total),
    warnings,
    perHolder: holders.map((h) => ({
      id: h.id,
      name: h.name,
      shares: String(h.shares),
      pctBefore: percentString(BigInt(h.shares), inp.S),
      pctAfter: percentString(BigInt(h.shares), total),
    })),
  };
}

/**
 * @param inputs { preMoney, investment, poolTargetPct, currentShares, currentPoolShares }
 * @param holders 当前股东 [{ id, name, shares }]
 * @returns { pre, post } 两种池补足口径的完整结果
 */
export function simulateRound(inputs, holders) {
  const inp = parseInputs(inputs);
  return {
    currentShares: inp.S.toString(),
    currentPoolShares: inp.P0.toString(),
    pre: computeScenario(inp, 'pre', holders),
    post: computeScenario(inp, 'post', holders),
  };
}

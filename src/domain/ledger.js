// 台账引擎：追加式交易链 + 全链路重放校验。
// 股数一律为整数（BigInt），价格/金额为精确小数字符串。
import { Decimal, DecimalError } from './decimal.js';

export class ValidationError extends Error {
  /** @param {string} message @param {string[]} details 逐条校验错误 */
  constructor(message, details = []) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export const TX_TYPES = {
  ISSUE: '增资发行',
  TRANSFER: '股权转让',
  SPLIT: '拆股/并股',
  CANCEL: '注销减资',
};

export function createEmptyLedger() {
  return {
    version: 1,
    shareholders: [], // { id, name }
    transactions: [], // 追加式；位置即序号（seq = index + 1）
    scenarios: [],
    counters: { shareholder: 0, transaction: 0, scenario: 0 },
  };
}

const SHARES_RE = /^\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readShares(v) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (!SHARES_RE.test(t)) return null;
  const n = BigInt(t);
  return n > 0n ? n : null;
}

function readPrice(v) {
  if (v === null || v === undefined || String(v).trim() === '') return { value: null };
  try {
    const d = Decimal.parse(String(v).trim());
    if (d.isNegative()) return { error: '每股价格不能为负' };
    return { value: d.toString() };
  } catch (e) {
    if (e instanceof DecimalError) return { error: `每股价格格式无效：${e.message}` };
    throw e;
  }
}

function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 字段级校验并规范化交易草稿；不通过则抛 ValidationError（details 为逐条错误）。 */
export function buildTransaction(state, draft) {
  const errors = [];
  const type = draft?.type;
  if (!TX_TYPES[type]) errors.push('交易类型无效');

  const date = String(draft?.date ?? '').trim();
  if (!isValidDate(date)) errors.push('日期无效（应为 YYYY-MM-DD）');

  const rawNote = String(draft?.note ?? '');
  if (rawNote.length > 200) errors.push('备注过长（不超过 200 字）');
  const note = rawNote.trim();

  const tx = { type, date, note };
  const holderExists = (id) => state.shareholders.some((h) => h.id === id);
  const nameTaken = (name) => state.shareholders.some((h) => h.name === name);

  const readHolder = (id, newName, label, idKey) => {
    if (id === '__new__') {
      const name = String(newName ?? '').trim();
      if (!name) errors.push(`请填写新${label}名称`);
      else if (name.length > 50) errors.push(`${label}名称过长（不超过 50 字）`);
      else if (nameTaken(name)) errors.push(`股东「${name}」已存在，请直接选择`);
      else tx[idKey === 'holderId' ? 'newHolderName' : 'newToName'] = name;
    } else if (holderExists(id)) {
      tx[idKey] = id;
    } else {
      errors.push(`请选择${label}`);
    }
  };

  if (type === 'ISSUE') {
    readHolder(draft.holderId, draft.newHolderName, '股东', 'holderId');
    const sh = readShares(draft.shares);
    if (sh === null) errors.push('发行股数必须为正整数');
    else tx.shares = sh.toString();
    const price = readPrice(draft.pricePerShare);
    if (price.error) errors.push(price.error);
    else tx.pricePerShare = price.value;
  } else if (type === 'TRANSFER') {
    if (!holderExists(draft.fromId)) errors.push('请选择转让方');
    else tx.fromId = draft.fromId;
    readHolder(draft.toId, draft.newToName, '受让方', 'toId');
    if (tx.fromId && tx.toId && tx.fromId === tx.toId) errors.push('转让方与受让方不能是同一人');
    const sh = readShares(draft.shares);
    if (sh === null) errors.push('转让股数必须为正整数');
    else tx.shares = sh.toString();
    const price = readPrice(draft.pricePerShare);
    if (price.error) errors.push(price.error);
    else tx.pricePerShare = price.value;
  } else if (type === 'SPLIT') {
    const num = readShares(draft.numerator);
    const den = readShares(draft.denominator);
    if (num === null) errors.push('拆股分子必须为正整数');
    if (den === null) errors.push('拆股分母必须为正整数');
    if (num !== null && den !== null && num === den) errors.push('拆股比例无效：分子等于分母');
    if (num !== null) tx.numerator = num.toString();
    if (den !== null) tx.denominator = den.toString();
  } else if (type === 'CANCEL') {
    if (!holderExists(draft.holderId)) errors.push('请选择股东');
    else tx.holderId = draft.holderId;
    const sh = readShares(draft.shares);
    if (sh === null) errors.push('注销股数必须为正整数');
    else tx.shares = sh.toString();
  }

  if (errors.length) throw new ValidationError(errors.join('；'), errors);
  return tx;
}

/**
 * 全链路重放：逐笔应用并校验（余额不得为负、拆股须整除、日期不得倒退）。
 * 在第一个错误处停止。返回 { ok, errors, balances, total }。
 */
export function simulateChain(shareholders, transactions) {
  const balances = new Map(shareholders.map((h) => [h.id, 0n]));
  let total = 0n;
  let prevDate = null;
  const fail = (index, message) => ({ ok: false, errors: [{ index, message }], balances, total });

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (prevDate && tx.date < prevDate) {
      return fail(i, `交易日期 ${tx.date} 早于前一笔 ${prevDate}，交易顺序冲突`);
    }
    prevDate = tx.date;

    if (tx.type === 'ISSUE') {
      const sh = BigInt(tx.shares);
      if (!balances.has(tx.holderId)) return fail(i, '发行对象股东不存在');
      balances.set(tx.holderId, balances.get(tx.holderId) + sh);
      total += sh;
    } else if (tx.type === 'TRANSFER') {
      const sh = BigInt(tx.shares);
      if (!balances.has(tx.fromId)) return fail(i, '转让方不存在');
      if (!balances.has(tx.toId)) return fail(i, '受让方不存在');
      if (tx.fromId === tx.toId) return fail(i, '转让方与受让方不能是同一人');
      const from = balances.get(tx.fromId);
      if (from < sh) return fail(i, `转让方持股不足：当前 ${from} 股，拟转让 ${sh} 股`);
      balances.set(tx.fromId, from - sh);
      balances.set(tx.toId, balances.get(tx.toId) + sh);
    } else if (tx.type === 'SPLIT') {
      const num = BigInt(tx.numerator);
      const den = BigInt(tx.denominator);
      const bad = [];
      for (const [id, bal] of balances) {
        if (bal > 0n && (bal * num) % den !== 0n) bad.push(`${id}:${bal}`);
      }
      if (bad.length) {
        const names = bad
          .map((s) => {
            const [id, bal] = s.split(':');
            const h = shareholders.find((x) => x.id === id);
            return `${h ? h.name : id}（${bal} 股）`;
          })
          .join('、');
        return fail(i, `拆股将产生零碎股：${names} 无法按 ${tx.denominator}:${tx.numerator} 整除`);
      }
      for (const [id, bal] of balances) balances.set(id, (bal * num) / den);
      total = (total * num) / den;
    } else if (tx.type === 'CANCEL') {
      const sh = BigInt(tx.shares);
      if (!balances.has(tx.holderId)) return fail(i, '注销对象股东不存在');
      const bal = balances.get(tx.holderId);
      if (bal < sh) return fail(i, `注销超过持股：当前 ${bal} 股，拟注销 ${sh} 股`);
      balances.set(tx.holderId, bal - sh);
      total -= sh;
    } else {
      return fail(i, `未知交易类型 ${tx.type}`);
    }
  }
  return { ok: true, errors: [], balances, total };
}

/**
 * 插入交易（默认追加到末尾）。先做字段校验，再把整条链重放一遍：
 * 若插入导致任何后续交易失效（余额不足、日期倒退等），整体拒绝。
 */
export function insertTransaction(state, draft, insertAfter = null, extra = {}) {
  const tx = buildTransaction(state, draft);
  const len = state.transactions.length;
  const pos = insertAfter === null || insertAfter === undefined ? len : Number(insertAfter);
  if (!Number.isInteger(pos) || pos < 0 || pos > len) {
    throw new ValidationError(`插入位置无效（应在 0–${len} 之间）`);
  }

  // 先 tentative 地解析新股东
  const newNames = [];
  if (tx.newHolderName) newNames.push(['newHolderName', 'holderId', tx.newHolderName]);
  if (tx.newToName) newNames.push(['newToName', 'toId', tx.newToName]);
  const tentativeHolders = state.shareholders.slice();
  newNames.forEach(([, , name], i) => {
    tentativeHolders.push({ id: `h-new-${i}`, name });
  });
  const resolved = { ...tx };
  newNames.forEach(([nameKey, idKey, name], i) => {
    resolved[idKey] = `h-new-${i}`;
    delete resolved[nameKey];
  });

  const tentativeTxs = state.transactions.slice();
  tentativeTxs.splice(pos, 0, resolved);
  const check = simulateChain(tentativeHolders, tentativeTxs);
  if (!check.ok) {
    const { index, message } = check.errors[0];
    const where = `第 ${index + 1} 笔`;
    const msg =
      index === pos
        ? `新增交易（${where}）无效：${message}`
        : `交易顺序冲突：插入后${where}交易（${tentativeTxs[index].date} ${TX_TYPES[tentativeTxs[index].type]}）将失效：${message}`;
    throw new ValidationError(msg, [msg]);
  }

  // 提交：真正创建新股东、分配 id、落位
  for (const [nameKey, idKey, name] of newNames) {
    const id = `h-${++state.counters.shareholder}`;
    state.shareholders.push({ id, name });
    resolved[idKey] = id;
  }
  const finalTx = { id: `t-${++state.counters.transaction}`, ...resolved, ...extra };
  state.transactions.splice(pos, 0, finalTx);
  return finalTx;
}

/** 撤销最后一笔（由情景并入的交易不可单独撤销）。 */
export function removeLastTransaction(state) {
  const last = state.transactions[state.transactions.length - 1];
  if (!last) throw new ValidationError('没有可撤销的交易');
  if (last.linkedScenarioId) {
    throw new ValidationError('最后一笔交易由情景并入产生，不可单独撤销（追加式台账）');
  }
  state.transactions.pop();
  return last;
}

/** 比例字符串：part/whole 以百分比表示，保留 dp 位小数（四舍五入）。whole 为 0 时返回 null。 */
export function percentString(part, whole, dp = 6) {
  const p = BigInt(part);
  const w = BigInt(whole);
  if (w === 0n) return null;
  const scale = 10n ** BigInt(dp + 2); // 百分比 + dp 位小数
  const num = p * scale;
  const q = (2n * num + w) / (2n * w); // half-up
  const s = q.toString().padStart(dp + 1, '0');
  const int = s.slice(0, s.length - dp);
  const frac = s.slice(s.length - dp);
  return `${int}.${frac}`;
}

/** 截至第 at 笔之后（at=null 表示最新）的持股表。 */
export function holdingsAt(state, at = null) {
  const len = state.transactions.length;
  const n = at === null || at === undefined ? len : Math.max(0, Math.min(Number(at), len));
  const { ok, errors, balances, total } = simulateChain(
    state.shareholders,
    state.transactions.slice(0, n),
  );
  if (!ok) throw new Error(`台账数据不一致：第 ${errors[0].index + 1} 笔 ${errors[0].message}`);
  const rows = state.shareholders
    .map((h) => {
      const shares = balances.get(h.id) ?? 0n;
      return { id: h.id, name: h.name, shares: shares.toString(), pct: percentString(shares, total) };
    })
    .sort((a, b) => {
      const x = BigInt(a.shares);
      const y = BigInt(b.shares);
      return x === y ? a.name.localeCompare(b.name, 'zh-CN') : x < y ? 1 : -1;
    });
  return { at: n, rows, total: total.toString() };
}

const fmtShares = (s) => BigInt(s).toLocaleString('zh-CN');

export function txSummary(shareholders, tx) {
  const name = (id) => shareholders.find((h) => h.id === id)?.name ?? '？';
  switch (tx.type) {
    case 'ISSUE':
      return (
        `向 ${name(tx.holderId)} 发行 ${fmtShares(tx.shares)} 股` +
        (tx.pricePerShare ? `，每股 ¥${tx.pricePerShare}` : '')
      );
    case 'TRANSFER':
      return (
        `${name(tx.fromId)} → ${name(tx.toId)} 转让 ${fmtShares(tx.shares)} 股` +
        (tx.pricePerShare ? `，每股 ¥${tx.pricePerShare}` : '')
      );
    case 'SPLIT': {
      const n = BigInt(tx.numerator);
      const d = BigInt(tx.denominator);
      if (d === 1n) return `拆股：1 股拆 ${n} 股`;
      if (n === 1n) return `并股：${d} 股并 1 股`;
      return `拆并股：每 ${d} 股变为 ${n} 股`;
    }
    case 'CANCEL':
      return `注销 ${name(tx.holderId)} ${fmtShares(tx.shares)} 股`;
    default:
      return tx.type;
  }
}

/** 某股东截至第 at 笔的持股构成（影响过该股东的逐笔交易 + 变动后余额/比例）。 */
export function provenance(state, holderId, at = null) {
  const holder = state.shareholders.find((h) => h.id === holderId);
  if (!holder) throw new ValidationError('股东不存在');
  const len = state.transactions.length;
  const n = at === null || at === undefined ? len : Math.max(0, Math.min(Number(at), len));

  let bal = 0n;
  let total = 0n;
  const events = [];
  for (let i = 0; i < n; i++) {
    const tx = state.transactions[i];
    let delta = null;
    if (tx.type === 'ISSUE') {
      total += BigInt(tx.shares);
      if (tx.holderId === holderId) delta = BigInt(tx.shares);
    } else if (tx.type === 'TRANSFER') {
      const sh = BigInt(tx.shares);
      if (tx.fromId === holderId) delta = -sh;
      if (tx.toId === holderId) delta = (delta ?? 0n) + sh;
    } else if (tx.type === 'SPLIT') {
      const num = BigInt(tx.numerator);
      const den = BigInt(tx.denominator);
      const nb = (bal * num) / den;
      delta = nb - bal;
      total = (total * num) / den;
    } else if (tx.type === 'CANCEL') {
      total -= BigInt(tx.shares);
      if (tx.holderId === holderId) delta = -BigInt(tx.shares);
    }
    if (delta !== null && delta !== 0n) {
      bal += delta;
      events.push({
        seq: i + 1,
        date: tx.date,
        type: tx.type,
        typeLabel: TX_TYPES[tx.type],
        summary: txSummary(state.shareholders, tx),
        delta: delta.toString(),
        balanceAfter: bal.toString(),
        pctAfter: percentString(bal, total),
      });
    }
  }
  return {
    holder: { id: holder.id, name: holder.name },
    at: n,
    txCount: len,
    balance: bal.toString(),
    total: total.toString(),
    pct: percentString(bal, total),
    events,
  };
}

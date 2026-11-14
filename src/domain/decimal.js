// 精确小数：BigInt 尾数 + 小数位标度，用于货币与每股价格。
// 加/减/乘精确；除法按指定标度四舍五入（half-up），结果仍是精确小数。

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export class DecimalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecimalError';
  }
}

export class Decimal {
  /** @param {bigint} m 尾数 @param {number} s 小数位数 */
  constructor(m, s) {
    this.m = m;
    this.s = s;
    Object.freeze(this);
  }

  static parse(v) {
    if (v instanceof Decimal) return v;
    if (typeof v === 'bigint') return new Decimal(v, 0);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new DecimalError('数值必须有限');
      v = String(v);
    }
    if (typeof v !== 'string') throw new DecimalError(`无法解析的数值: ${String(v)}`);
    const t = v.trim();
    if (!DECIMAL_RE.test(t)) throw new DecimalError(`数值格式不合法: "${v}"`);
    const neg = t.startsWith('-');
    const body = neg ? t.slice(1) : t;
    const dot = body.indexOf('.');
    const intPart = dot === -1 ? body : body.slice(0, dot);
    const fracPart = dot === -1 ? '' : body.slice(dot + 1);
    const m = BigInt(intPart + fracPart) * (neg ? -1n : 1n);
    return new Decimal(m, fracPart.length);
  }

  static zero() {
    return new Decimal(0n, 0);
  }

  static #align(a, b) {
    if (a.s === b.s) return [a.m, b.m, a.s];
    if (a.s > b.s) return [a.m, b.m * 10n ** BigInt(a.s - b.s), a.s];
    return [a.m * 10n ** BigInt(b.s - a.s), b.m, b.s];
  }

  add(other) {
    const b = Decimal.parse(other);
    const [x, y, s] = Decimal.#align(this, b);
    return new Decimal(x + y, s);
  }

  sub(other) {
    const b = Decimal.parse(other);
    const [x, y, s] = Decimal.#align(this, b);
    return new Decimal(x - y, s);
  }

  mul(other) {
    const b = Decimal.parse(other);
    return new Decimal(this.m * b.m, this.s + b.s);
  }

  /** 除以 other，结果保留 scale 位小数（四舍五入 half-up，负数按绝对值对称处理）。 */
  div(other, scale = 6) {
    const b = Decimal.parse(other);
    if (b.m === 0n) throw new DecimalError('除数为零');
    if (!Number.isInteger(scale) || scale < 0) throw new DecimalError('标度必须为非负整数');
    const num = this.m * 10n ** BigInt(b.s + scale);
    const den = b.m * 10n ** BigInt(this.s);
    let q = num / den;
    const r = num % den;
    if (r !== 0n) {
      const twice = (r < 0n ? -r : r) * 2n;
      const ad = den < 0n ? -den : den;
      if (twice >= ad) q += (num < 0n) !== (den < 0n) ? -1n : 1n;
    }
    return new Decimal(q, scale);
  }

  /** this / other 向下取整，返回 BigInt（用于由投资额求可认购股数）。 */
  floorDiv(other) {
    const b = Decimal.parse(other);
    if (b.m === 0n) throw new DecimalError('除数为零');
    const num = this.m * 10n ** BigInt(b.s);
    const den = b.m * 10n ** BigInt(this.s);
    let q = num / den;
    if (num % den !== 0n && (num < 0n) !== (den < 0n)) q -= 1n;
    return q;
  }

  cmp(other) {
    const b = Decimal.parse(other);
    const [x, y] = Decimal.#align(this, b);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  isZero() {
    return this.m === 0n;
  }

  isPositive() {
    return this.m > 0n;
  }

  isNegative() {
    return this.m < 0n;
  }

  neg() {
    return new Decimal(-this.m, this.s);
  }

  abs() {
    return this.m < 0n ? new Decimal(-this.m, this.s) : this;
  }

  /** 精确字符串（保留全部标度位，不丢精度）。 */
  toString() {
    const neg = this.m < 0n;
    const digits = (neg ? -this.m : this.m).toString().padStart(this.s + 1, '0');
    const int = digits.slice(0, digits.length - this.s || undefined);
    const frac = this.s ? digits.slice(digits.length - this.s) : '';
    return (neg ? '-' : '') + (this.s ? `${int}.${frac}` : int);
  }

  /** 四舍五入到 scale 位的字符串。 */
  toFixed(scale) {
    if (!Number.isInteger(scale) || scale < 0) throw new DecimalError('标度必须为非负整数');
    if (scale >= this.s) {
      const base = this.toString();
      if (scale === this.s) return base;
      const pad = '0'.repeat(scale - this.s);
      return this.s ? `${base}${pad}` : `${base}.${pad}`;
    }
    const drop = BigInt(this.s - scale);
    const div = 10n ** drop;
    let q = this.m / div;
    const r = this.m % div;
    if (r !== 0n && (r < 0n ? -r : r) * 2n >= div) q += this.m < 0n ? -1n : 1n;
    return new Decimal(q, scale).toString();
  }

  /** 去掉末尾多余的 0 的展示字符串。 */
  trimmed() {
    const s = this.toString();
    if (!s.includes('.')) return s;
    const t = s.replace(/0+$/, '').replace(/\.$/, '');
    return t === '-0' ? '0' : t;
  }
}

export function dec(v) {
  return Decimal.parse(v);
}

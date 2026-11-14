import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateRound } from '../src/domain/financing.js';
import { ValidationError } from '../src/domain/ledger.js';

const HOLDERS = [
  { id: 'h-1', name: '张三', shares: '6000000' },
  { id: 'h-2', name: '李四', shares: '4000000' },
];

test('融资后补足池：价格不摊薄，池由全员承担', () => {
  const r = simulateRound(
    {
      preMoney: '40000000',
      investment: '10000000',
      poolTargetPct: '10',
      currentShares: '10000000',
      currentPoolShares: '0',
    },
    HOLDERS,
  );
  const post = r.post;
  assert.equal(post.pricePerShare, '4.000000');
  assert.equal(post.investorShares, '2500000');
  assert.equal(post.actualInvestment, '10000000.000000');
  assert.equal(post.remainder, '0.000000');
  // 池：P/(1000万+250万+P) ≥ 10% → P = ceil(1250000/0.9) = 1,388,889
  assert.equal(post.newPoolShares, '1388889');
  assert.equal(post.postTotalShares, '13888889');
  assert.ok(Number(post.poolPct) >= 10, `poolPct=${post.poolPct}`);
  assert.ok(Number(post.investorPct) < 20); // 投资人也被池稀释
});

test('融资前补足池：原股东承担池稀释，两种口径对照', () => {
  const inputs = {
    preMoney: '40000000',
    investment: '10000000',
    poolTargetPct: '10',
    currentShares: '10000000',
    currentPoolShares: '0',
  };
  const r = simulateRound(inputs, HOLDERS);
  // 经典结论：池计入投前时，原股东稀释更重、投资人拿到更多股
  assert.ok(Number(r.pre.othersPct) < Number(r.post.othersPct));
  assert.ok(Number(r.pre.investorPct) > Number(r.post.investorPct));
  assert.ok(Number(r.pre.poolPct) >= 10);
  assert.ok(Number(r.pre.pricePerShare) < Number(r.post.pricePerShare));
  // 两种口径都满足池目标
  assert.ok(Number(r.post.poolPct) >= 10);
});

test('整数股尾差：展示实际认购额与差额，不改动投资额', () => {
  const r = simulateRound(
    {
      preMoney: '10000000',
      investment: '1000000',
      poolTargetPct: '0',
      currentShares: '3000000',
      currentPoolShares: '0',
    },
    HOLDERS,
  );
  const post = r.post;
  assert.equal(post.pricePerShare, '3.333333');
  assert.equal(post.investorShares, '300000');
  assert.equal(post.actualInvestment, '999999.900000');
  assert.equal(post.remainder, '0.100000'); // 尾差如实展示
  assert.ok(post.warnings.some((w) => w.includes('尾差')));
});

test('已有池抵扣目标；池目标为 0 时不新增', () => {
  const r = simulateRound(
    {
      preMoney: '40000000',
      investment: '10000000',
      poolTargetPct: '5',
      currentShares: '10000000',
      currentPoolShares: '1000000',
    },
    HOLDERS,
  );
  assert.ok(BigInt(r.post.newPoolShares) >= 0n);
  assert.ok(Number(r.post.poolPct) >= 5);
  const r0 = simulateRound(
    {
      preMoney: '40000000',
      investment: '10000000',
      poolTargetPct: '0',
      currentShares: '10000000',
      currentPoolShares: '0',
    },
    HOLDERS,
  );
  assert.equal(r0.pre.newPoolShares, '0');
  assert.equal(r0.post.newPoolShares, '0');
});

test('逐股东稀释对照行', () => {
  const r = simulateRound(
    {
      preMoney: '40000000',
      investment: '10000000',
      poolTargetPct: '10',
      currentShares: '10000000',
      currentPoolShares: '0',
    },
    HOLDERS,
  );
  const zhang = r.pre.perHolder.find((h) => h.name === '张三');
  assert.equal(zhang.pctBefore, '60.000000');
  assert.ok(Number(zhang.pctAfter) < 60);
});

test('非法参数被阻止', () => {
  assert.throws(
    () =>
      simulateRound(
        { preMoney: '0', investment: '100', poolTargetPct: '10', currentShares: '100', currentPoolShares: '0' },
        [],
      ),
    ValidationError,
  );
  assert.throws(
    () =>
      simulateRound(
        { preMoney: '100', investment: '100', poolTargetPct: '100', currentShares: '100', currentPoolShares: '0' },
        [],
      ),
    /期权池目标/,
  );
  assert.throws(
    () =>
      simulateRound(
        { preMoney: '100', investment: '100', poolTargetPct: '10', currentShares: '100', currentPoolShares: '200' },
        [],
      ),
    /不能超过/,
  );
});

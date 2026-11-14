import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyLedger,
  insertTransaction,
  removeLastTransaction,
  holdingsAt,
  provenance,
  ValidationError,
} from '../src/domain/ledger.js';

function issue(state, name, shares, date, price = '0.01') {
  return insertTransaction(state, {
    type: 'ISSUE',
    date,
    holderId: '__new__',
    newHolderName: name,
    shares,
    pricePerShare: price,
  });
}

function baseLedger() {
  const st = createEmptyLedger();
  issue(st, '甲', '6000000', '2024-01-01');
  issue(st, '乙', '4000000', '2024-01-01');
  return st;
}

const holderId = (st, name) => st.shareholders.find((h) => h.name === name).id;

test('逐笔重放：任意时点的持股与比例', () => {
  const st = baseLedger();
  insertTransaction(st, {
    type: 'TRANSFER',
    date: '2024-02-01',
    fromId: holderId(st, '甲'),
    toId: holderId(st, '乙'),
    shares: '1000000',
  });
  const at2 = holdingsAt(st, 2);
  assert.equal(at2.total, '10000000');
  const row = (rows, name) => rows.find((r) => r.name === name);
  assert.equal(row(at2.rows, '甲').shares, '6000000');
  assert.equal(row(at2.rows, '甲').pct, '60.000000');
  const at3 = holdingsAt(st, 3);
  assert.equal(row(at3.rows, '甲').shares, '5000000');
  assert.equal(row(at3.rows, '甲').pct, '50.000000');
  assert.equal(row(at3.rows, '乙').shares, '5000000');
  // 转让不改变总股数
  assert.equal(at3.total, '10000000');
});

test('增资才改变分母', () => {
  const st = baseLedger();
  issue(st, '丙', '2500000', '2024-03-01', '0.8');
  const h = holdingsAt(st);
  assert.equal(h.total, '12500000');
  assert.equal(h.rows.find((r) => r.name === '甲').pct, '48.000000');
});

test('股数不足的转让被阻止', () => {
  const st = baseLedger();
  assert.throws(
    () =>
      insertTransaction(st, {
        type: 'TRANSFER',
        date: '2024-02-01',
        fromId: holderId(st, '甲'),
        toId: holderId(st, '乙'),
        shares: '6000001',
      }),
    (e) => e instanceof ValidationError && /持股不足/.test(e.message),
  );
  assert.equal(st.transactions.length, 2); // 未落账
});

test('注销超量被阻止', () => {
  const st = baseLedger();
  assert.throws(
    () =>
      insertTransaction(st, {
        type: 'CANCEL',
        date: '2024-02-01',
        holderId: holderId(st, '乙'),
        shares: '4000001',
      }),
    /注销超过持股/,
  );
});

test('拆股同比调整所有股份；不能整除的并股被阻止', () => {
  const st = baseLedger();
  insertTransaction(st, { type: 'SPLIT', date: '2024-02-01', numerator: '2', denominator: '1' });
  const h = holdingsAt(st);
  assert.equal(h.total, '20000000');
  assert.equal(h.rows.find((r) => r.name === '甲').shares, '12000000');
  // 1 并 3：6,000,000/3 整除，4,000,000/3 不整除 → 拒绝
  assert.throws(
    () => insertTransaction(st, { type: 'SPLIT', date: '2024-03-01', numerator: '1', denominator: '3' }),
    /零碎股/,
  );
});

test('交易顺序冲突：日期倒退被阻止', () => {
  const st = baseLedger();
  assert.throws(
    () =>
      insertTransaction(st, {
        type: 'CANCEL',
        date: '2023-12-31',
        holderId: holderId(st, '甲'),
        shares: '1',
      }),
    /顺序冲突/,
  );
});

test('交易顺序冲突：中间插入导致后续交易失效被阻止', () => {
  const st = createEmptyLedger();
  issue(st, '甲', '100', '2024-01-01');
  insertTransaction(st, {
    type: 'TRANSFER',
    date: '2024-02-01',
    fromId: holderId(st, '甲'),
    toId: '__new__',
    newToName: '乙',
    shares: '100',
  });
  // 在第 1 笔之后插入一笔注销 50，甲只剩 50，后续转让 100 将失效
  assert.throws(
    () =>
      insertTransaction(
        st,
        { type: 'CANCEL', date: '2024-01-15', holderId: holderId(st, '甲'), shares: '50' },
        1,
      ),
    (e) => e instanceof ValidationError && /失效|不足/.test(e.message),
  );
  assert.equal(st.transactions.length, 2);
});

test('中间插入合法交易：后续链条重新校验通过', () => {
  const st = createEmptyLedger();
  issue(st, '甲', '100', '2024-01-01');
  insertTransaction(st, {
    type: 'TRANSFER',
    date: '2024-03-01',
    fromId: holderId(st, '甲'),
    toId: '__new__',
    newToName: '乙',
    shares: '60',
  });
  insertTransaction(
    st,
    { type: 'ISSUE', date: '2024-02-01', holderId: holderId(st, '甲'), shares: '50' },
    1,
  );
  const h = holdingsAt(st);
  assert.equal(h.rows.find((r) => r.name === '甲').shares, '90');
  assert.equal(h.rows.find((r) => r.name === '乙').shares, '60');
});

test('比例不做凑整：三等分时显示值合计不等于 100%', () => {
  const st = createEmptyLedger();
  issue(st, '甲', '1', '2024-01-01');
  issue(st, '乙', '1', '2024-01-01');
  issue(st, '丙', '1', '2024-01-01');
  const h = holdingsAt(st);
  for (const r of h.rows) {
    assert.equal(r.pct, '33.333333');
    assert.ok(BigInt(r.shares) >= 0n); // 绝无负持股
  }
  const sum = h.rows.reduce((a, r) => a + Number(r.pct), 0);
  assert.notEqual(sum.toFixed(6), '100.000000'); // 显示尾差如实呈现，不凑整
  // 但底层是精确有理数：1/3 × 3 = 1
  assert.equal(h.total, '3');
});

test('持股构成回溯：影响该股东的交易逐笔列出', () => {
  const st = baseLedger();
  insertTransaction(st, {
    type: 'TRANSFER',
    date: '2024-02-01',
    fromId: holderId(st, '甲'),
    toId: holderId(st, '乙'),
    shares: '1000000',
  });
  insertTransaction(st, { type: 'SPLIT', date: '2024-03-01', numerator: '2', denominator: '1' });
  const p = provenance(st, holderId(st, '甲'));
  assert.equal(p.events.length, 3);
  assert.deepEqual(
    p.events.map((e) => e.type),
    ['ISSUE', 'TRANSFER', 'SPLIT'],
  );
  assert.equal(p.events[1].delta, '-1000000');
  assert.equal(p.events[2].delta, '5000000'); // 拆股：5,000,000 → 10,000,000
  assert.equal(p.balance, '10000000');
  assert.equal(p.pct, '50.000000');
  // 截至第 3 笔（转让后、拆股前）
  const p2 = provenance(st, holderId(st, '甲'), 3);
  assert.equal(p2.balance, '5000000');
  assert.equal(p2.events.length, 2);
});

test('撤销最后一笔；情景并入的交易不可撤销', () => {
  const st = baseLedger();
  const removed = removeLastTransaction(st);
  assert.equal(removed.type, 'ISSUE');
  assert.equal(st.transactions.length, 1);
  insertTransaction(
    st,
    { type: 'ISSUE', date: '2024-02-01', holderId: holderId(st, '甲'), shares: '10' },
    null,
    { linkedScenarioId: 's-1' },
  );
  assert.throws(() => removeLastTransaction(st), /情景并入/);
});

test('字段级校验：同一人转让、非法股数、重复股东名', () => {
  const st = baseLedger();
  assert.throws(
    () =>
      insertTransaction(st, {
        type: 'TRANSFER',
        date: '2024-02-01',
        fromId: holderId(st, '甲'),
        toId: holderId(st, '甲'),
        shares: '1',
      }),
    /同一人/,
  );
  assert.throws(
    () =>
      insertTransaction(st, {
        type: 'ISSUE',
        date: '2024-02-01',
        holderId: holderId(st, '甲'),
        shares: '1.5',
      }),
    /正整数/,
  );
  assert.throws(
    () =>
      insertTransaction(st, {
        type: 'ISSUE',
        date: '2024-02-01',
        holderId: '__new__',
        newHolderName: '甲',
        shares: '1',
      }),
    /已存在/,
  );
});

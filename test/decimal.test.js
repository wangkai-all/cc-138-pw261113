import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../src/domain/decimal.js';

test('解析与输出往返一致', () => {
  assert.equal(Decimal.parse('1234.5678').toString(), '1234.5678');
  assert.equal(Decimal.parse('10000000').toString(), '10000000');
  assert.equal(Decimal.parse('-0.5').toString(), '-0.5');
  assert.equal(Decimal.parse('0.010').toString(), '0.010');
});

test('拒绝非法格式', () => {
  assert.throws(() => Decimal.parse('1e5'));
  assert.throws(() => Decimal.parse('abc'));
  assert.throws(() => Decimal.parse('1.2.3'));
  assert.throws(() => Decimal.parse(''));
});

test('加减乘精确（无浮点误差）', () => {
  assert.equal(Decimal.parse('0.1').add(Decimal.parse('0.2')).toString(), '0.3');
  assert.equal(Decimal.parse('1.005').sub(Decimal.parse('0.005')).toString(), '1.000');
  assert.equal(Decimal.parse('3.333333').mul(Decimal.parse('300000')).toString(), '999999.900000');
  assert.equal(Decimal.parse('4').mul(Decimal.parse('2500000')).toString(), '10000000');
});

test('除法按标度四舍五入', () => {
  assert.equal(Decimal.parse('1').div(Decimal.parse('3'), 6).toString(), '0.333333');
  assert.equal(Decimal.parse('2').div(Decimal.parse('3'), 6).toString(), '0.666667');
  assert.equal(Decimal.parse('10').div(Decimal.parse('4'), 2).toString(), '2.50');
  assert.equal(Decimal.parse('40000000').div(Decimal.parse('11388889'), 6).toString(), '3.512195');
  assert.throws(() => Decimal.parse('1').div(Decimal.parse('0'), 6));
});

test('floorDiv 向下取整', () => {
  assert.equal(Decimal.parse('1000000').floorDiv(Decimal.parse('3.333333')), 300000n);
  assert.equal(Decimal.parse('10').floorDiv(Decimal.parse('4')), 2n);
  assert.equal(Decimal.parse('7.5').floorDiv(Decimal.parse('2.5')), 3n);
});

test('toFixed 与 trimmed', () => {
  assert.equal(Decimal.parse('999999.900000').toFixed(2), '999999.90');
  assert.equal(Decimal.parse('0.100000').trimmed(), '0.1');
  assert.equal(Decimal.parse('2.5').toFixed(4), '2.5000');
  assert.equal(Decimal.parse('3.14159').toFixed(2), '3.14');
  assert.equal(Decimal.parse('3.145').toFixed(2), '3.15');
});

test('比较', () => {
  assert.equal(Decimal.parse('0.3').cmp(Decimal.parse('0.30')), 0);
  assert.ok(Decimal.parse('0.31').cmp(Decimal.parse('0.3')) > 0);
  assert.ok(Decimal.parse('-1').isNegative());
  assert.ok(Decimal.parse('0').isZero());
});

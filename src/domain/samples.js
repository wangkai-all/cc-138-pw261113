// 内置多轮交易样本：创始 → 天使 → 期权池 → 老股转让 → A 轮 → 拆股 → 注销 → B 轮。
export function sampleDataset() {
  return {
    shareholders: [
      { key: 'zhang', name: '张三' },
      { key: 'li', name: '李四' },
      { key: 'wang', name: '王五（天使投资人）' },
      { key: 'esop', name: '期权池（ESOP）' },
      { key: 'zhao', name: '赵六' },
      { key: 'chenhui', name: '晨晖资本（A 轮）' },
      { key: 'yuanshan', name: '远山产业资本（B 轮）' },
    ],
    transactions: [
      { date: '2021-03-01', type: 'ISSUE', holder: 'zhang', shares: '6000000', pricePerShare: '0.01', note: '创始出资 6 万元' },
      { date: '2021-03-01', type: 'ISSUE', holder: 'li', shares: '4000000', pricePerShare: '0.01', note: '创始出资 4 万元' },
      { date: '2022-06-15', type: 'ISSUE', holder: 'wang', shares: '1250000', pricePerShare: '0.8', note: '天使轮 100 万元' },
      { date: '2022-06-15', type: 'ISSUE', holder: 'esop', shares: '1000000', pricePerShare: '0.01', note: '设立期权池' },
      { date: '2023-09-01', type: 'TRANSFER', from: 'li', to: 'zhao', shares: '500000', pricePerShare: '1.2', note: '老股转让 60 万元' },
      { date: '2024-04-10', type: 'ISSUE', holder: 'chenhui', shares: '2500000', pricePerShare: '4', note: 'A 轮 1000 万元' },
      { date: '2024-12-01', type: 'SPLIT', numerator: '2', denominator: '1', note: '1 股拆 2 股' },
      { date: '2025-06-30', type: 'CANCEL', holder: 'esop', shares: '200000', note: '回购注销未授予期权' },
      { date: '2025-08-15', type: 'ISSUE', holder: 'yuanshan', shares: '3000000', pricePerShare: '9.5', note: 'B 轮 2850 万元' },
    ],
  };
}

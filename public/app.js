// 股权台账前端：全部计算走服务端 API，前端只负责展示与交互。
const $ = (sel) => document.querySelector(sel);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

const fmtInt = (s) => {
  if (s === null || s === undefined || s === '') return '—';
  const str = String(s);
  const neg = str.startsWith('-');
  const digits = neg ? str.slice(1) : str;
  return (neg ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

const fmtSigned = (s) => {
  const neg = String(s).startsWith('-');
  return `${neg ? '−' : '+'}${fmtInt(String(s).replace('-', ''))}`;
};

const fmtMoney = (s) => {
  if (s === null || s === undefined || s === '') return '—';
  let [int, frac = ''] = String(s).split('.');
  const neg = int.startsWith('-');
  if (neg) int = int.slice(1);
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  frac = frac.replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${int}.${frac}`;
};

const fmtPct = (s) => (s === null || s === undefined ? '—' : `${s}%`);

const pctOf = (shares, total) => {
  const t = Number(total);
  if (!t) return '—';
  return ((Number(shares) / t) * 100).toFixed(6);
};

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `请求失败（${res.status}）`);
    err.details = data?.error?.details || [];
    throw err;
  }
  return data;
}

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------- 应用状态 ----------
const TX_TYPES = { ISSUE: '增资发行', TRANSFER: '股权转让', SPLIT: '拆股/并股', CANCEL: '注销减资' };

const defaultTxForm = () => ({ type: 'ISSUE', insertAfter: null, errors: [], values: {} });

const S = {
  data: null,
  at: null, // null = 最新；数字 = 截至第 N 笔之后
  tab: 'table',
  txForm: defaultTxForm(),
  simInputs: {
    preMoney: '',
    investment: '',
    poolTargetPct: '10',
    currentPoolShares: '',
    investorName: '',
    poolTiming: 'pre',
  },
  simResult: null,
  simErrors: [],
};

async function load() {
  const q = S.at === null ? '' : `?at=${S.at}`;
  S.data = await api('GET', `/api/state${q}`);
  if (S.at !== null && S.at > S.data.txCount) {
    S.at = null;
    return load();
  }
  if (S.simInputs.currentPoolShares === '') {
    S.simInputs.currentPoolShares = S.data.poolSharesAuto;
  }
  render();
}

// ---------- 渲染 ----------

function render() {
  const d = S.data;
  const holders = d.holdings.rows.filter((r) => r.shares !== '0').length;
  $('#stats').innerHTML =
    `<span>总股本 <b>${fmtInt(d.holdings.total)}</b> 股</span>` +
    `<span>持股股东 <b>${holders}</b> 名</span>` +
    `<span>交易 <b>${d.txCount}</b> 笔</span>`;
  const opts = [
    `<option value="">最新（第 ${d.txCount} 笔后）</option>`,
    `<option value="0" ${S.at === 0 ? 'selected' : ''}>初始（0 笔）</option>`,
    ...d.transactions.map(
      (tx) =>
        `<option value="${tx.seq}" ${S.at === tx.seq ? 'selected' : ''}>第 ${tx.seq} 笔后 · ${tx.date} ${esc(tx.typeLabel)}</option>`,
    ),
  ];
  $('#position').innerHTML = `<label style="flex-direction:row;align-items:center;gap:8px">查看时点 <select id="position-select">${opts.join('')}</select></label>`;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  const main = $('#app');
  main.innerHTML =
    S.tab === 'table' ? viewTable() : S.tab === 'txs' ? viewTxs() : S.tab === 'sim' ? viewSim() : viewScen();
}

function viewTable() {
  const d = S.data;
  if (d.txCount === 0) {
    return `<div class="card empty">
      <p>台账为空。从初始股东开始逐笔录入，或载入内置多轮样本体验。</p>
      <p><button class="primary" data-action="goto-txs">录入第一笔交易</button>
      <button data-action="load-sample">载入多轮样本</button></p>
    </div>`;
  }
  const { rows, total } = d.holdings;
  const body = rows
    .map(
      (r) => `<tr>
        <td>${esc(r.name)}</td>
        <td class="num">${fmtInt(r.shares)}</td>
        <td class="num"><a class="pct-link" data-action="prov" data-id="${r.id}" title="点击查看持股构成">${fmtPct(r.pct)}</a></td>
      </tr>`,
    )
    .join('');
  const sum = rows.reduce((a, r) => a + (r.pct === null ? 0 : Number(r.pct)), 0);
  const diff = Math.abs(100 - sum);
  const note =
    total !== '0' && diff > 0.0000005
      ? `<div class="note">各行比例为四舍五入显示值，合计 ${sum.toFixed(6)}%，与 100% 的差为显示尾差；系统按精确股数保存，未做凑整。</div>`
      : '';
  return `<div class="card">
    <h3>股权表 · 截至${S.at === null || S.at === d.txCount ? '最新' : `第 ${S.at} 笔交易`}（点击比例可回溯构成）</h3>
    <table>
      <thead><tr><th>股东</th><th class="num">持股数（股）</th><th class="num">比例</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>合计</td><td class="num">${fmtInt(total)}</td><td class="num">${total === '0' ? '—' : '100.000000%'}</td></tr></tfoot>
    </table>
    ${note}
  </div>`;
}

function holderOptions(selected, allowNew) {
  const opts = S.data.shareholders.map(
    (h) => `<option value="${h.id}" ${selected === h.id ? 'selected' : ''}>${esc(h.name)}</option>`,
  );
  if (allowNew) opts.push(`<option value="__new__" ${selected === '__new__' ? 'selected' : ''}>＋ 新股东…</option>`);
  if (!selected && !allowNew) opts.unshift('<option value="">请选择…</option>');
  if (!selected && allowNew) opts.unshift('<option value="" selected>请选择…</option>');
  return opts.join('');
}

function viewTxs() {
  const d = S.data;
  const rows = d.transactions
    .map(
      (tx) => `<tr>
        <td>${tx.seq}</td>
        <td>${tx.date}</td>
        <td><span class="badge ${tx.type}">${tx.typeLabel}</span>${tx.linked ? ' <span class="badge linked">情景并入</span>' : ''}</td>
        <td>${esc(tx.summary)}</td>
        <td class="muted">${esc(tx.note)}</td>
        <td>
          <button class="small" data-action="view-at" data-seq="${tx.seq}">查看此时点</button>
          <button class="small" data-action="insert-here" data-seq="${tx.seq}">在此后插入</button>
        </td>
      </tr>`,
    )
    .join('');
  const toolbar = `<div class="toolbar">
    ${d.txCount === 0 ? '<button data-action="load-sample">载入多轮样本</button>' : ''}
    <button data-action="undo-last" ${d.txCount === 0 ? 'disabled' : ''}>撤销最后一笔</button>
    <span class="spacer"></span>
    <button class="danger" data-action="reset-all">清空重置</button>
  </div>`;
  const table =
    d.txCount === 0
      ? '<div class="empty">尚无交易。可在下方录入第一笔（初始股东的首次出资用「增资发行」）。</div>'
      : `<div class="card"><table>
        <thead><tr><th>#</th><th>日期</th><th>类型</th><th>摘要</th><th>备注</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  return toolbar + table + txFormHtml();
}

function txFormHtml() {
  const f = S.txForm;
  const v = f.values;
  const d = S.data;
  const typeOpts = Object.entries(TX_TYPES)
    .map(([k, label]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${label}</option>`)
    .join('');
  const banner =
    f.insertAfter !== null
      ? `<div class="banner">插入位置：第 ${f.insertAfter} 笔之后（其后的 ${d.txCount - f.insertAfter} 笔将重新校验，冲突会被阻止）
        <button class="small" data-action="insert-reset">改为末尾追加</button></div>`
      : '';
  const errors = f.errors.length
    ? `<div class="errors">${f.errors.map((e) => `<div>${esc(e)}</div>`).join('')}</div>`
    : '';
  const today = new Date().toISOString().slice(0, 10);

  let fields = '';
  if (f.type === 'ISSUE') {
    fields = `
      <label><span>股东</span><select name="holderId" data-new-toggle="newHolderName">${holderOptions(v.holderId, true)}</select></label>
      <label data-newname="newHolderName" ${v.holderId === '__new__' ? '' : 'hidden'}><span>新股东名称</span><input name="newHolderName" value="${esc(v.newHolderName ?? '')}"></label>
      <label><span>发行股数</span><input name="shares" inputmode="numeric" placeholder="如 1000000" value="${esc(v.shares ?? '')}"></label>
      <label><span>每股价格（可选）</span><input name="pricePerShare" placeholder="如 4.00" value="${esc(v.pricePerShare ?? '')}"></label>`;
  } else if (f.type === 'TRANSFER') {
    fields = `
      <label><span>转让方</span><select name="fromId">${holderOptions(v.fromId, false)}</select></label>
      <label><span>受让方</span><select name="toId" data-new-toggle="newToName">${holderOptions(v.toId, true)}</select></label>
      <label data-newname="newToName" ${v.toId === '__new__' ? '' : 'hidden'}><span>新股东名称</span><input name="newToName" value="${esc(v.newToName ?? '')}"></label>
      <label><span>转让股数</span><input name="shares" inputmode="numeric" placeholder="不超过转让方持股" value="${esc(v.shares ?? '')}"></label>
      <label><span>每股价格（可选）</span><input name="pricePerShare" placeholder="如 1.20" value="${esc(v.pricePerShare ?? '')}"></label>`;
  } else if (f.type === 'SPLIT') {
    fields = `
      <label><span>分子</span><input name="numerator" inputmode="numeric" placeholder="如 2" value="${esc(v.numerator ?? '')}"></label>
      <label><span>分母</span><input name="denominator" inputmode="numeric" placeholder="如 1" value="${esc(v.denominator ?? '')}"></label>
      <div class="hint" style="grid-column:1/-1">每 1 股变为 分子/分母 股：2/1 表示 1 拆 2，1/3 表示 3 并 1。全体股东同比调整；任一持股不能整除时将被阻止。</div>`;
  } else if (f.type === 'CANCEL') {
    fields = `
      <label><span>股东</span><select name="holderId">${holderOptions(v.holderId, false)}</select></label>
      <label><span>注销股数</span><input name="shares" inputmode="numeric" placeholder="不超过其持股" value="${esc(v.shares ?? '')}"></label>`;
  }

  return `<form id="tx-form" class="card">
    <h3>录入交易</h3>
    ${banner}
    <div class="grid">
      <label><span>类型</span><select name="type">${typeOpts}</select></label>
      <label><span>日期</span><input type="date" name="date" value="${esc(v.date ?? today)}"></label>
      ${fields}
      <label style="grid-column:1/-1"><span>备注（可选）</span><input name="note" maxlength="200" value="${esc(v.note ?? '')}"></label>
    </div>
    ${errors}
    <button type="submit" class="primary">提交交易</button>
    <span class="hint" style="margin-left:10px">股数不足、注销超量、顺序冲突会在服务端被阻止，不会产生负持股。</span>
  </form>`;
}

const METRICS = [
  ['每股价格（元）', (r) => fmtMoney(r.pricePerShare)],
  ['新投资人股数（股）', (r) => fmtInt(r.investorShares)],
  ['实际认购额（元）', (r) => fmtMoney(r.actualInvestment)],
  ['未认购尾差（元）', (r) => fmtMoney(r.remainder)],
  ['新增期权池（股）', (r) => fmtInt(r.newPoolShares)],
  ['投后总股本（股）', (r) => fmtInt(r.postTotalShares)],
  ['投资人持股', (r) => fmtPct(r.investorPct)],
  ['期权池合计', (r) => fmtPct(r.poolPct)],
  ['原股东（除池）', (r) => fmtPct(r.othersPct)],
  ['投后估值·名义（元）', (r) => fmtMoney(r.postMoneyValuation)],
];

function viewSim() {
  const i = S.simInputs;
  const d = S.data;
  const form = `<form id="sim-form" class="card">
    <h3>融资试算 <span class="muted">（基于最新台账：总股本 ${fmtInt(d.holdings.total)} 股）</span></h3>
    <div class="grid">
      <label><span>投前估值（元）</span><input name="preMoney" required placeholder="如 40000000" value="${esc(i.preMoney)}"></label>
      <label><span>投资额（元）</span><input name="investment" required placeholder="如 10000000" value="${esc(i.investment)}"></label>
      <label><span>期权池目标（投后 %）</span><input name="poolTargetPct" required placeholder="如 10" value="${esc(i.poolTargetPct)}"></label>
      <label><span>现有期权池股数</span><input name="currentPoolShares" inputmode="numeric" value="${esc(i.currentPoolShares)}"></label>
      <label><span>新投资人名称</span><input name="investorName" placeholder="如 某某资本" value="${esc(i.investorName)}"></label>
      <fieldset>
        <legend>期权池补足时机</legend>
        <label><input type="radio" name="poolTiming" value="pre" ${i.poolTiming === 'pre' ? 'checked' : ''}> 融资前补足（计入投前，原股东承担稀释）</label>
        <label><input type="radio" name="poolTiming" value="post" ${i.poolTiming === 'post' ? 'checked' : ''}> 融资后补足（全体股东含新投资人共同稀释）</label>
      </fieldset>
    </div>
    ${S.simErrors.length ? `<div class="errors">${S.simErrors.map((e) => `<div>${esc(e)}</div>`).join('')}</div>` : ''}
    <button type="submit" class="primary">开始试算</button>
    <span class="hint" style="margin-left:10px">两种口径对照输出；试算不影响台账，可另存为情景。</span>
  </form>`;

  if (!S.simResult) return form;

  const r = S.simResult;
  const sel = i.poolTiming === 'post' ? 'post' : 'pre';
  const chosen = r[sel];
  const cmpRows = METRICS.map(
    ([label, fn]) => `<tr><td>${label}</td>
      <td class="num ${sel === 'pre' ? 'sel' : ''}">${fn(r.pre)}</td>
      <td class="num ${sel === 'post' ? 'sel' : ''}">${fn(r.post)}</td></tr>`,
  ).join('');
  const warnings = chosen.warnings.map((w) => `<div class="note">${esc(w)}</div>`).join('');
  const holderRows = chosen.perHolder
    .map(
      (h) => `<tr><td>${esc(h.name)}</td><td class="num">${fmtInt(h.shares)}</td>
        <td class="num">${fmtPct(h.pctBefore)}</td><td class="num">${fmtPct(h.pctAfter)}</td></tr>`,
    )
    .join('');
  const extraRows = [
    BigInt(chosen.newPoolShares) > 0n
      ? `<tr><td>期权池（本轮新增）</td><td class="num">${fmtInt(chosen.newPoolShares)}</td>
          <td class="num">—</td><td class="num">${pctOf(chosen.newPoolShares, chosen.postTotalShares)}%</td></tr>`
      : '',
    `<tr><td>${esc(i.investorName.trim() || '新投资人')}（本轮）</td><td class="num">${fmtInt(chosen.investorShares)}</td>
      <td class="num">—</td><td class="num">${fmtPct(chosen.investorPct)}</td></tr>`,
  ].join('');

  return `${form}
  <div class="card">
    <h3>两种补足口径对照 <span class="muted">（高亮列为当前选择的时机）</span></h3>
    <table class="compare">
      <thead><tr><th>指标</th><th class="num ${sel === 'pre' ? 'sel' : ''}">融资前补足</th><th class="num ${sel === 'post' ? 'sel' : ''}">融资后补足</th></tr></thead>
      <tbody>${cmpRows}</tbody>
    </table>
    ${warnings}
    <h4>各股东稀释对照（${sel === 'pre' ? '融资前补足' : '融资后补足'}）</h4>
    <table>
      <thead><tr><th>股东</th><th class="num">股数</th><th class="num">融资前</th><th class="num">融资后</th></tr></thead>
      <tbody>${holderRows}${extraRows}</tbody>
      <tfoot><tr><td>合计</td><td class="num">${fmtInt(chosen.postTotalShares)}</td><td class="num">100.000000%</td><td class="num">100.000000%</td></tr></tfoot>
    </table>
    <div style="margin-top:14px">
      <button class="primary" data-action="sim-save">另存为情景</button>
      <span class="hint" style="margin-left:10px">情景只是草稿，只有在「情景」页明确确认后才会并入正式台账。</span>
    </div>
  </div>`;
}

function viewScen() {
  const list = S.data.scenarios;
  if (!list.length) {
    return `<div class="card empty">尚无情景。在「融资试算」中完成试算后可另存为情景。</div>`;
  }
  const cards = list
    .map((sc) => {
      const r = sc.results[sc.selectedTiming];
      const timingLabel = sc.selectedTiming === 'pre' ? '融资前补足' : '融资后补足';
      const status = sc.applied
        ? `<span class="badge applied">已并入 · 截至第 ${sc.applied.at} 笔</span>`
        : `<span class="badge pending">未并入</span>`;
      const actions = sc.applied
        ? ''
        : `<div class="actions">
            <button class="primary small" data-action="scen-apply" data-id="${sc.id}">并入正式台账</button>
            <button class="danger small" data-action="scen-delete" data-id="${sc.id}">删除</button>
          </div>`;
      return `<div class="scenario-card">
        <h4>${esc(sc.name)} ${status}</h4>
        <div class="kv">投前 <b>¥${fmtMoney(sc.inputs.preMoney)}</b> · 投资 <b>¥${fmtMoney(sc.inputs.investment)}</b> · 池目标 <b>${esc(sc.inputs.poolTargetPct)}%</b>（${timingLabel}）</div>
        <div class="kv">投资人 <b>${fmtInt(r.investorShares)}</b> 股（${fmtPct(r.investorPct)}）· 每股 ¥${fmtMoney(r.pricePerShare)} · 尾差 ¥${fmtMoney(r.remainder)}</div>
        <div class="kv muted">创建于 ${new Date(sc.createdAt).toLocaleString('zh-CN', { hour12: false })}</div>
        ${actions}
      </div>`;
    })
    .join('');
  return `<div class="scenario-grid">${cards}</div>`;
}

// ---------- 弹窗 ----------

let modalResolver = null;

function openModal(html) {
  $('#modal-root').innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`;
}

function settleModal(value) {
  const r = modalResolver;
  modalResolver = null;
  $('#modal-root').innerHTML = '';
  if (r) r(value);
}

function confirmDialog({ title, bodyHtml, okText = '确认', danger = false }) {
  openModal(`<h3>${esc(title)}</h3><div>${bodyHtml}</div>
    <div class="actions">
      <button data-action="modal-no">取消</button>
      <button class="${danger ? 'danger' : 'primary'}" data-action="modal-yes">${esc(okText)}</button>
    </div>`);
  return new Promise((res) => {
    modalResolver = res;
  });
}

function promptDialog({ title, label, placeholder = '' }) {
  openModal(`<h3>${esc(title)}</h3>
    <label><span>${esc(label)}</span><input id="modal-input" placeholder="${esc(placeholder)}" maxlength="50"></label>
    <div class="actions">
      <button data-action="modal-no">取消</button>
      <button class="primary" data-action="modal-prompt-ok">确定</button>
    </div>`);
  setTimeout(() => $('#modal-input')?.focus(), 0);
  return new Promise((res) => {
    modalResolver = res;
  });
}

async function showProvenance(holderId) {
  try {
    const at = S.at === null ? '' : S.at;
    const d = await api('GET', `/api/provenance?holder=${encodeURIComponent(holderId)}&at=${at}`);
    const rows = d.events
      .map(
        (ev) => `<tr>
          <td>${ev.seq}</td><td>${ev.date}</td>
          <td><span class="badge ${ev.type}">${ev.typeLabel}</span></td>
          <td>${esc(ev.summary)}</td>
          <td class="num ${String(ev.delta).startsWith('-') ? 'delta-neg' : 'delta-pos'}">${fmtSigned(ev.delta)}</td>
          <td class="num">${fmtInt(ev.balanceAfter)}</td>
          <td class="num">${fmtPct(ev.pctAfter)}</td>
        </tr>`,
      )
      .join('');
    openModal(`<h3>${esc(d.holder.name)} · 截至${d.at === d.txCount ? '最新' : `第 ${d.at} 笔`}</h3>
      <p>持股 <b>${fmtInt(d.balance)}</b> 股 ÷ 当时总股本 <b>${fmtInt(d.total)}</b> 股 ＝ <b>${fmtPct(d.pct)}</b></p>
      ${
        d.events.length
          ? `<table>
              <thead><tr><th>#</th><th>日期</th><th>类型</th><th>摘要</th><th class="num">变动（股）</th><th class="num">变动后持股</th><th class="num">变动后比例</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`
          : '<p class="muted">截至该时点，该股东名下没有构成交易。</p>'
      }
      <p class="hint">构成说明：比例为持股 ÷ 当时总股本；拆股/并股同比影响全体股东。列表为影响该股东持股的全部交易。</p>
      <div class="actions"><button data-action="modal-no">关闭</button></div>`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 表单读取 ----------

function readTxFormValues(form) {
  const fd = new FormData(form);
  const keys = ['date', 'holderId', 'newHolderName', 'fromId', 'toId', 'newToName', 'shares', 'pricePerShare', 'numerator', 'denominator', 'note'];
  const v = {};
  for (const k of keys) v[k] = fd.get(k) ?? '';
  return v;
}

function readSimForm() {
  const form = $('#sim-form');
  if (!form) return;
  const fd = new FormData(form);
  for (const k of ['preMoney', 'investment', 'poolTargetPct', 'currentPoolShares', 'investorName', 'poolTiming']) {
    S.simInputs[k] = String(fd.get(k) ?? S.simInputs[k]);
  }
}

// ---------- 事件 ----------

document.addEventListener('click', async (e) => {
  if (e.target.classList?.contains('modal-mask')) {
    settleModal(null);
    return;
  }
  const tabEl = e.target.closest('[data-tab]');
  if (tabEl) {
    S.tab = tabEl.dataset.tab;
    render();
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  try {
    switch (action) {
      case 'prov':
        await showProvenance(id);
        break;
      case 'goto-txs':
        S.tab = 'txs';
        render();
        break;
      case 'view-at':
        S.at = Number(el.dataset.seq);
        S.tab = 'table';
        await load();
        break;
      case 'insert-here':
        S.txForm.insertAfter = Number(el.dataset.seq);
        render();
        $('#tx-form')?.scrollIntoView({ behavior: 'smooth' });
        break;
      case 'insert-reset':
        S.txForm.insertAfter = null;
        render();
        break;
      case 'undo-last': {
        const ok = await confirmDialog({
          title: '撤销最后一笔交易',
          bodyHtml: '将从台账末尾移除最后一笔交易（情景并入的交易不可撤销）。',
          okText: '撤销',
          danger: true,
        });
        if (ok) {
          await api('POST', '/api/transactions/undo-last', {});
          toast('已撤销最后一笔交易');
          await load();
        }
        break;
      }
      case 'load-sample': {
        const ok = await confirmDialog({
          title: '载入多轮样本',
          bodyHtml: '将载入内置样本：创始 → 天使 → 期权池 → 老股转让 → A 轮 → 拆股 → 注销 → B 轮（仅可在空台账上载入）。',
          okText: '载入',
        });
        if (ok) {
          await api('POST', '/api/sample/load', { confirm: true });
          toast('样本已载入');
          await load();
        }
        break;
      }
      case 'reset-all': {
        const ok = await confirmDialog({
          title: '清空重置',
          bodyHtml: '将删除全部股东、交易与情景，且不可恢复。确定继续？',
          okText: '全部清空',
          danger: true,
        });
        if (ok) {
          await api('POST', '/api/reset', { confirm: true });
          S.at = null;
          S.simResult = null;
          S.txForm = defaultTxForm();
          toast('已重置');
          await load();
        }
        break;
      }
      case 'sim-save': {
        const name = await promptDialog({ title: '另存为情景', label: '情景名称', placeholder: '如：A 轮 · 池前置 10%' });
        if (name && name.trim()) {
          await api('POST', '/api/scenarios', { name: name.trim(), inputs: S.simInputs });
          toast('情景已保存（尚未并入台账）');
          await load();
        }
        break;
      }
      case 'scen-apply': {
        const sc = S.data.scenarios.find((s) => s.id === id);
        if (!sc) break;
        const r = sc.results[sc.selectedTiming];
        const ops = [];
        const poolOp = `<li>增资发行：期权池（ESOP）+${fmtInt(r.newPoolShares)} 股</li>`;
        const invOp = `<li>增资发行：${esc(sc.inputs.investorName || '新投资人')} +${fmtInt(r.investorShares)} 股 @ ¥${fmtMoney(r.pricePerShare)}（实际认购 ¥${fmtMoney(r.actualInvestment)}）</li>`;
        if (sc.selectedTiming === 'pre') {
          if (BigInt(r.newPoolShares) > 0n) ops.push(poolOp);
          ops.push(invOp);
        } else {
          ops.push(invOp);
          if (BigInt(r.newPoolShares) > 0n) ops.push(poolOp);
        }
        const ok = await confirmDialog({
          title: `并入情景「${sc.name}」`,
          bodyHtml: `<p>将按保存时的试算结果，向正式台账追加以下交易：</p><ol>${ops.join('')}</ol>
            <p class="hint">并入后作为正式台账交易，不可单独撤销。</p>`,
          okText: '确认并入',
        });
        if (ok) {
          const res = await api('POST', `/api/scenarios/${sc.id}/apply`, { confirm: true });
          toast(`已并入台账：${res.appended.join('；')}`);
          await load();
        }
        break;
      }
      case 'scen-delete': {
        const sc = S.data.scenarios.find((s) => s.id === id);
        const ok = await confirmDialog({
          title: '删除情景',
          bodyHtml: `确定删除情景「${esc(sc?.name ?? '')}」？该操作不影响正式台账。`,
          okText: '删除',
          danger: true,
        });
        if (ok) {
          await api('DELETE', `/api/scenarios/${id}`);
          toast('情景已删除');
          await load();
        }
        break;
      }
      case 'modal-yes':
        settleModal(true);
        break;
      case 'modal-no':
        settleModal(null);
        break;
      case 'modal-prompt-ok':
        settleModal($('#modal-input')?.value ?? null);
        break;
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'position-select') {
    S.at = e.target.value === '' ? null : Number(e.target.value);
    load().catch((err) => toast(err.message, 'error'));
    return;
  }
  const toggle = e.target.closest?.('select[data-new-toggle]');
  if (toggle) {
    const row = document.querySelector(`[data-newname="${toggle.dataset.newToggle}"]`);
    if (row) row.hidden = toggle.value !== '__new__';
  }
  if (e.target.name === 'type' && e.target.closest('#tx-form')) {
    S.txForm.values = readTxFormValues(e.target.closest('#tx-form'));
    S.txForm.type = e.target.value;
    S.txForm.errors = [];
    render();
    return;
  }
  if (e.target.closest?.('#sim-form')) {
    readSimForm();
    if (S.simResult) render();
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.id === 'tx-form') {
    const f = S.txForm;
    const v = readTxFormValues(form);
    f.values = v;
    const payload = { type: f.type, date: v.date, note: v.note, insertAfter: f.insertAfter };
    if (f.type === 'ISSUE') {
      Object.assign(payload, { holderId: v.holderId, newHolderName: v.newHolderName, shares: v.shares, pricePerShare: v.pricePerShare });
    } else if (f.type === 'TRANSFER') {
      Object.assign(payload, { fromId: v.fromId, toId: v.toId, newToName: v.newToName, shares: v.shares, pricePerShare: v.pricePerShare });
    } else if (f.type === 'SPLIT') {
      Object.assign(payload, { numerator: v.numerator, denominator: v.denominator });
    } else if (f.type === 'CANCEL') {
      Object.assign(payload, { holderId: v.holderId, shares: v.shares });
    }
    try {
      await api('POST', '/api/transactions', payload);
      toast('交易已入账');
      S.txForm = defaultTxForm();
      await load();
    } catch (err) {
      f.errors = err.details?.length ? err.details : [err.message];
      render();
      $('#tx-form')?.scrollIntoView({ behavior: 'smooth' });
    }
  } else if (form.id === 'sim-form') {
    readSimForm();
    try {
      S.simResult = await api('POST', '/api/simulate', S.simInputs);
      S.simErrors = [];
    } catch (err) {
      S.simResult = null;
      S.simErrors = err.details?.length ? err.details : [err.message];
    }
    render();
  }
});

// ---------- 启动 ----------
load().catch((err) => {
  $('#app').innerHTML = `<div class="card errors">加载失败：${esc(err.message)}</div>`;
});

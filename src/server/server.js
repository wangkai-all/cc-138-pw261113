import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createEmptyLedger,
  holdingsAt,
  insertTransaction,
  provenance,
  removeLastTransaction,
  TX_TYPES,
  txSummary,
  ValidationError,
} from '../domain/ledger.js';
import { FinancingError, simulateRound } from '../domain/financing.js';
import { sampleDataset } from '../domain/samples.js';
import { Store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'ledger.json');
const PORT = Number(process.env.PORT || 3000);

const store = new Store(DATA_FILE);
let state = store.load() ?? createEmptyLedger();

function save() {
  store.save(state);
}

const POOL_NAME_RE = /期权池|ESOP/i;

function latestHoldings() {
  return holdingsAt(state, null);
}

function poolSharesAuto() {
  const h = latestHoldings();
  return h.rows
    .filter((r) => POOL_NAME_RE.test(r.name))
    .reduce((acc, r) => acc + BigInt(r.shares), 0n)
    .toString();
}

function serializeState(at) {
  const holdings = holdingsAt(state, at);
  return {
    shareholders: state.shareholders,
    transactions: state.transactions.map((tx, i) => ({
      seq: i + 1,
      id: tx.id,
      date: tx.date,
      type: tx.type,
      typeLabel: TX_TYPES[tx.type],
      summary: txSummary(state.shareholders, tx),
      note: tx.note ?? '',
      linked: Boolean(tx.linkedScenarioId),
    })),
    txCount: state.transactions.length,
    holdings,
    scenarios: state.scenarios,
    poolSharesAuto: poolSharesAuto(),
  };
}

function runSimulation(body) {
  const holdings = latestHoldings();
  const inputs = {
    preMoney: body.preMoney,
    investment: body.investment,
    poolTargetPct: body.poolTargetPct,
    currentShares: holdings.total,
    currentPoolShares:
      body.currentPoolShares === undefined || body.currentPoolShares === ''
        ? poolSharesAuto()
        : body.currentPoolShares,
  };
  const result = simulateRound(inputs, holdings.rows);
  return { inputs, result };
}

function applyScenario(sc) {
  if (sc.applied) throw new ValidationError('该情景已并入正式台账，不能重复并入');
  const r = sc.results[sc.selectedTiming];
  if (!r) throw new ValidationError('情景数据不完整');
  if (BigInt(r.investorShares) <= 0n) {
    throw new ValidationError('试算认购股数为 0，无法并入台账');
  }
  const today = new Date().toISOString().slice(0, 10);
  const lastDate = state.transactions[state.transactions.length - 1]?.date;
  const date = lastDate && lastDate > today ? lastDate : today;
  const appended = [];

  const doPool = () => {
    if (BigInt(r.newPoolShares) <= 0n) return;
    const existing = state.shareholders.find((h) => POOL_NAME_RE.test(h.name));
    const tx = insertTransaction(
      state,
      {
        type: 'ISSUE',
        date,
        holderId: existing ? existing.id : '__new__',
        newHolderName: existing ? undefined : '期权池（ESOP）',
        shares: r.newPoolShares,
        note: `融资试算并入：期权池补足（情景「${sc.name}」）`,
      },
      null,
      { linkedScenarioId: sc.id },
    );
    appended.push(tx);
  };
  const doInvestor = () => {
    const name = (sc.inputs.investorName || '').trim() || '新投资人';
    const existing = state.shareholders.find((h) => h.name === name);
    const tx = insertTransaction(
      state,
      {
        type: 'ISSUE',
        date,
        holderId: existing ? existing.id : '__new__',
        newHolderName: existing ? undefined : name,
        shares: r.investorShares,
        pricePerShare: r.pricePerShare,
        note: `融资试算并入：${name} 认购（情景「${sc.name}」）`,
      },
      null,
      { linkedScenarioId: sc.id },
    );
    appended.push(tx);
  };

  if (sc.selectedTiming === 'pre') {
    doPool();
    doInvestor();
  } else {
    doInvestor();
    doPool();
  }
  sc.applied = { at: state.transactions.length, date, txIds: appended.map((t) => t.id) };
  return appended;
}

// ---------- 路由 ----------

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(
    `^${pattern.replace(/:[^/]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/state', (req, res, q) => {
  sendJson(res, serializeState(q.get('at') === '' || q.get('at') === null ? null : Number(q.get('at'))));
});

route('GET', '/api/provenance', (req, res, q) => {
  const at = q.get('at');
  sendJson(res, provenance(state, q.get('holder'), at === '' || at === null ? null : Number(at)));
});

route('POST', '/api/transactions', (req, res, q, body) => {
  const { insertAfter, ...draft } = body ?? {};
  const tx = insertTransaction(state, draft, insertAfter ?? null);
  save();
  sendJson(res, { ok: true, transaction: tx }, 201);
});

route('POST', '/api/transactions/undo-last', (req, res) => {
  const removed = removeLastTransaction(state);
  save();
  sendJson(res, { ok: true, removed });
});

route('POST', '/api/simulate', (req, res, q, body) => {
  const { inputs, result } = runSimulation(body ?? {});
  const selected = body?.poolTiming === 'post' ? 'post' : 'pre';
  sendJson(res, { inputs, selected, ...result });
});

route('GET', '/api/scenarios', (req, res) => {
  sendJson(res, state.scenarios);
});

route('POST', '/api/scenarios', (req, res, q, body) => {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new ValidationError('请填写情景名称');
  if (name.length > 50) throw new ValidationError('情景名称过长（不超过 50 字）');
  const inputs = body?.inputs ?? {};
  const { result } = runSimulation(inputs);
  const sc = {
    id: `s-${++state.counters.scenario}`,
    name,
    createdAt: new Date().toISOString(),
    inputs: {
      preMoney: String(inputs.preMoney ?? ''),
      investment: String(inputs.investment ?? ''),
      poolTargetPct: String(inputs.poolTargetPct ?? '0'),
      currentPoolShares: String(
        inputs.currentPoolShares === undefined || inputs.currentPoolShares === ''
          ? poolSharesAuto()
          : inputs.currentPoolShares,
      ),
      investorName: String(inputs.investorName ?? '').trim(),
    },
    selectedTiming: inputs.poolTiming === 'post' ? 'post' : 'pre',
    results: { pre: result.pre, post: result.post },
    applied: null,
  };
  state.scenarios.push(sc);
  save();
  sendJson(res, { ok: true, scenario: sc }, 201);
});

route('POST', '/api/scenarios/:id/apply', (req, res, q, body, params) => {
  const sc = state.scenarios.find((s) => s.id === params.id);
  if (!sc) throw new ValidationError('情景不存在');
  if (!body?.confirm) throw new ValidationError('并入正式台账需要明确确认（confirm: true）');
  const appended = applyScenario(sc);
  save();
  sendJson(res, {
    ok: true,
    applied: sc.applied,
    appended: appended.map((tx) => txSummary(state.shareholders, tx)),
  });
});

route('DELETE', '/api/scenarios/:id', (req, res, q, body, params) => {
  const idx = state.scenarios.findIndex((s) => s.id === params.id);
  if (idx === -1) throw new ValidationError('情景不存在');
  if (state.scenarios[idx].applied) throw new ValidationError('已并入台账的情景不可删除');
  state.scenarios.splice(idx, 1);
  save();
  sendJson(res, { ok: true });
});

route('POST', '/api/sample/load', (req, res, q, body) => {
  if (!body?.confirm) throw new ValidationError('载入样本需要明确确认（confirm: true）');
  if (state.transactions.length || state.shareholders.length) {
    throw new ValidationError('台账非空，无法载入样本（可先重置）');
  }
  const ds = sampleDataset();
  const idMap = {};
  for (const sh of ds.shareholders) {
    const id = `h-${++state.counters.shareholder}`;
    idMap[sh.key] = id;
    state.shareholders.push({ id, name: sh.name });
  }
  for (const t of ds.transactions) {
    const draft = { type: t.type, date: t.date, note: t.note };
    if (t.type === 'ISSUE') {
      draft.holderId = idMap[t.holder];
      draft.shares = t.shares;
      draft.pricePerShare = t.pricePerShare;
    } else if (t.type === 'TRANSFER') {
      draft.fromId = idMap[t.from];
      draft.toId = idMap[t.to];
      draft.shares = t.shares;
      draft.pricePerShare = t.pricePerShare;
    } else if (t.type === 'SPLIT') {
      draft.numerator = t.numerator;
      draft.denominator = t.denominator;
    } else if (t.type === 'CANCEL') {
      draft.holderId = idMap[t.holder];
      draft.shares = t.shares;
    }
    insertTransaction(state, draft);
  }
  save();
  sendJson(res, { ok: true, txCount: state.transactions.length });
});

route('POST', '/api/reset', (req, res, q, body) => {
  if (!body?.confirm) throw new ValidationError('重置需要明确确认（confirm: true）');
  state = createEmptyLedger();
  save();
  sendJson(res, { ok: true });
});

// ---------- 静态文件 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not Found');
  }
}

// ---------- HTTP 骨架 ----------

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res, err) {
  if (err instanceof ValidationError || err instanceof FinancingError) {
    sendJson(res, { error: { message: err.message, details: err.details ?? [] } }, 422);
  } else {
    console.error(err);
    sendJson(res, { error: { message: '服务器内部错误', details: [] } }, 500);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      await serveStatic(res, url.pathname);
      return;
    }
    let body = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) throw new ValidationError('请求体过大');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new ValidationError('请求体不是合法 JSON');
        }
      }
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      await r.handler(req, res, url.searchParams, body, params);
      return;
    }
    sendJson(res, { error: { message: '接口不存在', details: [] } }, 404);
  } catch (err) {
    sendError(res, err);
  }
});

server.listen(PORT, () => {
  console.log(`股权台账服务已启动: http://localhost:${PORT}`);
  console.log(`数据文件: ${DATA_FILE}`);
});

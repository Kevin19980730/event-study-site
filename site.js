/* Event Study — static-site runtime.
 *
 * The website is the local app's own two pages (templates/index.html and
 * rotate.html, copied by export_site.py) running without a server. This file
 * loads before the page script and:
 *   1. asks for the password, decrypts data.bin (AES-256-GCM, key from PBKDF2),
 *      and inflates the price history in the browser;
 *   2. answers the pages' /api/* fetches locally with a line-for-line port of
 *      engine.py -- same conventions: trading-day row offsets, 253-session 52W
 *      window, 7-day snap tolerance, numpy NaN semantics, deterministic placebo.
 * Nothing is sent anywhere; the data never leaves the browser decrypted.
 */
(function () {
'use strict';

/* ------------------------------------------------------------------ gate */
const KEY_STORE = 'eventstudy.key';
let resolveReady, rejectReady;
const READY = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
let DATA = null;

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function loadBlob() {
  const r = await fetch('data.bin', {cache: 'no-cache'});
  if (!r.ok) throw new Error('data.bin: HTTP ' + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  const magic = String.fromCharCode(...buf.slice(0, 4));
  if (magic === 'ESD0') return {open: true, gz: buf.slice(4)};   // published without a password
  if (magic !== 'ESD1') throw new Error('unexpected data format');
  const dv = new DataView(buf.buffer);
  return {salt: buf.slice(4, 20), iv: buf.slice(20, 32), iter: dv.getUint32(32), ct: buf.slice(36)};
}

async function deriveKey(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password),
                                             'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter}, base, 256);
}

async function inflate(bytes) {
  const text = await new Response(new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

async function openWith(rawKey, blob) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: blob.iv}, key, blob.ct);
  return inflate(plain);
}

function gateUI() {
  const wrap = document.createElement('div');
  wrap.id = 'gate';
  wrap.innerHTML = `
    <style>
      #gate{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
        background:var(--bg,#f7f7f5);font:14px system-ui,-apple-system,"Segoe UI",sans-serif}
      #gate form{background:var(--surface-1,#fff);border:1px solid var(--border,#ddd);border-radius:10px;
        padding:26px 28px;width:min(360px,90vw);box-shadow:0 10px 40px rgba(0,0,0,.08)}
      #gate h2{margin:0 0 6px;font-size:18px}
      #gate p{margin:0 0 16px;color:var(--text-muted,#777);font-size:13px;line-height:1.45}
      #gate input[type=password]{width:100%;box-sizing:border-box;padding:9px 11px;font-size:15px;
        border:1px solid var(--border,#ccc);border-radius:6px;margin-bottom:10px}
      #gate label{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-muted,#777)}
      #gate button{margin-top:14px;width:100%;padding:9px;font-size:14px;font-weight:600;border-radius:6px;
        border:0;background:var(--accent,#2a78d6);color:#fff;cursor:pointer}
      #gate .err{color:#c0392b;font-size:12px;min-height:16px;margin-top:8px}
    </style>
    <form autocomplete="on">
      <h2>Event Study</h2>
      <p>This site's data is encrypted. Enter the password to unlock it — it is
         decrypted in your browser and never sent anywhere.</p>
      <input type="text" name="username" value="event-study" autocomplete="username" hidden>
      <input type="password" id="gate-pw" autocomplete="current-password" placeholder="Password" required autofocus>
      <label><input type="checkbox" id="gate-remember"> Remember on this device</label>
      <button type="submit" id="gate-go">Unlock</button>
      <div class="err" id="gate-err"></div>
    </form>`;
  return wrap;
}

async function unlock() {
  let blob;
  try { blob = await loadBlob(); }
  catch (e) { rejectReady(e); return; }

  if (blob.open) {                       // no password on this build
    try { DATA = await inflate(blob.gz); prepare(); resolveReady(); }
    catch (e) { rejectReady(e); }
    return;
  }

  for (const store of [sessionStorage, localStorage]) {          // remembered key
    const k = store.getItem(KEY_STORE);
    if (!k) continue;
    try { DATA = await openWith(unb64(k), blob); prepare(); resolveReady(); return; }
    catch (e) { store.removeItem(KEY_STORE); }
  }

  const ui = gateUI();
  document.body.appendChild(ui);
  const form = ui.querySelector('form'), err = ui.querySelector('#gate-err'), go = ui.querySelector('#gate-go');
  form.onsubmit = async ev => {
    ev.preventDefault();
    go.disabled = true; go.textContent = 'Unlocking…'; err.textContent = '';
    try {
      const raw = await deriveKey(ui.querySelector('#gate-pw').value, blob.salt, blob.iter);
      DATA = await openWith(raw, blob);
      sessionStorage.setItem(KEY_STORE, b64(raw));
      if (ui.querySelector('#gate-remember').checked) localStorage.setItem(KEY_STORE, b64(raw));
      prepare();
      ui.remove();
      resolveReady();
    } catch (e) {
      err.textContent = 'Wrong password.';
      go.disabled = false; go.textContent = 'Unlock';
    }
  };
}

/* ------------------------------------------------------------ data model */
const PX = {};           // sid -> {d: Int32Array (days since epoch), v: Float64Array, p0}
function prepare() {
  for (const [sid, s] of Object.entries(DATA.prices)) {
    const n = s.dd.length, d = new Int32Array(n), v = new Float64Array(n), sc = Math.pow(10, s.dec);
    let day = s.d0, iv = 0;
    for (let i = 0; i < n; i++) {
      day += s.dd[i]; iv += s.vd[i];
      d[i] = day; v[i] = iv / sc;
    }
    PX[sid] = {d, v, p0: s.p0};
  }
}
const EMPTY = {d: new Int32Array(0), v: new Float64Array(0), p0: -1};
const series = sid => PX[sid] || EMPTY;

const DAY = 86400000;
const toDay = iso => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY);
const iso = day => new Date(day * DAY).toISOString().slice(0, 10);
const yearOf = day => new Date(day * DAY).getUTCFullYear();

function lowerBound(arr, x) {                 // numpy searchsorted(side='left')
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
function upperBound(arr, x) {                 // searchsorted(side='right')
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

/* --------------------------------------------------------------- metrics */
const FWD = [['1W', 5], ['2W', 10], ['1M', 21], ['3M', 63], ['6M', 126], ['12M', 252], ['18M', 378]];
const PAST = [['18M', 378], ['12M', 252], ['6M', 126], ['3M', 63], ['1M', 21], ['2W', 10], ['1W', 5]];
const WIN_52W = 253;
const RET_DAYS = {ret_1w: 5, ret_2w: 10, ret_1m: 21, ret_3m: 63, ret_6m: 126, ret_12m: 252, ret_18m: 378};
const STATE_COLS = new Set(['52W high']);
const RETURN_COLS = ['52W high', 'YTD', ...PAST.map(([l]) => 'Last ' + l), ...FWD.map(([l]) => 'Next ' + l)];
const FWD_COLS = FWD.map(([l]) => 'Next ' + l);
const COL_DAYS = Object.fromEntries([['52W high', WIN_52W], ['YTD', 252],
  ...PAST.map(([l, n]) => ['Last ' + l, n]), ...FWD.map(([l, n]) => ['Next ' + l, n])]);
const SNAP_TOLERANCE = 7;

function rollingExtreme(v, win, isMax) {     // rolling(win, min_periods=1).max()/min()
  const n = v.length, out = new Float64Array(n), dq = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    while (tail > head && (isMax ? v[dq[tail - 1]] <= v[i] : v[dq[tail - 1]] >= v[i])) tail--;
    dq[tail++] = i;
    if (dq[head] <= i - win) head++;
    out[i] = v[dq[head]];
  }
  return out;
}
function rollingMean(v, win) {               // rolling(win, min_periods=win).mean()
  const n = v.length, out = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += v[i];
    if (i >= win) sum -= v[i - win];
    if (i >= win - 1) out[i] = sum / win;
  }
  return out;
}
function ytdReturn(s) {
  const lastByYear = new Map();
  for (let i = 0; i < s.d.length; i++) lastByYear.set(yearOf(s.d[i]), s.v[i]);
  const out = new Float64Array(s.v.length);
  for (let i = 0; i < s.v.length; i++) {
    const base = lastByYear.get(yearOf(s.d[i]) - 1);
    out[i] = base === undefined ? NaN : s.v[i] / base - 1;
  }
  return out;
}
const mcache = new Map();
function metricSeries(sid, metric) {
  const key = sid + '|' + metric;
  if (mcache.has(key)) return mcache.get(key);
  const s = series(sid), v = s.v, n = v.length;
  let out;
  if (metric === 'price') out = v;
  else if (metric === 'dd_52w_high') { const m = rollingExtreme(v, WIN_52W, true); out = v.map((x, i) => x / m[i] - 1); }
  else if (metric === 'up_52w_low') { const m = rollingExtreme(v, WIN_52W, false); out = v.map((x, i) => x / m[i] - 1); }
  else if (metric === 'dd_alltime') { let mx = -Infinity; out = v.map(x => { mx = Math.max(mx, x); return x / mx - 1; }); }
  else if (metric === 'ret_ytd') out = ytdReturn(s);
  else if (metric === 'vs_ma50') { const m = rollingMean(v, 50); out = v.map((x, i) => x / m[i] - 1); }
  else if (metric === 'vs_ma200') { const m = rollingMean(v, 200); out = v.map((x, i) => x / m[i] - 1); }
  else if (metric in RET_DAYS) { const k = RET_DAYS[metric]; out = new Float64Array(n); for (let i = 0; i < n; i++) out[i] = i >= k ? v[i] / v[i - k] - 1 : NaN; }
  else throw new Error('unknown metric ' + metric);
  mcache.set(key, out);
  return out;
}
const PCT = id => id !== 'price';
function applyOp(x, op, val) {
  if (op === '<=') return x <= val;
  if (op === '>=') return x >= val;
  if (op === '<') return x < val;
  if (op === '>') return x > val;
  throw new Error('unknown operator ' + op);
}

/* ------------------------------------------------------------- detection */
function findEvents(conds, minGap, mode, start, end) {
  if (!conds.length) return [];
  let baseD = null, combined = null;
  for (const c of conds) {
    const s = series(c.series);
    if (!s.v.length) return [];
    const m = metricSeries(c.series, c.metric);
    const val = PCT(c.metric) ? c.value / 100 : c.value;
    const mask = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) mask[i] = (!Number.isNaN(m[i]) && applyOp(m[i], c.op, val)) ? 1 : 0;
    if (baseD === null) { baseD = s.d; combined = mask; continue; }
    for (let i = 0; i < baseD.length; i++) {            // reindex(method='ffill').fillna(False)
      if (!combined[i]) continue;
      const j = upperBound(s.d, baseD[i]) - 1;
      combined[i] = j >= 0 ? mask[j] : 0;
    }
  }
  const lo = start ? toDay(start) : -Infinity, hi = end ? toDay(end) : Infinity;
  const days = [], arr = [];
  for (let i = 0; i < baseD.length; i++) if (baseD[i] >= lo && baseD[i] <= hi) { days.push(baseD[i]); arr.push(combined[i]); }
  if (!days.length) return [];
  if (mode === 'every_day') return days.filter((_, i) => arr[i]);
  const kept = []; let last = -1e9;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] && !(i > 0 && arr[i - 1]) && i - last >= minGap) { kept.push(days[i]); last = i; }
  }
  return kept;
}

/* ----------------------------------------------------------- measurement */
const fcache = new Map();
function returnFrame(sid) {
  if (fcache.has(sid)) return fcache.get(sid);
  const s = series(sid), v = s.v, n = v.length, cols = {};
  cols['52W high'] = metricSeries(sid, 'dd_52w_high');
  cols['YTD'] = metricSeries(sid, 'ret_ytd');
  for (const [l, k] of PAST) { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = i >= k ? v[i] / v[i - k] - 1 : NaN; cols['Last ' + l] = a; }
  for (const [l, k] of FWD) { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = i + k < n ? v[i + k] / v[i] - 1 : NaN; cols['Next ' + l] = a; }
  fcache.set(sid, cols);
  return cols;
}
/* rows: {pos, day, level, provisional, [col]: value} -- event_table() */
function eventTable(days, sid, cols) {
  const s = series(sid);
  if (!s.v.length || !days.length) return [];
  const frame = returnFrame(sid), out = [];
  for (const d of days) {
    const pos = lowerBound(s.d, d);
    if (pos >= s.d.length) continue;
    if (s.d[pos] - d > SNAP_TOLERANCE) continue;
    const row = {pos, day: s.d[pos], level: s.v[pos], provisional: s.p0 >= 0 && pos >= s.p0};
    for (const c of cols) row[c] = frame[c][pos];
    out.push(row);
  }
  return out;
}

const finite = x => typeof x === 'number' && Number.isFinite(x);
function median(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}
function summarize(rows, cols) {
  const out = {};
  for (const c of cols) {
    const s = rows.map(r => r[c]).filter(finite), n = s.length;
    let avg = null, med = null, sd = null, se = null, mn = null, mx = null, win = null;
    if (n) {
      const sum = s.reduce((a, b) => a + b, 0);
      avg = sum / n;
      med = median([...s].sort((a, b) => a - b));
      mn = Math.min(...s); mx = Math.max(...s);
      if (!STATE_COLS.has(c)) win = s.filter(x => x > 0).length / n;
      if (n > 1) {
        let ss = 0; for (const x of s) ss += (x - avg) * (x - avg);
        sd = Math.sqrt(ss / (n - 1)); se = sd / Math.sqrt(n);
      }
    }
    out[c] = {avg, median: med, sd, se, min: mn, max: mx, win, n};
  }
  return out;
}

function conditionNow(conds) {
  const detail = []; let met = true;
  for (const c of conds) {
    const s = series(c.series);
    if (!s.v.length) return {met: false, detail: []};
    const m = metricSeries(c.series, c.metric);
    let i = m.length - 1; while (i >= 0 && Number.isNaN(m[i])) i--;
    if (i < 0) return {met: false, detail: []};
    const val = m[i], thresh = PCT(c.metric) ? c.value / 100 : c.value;
    const ok = applyOp(val, c.op, thresh);
    met = met && ok;
    detail.push({series: c.series, metric: c.metric, label: DATA.metricLabels[c.metric],
                 value: val, pct: PCT(c.metric), op: c.op, threshold: c.value,
                 date: iso(s.d[i]), met: ok});
  }
  return {met, detail};
}

function independentN(days, sid, horizon) {
  const s = series(sid);
  if (!s.v.length || !days.length || horizon <= 0) return days.length;
  let kept = 0, last = -1e9;
  for (const d of days) {
    const pos = lowerBound(s.d, d);
    if (pos >= s.d.length) continue;
    if (pos - last >= horizon) { kept++; last = pos; }
  }
  return kept;
}

function significance(days, sid, cols, nIter) {
  const s = series(sid), length = s.v.length;
  if (!length || !days.length) return {};
  const frame = returnFrame(sid);
  const pos = days.map(d => lowerBound(s.d, d)).filter(p => p < length);
  if (!pos.length) return {};
  const k = pos.length, buf = new Float64Array(k), out = {};
  const stats = (col, shift) => {           // nanmean, nanmedian, nanmean(x > 0)
    let cnt = 0, sum = 0, pos_ = 0;
    for (let i = 0; i < k; i++) {
      const x = col[(pos[i] + shift) % length];
      if (x > 0) pos_++;
      if (x === x) { buf[cnt++] = x; sum += x; }
    }
    if (!cnt) return [NaN, NaN, pos_ / k];
    const arr = buf.subarray(0, cnt).sort();
    return [sum / cnt, median(arr), pos_ / k];
  };
  for (const c of cols) {
    const col = frame[c];
    const a = stats(col, 0);
    const dist = [[], [], []];
    for (let it = 0; it < nIter; it++) {
      const shift = Math.floor(it * length / nIter);
      const r = stats(col, shift);
      for (let j = 0; j < 3; j++) if (Number.isFinite(r[j])) dist[j].push(r[j]);
    }
    out[c] = {};
    ['avg', 'median', 'win'].forEach((stat, j) => {
      if (stat === 'win' && STATE_COLS.has(c)) { out[c][stat] = null; return; }
      if (!Number.isFinite(a[j]) || dist[j].length < 50) { out[c][stat] = null; return; }
      const sorted = Float64Array.from(dist[j]).sort(), centre = median(sorted);
      const ref = Math.abs(a[j] - centre);
      let ext = 0; for (const x of dist[j]) if (Math.abs(x - centre) >= ref) ext++;
      out[c][stat] = (1 + ext) / (dist[j].length + 1);
    });
  }
  return out;
}

function baseline(sid, cols) {
  const s = series(sid);
  if (!s.v.length) return {};
  return summarize(eventTable(Array.from(s.d), sid, cols), cols);
}

/* ------------------------------------------------------------ API shims */
function parseRequest(p) {
  const conds = (p.conditions || []).filter(c => c.series).map(c => ({
    series: c.series, metric: c.metric, op: c.op, value: parseFloat(c.value)}));
  if (!conds.length) throw new Error('add at least one condition');
  if (conds.some(c => Number.isNaN(c.value))) throw new Error('could not convert string to float');
  return {conditions: conds, measure: p.measure || conds[0].series,
          minGap: p.min_gap === undefined ? 63 : parseInt(p.min_gap),
          mode: p.mode || 'first_entry', start: p.start || null, end: p.end || null};
}
const N_ITER = 2000;

function study(payload) {
  const kw = parseRequest(payload), cols = RETURN_COLS;
  const days = findEvents(kw.conditions, kw.minGap, kw.mode, kw.start, kw.end);
  const table = eventTable(days, kw.measure, cols);
  const toRec = r => {
    const rec = {date: iso(r.day), level: Number(r.level.toFixed(2)), provisional: r.provisional};
    for (const c of cols) rec[c] = finite(r[c]) ? r[c] : null;
    return rec;
  };
  const s = series(kw.measure);
  let latest = null;
  if (s.v.length) {
    const lt = eventTable([s.d[s.d.length - 1]], kw.measure, cols);
    if (lt.length) {
      latest = toRec(lt[0]);
      latest.is_event = !!(table.length && table[table.length - 1].day === lt[0].day);
    }
  }
  const step = Math.max(1, Math.floor(s.v.length / 1400)), idx = [];
  for (let i = 0; i < s.v.length; i += step) idx.push(i);
  if (s.v.length && idx[idx.length - 1] !== s.v.length - 1) idx.push(s.v.length - 1);
  const meta = DATA.series.find(x => x.id === kw.measure) || {};
  return {
    kw, table, days,
    json: {
      cols, events: table.map(toRec), stats: summarize(table, cols),
      baseline: baseline(kw.measure, cols), n_events: table.length,
      pvals: days.length ? significance(days, kw.measure, cols, N_ITER) : {},
      independent: days.length ? Object.fromEntries(cols.map(c => [c, independentN(days, kw.measure, COL_DAYS[c])])) : {},
      n_iter: N_ITER, latest, now: conditionNow(kw.conditions),
      measure: {name: meta.name, ticker: meta.ticker}, measure_id: kw.measure,
      chart: {dates: idx.map(i => iso(s.d[i])), levels: idx.map(i => s.v[i]),
              events: table.map(r => iso(r.day))},
    },
  };
}

function rotation(payload) {
  const kw = parseRequest(payload);
  const days = findEvents(kw.conditions, kw.minGap, kw.mode, kw.start, kw.end);
  const rows = [];
  for (const rec of DATA.series) {
    const table = days.length ? eventTable(days, rec.id, FWD_COLS) : [];
    if (!table.length) continue;
    const st = summarize(table, FWD_COLS);
    if (!FWD_COLS.some(c => st[c].n)) continue;
    rows.push({id: rec.id, name: rec.name, grp: rec.grp, sector: rec.sector, ticker: rec.ticker, stats: st});
  }
  return {kw, days, rows};
}

/* Python's repr() for floats, so CSV exports match the local app byte for byte */
function pyFloat(x) {
  if (Number.isInteger(x)) return x.toFixed(1);
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-4 || a >= 1e16)) {
    const [m, e] = x.toExponential().split('e');
    const ex = parseInt(e);
    return m + 'e' + (ex < 0 ? '-' : '+') + String(Math.abs(ex)).padStart(2, '0');
  }
  return String(x);
}
const rnd = (x, d) => Number(x.toFixed(d));
function csvCell(v) {
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvLine = arr => arr.map(csvCell).join(',') + '\r\n';

function studyCSV(payload) {
  const {table, json} = study(payload), cols = json.cols;
  let out = csvLine(['date', 'level', 'provisional', ...cols]);
  const rowOut = (label, r) => csvLine([label, pyFloat(rnd(r.level, 4)), r.provisional ? 1 : 0,
    ...cols.map(c => finite(r[c]) ? pyFloat(rnd(r[c], 6)) : '')]);
  for (const r of table) out += rowOut(iso(r.day), r);
  const s = series(json.measure_id);
  if (s.v.length) {
    const lt = eventTable([s.d[s.d.length - 1]], json.measure_id, cols);
    if (lt.length) out += rowOut(`LATEST ${iso(lt[0].day)} (reference, not an event)`, lt[0]);
  }
  const fmt = (v, d) => v === null || v === undefined ? '' : pyFloat(rnd(v, d));
  for (const [label, key] of [['Average', 'avg'], ['Median', 'median'], ['Std dev', 'sd'], ['Std error', 'se'],
                              ['Min', 'min'], ['Max', 'max'], ['Win rate', 'win'], ['N', 'n']])
    out += csvLine([label, '', '', ...cols.map(c => key === 'n' ? json.stats[c].n : fmt(json.stats[c][key], 6))]);
  out += csvLine(['N independent', '', '', ...cols.map(c => json.independent[c] ?? '')]);
  for (const [label, key] of [['p-value (average)', 'avg'], ['p-value (median)', 'median'], ['p-value (win rate)', 'win']])
    out += csvLine([label, '', '', ...cols.map(c => fmt(json.pvals[c]?.[key], 4))]);
  for (const [label, key] of [['Baseline average', 'avg'], ['Baseline median', 'median'], ['Baseline win rate', 'win']])
    out += csvLine([label, '', '', ...cols.map(c => fmt(json.baseline[c]?.[key], 6))]);
  return out;
}

function rotateJSON(payload) {
  const {kw, days, rows} = rotation(payload);
  return {cols: FWD_COLS, n_events: days.length, dates: days.map(iso), now: conditionNow(kw.conditions),
          rows: rows.map(r => ({id: r.id, name: r.name, grp: r.grp, sector: r.sector, ticker: r.ticker,
            stats: Object.fromEntries(FWD_COLS.map(c => [c, {avg: r.stats[c].avg, median: r.stats[c].median,
                                                            win: r.stats[c].win, n: r.stats[c].n}]))}))};
}
function rotateCSV(payload) {
  const {rows} = rotation(payload), cols = FWD_COLS;
  let out = csvLine(['group', 'name', 'ticker', 'sector', ...['avg', 'median', 'win', 'n'].flatMap(k => cols.map(c => k + ' ' + c))]);
  for (const r of rows) {
    const line = [r.grp, r.name, r.ticker, r.sector || ''];
    for (const key of ['avg', 'median', 'win', 'n'])
      for (const c of cols) {
        const v = r.stats[c][key];
        line.push(v === null ? '' : key === 'n' ? v : pyFloat(rnd(v, 6)));
      }
    out += csvLine(line);
  }
  return out;
}

const json = (obj, status) => new Response(JSON.stringify(obj), {status: status || 200,
  headers: {'Content-Type': 'application/json'}});
const realFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('/api/')) return realFetch(input, init);
  await READY;
  await new Promise(r => setTimeout(r, 30));      // let "Running…" paint before heavy work
  const body = init && init.body ? JSON.parse(init.body) : {};
  try {
    switch (url) {
      case '/api/series': return json(DATA.seriesList);
      case '/api/metrics': return json(DATA.metrics);
      case '/api/status': return json(DATA.status);
      case '/api/study': return json(study(body).json);
      case '/api/rotate': return json(rotateJSON(body));
      case '/api/export.csv': return new Response(studyCSV(body), {headers: {'Content-Type': 'text/csv'}});
      case '/api/rotate.csv': return new Response(rotateCSV(body), {headers: {'Content-Type': 'text/csv'}});
      case '/api/update': return json({status: 'unavailable', error: 'read-only website'}, 403);
      default: return json({error: 'not found'}, 404);
    }
  } catch (e) {
    return json({error: e.message}, 400);
  }
};

/* exposed for verification against the local app */
window.EventStudySite = {ready: READY, study: p => study(p).json, rotate: rotateJSON,
                         studyCSV, rotateCSV, get data() { return DATA; }};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', unlock);
else unlock();
READY.then(() => {
  const built = DATA.built ? ` · site built ${DATA.built}` : '';
  const p = document.getElementById('p-data');
  if (p && built) setTimeout(() => { if (!p.textContent.includes('site built')) p.insertAdjacentHTML('beforeend', `<span class="muted">${built}</span>`); }, 1500);
}).catch(e => {
  document.body.insertAdjacentHTML('afterbegin', `<div style="padding:16px;color:#c0392b">Could not load data: ${e.message}</div>`);
});
})();

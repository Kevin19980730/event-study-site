/* Event-criteria rows shared by the study (/) and rotation (/rotate) pages.

   A row is  group -> series -> criterion -> threshold.  The group list keeps the
   ~200 series out of one long dropdown; picking "Breadth" swaps the series list
   for the 15 breadth universes (sent as "br:<code>") and the criteria for the 7
   breadth internals (engine.BREADTH_METRICS). Needs SERIES and METRICS (from
   /api/series, /api/metrics) and $ in the page. */

const SERIES_GROUPS = [
  ['asset_class', 'Asset classes'], ['benchmark', 'Benchmark'],
  ['sector', 'GICS sectors (S&P 1500)'], ['industry', 'GICS industries (S&P 1500)'],
  ['ff_industry', 'Ken French 49 industries, value-weighted (1926+)'],
  ['ff_industry_ew', 'Ken French 49 industries, equal-weighted (1926+)'],
  ['breadth', 'Breadth (% of members)'],
];
/* breadth.UNIVERSES -- the breadth monitor's 15 series */
const BREADTH_UNIVERSES = [
  ['SPX', 'S&P 500'], ['NDX', 'Nasdaq 100'], ['RTY', 'Russell 2000'], ['SPR', 'S&P 1500'],
  ['S5COND', 'S&P 500 Consumer Discretionary'], ['S5CONS', 'S&P 500 Consumer Staples'],
  ['S5ENRS', 'S&P 500 Energy'], ['S5FINL', 'S&P 500 Financials'], ['S5HLTH', 'S&P 500 Health Care'],
  ['S5INDU', 'S&P 500 Industrials'], ['S5INFT', 'S&P 500 Information Technology'],
  ['S5MATR', 'S&P 500 Materials'], ['S5RLST', 'S&P 500 Real Estate'],
  ['S5TELS', 'S&P 500 Communication Services'], ['S5UTIL', 'S&P 500 Utilities'],
];
const METRIC_GROUPS = [
  ['Drawdown & level', ['dd_52w_high', 'up_52w_low', 'dd_alltime', 'vs_ma50', 'vs_ma200', 'price']],
  ['Returns', ['ret_1d', 'ret_1w', 'ret_2w', 'ret_1m', 'ret_3m', 'ret_6m', 'ret_12m', 'ret_18m', 'ret_ytd']],
  ['Streaks', ['up_streak', 'down_streak', 'streak_ret']],
  ['Calendar & elections', ['cycle_year', 'month', 'election_day', 'midterm_day', 'pres_day', 'midterm_flip']],
];
const isBreadthMetric = m => m.startsWith('br_');
const groupOf = sid => sid?.startsWith('br:') ? 'breadth'
  : (SERIES.find(s => s.id === sid) || {}).grp || 'asset_class';

function groupOptions(sel, withBreadth = true) {
  return SERIES_GROUPS.filter(([g]) => (withBreadth || g !== 'breadth') &&
      (g === 'breadth' || SERIES.some(s => s.grp === g)))
    .map(([g, l]) => `<option value="${g}"${g === sel ? ' selected' : ''}>${l}</option>`).join('');
}
function seriesOptionsFor(grp, sel) {
  const rows = grp === 'breadth' ? BREADTH_UNIVERSES.map(([c, l]) => ({id: 'br:' + c, name: l}))
    : SERIES.filter(s => s.grp === grp);
  return rows.map(s => `<option value="${s.id}"${s.id === sel ? ' selected' : ''}>${s.name}</option>`).join('');
}
/* full list in optgroups, for pages with a single series picker */
function seriesOptions(sel) {
  return SERIES_GROUPS.filter(([g]) => g !== 'breadth' && SERIES.some(s => s.grp === g))
    .map(([g, l]) => `<optgroup label="${l}">${seriesOptionsFor(g, sel)}</optgroup>`).join('');
}
function metricOptions(breadth, sel) {
  const label = id => (METRICS.find(m => m.id === id) || {}).label || id;
  const opt = id => `<option value="${id}"${id === sel ? ' selected' : ''}>${label(id)}</option>`;
  if (breadth) return METRICS.filter(m => isBreadthMetric(m.id)).map(m => opt(m.id)).join('');
  const known = new Set(METRIC_GROUPS.flatMap(([, ids]) => ids));
  const extra = METRICS.filter(m => !isBreadthMetric(m.id) && !known.has(m.id)).map(m => m.id);
  return [...METRIC_GROUPS, ...(extra.length ? [['Other', extra]] : [])]
    .map(([l, ids]) => `<optgroup label="${l}">${ids.filter(id => METRICS.some(m => m.id === id))
      .map(opt).join('')}</optgroup>`).join('');
}

/* An up/down streak row carries an optional total-move box: "5 down days in a row,
   down 5% or more in total". It is sent as a second, ANDed streak_ret condition. */
const STREAK = ['up_streak', 'down_streak'];
/* Calendar criteria pick a value from a list instead of taking a threshold, and are
   sent as "==" ("has" for the midterm_flip bit set). cycle_year is year % 4,
   election_day is sessions from US election day, as in engine.metric_series. */
const ELECTION_PICK = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map(k => [k,
    k === 0 ? 'Election day' : k === -1 ? 'Day before (−1)' : k === 1 ? 'Day after (+1)'
    : (k > 0 ? '+' : '−') + Math.abs(k) + ' sessions']);
const CAL = {
  cycle_year: [[0, 'Election year'], [1, 'Post-election year'], [2, 'Midterm year'], [3, 'Pre-election year']],
  election_day: ELECTION_PICK,
  midterm_day: ELECTION_PICK,
  pres_day: ELECTION_PICK,
  /* bit set (engine.midterm_flip_code), tested with "has": every bit of the pick present */
  midterm_flip: [[64, 'Any chamber flipped'], [1, 'Flipped D → R (any chamber)'],
                 [2, 'Flipped R → D (any chamber)'], [4, 'Both chambers flipped'],
                 [5, 'Both flipped D → R'], [6, 'Both flipped R → D'],
                 [16, 'House flipped'], [32, 'Senate flipped'], [8, 'No flip (both held)']],
  month: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => [i + 1, m]),
};

function addCond(series, metric, op, value, move) {
  const div = document.createElement('div');
  div.className = 'cond';
  const g0 = groupOf(series);
  div.innerHTML =
    `<select class="grp" title="Series group">${groupOptions(g0)}</select>
     <select class="series">${seriesOptionsFor(g0, series)}</select>
     <select class="metric">${metricOptions(g0 === 'breadth', metric)}</select>
     <select class="op">${['<=', '>=', '<', '>'].map(o =>
       `<option${o === op ? ' selected' : ''}>${o}</option>`).join('')}</select>
     <input type="number" class="val" value="${value}" step="0.5">
     <span class="unit muted"></span>
     <select class="pick"></select>
     <span class="streak-move"><span class="dir"></span> &ge;
       <input type="number" class="move" value="${move ?? ''}" min="0" step="0.5"
              placeholder="any" title="Total move over the run, from the close before it began. Blank = any size."> %</span>
     <button class="rm" title="remove">✕</button>`;
  const grp = div.querySelector('.grp'), ser = div.querySelector('.series');
  const met = div.querySelector('.metric'), mv = div.querySelector('.streak-move');
  const pick = div.querySelector('.pick'), unit = div.querySelector('.unit');
  const sync = () => {
    const cal = CAL[met.value];
    div.querySelector('.op').hidden = div.querySelector('.val').hidden = !!cal;
    pick.hidden = !cal;
    if (cal && pick.dataset.for !== met.value) {
      pick.innerHTML = cal.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      if (met.value === metric && cal.some(([v]) => v === value)) pick.value = value;
      pick.dataset.for = met.value;
    }
    unit.textContent = isBreadthMetric(met.value) ? '%' : '';
    unit.title = 'percent of the universe\'s members';
    unit.hidden = !isBreadthMetric(met.value);
    mv.hidden = !STREAK.includes(met.value);
    mv.querySelector('.dir').textContent = met.value === 'up_streak' ? '& up' : '& down';
  };
  grp.addEventListener('change', () => {
    const wasBreadth = isBreadthMetric(met.value), nowBreadth = grp.value === 'breadth';
    ser.innerHTML = seriesOptionsFor(grp.value);
    if (wasBreadth !== nowBreadth) {
      met.innerHTML = metricOptions(nowBreadth, nowBreadth ? 'br_ma200' : 'dd_52w_high');
      div.querySelector('.val').value = nowBreadth ? 20 : -10;
      div.querySelector('.op').value = '<=';
    }
    sync();
  });
  met.addEventListener('change', sync);
  sync();
  div.querySelector('.rm').onclick = () => {
    if ($('#conds').children.length > 1) div.remove();
  };
  $('#conds').appendChild(div);
}
function readConds() {
  return [...document.querySelectorAll('.cond')].flatMap(d => {
    const c = {
      series: d.querySelector('.series').value,
      metric: d.querySelector('.metric').value,
      op: d.querySelector('.op').value,
      value: parseFloat(d.querySelector('.val').value),
    };
    if (CAL[c.metric]) { c.op = c.metric === 'midterm_flip' ? 'has' : '=='; c.value = parseFloat(d.querySelector('.pick').value); }
    const move = parseFloat(d.querySelector('.move').value);
    if (!STREAK.includes(c.metric) || !(move > 0)) return [c];
    const up = c.metric === 'up_streak';
    return [c, {series: c.series, metric: 'streak_ret', op: up ? '>=' : '<=',
                value: up ? move : -move}];
  });
}

/* "Measure returns on": group, then series; group "" = the first condition's series
   (a breadth universe's own index when condition 1 is breadth -- engine.default_measure) */
function initMeasure() {
  const g = $('#measure-grp'), s = $('#measure');
  if (!g || !s) return;
  g.innerHTML = '<option value="">same as condition 1</option>' + groupOptions('', false);
  const fill = () => {
    s.innerHTML = g.value ? seriesOptionsFor(g.value) : '<option value=""></option>';
    s.hidden = !g.value;
  };
  g.onchange = fill;
  fill();
}
function resetMeasure() {
  const g = $('#measure-grp');
  if (g) { g.value = ''; g.onchange(); }
}

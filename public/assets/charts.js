/* Small SVG chart helpers: columns, horizontal bars, line, segmented bar. No dependencies. */
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const tip = () => document.getElementById('tooltip');

  function s(tag, attrs = {}, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
    for (const kid of kids) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }

  // ---------- formatting ----------
  const nf = new Intl.NumberFormat();
  const fmt = {
    int: (v) => nf.format(Math.round(v || 0)),
    compact: (v) => (Math.abs(v) >= 10_000 ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v) : nf.format(Math.round(v))),
    money(v) {
      if (v == null) return '—';
      if (v === 0) return '$0.00';
      const a = Math.abs(v);
      if (a < 0.01) return `$${v.toPrecision(2).replace(/0+$/, '')}`;
      if (a < 1) return `$${v.toFixed(3)}`;
      return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    },
    moneyAxis(v) {
      if (v === 0) return '$0';
      if (v < 0.01) return `$${v.toPrecision(1)}`;
      if (v < 1) return `$${+v.toFixed(3)}`;
      return `$${fmt.compact(v)}`;
    },
    pct: (v, digits = 0) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`),
  };

  // ---------- tooltip ----------
  function showTip(anchor, title, rows) {
    const el = tip();
    el.replaceChildren();
    if (title) el.append(Object.assign(document.createElement('div'), { className: 'tt-title', textContent: title }));
    for (const [value, label, keyClass] of rows) {
      const row = document.createElement('div');
      row.className = 'tt-row';
      if (keyClass !== false) {
        const key = document.createElement('i');
        key.className = 'tt-key';
        if (keyClass) key.style.background = `var(--series-${keyClass})`;
        row.append(key);
      }
      row.append(Object.assign(document.createElement('b'), { textContent: value }));
      if (label) row.append(Object.assign(document.createElement('span'), { textContent: label }));
      el.append(row);
    }
    el.classList.remove('hidden');
    let x, y;
    if (anchor.clientX != null) {
      x = anchor.clientX + 14; y = anchor.clientY + 14;
    } else {
      const r = anchor.getBoundingClientRect();
      x = r.left + r.width / 2; y = r.top - 8 - el.offsetHeight;
    }
    const w = el.offsetWidth, h = el.offsetHeight;
    if (x + w > innerWidth - 8) x = (anchor.clientX != null ? anchor.clientX - 14 : innerWidth - 8) - w;
    if (y + h > innerHeight - 8) y = innerHeight - 8 - h;
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, y)}px`;
  }
  function hideTip() { tip().classList.add('hidden'); }

  // ---------- scales ----------
  function niceTicks(max, count = 4, integer = false) {
    if (!(max > 0)) return [0, 1];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw);
    if (integer) step = Math.max(1, Math.ceil(step));
    const ticks = [];
    for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(+v.toPrecision(12));
    if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toPrecision(12));
    return ticks;
  }

  function measure(texts, cls = 'axis-text') {
    const probe = s('svg', { width: 0, height: 0, style: null });
    probe.setAttribute('aria-hidden', 'true');
    probe.classList.add('chart-probe');
    const t = s('text', { class: cls });
    probe.append(t);
    document.body.append(probe);
    let w = 0;
    for (const str of texts) { t.textContent = str; w = Math.max(w, t.getComputedTextLength()); }
    probe.remove();
    return w;
  }

  // Bar path: 4px rounded data-end, square at the baseline.
  function vbar(x, y, w, h, r = 4) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function hbar(x, y, w, h, r = 4) {
    r = Math.min(r, h / 2, w);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }

  function wireHover(container, hit, mark, onShow) {
    const enter = (e) => { container.classList.add('has-hover'); mark?.classList.add('is-hover'); onShow(e); };
    const leave = () => { container.classList.remove('has-hover'); mark?.classList.remove('is-hover'); hideTip(); };
    hit.addEventListener('pointermove', enter);
    hit.addEventListener('pointerleave', leave);
    hit.addEventListener('focus', () => enter(hit));
    hit.addEventListener('blur', leave);
  }

  // ---------- column chart (single series) ----------
  function columns(container, { data, format = fmt.int, axisFormat = format, height = 200, labelMax = true, integer = false, ariaLabel = '' }) {
    container.replaceChildren();
    const width = Math.max(260, container.clientWidth);
    const max = Math.max(0, ...data.map((d) => d.value));
    const ticks = niceTicks(max || 1, 4, integer);
    const top = ticks[ticks.length - 1];
    const left = Math.ceil(measure(ticks.map(axisFormat))) + 10;
    const m = { t: 18, r: 4, b: 24, l: left };
    const pw = width - m.l - m.r, ph = height - m.t - m.b;
    const band = pw / data.length;
    const barW = Math.max(1, Math.min(24, band * 0.72, band - 2));
    const y = (v) => m.t + ph - (v / top) * ph;

    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': ariaLabel });
    for (const t of ticks) {
      const yy = Math.round(y(t)) + 0.5;
      if (t !== 0) svg.append(s('line', { class: 'gridline', x1: m.l, x2: width - m.r, y1: yy, y2: yy }));
      svg.append(s('text', { class: 'axis-text', x: m.l - 8, y: yy + 4, 'text-anchor': 'end' }, axisFormat(t)));
    }
    // x labels, thinned so they never collide
    const labelW = measure(data.map((d) => d.label)) + 12;
    const every = Math.max(1, Math.ceil(labelW / band));
    data.forEach((d, i) => {
      if ((data.length - 1 - i) % every !== 0) return;
      svg.append(s('text', { class: 'axis-text', x: m.l + band * i + band / 2, y: height - 6, 'text-anchor': 'middle' }, d.label));
    });

    const maxIdx = data.findIndex((d) => d.value === max && max > 0);
    data.forEach((d, i) => {
      const cx = m.l + band * i + band / 2;
      let mark = null;
      if (d.value > 0) {
        const h = Math.max(1, (d.value / top) * ph);
        mark = s('path', { class: 'mark mark-1', d: vbar(cx - barW / 2, m.t + ph - h, barW, h) });
        svg.append(mark);
      }
      if (labelMax && i === maxIdx) {
        svg.append(s('text', { class: 'value-text', x: cx, y: y(d.value) - 6, 'text-anchor': 'middle' }, format(d.value)));
      }
      const hit = s('rect', { class: 'hit', x: m.l + band * i, y: m.t, width: band, height: ph, tabindex: 0, 'aria-label': `${d.title || d.label}: ${format(d.value)}` });
      wireHover(container, hit, mark, (e) => showTip(e, d.title || d.label, d.rows || [[format(d.value), '']]));
      svg.append(hit);
    });
    svg.append(s('line', { class: 'baseline', x1: m.l, x2: width - m.r, y1: m.t + ph + 0.5, y2: m.t + ph + 0.5 }));
    container.append(svg);
  }

  // ---------- horizontal bars (rating distribution) ----------
  function hbars(container, { data, format = fmt.int, ariaLabel = '' }) {
    container.replaceChildren();
    const width = Math.max(240, container.clientWidth);
    const rowH = 34, barH = 16;
    const height = data.length * rowH;
    const left = Math.ceil(measure(data.map((d) => d.label), 'label-text')) + 14;
    const valueW = Math.ceil(measure(data.map((d) => d.valueLabel || format(d.value)), 'value-text')) + 10;
    const pw = width - left - valueW;
    const max = Math.max(1, ...data.map((d) => d.value));
    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': ariaLabel });
    svg.append(s('line', { class: 'baseline', x1: left - 0.5, x2: left - 0.5, y1: 4, y2: height - 4 }));
    data.forEach((d, i) => {
      const cy = i * rowH + rowH / 2;
      svg.append(s('text', { class: 'label-text', x: left - 10, y: cy + 4, 'text-anchor': 'end' }, d.label));
      let mark = null;
      const w = (d.value / max) * pw;
      if (d.value > 0) {
        mark = s('path', { class: 'mark mark-1', d: hbar(left, cy - barH / 2, Math.max(2, w), barH) });
        svg.append(mark);
      }
      svg.append(s('text', { class: 'value-text', x: left + Math.max(0, w) + 6, y: cy + 4 }, d.valueLabel || format(d.value)));
      const hit = s('rect', { class: 'hit', x: 0, y: i * rowH, width, height: rowH, tabindex: 0, 'aria-label': `${d.label}: ${d.valueLabel || format(d.value)}` });
      wireHover(container, hit, mark, (e) => showTip(e, d.label, d.rows || [[format(d.value), '']]));
      svg.append(hit);
    });
    container.append(svg);
  }

  // ---------- line chart with crosshair (single series, gaps for missing values) ----------
  function line(container, { data, yMin = 0, yMax, format = (v) => v, height = 200, ariaLabel = '', emptyLabel = 'No data' }) {
    container.replaceChildren();
    const width = Math.max(260, container.clientWidth);
    const vals = data.map((d) => d.value).filter((v) => v != null);
    const hi = yMax ?? niceTicks(Math.max(...vals, 1)).at(-1);
    const ticks = [];
    const step = (hi - yMin) / 4;
    for (let v = yMin; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(4));
    const left = Math.ceil(measure(ticks.map(format))) + 10;
    const m = { t: 14, r: 34, b: 24, l: left };
    const pw = width - m.l - m.r, ph = height - m.t - m.b;
    const n = data.length;
    const x = (i) => m.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const y = (v) => m.t + ph - ((v - yMin) / (hi - yMin)) * ph;

    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': ariaLabel });
    for (const t of ticks) {
      const yy = Math.round(y(t)) + 0.5;
      svg.append(s('line', { class: t === yMin ? 'baseline' : 'gridline', x1: m.l, x2: width - m.r, y1: yy, y2: yy }));
      svg.append(s('text', { class: 'axis-text', x: m.l - 8, y: yy + 4, 'text-anchor': 'end' }, format(t)));
    }
    const labelW = measure(data.map((d) => d.label)) + 12;
    const every = Math.max(1, Math.ceil(labelW / (pw / Math.max(1, n - 1))));
    data.forEach((d, i) => {
      if ((n - 1 - i) % every !== 0) return;
      svg.append(s('text', { class: 'axis-text', x: x(i), y: height - 6, 'text-anchor': 'middle' }, d.label));
    });

    if (!vals.length) {
      svg.append(s('text', { class: 'label-text', x: m.l + pw / 2, y: m.t + ph / 2, 'text-anchor': 'middle' }, emptyLabel));
      container.append(svg);
      return;
    }

    // segments between gaps
    let seg = [];
    const flush = () => {
      if (seg.length > 1) svg.append(s('path', { class: 'line-1', d: seg.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i)},${y(v)}`).join('') }));
      else if (seg.length === 1) svg.append(s('circle', { class: 'dot-1', cx: x(seg[0][0]), cy: y(seg[0][1]), r: 3 }));
      seg = [];
    };
    data.forEach((d, i) => (d.value == null ? flush() : seg.push([i, d.value])));
    flush();

    const lastIdx = data.map((d) => d.value).findLastIndex((v) => v != null);
    svg.append(s('circle', { class: 'dot-1', cx: x(lastIdx), cy: y(data[lastIdx].value), r: 4 }));
    svg.append(s('text', { class: 'value-text', x: x(lastIdx) + 8, y: y(data[lastIdx].value) + 4 }, format(data[lastIdx].value)));

    const cross = s('line', { class: 'crosshair hidden', y1: m.t, y2: m.t + ph });
    const hot = s('circle', { class: 'dot-1 hidden', r: 4 });
    svg.append(cross, hot);
    const overlay = s('rect', { class: 'hit', x: m.l, y: m.t, width: pw, height: ph, tabindex: 0, 'aria-label': ariaLabel });
    let kbIndex = lastIdx;
    const showAt = (i, evt) => {
      const d = data[i];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
      cross.classList.remove('hidden');
      if (d.value != null) { hot.setAttribute('cx', x(i)); hot.setAttribute('cy', y(d.value)); hot.classList.remove('hidden'); } else hot.classList.add('hidden');
      showTip(evt, d.title || d.label, d.rows || [[d.value == null ? 'No reviews' : format(d.value), '']]);
    };
    const hide = () => { cross.classList.add('hidden'); hot.classList.add('hidden'); hideTip(); };
    overlay.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * width;
      const i = Math.max(0, Math.min(n - 1, Math.round(n === 1 ? 0 : ((px - m.l) / pw) * (n - 1))));
      showAt(i, e);
    });
    overlay.addEventListener('pointerleave', hide);
    overlay.addEventListener('blur', hide);
    overlay.addEventListener('focus', () => showAt(kbIndex, overlay));
    overlay.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      kbIndex = Math.max(0, Math.min(n - 1, kbIndex + (e.key === 'ArrowRight' ? 1 : -1)));
      showAt(kbIndex, overlay);
    });
    svg.append(overlay);
    container.append(svg);
  }

  // ---------- tall segmented bar (part-to-whole) ----------
  function segmented(container, { parts, ariaLabel = '' }) {
    container.replaceChildren();
    const total = parts.reduce((a, p) => a + p.value, 0);
    const bar = document.createElement('div');
    bar.className = 'seg-bar';
    bar.setAttribute('role', 'list');
    bar.setAttribute('aria-label', ariaLabel);
    const nodes = [];
    for (const p of parts) {
      if (!p.value) continue;
      const share = p.value / total;
      const el = document.createElement('div');
      el.className = `part k${p.k}`;
      el.style.flex = `${p.value} 1 0`;
      el.tabIndex = 0;
      el.setAttribute('role', 'listitem');
      el.setAttribute('aria-label', `${p.name}: ${fmt.int(p.value)} (${fmt.pct(share)})`);
      el.textContent = fmt.pct(share);
      const show = (e) => showTip(e, p.name, [[fmt.int(p.value), `· ${fmt.pct(share, 1)}`, p.k]]);
      el.addEventListener('pointermove', show);
      el.addEventListener('pointerleave', hideTip);
      el.addEventListener('focus', () => show(el));
      el.addEventListener('blur', hideTip);
      bar.append(el);
      nodes.push(el);
    }
    if (!total) {
      bar.append(Object.assign(document.createElement('div'), { className: 'muted small', textContent: 'No reviews in this period.' }));
    }
    container.append(bar);
    // Only keep in-block labels that fit with padding.
    requestAnimationFrame(() => nodes.forEach((el) => { if (el.scrollWidth > el.clientWidth) el.textContent = ''; }));

    const legend = document.createElement('div');
    legend.className = 'legend';
    for (const p of parts) {
      const item = document.createElement('span');
      const key = document.createElement('i');
      key.className = `k${p.k}`;
      item.append(key, document.createTextNode(p.name));
      legend.append(item);
    }
    container.append(legend);
  }

  // ---------- table view ----------
  function table(columns, rows, summaryText = 'Show data table') {
    const details = document.createElement('details');
    details.className = 'data-table';
    const summary = document.createElement('summary');
    summary.textContent = summaryText;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const t = document.createElement('table');
    const thead = t.createTHead().insertRow();
    for (const c of columns) {
      const th = document.createElement('th');
      th.textContent = c.label;
      if (c.num) th.className = 'num';
      thead.append(th);
    }
    const tbody = t.createTBody();
    for (const r of rows) {
      const tr = tbody.insertRow();
      columns.forEach((c, i) => {
        const td = tr.insertCell();
        td.textContent = r[i];
        if (c.num) td.className = 'num';
      });
    }
    wrap.append(t);
    details.append(summary, wrap);
    return details;
  }

  window.Charts = { columns, hbars, line, segmented, table, fmt, hideTip };
})();

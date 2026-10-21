"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/refineWorker.ts
var refineWorker_exports = {};
module.exports = __toCommonJS(refineWorker_exports);
var import_node_worker_threads = require("node:worker_threads");

// ../src/core/vision/raster.ts
function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
function colorDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db);
}
function pixelDistance(data, i, b) {
  const dr = data[i] - b[0];
  const dg = data[i + 1] - b[1];
  const db = data[i + 2] - b[2];
  return Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db);
}
function toHex([r, g, b]) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function clampRect(r, width, height) {
  const x0 = Math.max(0, Math.min(width, Math.floor(r.x)));
  const y0 = Math.max(0, Math.min(height, Math.floor(r.y)));
  const x1 = Math.max(x0, Math.min(width, Math.ceil(r.x + r.w)));
  const y1 = Math.max(y0, Math.min(height, Math.ceil(r.y + r.h)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ../src/core/vision/refine.ts
function dominantColor(img, win, mask) {
  const bins = /* @__PURE__ */ new Map();
  const { data, width } = img;
  const stepPx = Math.max(1, Math.floor(Math.sqrt(win.w * win.h / 4e4)));
  for (let y = win.y; y < win.y + win.h; y += stepPx) {
    for (let x = win.x; x < win.x + win.w; x += stepPx) {
      if (mask && mask[(y - win.y) * win.w + (x - win.x)]) continue;
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const key = r >> 3 << 10 | g >> 3 << 5 | b >> 3;
      const bin = bins.get(key);
      if (bin) {
        bin.n++;
        bin.r += r;
        bin.g += g;
        bin.b += b;
      } else bins.set(key, { n: 1, r, g, b });
    }
  }
  let best = null;
  let bestScore = -1;
  for (const [key, bin] of bins) {
    const r5 = key >> 10;
    const g5 = key >> 5 & 31;
    const b5 = key & 31;
    let score = bin.n;
    for (const [k2, b2] of bins) {
      if (k2 === key) continue;
      if (Math.abs((k2 >> 10) - r5) <= 1 && Math.abs((k2 >> 5 & 31) - g5) <= 1 && Math.abs((k2 & 31) - b5) <= 1) {
        score += b2.n * 0.5;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = bin;
    }
  }
  if (!best) return [255, 255, 255];
  return [best.r / best.n, best.g / best.n, best.b / best.n];
}
function components(mask, w, h) {
  const labels = new Int32Array(w * h);
  const out = [];
  const stack = [];
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    const comp = { x0: w, y0: h, x1: -1, y1: -1, count: 0, touchesEdge: false };
    labels[start] = next;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p - x) / w;
      comp.count++;
      if (x < comp.x0) comp.x0 = x;
      if (x > comp.x1) comp.x1 = x;
      if (y < comp.y0) comp.y0 = y;
      if (y > comp.y1) comp.y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) comp.touchesEdge = true;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = next;
            stack.push(q);
          }
        }
      }
    }
    out.push(comp);
    next++;
  }
  return out;
}
function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function detectLines(mask, w, box) {
  const rows = [];
  for (let y = box.y0; y <= box.y1; y++) {
    let n = 0;
    for (let x = box.x0; x <= box.x1; x++) n += mask[y * w + x];
    rows.push(n);
  }
  const peak = Math.max(...rows, 1);
  const ink = rows.map((n) => n > Math.max(1, peak * 0.04));
  const lines = [];
  let start = -1;
  for (let i = 0; i <= ink.length; i++) {
    if (i < ink.length && ink[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      lines.push({ y0: start + box.y0, y1: i - 1 + box.y0 });
      start = -1;
    }
  }
  if (!lines.length) return [];
  const heights = lines.map((l) => l.y1 - l.y0 + 1);
  const highest = Math.max(...heights);
  const tall = median(heights.filter((h) => h >= highest * 0.5));
  const merged = [];
  for (const l of lines) {
    const hgt = l.y1 - l.y0 + 1;
    const prev = merged[merged.length - 1];
    if (prev && (hgt < tall * 0.45 || prev.y1 - prev.y0 + 1 < tall * 0.45) && l.y0 - prev.y1 < tall * 0.6) {
      prev.y1 = l.y1;
    } else merged.push({ ...l });
  }
  return merged;
}
function refineRegion(img, proposed, opts = {}) {
  const fallback = clampRect(proposed, img.width, img.height);
  let pad = Math.max(12, Math.round(Math.max(proposed.w, proposed.h) * 0.3));
  let found = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const win2 = clampRect(
      { x: proposed.x - pad, y: proposed.y - pad, w: proposed.w + pad * 2, h: proposed.h + pad * 2 },
      img.width,
      img.height
    );
    if (win2.w < 4 || win2.h < 4 || fallback.w < 2 || fallback.h < 2) return fallbackRegion(img, fallback, win2);
    found = findGlyphs(img, win2, proposed, opts.debug);
    if (!found || !found.touchesWindow) break;
    pad = Math.round(pad * 1.8 + 20);
  }
  if (!found) found = searchAround(img, proposed, opts);
  if (!found) {
    const win2 = clampRect({ x: proposed.x - pad, y: proposed.y - pad, w: proposed.w + pad * 2, h: proposed.h + pad * 2 }, img.width, img.height);
    return fallbackRegion(img, fallback, win2);
  }
  const { win, bg, glyphMask, box: tb, ink } = found;
  const ww = win.w;
  const textBox = { x: tb.x0 + win.x, y: tb.y0 + win.y, w: tb.x1 - tb.x0 + 1, h: tb.y1 - tb.y0 + 1 };
  const lines = detectLines(glyphMask, ww, tb);
  const lineCount = Math.max(1, lines.length);
  const lineInkHeight = lines.length ? median(lines.map((l) => l.y1 - l.y0 + 1)) : textBox.h;
  const centres = lines.map((l) => (l.y0 + l.y1) / 2);
  const linePitch = centres.length > 1 ? median(centres.slice(1).map((c, i) => c - centres[i])) : 0;
  const lineWidths = lines.map((l) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let y = l.y0; y <= l.y1; y++) {
      for (let x = tb.x0; x <= tb.x1; x++) {
        if (glyphMask[y * ww + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
        }
      }
    }
    return x1 >= x0 ? x1 - x0 + 1 : 0;
  });
  const textColor = inkColor(img, win, glyphMask, bg);
  const strokeColor = strokeColorOf(img, win, glyphMask, bg, textColor);
  const weight = strokeWeights(img, win, glyphMask, textColor, strokeColor ?? bg);
  const m = Math.max(3, Math.round(lineInkHeight * 0.2));
  const ring = clampRect(
    { x: textBox.x - m, y: textBox.y - m, w: textBox.w + m * 2, h: textBox.h + m * 2 },
    img.width,
    img.height
  );
  const flatBackground = backgroundFlatness(img, ring, textBox, bg) > 0.82;
  const fringe = dilate(glyphMask, ww, win.h, 2);
  const isClear = (x, y) => {
    const lx = x - win.x;
    const ly = y - win.y;
    if (lx >= 0 && ly >= 0 && lx < ww && ly < win.h && fringe[ly * ww + lx]) return null;
    const i = (y * img.width + x) * 4;
    return colorDistance([img.data[i], img.data[i + 1], img.data[i + 2]], bg) < 14;
  };
  const clearIn = (r) => {
    let n = 0;
    let ok = 0;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const c = isClear(x, y);
        if (c === null) continue;
        n++;
        if (c) ok++;
      }
    }
    return n ? ok / n : 1;
  };
  const clearBehind = clearIn(textBox);
  const base = {
    textBox,
    lineCount,
    lineInkHeight,
    linePitch,
    lineWidths: lineWidths.length ? lineWidths : [textBox.w],
    bgColor: toHex(bg),
    textColor: toHex(textColor),
    strokeColor: strokeColor ? toHex(strokeColor) : void 0,
    strokeThickness: weight.core,
    rimThickness: strokeColor ? weight.rim : void 0,
    flatBackground,
    clearBehind,
    confident: ink > 10
  };
  if (!opts.overArt) {
    const glyphAt = (x, y) => {
      const lx = x - win.x;
      const ly = y - win.y;
      return lx >= 0 && ly >= 0 && lx < ww && ly < win.h && glyphMask[ly * ww + lx] === 1;
    };
    const onReject = opts.debug?.reasons ? (r) => opts.debug?.reasons?.push(r) : void 0;
    let balloon = floodInterior(img, textBox, bg, { glyphAt, lineHeight: lineInkHeight, onVisit: opts.debug?.onFloodVisit, onReject });
    let others = opts.others;
    if (balloon && others?.length) {
      const b = balloon;
      const inside = (x, y) => {
        const sp = b.spans[Math.round((y - b.area.y) / b.step)];
        return !!sp && sp[1] >= sp[0] && x >= sp[0] && x <= sp[1];
      };
      if (rivalsIn(textBox, others, inside).length) {
        onReject?.("holds another text");
        balloon = null;
      }
    }
    let ink2 = balloon ? inkInBalloon(img, balloon, bg, textColor, textBox, others) : null;
    if (!balloon) {
      balloon = findBalloon(img, textBox, bg, { glyphAt, lineHeight: lineInkHeight, others, onReject });
      ink2 = balloon ? inkInBalloon(img, balloon, bg, textColor, textBox, others) : null;
      if (balloon && ink2?.foreign.length) {
        others = [...others ?? [], ...ink2.foreign];
        const again = findBalloon(img, textBox, bg, { glyphAt, lineHeight: lineInkHeight, others, onReject });
        if (again) {
          balloon = again;
          ink2 = inkInBalloon(img, again, bg, textColor, textBox, others);
        }
      }
    }
    if (balloon) {
      const merged = { ...base, ...ink2?.metrics ?? {} };
      const full2 = withFullLines(img, merged, bg, textColor, strokeColor, interiorRange(balloon));
      const cells = backgroundCells(img, balloon, bg, textColor, full2.textBox);
      return { ...full2, enclosed: true, area: balloon.area, spans: balloon.spans, step: balloon.step, tones: balloon.tones, cells };
    }
  }
  const full = flatBackground ? withFullLines(img, base, bg, textColor, strokeColor) : base;
  const maxPad = Math.max(4, Math.round(lineInkHeight * 0.4));
  const clearBox = clearAround(img, full.textBox, foreignTester(bg, textColor, strokeColor), maxPad);
  const ft = full.textBox;
  const artBeside = clearBox.x > ft.x - maxPad || clearBox.y > ft.y - maxPad || clearBox.x + clearBox.w < ft.x + ft.w + maxPad || clearBox.y + clearBox.h < ft.y + ft.h + maxPad;
  const grown = growOverBackground(img, full.textBox, bg, flatBackground);
  return { ...full, clearBox, artBeside, clearBehind: Math.min(clearBehind, clearIn(grown)), enclosed: false, area: grown, step: 1 };
}
var MAX_CELLS = 240;
function backgroundCells(img, b, bg, text, tb) {
  const { area, spans, step, tones } = b;
  if (!tones) return void 0;
  const axis = [text[0] - bg[0], text[1] - bg[1], text[2] - bg[2]];
  const axisLen2 = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2] || 1;
  const leansToInk = (c) => ((c[0] - bg[0]) * axis[0] + (c[1] - bg[1]) * axis[1] + (c[2] - bg[2]) * axis[2]) / axisLen2 > 0.12;
  const at = (x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const rx0 = tb.x - 2;
  const rx1 = tb.x + tb.w + 1;
  const inRect = (y) => y >= tb.y - 2 && y <= tb.y + tb.h + 1;
  const span = (i) => {
    const s = spans[i];
    return s && s[1] >= s[0] ? s : null;
  };
  let deviating = 0;
  const done = [];
  let open = [];
  for (let i = 0; i < spans.length; i++) {
    const y = area.y + i * step;
    const next = [];
    let l = Infinity;
    let r = -Infinity;
    const own = span(i);
    if (own) {
      l = own[0] + 1;
      r = own[1] - 1;
      for (const j of [i - 1, i + 1]) {
        const e = span(j);
        if (e) {
          l = Math.max(l, e[0] + 1);
          r = Math.min(r, e[1] - 1);
        }
      }
    }
    if (inRect(y)) {
      l = Math.min(l, rx0);
      r = Math.max(r, rx1);
    }
    l = Math.max(0, l);
    r = Math.min(img.width - 1, r);
    if (r - l >= 5 && y >= 0 && y < img.height) {
      const tone = tones[i] ?? bg;
      const runs = [];
      let cur = null;
      let ref = tone;
      let pending = [];
      const ink = new Uint8Array(r - l + 3);
      for (let x = l; x <= r; x++) {
        if (!leansToInk(at(x, y))) continue;
        ink[x - l] = 1;
        ink[x - l + 1] = 1;
        ink[x - l + 2] = 1;
      }
      for (let x = l; x <= r; x++) {
        const c = at(x, y);
        if (ink[x - l + 1]) {
          if (cur) cur.x1 = x;
          continue;
        }
        if (!cur) {
          cur = { x0: l, x1: x, px: [c] };
          ref = c;
          continue;
        }
        if (colorDistance(c, ref) > 6) {
          pending.push({ x, c });
          if (pending.length >= 3) {
            cur.x1 = pending[0].x - 1;
            runs.push(cur);
            cur = { x0: pending[0].x, x1: x, px: pending.map((q) => q.c) };
            ref = medianRgb(cur.px);
            pending = [];
          }
          continue;
        }
        for (const q of pending) cur.px.push(q.c);
        pending = [];
        cur.px.push(c);
        cur.x1 = x;
        if (cur.px.length <= 5) ref = medianRgb(cur.px);
      }
      if (cur) {
        for (const q of pending) cur.px.push(q.c);
        cur.x1 = r;
        runs.push(cur);
      }
      for (const u of runs) {
        if (u.px.length < 6 || u.x1 - u.x0 < 5) continue;
        const rgb = medianRgb(u.px);
        if (colorDistance(rgb, tone) <= 10) continue;
        next.push({ x: u.x0, y: y - step / 2, w: u.x1 - u.x0 + 1, h: step, rgb, miss: 0 });
        deviating += (u.x1 - u.x0 + 1) * step;
      }
    }
    const carried = [];
    for (const c of next) {
      const k = open.findIndex((o) => Math.abs(o.x - c.x) <= 2 && Math.abs(o.x + o.w - c.x - c.w) <= 2 && colorDistance(o.rgb, c.rgb) <= 3);
      if (k >= 0) {
        const o = open.splice(k, 1)[0];
        const x0 = Math.max(o.x, c.x);
        const x1 = Math.min(o.x + o.w, c.x + c.w);
        o.x = x0;
        o.w = x1 - x0;
        o.h = c.y + c.h - o.y;
        o.miss = 0;
        carried.push(o);
      } else carried.push(c);
    }
    for (const o of open) {
      if (o.miss++ < 1) carried.push(o);
      else done.push(o);
    }
    open = carried;
    if (done.length + open.length > MAX_CELLS) return void 0;
  }
  done.push(...open);
  const kept = done.filter((c) => c.w >= 12 && c.h >= 6);
  if (!kept.length || kept.reduce((a, c) => a + c.w * c.h, 0) < deviating * 0.85) return void 0;
  const touches = (a, b2) => a.y <= b2.y + b2.h + step && b2.y <= a.y + a.h + step && a.x <= b2.x + b2.w && b2.x <= a.x + a.w && colorDistance(a.rgb, b2.rgb) <= 4;
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of done) {
      if (kept.includes(c) || c.w < 6 || !kept.some((k) => touches(c, k))) continue;
      kept.push(c);
      grew = true;
    }
  }
  kept.sort((a, b2) => a.y - b2.y);
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const a = kept[i];
      const b2 = kept[j];
      const gap = b2.y - (a.y + a.h);
      if (gap < 0 || gap > 4 * step || Math.abs(a.x - b2.x) > 3 || Math.abs(a.x + a.w - b2.x - b2.w) > 3 || colorDistance(a.rgb, b2.rgb) > 4) continue;
      const x0 = Math.max(a.x, b2.x);
      a.w = Math.min(a.x + a.w, b2.x + b2.w) - x0;
      a.x = x0;
      a.h = b2.y + b2.h - a.y;
      kept.splice(j--, 1);
    }
  }
  return kept.map(({ x, y, w, h, rgb }) => ({ x, y, w, h, color: toHex(rgb) }));
}
function medianRgb(px) {
  const ch = (k) => {
    const v = px.map((p) => p[k]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  return [ch(0), ch(1), ch(2)];
}
function foreignTester(bg, text, stroke) {
  const segs = [[bg, text]];
  if (stroke) segs.push([bg, stroke], [text, stroke]);
  const near = (c, a, b) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
    const t = Math.max(0, Math.min(1, ((c[0] - a[0]) * d[0] + (c[1] - a[1]) * d[1] + (c[2] - a[2]) * d[2]) / len));
    return colorDistance(c, [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t]) < 35;
  };
  return (c) => colorDistance(c, bg) >= 40 && !segs.some(([a, b]) => near(c, a, b));
}
function clearAround(img, tb, isForeign, maxPad) {
  const at = (x, y) => {
    const i = (y * img.width + x) * 4;
    return isForeign([img.data[i], img.data[i + 1], img.data[i + 2]]);
  };
  const reach = (step) => {
    let k = 0;
    for (; k < maxPad; k++) {
      const { line } = step(k + 1);
      if (!line) continue;
      const [x0, y0, x12, y12] = line;
      let bad = 0;
      for (let y = y0; y <= y12; y++) for (let x = x0; x <= x12; x++) if (at(x, y)) bad++;
      if (bad > 1) break;
    }
    return k;
  };
  const x1 = tb.x + tb.w - 1;
  const y1 = tb.y + tb.h - 1;
  const l = reach((k) => ({ line: tb.x - k >= 0 ? [tb.x - k, tb.y, tb.x - k, y1] : null }));
  const r = reach((k) => ({ line: x1 + k < img.width ? [x1 + k, tb.y, x1 + k, y1] : null }));
  const t = reach((k) => ({ line: tb.y - k >= 0 ? [tb.x, tb.y - k, x1, tb.y - k] : null }));
  const b = reach((k) => ({ line: y1 + k < img.height ? [tb.x, y1 + k, x1, y1 + k] : null }));
  const artColumn = (x) => {
    let bad = 0;
    for (let y = tb.y; y <= y1; y++) if (at(x, y)) bad++;
    return bad > tb.h * 0.3;
  };
  const limit = Math.floor(tb.w * 0.15);
  let cl = 0;
  let cr = 0;
  if (!l) while (cl < limit && artColumn(tb.x + cl)) cl++;
  if (!r) while (cr < limit && artColumn(x1 - cr)) cr++;
  return { x: tb.x - l + cl, y: tb.y - t, w: tb.w + l + r - cl - cr, h: tb.h + t + b };
}
function interiorRange(b) {
  return (y0, y1) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = y0; y <= y1; y += Math.max(1, b.step)) {
      const s = b.spans[Math.round((y - b.area.y) / b.step)];
      if (!s || s[1] < s[0]) continue;
      lo = Math.min(lo, s[0]);
      hi = Math.max(hi, s[1]);
    }
    return lo <= hi ? [lo, hi] : void 0;
  };
}
function withFullLines(img, r, bg, text, stroke, within) {
  const tb = r.textBox;
  if (tb.h < 4 || tb.w < 4) return r;
  const px = (x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const isInk = (c) => colorDistance(c, text) < 70 || !!stroke && colorDistance(c, stroke) < 70;
  const isForeign = foreignTester(bg, text, stroke);
  const inkAt = (x, y) => x >= 0 && x < img.width && y >= 0 && y < img.height && isInk(px(x, y));
  const foreignAt = (x, y) => x >= 0 && x < img.width && y >= 0 && y < img.height && isForeign(px(x, y));
  const bands = [];
  const yEnd = Math.min(img.height - 1, tb.y + tb.h - 1);
  let open = -1;
  let blank = 0;
  for (let y = tb.y; y <= yEnd + 1; y++) {
    let has = false;
    if (y <= yEnd) for (let x = tb.x; x < tb.x + tb.w && !has; x++) has = inkAt(x, y);
    if (has) {
      if (open < 0) open = y;
      blank = 0;
    } else if (open >= 0 && (++blank > 2 || y > yEnd)) {
      bands.push([open, y - blank]);
      open = -1;
      blank = 0;
    }
  }
  if (!bands.length) return r;
  let left = tb.x;
  let right = tb.x + tb.w - 1;
  for (const [y0, y1] of bands) {
    const band = y1 - y0 + 1;
    if (band < 3) continue;
    const maxGap = Math.max(6, Math.round(band * 0.9));
    const range = within?.(y0, y1);
    const slack = band * 2;
    const wx0 = Math.max(range ? range[0] - slack : 0, tb.x - band * 8, 0);
    const wx1 = Math.min(range ? range[1] + slack : img.width - 1, tb.x + tb.w - 1 + band * 8, img.width - 1);
    const wy0 = Math.max(0, y0 - band);
    const wy1 = Math.min(img.height - 1, y1 + band);
    const W = wx1 - wx0 + 1;
    const H = wy1 - wy0 + 1;
    if (W < 2 || H < 2) continue;
    const raw = new Uint8Array(W * H);
    for (let y = wy0; y <= wy1; y++) for (let x = wx0; x <= wx1; x++) if (inkAt(x, y)) raw[(y - wy0) * W + (x - wx0)] = 1;
    const mask = dilate(raw, W, H, 1);
    const artCol = new Uint8Array(W);
    for (let x = wx0; x <= wx1; x++) {
      let foreign = 0;
      for (let y = y0; y <= y1; y++) if (foreignAt(x, y)) foreign++;
      if (foreign > band * 0.25) artCol[x - wx0] = 1;
    }
    const label = new Int32Array(W * H).fill(-1);
    const shapes = [];
    for (let i = 0; i < W * H; i++) {
      if (!mask[i] || label[i] >= 0) continue;
      const id = shapes.length;
      const sh = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, inBand: [] };
      const stack = [i];
      label[i] = id;
      while (stack.length) {
        const j = stack.pop();
        const x = j % W + wx0;
        const y = Math.floor(j / W) + wy0;
        if (raw[j]) {
          sh.x0 = Math.min(sh.x0, x);
          sh.x1 = Math.max(sh.x1, x);
          sh.y0 = Math.min(sh.y0, y);
          sh.y1 = Math.max(sh.y1, y);
          if (y >= y0 && y <= y1) sh.inBand.push(x);
        }
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x - wx0 + dx;
            const ny = y - wy0 + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const k = ny * W + nx;
            if (mask[k] && label[k] < 0) {
              label[k] = id;
              stack.push(k);
            }
          }
        }
      }
      shapes.push(sh);
    }
    const margin = band * 0.35;
    const kind = (sh) => {
      const h = sh.y1 - sh.y0 + 1;
      const w = sh.x1 - sh.x0 + 1;
      const inLine = sh.y0 >= y0 - margin && sh.y1 <= y1 + margin && h <= band * 1.5 && w <= band * 8 && sh.y0 > wy0 && sh.y1 < wy1;
      if (!inLine) return "stop";
      let ring = 0;
      let bad = 0;
      for (let y = sh.y0 - 2; y <= sh.y1 + 2; y++) {
        for (let x = sh.x0 - 2; x <= sh.x1 + 2; x++) {
          if (inkAt(x, y)) continue;
          ring++;
          if (foreignAt(x, y)) bad++;
        }
      }
      if (ring && bad > ring * 0.15) return "stop";
      return h >= band * 0.4 || w >= band * 0.3 && h <= band * 0.35 ? "letter" : "speck";
    };
    const grow = (dir) => {
      let edge = dir < 0 ? left : right;
      const beyond = shapes.map((sh) => {
        const xs = sh.inBand.filter((x) => dir < 0 ? x < edge : x > edge);
        return xs.length ? { sh, near: dir < 0 ? Math.max(...xs) : Math.min(...xs), kind: kind(sh) } : null;
      }).filter((c) => !!c).sort((a, b) => dir < 0 ? b.near - a.near : a.near - b.near);
      const crossesArt = (a, b) => {
        for (let x = Math.min(a, b); x <= Math.max(a, b); x++) if (artCol[x - wx0] === 1) return true;
        return false;
      };
      let stopAt = Infinity;
      for (const c of beyond) {
        if (dir < 0 ? c.near >= edge : c.near <= edge) continue;
        if (Math.abs(edge - c.near) > maxGap) break;
        if (crossesArt(edge, c.near) || c.kind === "stop") {
          stopAt = Math.abs(edge - c.near);
          break;
        }
        if (c.kind === "letter") edge = dir < 0 ? Math.min(edge, c.sh.x0) : Math.max(edge, c.sh.x1);
      }
      for (const c of beyond) {
        if (c.kind !== "speck" || (dir < 0 ? c.near >= edge : c.near <= edge)) continue;
        const gap = Math.abs(edge - c.near);
        if (gap > band * 0.4 || gap >= stopAt || crossesArt(edge, c.near)) continue;
        if (c.sh.y0 < y0 - margin || c.sh.y1 > y1 + margin) continue;
        edge = dir < 0 ? Math.min(edge, c.sh.x0) : Math.max(edge, c.sh.x1);
      }
      return edge;
    };
    left = Math.min(left, grow(-1));
    right = Math.max(right, grow(1));
  }
  if (left === tb.x && right === tb.x + tb.w - 1) return r;
  const textBox = { x: left, y: tb.y, w: right - left + 1, h: tb.h };
  const widest = Math.max(...r.lineWidths);
  return { ...r, textBox, lineWidths: r.lineWidths.map((w) => w === widest ? Math.max(w, textBox.w) : w) };
}
function searchAround(img, proposed, opts) {
  const unit = Math.max(proposed.h, 16);
  const shifts = [[0, -1], [0, 1], [0, -1.8], [0, 1.8], [-0.4, 0], [0.4, 0]];
  for (const [dx, dy] of shifts) {
    const p = { x: Math.round(proposed.x + dx * proposed.w), y: Math.round(proposed.y + dy * unit), w: proposed.w, h: proposed.h };
    const pad = Math.max(12, Math.round(Math.max(p.w, p.h) * 0.3));
    const win = clampRect({ x: p.x - pad, y: p.y - pad, w: p.w + pad * 2, h: p.h + pad * 2 }, img.width, img.height);
    if (win.w < 4 || win.h < 4) continue;
    const f = findGlyphs(img, win, p);
    if (!f || f.ink <= 10) continue;
    const box = { x: f.box.x0 + f.win.x, y: f.box.y0 + f.win.y, w: f.box.x1 - f.box.x0 + 1, h: f.box.y1 - f.box.y0 + 1 };
    const theirs = (opts.others ?? []).some((o) => {
      const ix = Math.max(0, Math.min(o.x + o.w, box.x + box.w) - Math.max(o.x, box.x));
      const iy = Math.max(0, Math.min(o.y + o.h, box.y + box.h) - Math.max(o.y, box.y));
      return ix * iy > box.w * box.h * 0.3;
    });
    if (theirs) continue;
    if (box.h > proposed.h * 2.5 + 10 || box.w > proposed.w * 2 + 20) continue;
    return f;
  }
  return null;
}
function labelBackground(img, win, bg) {
  const ww = win.w;
  const wh = win.h;
  const { data, width } = img;
  const isBg = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = ((y + win.y) * width + (x + win.x)) * 4;
      if (pixelDistance(data, i, bg) < 40) isBg[y * ww + x] = 1;
    }
  }
  const labels = new Int32Array(ww * wh);
  let next = 1;
  const stack = [];
  for (let p0 = 0; p0 < ww * wh; p0++) {
    if (!isBg[p0] || labels[p0]) continue;
    labels[p0] = next;
    stack.push(p0);
    while (stack.length) {
      const p = stack.pop();
      const x = p % ww;
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? x > 0 ? p - 1 : -1 : k === 1 ? x < ww - 1 ? p + 1 : -1 : k === 2 ? p - ww : p + ww;
        if (q < 0 || q >= ww * wh || !isBg[q] || labels[q]) continue;
        labels[q] = next;
        stack.push(q);
      }
    }
    next++;
  }
  return labels;
}
function regionOf(labels, w, h, c) {
  const counts = /* @__PURE__ */ new Map();
  const m = 2;
  for (let y = Math.max(0, c.y0 - m); y <= Math.min(h - 1, c.y1 + m); y++) {
    for (let x = Math.max(0, c.x0 - m); x <= Math.min(w - 1, c.x1 + m); x++) {
      if (x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1) continue;
      const l = labels[y * w + x];
      if (l) counts.set(l, (counts.get(l) || 0) + 1);
    }
  }
  let best = 0;
  let bestN = 0;
  for (const [l, n] of counts) {
    if (n > bestN) {
      best = l;
      bestN = n;
    }
  }
  return best;
}
function findGlyphs(img, win, proposed, debug) {
  const m0 = Math.max(6, Math.round(Math.min(proposed.h, proposed.w) * 0.4));
  const around = clampRect({ x: proposed.x - m0, y: proposed.y - m0, w: proposed.w + m0 * 2, h: proposed.h + m0 * 2 }, img.width, img.height);
  const bg = dominantColor(img, around);
  const found = glyphsOn(img, win, proposed, bg, debug);
  if (!found || found.regionSize < proposed.w * proposed.h * 0.05) {
    const { data, width } = img;
    const bgLuma = luma(bg[0], bg[1], bg[2]);
    const skip = new Uint8Array(around.w * around.h);
    let other = 0;
    for (let y = 0; y < around.h; y++) {
      for (let x = 0; x < around.w; x++) {
        const i = ((y + around.y) * width + (x + around.x)) * 4;
        if (pixelDistance(data, i, bg) <= 70 && Math.abs(luma(data[i], data[i + 1], data[i + 2]) - bgLuma) <= 60) skip[y * around.w + x] = 1;
        else other++;
      }
    }
    if (other > around.w * around.h * 0.15) {
      const alt = glyphsOn(img, win, proposed, dominantColor(img, around, skip), debug);
      if (alt && (!found || alt.ink > found.ink * 2)) return alt;
    }
  }
  return found;
}
function glyphsOn(img, win, proposed, bg, debug) {
  const { data, width } = img;
  const ww = win.w;
  const wh = win.h;
  const mask = new Uint8Array(ww * wh);
  const bgLuma = luma(bg[0], bg[1], bg[2]);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const i = ((y + win.y) * width + (x + win.x)) * 4;
      if (pixelDistance(data, i, bg) > 70 || Math.abs(luma(data[i], data[i + 1], data[i + 2]) - bgLuma) > 60) mask[y * ww + x] = 1;
    }
  }
  const comps = components(mask, ww, wh);
  const big = Math.max(proposed.w, proposed.h);
  const letterLike = comps.filter((c) => {
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    if (c.count < 3) return false;
    if (cw > big * 0.9 && ch > proposed.h * 0.6) return false;
    if (cw / ch > 9 && cw > 30) return false;
    if (ch / cw > 9 && ch > 40) return false;
    if (c.touchesEdge && (cw > ww * 0.4 || ch > wh * 0.4)) return false;
    const fill = c.count / (cw * ch);
    if (cw * ch > 400 && fill > 0.85) return false;
    return true;
  });
  if (!letterLike.length) return null;
  const px0 = proposed.x - win.x - proposed.w * 0.06;
  const py0 = proposed.y - win.y - proposed.h * 0.06;
  const px1 = proposed.x - win.x + proposed.w * 1.06;
  const py1 = proposed.y - win.y + proposed.h * 1.06;
  let seeds = letterLike.filter((c) => {
    const cx = (c.x0 + c.x1) / 2;
    const cy = (c.y0 + c.y1) / 2;
    return cx >= px0 && cx <= px1 && cy >= py0 && cy <= py1;
  });
  if (!seeds.length) return null;
  const labels = labelBackground(img, win, bg);
  const region = /* @__PURE__ */ new Map();
  for (const c of letterLike) region.set(c, regionOf(labels, ww, wh, c));
  const weight = /* @__PURE__ */ new Map();
  for (const c of seeds) {
    const r = region.get(c) || 0;
    if (r) weight.set(r, (weight.get(r) || 0) + c.count);
  }
  let textRegion = 0;
  let textWeight = 0;
  for (const [r, wgt] of weight) {
    if (wgt > textWeight) {
      textRegion = r;
      textWeight = wgt;
    }
  }
  if (textRegion) seeds = seeds.filter((c) => region.get(c) === textRegion);
  if (!seeds.length) return null;
  let regionSize = Infinity;
  if (textRegion) {
    regionSize = 0;
    for (let p = 0; p < labels.length; p++) if (labels[p] === textRegion) regionSize++;
  }
  const heights = seeds.map((c) => c.y1 - c.y0 + 1);
  const tallest = Math.max(...heights);
  const typical = median(heights.filter((h) => h >= tallest * 0.35)) || tallest;
  seeds = seeds.filter((c) => c.y1 - c.y0 + 1 <= typical * 2.4);
  if (!seeds.length) return null;
  const isLetter = (c) => {
    const h = c.y1 - c.y0 + 1;
    return h >= typical * 0.55 && h <= typical * 1.7;
  };
  const letters = seeds.filter(isLetter);
  if (letters.length >= 3) {
    const lined = letters.filter(
      (c) => letters.some((o) => {
        if (o === c) return false;
        const vOverlap = Math.min(c.y1, o.y1) - Math.max(c.y0, o.y0) + 1;
        const dx = Math.max(0, o.x0 - c.x1, c.x0 - o.x1);
        return vOverlap >= Math.min(c.y1 - c.y0, o.y1 - o.y0) * 0.6 && dx <= typical * 1.2;
      })
    );
    if (lined.length >= 2) {
      const lb = {
        x0: Math.min(...lined.map((c) => c.x0)) - typical * 0.4,
        y0: Math.min(...lined.map((c) => c.y0)) - typical * 0.4,
        x1: Math.max(...lined.map((c) => c.x1)) + typical * 0.4,
        y1: Math.max(...lined.map((c) => c.y1)) + typical * 0.4
      };
      const kept = new Set(lined);
      const onLine = (c) => {
        if (c.y1 - c.y0 + 1 > typical * 0.5 || c.x1 - c.x0 + 1 > typical * 0.7) return false;
        const cy = (c.y0 + c.y1) / 2;
        return lined.some((l) => cy >= l.y0 && cy <= l.y1 && Math.max(0, l.x0 - c.x1, c.x0 - l.x1) <= typical * 1.6);
      };
      seeds = seeds.filter(
        (c) => kept.has(c) || !isLetter(c) && (c.x0 >= lb.x0 && c.x1 <= lb.x1 && c.y0 >= lb.y0 && c.y1 <= lb.y1 || onLine(c))
      );
      let grown = true;
      while (grown) {
        grown = false;
        for (const c of letterLike) {
          if (seeds.includes(c) || isLetter(c) || c.y1 - c.y0 + 1 > typical * 0.5) continue;
          const near = seeds.some((o) => !isLetter(o) && Math.max(0, o.x0 - c.x1, c.x0 - o.x1) <= typical * 0.6 && Math.abs((o.y0 + o.y1) / 2 - (c.y0 + c.y1) / 2) < typical * 0.3);
          if (near) {
            seeds.push(c);
            grown = true;
          }
        }
      }
    }
  }
  const inSet = new Set(seeds);
  const box = { x0: ww, y0: wh, x1: 0, y1: 0 };
  const add = (c) => {
    box.x0 = Math.min(box.x0, c.x0);
    box.y0 = Math.min(box.y0, c.y0);
    box.x1 = Math.max(box.x1, c.x1);
    box.y1 = Math.max(box.y1, c.y1);
  };
  seeds.forEach(add);
  const limit = {
    x0: proposed.x - win.x - proposed.w * 0.3 - typical,
    y0: proposed.y - win.y - proposed.h * 0.3 - typical,
    x1: proposed.x - win.x + proposed.w * 1.3 + typical,
    y1: proposed.y - win.y + proposed.h * 1.3 + typical
  };
  const letterSized = (c) => {
    const ch = c.y1 - c.y0 + 1;
    const cw = c.x1 - c.x0 + 1;
    const fill = c.count / (cw * ch);
    if (ch / cw > 2.5 && fill < 0.5) return false;
    if (ch / cw > 5) return false;
    return ch >= typical * 0.6 && ch <= typical * 1.35 && c.x0 >= limit.x0 && c.y0 >= limit.y0 && c.x1 <= limit.x1 && c.y1 <= limit.y1 && (!textRegion || region.get(c) === textRegion);
  };
  const pool = letterLike.filter((c) => !inSet.has(c) && letterSized(c));
  const gapX = typical * 0.9;
  const gapY = typical * 0.6;
  const growSideways = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of pool) {
        if (inSet.has(c)) continue;
        const cy = (c.y0 + c.y1) / 2;
        if (!isolatedOnBackground(mask, ww, wh, c)) continue;
        const chh = c.y1 - c.y0 + 1;
        for (const m of inSet) {
          const mh = m.y1 - m.y0 + 1;
          if (mh < typical * 0.55) continue;
          if (cy < m.y0 - mh * 0.2 || cy > m.y1 + mh * 0.2) continue;
          const vOverlap = Math.min(c.y1, m.y1) - Math.max(c.y0, m.y0) + 1;
          if (vOverlap < Math.max(chh, mh) * 0.6) continue;
          const dx = Math.max(0, m.x0 - c.x1, c.x0 - m.x1);
          if (dx <= gapX) {
            inSet.add(c);
            add(c);
            changed = true;
            break;
          }
        }
      }
    }
  };
  const addLine = () => {
    const near = pool.filter((c) => {
      if (inSet.has(c)) return false;
      const dy = Math.max(0, box.y0 - c.y1, c.y0 - box.y1);
      return dy > 0 && dy <= gapY;
    });
    if (near.length < 2) return false;
    near.sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
    const groups = [];
    for (const c of near) {
      const g = groups[groups.length - 1];
      const cy = (c.y0 + c.y1) / 2;
      if (g && Math.abs(cy - (g[0].y0 + g[0].y1) / 2) < typical * 0.5) g.push(c);
      else groups.push([c]);
    }
    for (const g0 of groups) {
      const g = g0.filter((c) => {
        const cw = c.x1 - c.x0 + 1;
        const ch = c.y1 - c.y0 + 1;
        const fill = c.count / (cw * ch);
        return fill > 0.12 && fill < 0.85 && ch / cw < 5 && cw / ch < 3.2 && ch >= typical * 0.7 && ch <= typical * 1.3;
      });
      const gw = g.length ? Math.max(...g.map((c) => c.x1)) - Math.min(...g.map((c) => c.x0)) : 0;
      if (g.length < 2 || gw < typical * 1.2) continue;
      const hs = g.map((c) => c.y1 - c.y0 + 1);
      const mean = hs.reduce((a, b) => a + b, 0) / hs.length;
      const sd = Math.sqrt(hs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / hs.length);
      if (sd / mean > 0.2) continue;
      if (g.filter((c) => isolatedOnBackground(mask, ww, wh, c, 0.3)).length < g.length * 0.6) continue;
      g.sort((a, b) => a.x0 - b.x0);
      let spaced = true;
      for (let i = 1; i < g.length; i++) if (g[i].x0 - g[i - 1].x1 > gapX) spaced = false;
      const gx0 = g[0].x0;
      const gx1 = Math.max(...g.map((c) => c.x1));
      const overlap = Math.min(gx1, box.x1) - Math.max(gx0, box.x0);
      const gcx = (gx0 + gx1) / 2;
      const centred = gcx > box.x0 + (box.x1 - box.x0) * 0.15 && gcx < box.x1 - (box.x1 - box.x0) * 0.15;
      if (!spaced || overlap < Math.min(gx1 - gx0, box.x1 - box.x0) * 0.6 || !centred) continue;
      g.forEach((c) => {
        inSet.add(c);
        add(c);
      });
      return true;
    }
    return false;
  };
  growSideways();
  for (let i = 0; i < 8 && addLine(); i++) growSideways();
  const dots = letterLike.filter((c) => {
    if (inSet.has(c)) return false;
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    if (ch > typical * 0.45 || cw > typical * 0.6 || cw / ch > 2.5 || ch / cw > 2.5) return false;
    if (textRegion && region.get(c) !== textRegion) return false;
    const dy = Math.max(0, box.y0 - c.y1, c.y0 - box.y1);
    return dy > 0 && dy <= typical * 1.4 && c.x0 >= box.x0 && c.x1 <= box.x1;
  });
  if (dots.length >= 2 && dots.length <= 4) {
    const cys = dots.map((d) => (d.y0 + d.y1) / 2);
    if (Math.max(...cys) - Math.min(...cys) < typical * 0.3) dots.forEach((d) => {
      inSet.add(d);
      add(d);
    });
  }
  const hug = typical * 0.35;
  for (const c of letterLike) {
    if (inSet.has(c)) continue;
    if (c.y1 - c.y0 + 1 > typical * 1.7) continue;
    if (textRegion && region.get(c) !== textRegion) continue;
    if (c.x0 >= box.x0 - hug && c.x1 <= box.x1 + hug && c.y0 >= box.y0 - hug && c.y1 <= box.y1 + hug) {
      inSet.add(c);
      add(c);
    }
  }
  if (debug) {
    const toRect = (c) => ({ x: c.x0 + win.x, y: c.y0 + win.y, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1 });
    debug.seeds = seeds.map(toRect);
    debug.glyphs = [...inSet].filter((c) => !seeds.includes(c)).map(toRect);
  }
  const glyphMask = new Uint8Array(ww * wh);
  let ink = 0;
  for (const g of inSet) {
    ink += g.count;
    for (let y = g.y0; y <= g.y1; y++) for (let x = g.x0; x <= g.x1; x++) glyphMask[y * ww + x] = mask[y * ww + x];
  }
  const touchesWindow = box.x0 <= 1 && win.x > 0 || box.y0 <= 1 && win.y > 0 || box.x1 >= ww - 2 && win.x + ww < img.width || box.y1 >= wh - 2 && win.y + wh < img.height;
  return { win, bg, glyphMask, box, ink, touchesWindow, regionSize };
}
function isolatedOnBackground(mask, w, h, c, maxInk = 0.2) {
  const m = 2;
  let ink = 0;
  let total = 0;
  const x0 = Math.max(0, c.x0 - m);
  const y0 = Math.max(0, c.y0 - m);
  const x1 = Math.min(w - 1, c.x1 + m);
  const y1 = Math.min(h - 1, c.y1 + m);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const inside = x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1;
      if (inside) continue;
      total++;
      ink += mask[y * w + x];
    }
  }
  return total === 0 || ink / total < maxInk;
}
function inkColor(img, win, mask, bg) {
  const samples = [];
  const { data, width } = img;
  for (let y = 0; y < win.h; y++) {
    for (let x = 0; x < win.w; x++) {
      if (!mask[y * win.w + x]) continue;
      const i = ((y + win.y) * width + (x + win.x)) * 4;
      const c = [data[i], data[i + 1], data[i + 2]];
      samples.push({ d: colorDistance(c, bg), c });
    }
  }
  if (!samples.length) return luma(bg[0], bg[1], bg[2]) > 128 ? [0, 0, 0] : [255, 255, 255];
  samples.sort((a, b2) => b2.d - a.d);
  const top = samples.slice(0, Math.max(1, Math.floor(samples.length * 0.5)));
  const r = median(top.map((s) => s.c[0]));
  const g = median(top.map((s) => s.c[1]));
  const b = median(top.map((s) => s.c[2]));
  return [r, g, b];
}
function strokeColorOf(img, win, mask, bg, fill) {
  const { data, width } = img;
  let total = 0;
  const rim = [];
  for (let y = 0; y < win.h; y++) {
    for (let x = 0; x < win.w; x++) {
      if (!mask[y * win.w + x]) continue;
      total++;
      const i = ((y + win.y) * width + (x + win.x)) * 4;
      const c2 = [data[i], data[i + 1], data[i + 2]];
      if (colorDistance(c2, fill) > 70 && colorDistance(c2, bg) > 70) rim.push(c2);
    }
  }
  if (total < 50 || rim.length / total < 0.22) return null;
  const r = median(rim.map((c2) => c2[0]));
  const g = median(rim.map((c2) => c2[1]));
  const b = median(rim.map((c2) => c2[2]));
  const c = [r, g, b];
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  if (sat < 50 && Math.abs(luma(r, g, b) - (luma(...fill) + luma(...bg)) / 2) < 50) return null;
  return c;
}
function strokeWeights(img, win, mask, fill, other) {
  const { data, width } = img;
  const w = win.w;
  const h = win.h;
  const core = new Uint8Array(w * h);
  let rimArea = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      const i = ((y + win.y) * width + (x + win.x)) * 4;
      const c = [data[i], data[i + 1], data[i + 2]];
      if (colorDistance(c, fill) <= colorDistance(c, other)) core[p] = 1;
      else rimArea++;
    }
  }
  let area = 0;
  let perimeter = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!core[p]) continue;
      area++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !core[p - 1] || !core[p + 1] || !core[p - w] || !core[p + w]) perimeter++;
    }
  }
  if (!perimeter) return { core: 1, rim: 1 };
  return { core: 2 * area / perimeter, rim: rimArea / perimeter };
}
function backgroundFlatness(img, ring, text, bg) {
  let near = 0;
  let total = 0;
  const { data, width } = img;
  for (let y = ring.y; y < ring.y + ring.h; y++) {
    for (let x = ring.x; x < ring.x + ring.w; x++) {
      if (x >= text.x && x < text.x + text.w && y >= text.y && y < text.y + text.h) continue;
      const i = (y * width + x) * 4;
      total++;
      if (pixelDistance(data, i, bg) < 28) near++;
    }
  }
  return total ? near / total : 0;
}
function toneHistograms() {
  return [new Uint16Array(256), new Uint16Array(256), new Uint16Array(256)];
}
function rowTone(img, hist, x0, x1, y, counts) {
  for (const h of hist) h.fill(0);
  let n = 0;
  for (let x = x0; x <= x1; x++) {
    if (!counts(x)) continue;
    const i = (y * img.width + x) * 4;
    hist[0][img.data[i]]++;
    hist[1][img.data[i + 1]]++;
    hist[2][img.data[i + 2]]++;
    n++;
  }
  const rgb = hist.map((h) => {
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += h[v];
      if (seen * 2 >= n) return v;
    }
    return 255;
  });
  return { rgb, n };
}
function floodInterior(img, text, bg, opts = {}) {
  const reject = (reason) => {
    opts.onReject?.(reason);
    return null;
  };
  const lineH = opts.lineHeight ?? Math.min(text.h, 40);
  const limitPad = Math.round(Math.max(text.w, text.h) * 0.6 + lineH * 4 + 16);
  const lim = clampRect(
    { x: text.x - limitPad, y: text.y - limitPad, w: text.w + limitPad * 2, h: text.h + limitPad * 2 },
    img.width,
    img.height
  );
  const lw = lim.w;
  const lh = lim.h;
  const visited = new Uint8Array(lw * lh);
  const { data, width } = img;
  const tol = 24;
  const near = new Uint8Array(lw * lh);
  const isNear = (p) => {
    let v = near[p];
    if (!v) {
      const x = p % lw;
      const i = (((p - x) / lw + lim.y) * width + (x + lim.x)) * 4;
      v = near[p] = pixelDistance(data, i, bg) < tol ? 1 : 2;
    }
    return v === 1;
  };
  const glyph = (x, y) => opts.glyphAt ? opts.glyphAt(x + lim.x, y + lim.y) : false;
  const passable = (x, y) => {
    const p = y * lw + x;
    if (isNear(p) && (x === 0 || isNear(p - 1)) && (x === lw - 1 || isNear(p + 1)) && (y === 0 || isNear(p - lw)) && (y === lh - 1 || isNear(p + lw))) {
      return true;
    }
    return glyph(x, y);
  };
  const stack = [];
  const sx = Math.max(1, Math.floor(text.w / 40));
  const sy = Math.max(1, Math.floor(text.h / 40));
  for (let y = text.y + 1; y < text.y + text.h - 1; y += sy) {
    for (let x = text.x + 1; x < text.x + text.w - 1; x += sx) {
      const lx = x - lim.x;
      const ly = y - lim.y;
      if (lx > 0 && ly > 0 && lx < lw - 1 && ly < lh - 1 && passable(lx, ly) && !glyph(lx, ly)) stack.push(ly * lw + lx);
    }
  }
  if (!stack.length) return reject("no seed");
  let leaked = false;
  let filled = 0;
  let fx0 = lw;
  let fx1 = -1;
  let fy0 = lh;
  let fy1 = -1;
  while (stack.length) {
    const p = stack.pop();
    if (visited[p]) continue;
    const x = p % lw;
    const y = (p - x) / lw;
    if (!passable(x, y)) continue;
    visited[p] = 1;
    filled++;
    if (x < fx0) fx0 = x;
    if (x > fx1) fx1 = x;
    if (y < fy0) fy0 = y;
    if (y > fy1) fy1 = y;
    if (opts.onVisit) opts.onVisit(x + lim.x, y + lim.y);
    const atLimit = x === 0 || y === 0 || x === lw - 1 || y === lh - 1;
    const atImageEdge = x + lim.x === 0 || y + lim.y === 0 || x + lim.x === img.width - 1 || y + lim.y === img.height - 1;
    if (atLimit && !atImageEdge) {
      leaked = true;
      if (!opts.onVisit) break;
    }
    if (x > 0) stack.push(p - 1);
    if (x < lw - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - lw);
    if (y < lh - 1) stack.push(p + lw);
  }
  if (leaked) return reject("leak");
  if (filled < text.w * text.h * 0.25) return reject("small fill");
  const inText = (x, y) => x + lim.x >= text.x && x + lim.x < text.x + text.w && y + lim.y >= text.y && y + lim.y < text.y + text.h;
  const outside = outsideOf(visited, lw, lh, fx0, fy0, fx1, fy1);
  const interior = (x, y) => visited[y * lw + x] === 1 || outside[y * lw + x] === 0 || inText(x, y);
  const ccx = Math.round(text.x + text.w / 2 - lim.x);
  const ccy = Math.round(text.y + text.h / 2 - lim.y);
  const tx0 = text.x - lim.x;
  const tx1 = text.x + text.w - 1 - lim.x;
  const runAt = (y) => {
    let cx = -1;
    if (interior(ccx, y)) cx = ccx;
    else {
      for (let d = 1; d <= (tx1 - tx0) / 2 + 1 && cx < 0; d++) {
        if (ccx - d >= 0 && interior(ccx - d, y)) cx = ccx - d;
        else if (ccx + d < lw && interior(ccx + d, y)) cx = ccx + d;
      }
    }
    if (cx < 0) return null;
    let l = cx;
    let r = cx;
    while (l > 0 && interior(l - 1, y)) l--;
    while (r < lw - 1 && interior(r + 1, y)) r++;
    return [l, r];
  };
  const hist = toneHistograms();
  const toneOf = (run, y) => rowTone(img, hist, run[0] + lim.x, run[1] + lim.x, y + lim.y, (x) => {
    const p = y * lw + x - lim.x;
    return visited[p] === 1 && near[p] === 1 && !glyph(x - lim.x, y);
  });
  const textTop = text.y - lim.y;
  const textBottom = text.y + text.h - 1 - lim.y;
  const step = 2;
  const rows = /* @__PURE__ */ new Map();
  const tones = /* @__PURE__ */ new Map();
  const walk = (dir) => {
    const recent = [];
    let tone = null;
    for (let y = ccy; y >= 0 && y < lh; y += dir * step) {
      const run = runAt(y);
      if (!run) break;
      const last = recent[recent.length - 1];
      if (last) {
        const refL = Math.min(...recent.map((r) => r[0]));
        const refR = Math.max(...recent.map((r) => r[1]));
        const slack = Math.max(6, (refR - refL + 1) * 0.15);
        if (refL - run[0] > slack || run[1] - refR > slack) break;
        if (run[1] < last[0] || run[0] > last[1]) break;
      }
      const t = toneOf(run, y);
      if (t.n >= 12) {
        const beyond = y < textTop || y > textBottom;
        if (tone && last && beyond && colorDistance(t.rgb, tone) > 6 && run[1] - run[0] < (last[1] - last[0]) * 0.6) break;
        tone = t.rgb;
      }
      rows.set(y, run);
      tones.set(y, t.n >= 12 ? t.rgb : null);
      recent.push(run);
      if (recent.length > 6) recent.shift();
    }
  };
  walk(-1);
  walk(1);
  if (rows.size < 3) return reject("few rows");
  let ys = [...rows.keys()].sort((a, b) => a - b);
  const covered = Math.min(ys[ys.length - 1], textBottom) - Math.max(ys[0], textTop);
  if (covered < (textBottom - textTop) * 0.6) return reject("text not covered");
  const extend = (from, to, dir) => {
    const last = rows.get(from);
    for (let y = from + dir * step; dir === 1 ? y <= to : y >= to; y += dir * step) {
      const run = runAt(y);
      const l = run ? Math.max(run[0], last[0]) : Math.max(last[0], tx0);
      const r = run ? Math.min(run[1], last[1]) : Math.min(last[1], tx1);
      rows.set(y, [Math.min(l, tx0), Math.max(r, tx1)]);
    }
  };
  const margin = Math.round(lineH * 0.3);
  if (ys[ys.length - 1] < textBottom) extend(ys[ys.length - 1], Math.min(lh - 1, textBottom + margin), 1);
  if (ys[0] > textTop) extend(ys[0], Math.max(0, textTop - margin), -1);
  ys = [...rows.keys()].sort((a, b) => a - b);
  const y0 = ys[0];
  const y1 = ys[ys.length - 1];
  const spans = [];
  const rowTones = [];
  let ax0 = Infinity;
  let ax1 = -Infinity;
  let spanned = 0;
  let solid = 0;
  for (let y = y0; y <= y1; y += step) {
    const run = rows.get(y);
    rowTones.push(tones.get(y) ?? null);
    if (!run) {
      spans.push([0, -1]);
      continue;
    }
    const [left, right] = run;
    for (let x = left; x <= right; x++) {
      spanned++;
      if (interior(x, y)) solid++;
    }
    spans.push([left + lim.x - 1, right + lim.x + 1]);
    ax0 = Math.min(ax0, left + lim.x - 1);
    ax1 = Math.max(ax1, right + lim.x + 1);
  }
  const K = 3;
  const closed = spans.map(([l, r], i) => {
    if (r < l) return [l, r];
    const y = y0 + i * step;
    if (y < textTop - lineH || y > textBottom + lineH) return [l, r];
    const range = (a, b) => spans.slice(Math.max(0, a), Math.min(spans.length, b + 1)).filter(([x0, x1]) => x1 >= x0);
    const above = range(i - K, i);
    const below = range(i, i + K);
    if (!above.length || !below.length) return [l, r];
    const left = Math.max(Math.min(...above.map((s) => s[0])), Math.min(...below.map((s) => s[0])));
    const right = Math.min(Math.max(...above.map((s) => s[1])), Math.max(...below.map((s) => s[1])));
    return [Math.min(l, left), Math.max(r, right)];
  });
  spans.splice(0, spans.length, ...closed);
  if (ax0 > text.x + 2 || ax1 < text.x + text.w - 3 || y0 + lim.y > text.y + 2 || y1 + lim.y < text.y + text.h - 3) return reject("text outside");
  if (!spanned || solid / spanned < 0.93) return reject(`solidity ${spanned ? (solid / spanned).toFixed(3) : 0}`);
  if (spanned * step > text.w * text.h * 9 + 4e3) return reject(`too large ${spanned * step} > ${text.w * text.h * 9 + 4e3}`);
  return {
    area: { x: ax0, y: y0 + lim.y, w: ax1 - ax0 + 1, h: y1 - y0 + 1 },
    spans,
    step,
    tones: rowTones
  };
}
var CONVEXITY_MIN = 0.86;
function hullArea(runs, y0, y1) {
  const pts = [];
  for (let y = y0; y <= y1; y++) {
    const r = runs[y];
    if (!r) continue;
    pts.push([r[0], y], [r[1] + 1, y], [r[0], y + 1], [r[1] + 1, y + 1]);
  }
  if (pts.length < 3) return 1;
  pts.sort((a2, b) => a2[0] - b[0] || a2[1] - b[1]);
  const cross = (o, a2, b) => (a2[0] - o[0]) * (b[1] - o[1]) - (a2[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let k = pts.length - 1; k >= 0; k--) {
    const p = pts[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let a = 0;
  for (let k = 0; k < hull.length; k++) {
    const [x1, y12] = hull[k];
    const [x2, y2] = hull[(k + 1) % hull.length];
    a += x1 * y2 - x2 * y12;
  }
  return Math.max(1, Math.abs(a) / 2);
}
function outsideUniformity(img, runs, y0, y1, lim) {
  const { data, width, height } = img;
  const bins = /* @__PURE__ */ new Map();
  let total = 0;
  const sample = (x, y) => {
    const gx = x + lim.x;
    const gy = y + lim.y;
    if (gx < 0 || gy < 0 || gx >= width || gy >= height) return;
    const i = (gy * width + gx) * 4;
    const key = data[i] >> 4 << 8 | data[i + 1] >> 4 << 4 | data[i + 2] >> 4;
    bins.set(key, (bins.get(key) ?? 0) + 1);
    total++;
  };
  for (let y = y0; y <= y1; y++) {
    const r = runs[y];
    if (!r) continue;
    sample(r[0] - 3, y);
    sample(r[1] + 3, y);
  }
  for (const [y, dy] of [[y0, -3], [y1, 3]]) {
    const r = runs[y];
    if (!r) continue;
    for (let x = r[0]; x <= r[1]; x += 2) sample(x, y + dy);
  }
  if (!total) return 0;
  return Math.max(...bins.values()) / total;
}
function outsideOf(filled, w, h, x0, y0, x1, y1) {
  const outside = new Uint8Array(w * h).fill(1);
  if (x1 < x0 || y1 < y0) return outside;
  const bx0 = Math.max(0, x0 - 1);
  const by0 = Math.max(0, y0 - 1);
  const bx1 = Math.min(w - 1, x1 + 1);
  const by1 = Math.min(h - 1, y1 + 1);
  for (let y = by0; y <= by1; y++) outside.fill(0, y * w + bx0, y * w + bx1 + 1);
  const stack = [];
  for (let x = bx0; x <= bx1; x++) stack.push(by0 * w + x, by1 * w + x);
  for (let y = by0; y <= by1; y++) stack.push(y * w + bx0, y * w + bx1);
  while (stack.length) {
    const p = stack.pop();
    if (outside[p] || filled[p]) continue;
    outside[p] = 1;
    const x = p % w;
    const y = (p - x) / w;
    if (x > bx0) stack.push(p - 1);
    if (x < bx1) stack.push(p + 1);
    if (y > by0) stack.push(p - w);
    if (y < by1) stack.push(p + w);
  }
  return outside;
}
function dilate(mask, w, h, r) {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < w) tmp[y * w + nx] = 1;
      }
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!tmp[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny >= 0 && ny < h) out[ny * w + x] = 1;
      }
    }
  }
  return out;
}
function rectDistance(x, y, r) {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w - 1));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h - 1));
  return Math.hypot(dx, dy);
}
function rivalsIn(text, others, inside) {
  return (others ?? []).filter((o) => {
    const cx = Math.round(o.x + o.w / 2);
    const cy = Math.round(o.y + o.h / 2);
    if (rectDistance(cx, cy, text) < 2) return false;
    return inside(cx, cy);
  });
}
function findBalloon(img, text, bg, opts = {}) {
  for (const scale of [1, 2.4]) {
    const found = clusterBalloon(img, text, bg, opts, scale);
    if (found !== "leak") return found;
  }
  opts.onReject?.("cluster: leak");
  return null;
}
function clusterBalloon(img, text, bg, opts, scale) {
  const reject = (reason) => {
    opts.onReject?.(`cluster: ${reason}`);
    return null;
  };
  const lineH = opts.lineHeight ?? Math.min(text.h, 40);
  const limitPad = Math.round((Math.max(text.w, text.h) * 1.4 + lineH * 6 + 40) * scale);
  const lim = clampRect({ x: text.x - limitPad, y: text.y - limitPad, w: text.w + limitPad * 2, h: text.h + limitPad * 2 }, img.width, img.height);
  const lw = lim.w;
  const lh = lim.h;
  const n = lw * lh;
  const { data, width } = img;
  const near = new Uint8Array(n);
  const isNear = (p) => {
    let v = near[p];
    if (!v) {
      const x = p % lw;
      const i = (((p - x) / lw + lim.y) * width + (x + lim.x)) * 4;
      v = near[p] = pixelDistance(data, i, bg) < 24 ? 1 : 2;
    }
    return v === 1;
  };
  const glyph = (x, y) => opts.glyphAt ? opts.glyphAt(x + lim.x, y + lim.y) : false;
  const passable = (x, y) => {
    const p = y * lw + x;
    if (isNear(p) && (x === 0 || isNear(p - 1)) && (x === lw - 1 || isNear(p + 1)) && (y === 0 || isNear(p - lw)) && (y === lh - 1 || isNear(p + lw))) return true;
    return glyph(x, y);
  };
  const visited = new Uint8Array(n);
  const stack = [];
  const sx = Math.max(1, Math.floor(text.w / 40));
  const sy = Math.max(1, Math.floor(text.h / 40));
  for (let y = text.y + 1; y < text.y + text.h - 1; y += sy) {
    for (let x = text.x + 1; x < text.x + text.w - 1; x += sx) {
      const lx = x - lim.x;
      const ly = y - lim.y;
      if (lx > 0 && ly > 0 && lx < lw - 1 && ly < lh - 1 && passable(lx, ly) && !glyph(lx, ly)) stack.push(ly * lw + lx);
    }
  }
  if (!stack.length) return reject("no seed");
  let filled = 0;
  let fx0 = lw;
  let fx1 = -1;
  let fy0 = lh;
  let fy1 = -1;
  while (stack.length) {
    const p = stack.pop();
    if (visited[p]) continue;
    const x = p % lw;
    const y = (p - x) / lw;
    if (!passable(x, y)) continue;
    visited[p] = 1;
    filled++;
    if (x < fx0) fx0 = x;
    if (x > fx1) fx1 = x;
    if (y < fy0) fy0 = y;
    if (y > fy1) fy1 = y;
    const atLimit = x === 0 || y === 0 || x === lw - 1 || y === lh - 1;
    const atImageEdge = x + lim.x === 0 || y + lim.y === 0 || x + lim.x === img.width - 1 || y + lim.y === img.height - 1;
    if (atLimit && !atImageEdge) return "leak";
    if (x > 0) stack.push(p - 1);
    if (x < lw - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - lw);
    if (y < lh - 1) stack.push(p + lw);
  }
  if (filled < text.w * text.h * 0.25) return reject("small fill");
  const outside = outsideOf(visited, lw, lh, fx0, fy0, fx1, fy1);
  const inR = (x, y) => {
    const lx = x - lim.x;
    const ly = y - lim.y;
    if (lx < 0 || ly < 0 || lx >= lw || ly >= lh) return false;
    const p = ly * lw + lx;
    return visited[p] === 1 || outside[p] === 0;
  };
  const rivals = rivalsIn(text, opts.others, inR);
  const own = (x, y) => {
    if (!rivals.length) return true;
    const d = rectDistance(x, y, text);
    return rivals.every((r) => d <= rectDistance(x, y, r));
  };
  const step = 2;
  let y0 = -1;
  let y1 = -1;
  const rowRuns = [];
  let cellCount = 0;
  for (let y = 0; y < lh; y++) {
    let l = -1;
    let r = -1;
    for (let x = y < fy0 || y > fy1 ? lw : fx0; x <= fx1 && x < lw; x++) {
      const p = y * lw + x;
      if ((visited[p] || !outside[p]) && own(x + lim.x, y + lim.y)) {
        cellCount++;
        if (l < 0) l = x;
        r = x;
      }
    }
    rowRuns.push(l >= 0 ? [l, r] : null);
    if (l >= 0) {
      if (y0 < 0) y0 = y;
      y1 = y;
    }
  }
  if (y0 < 0) return reject("empty cell");
  let spanned = 0;
  let ax0 = Infinity;
  let ax1 = -Infinity;
  const spans = [];
  for (let y = y0; y <= y1; y++) {
    const run = rowRuns[y];
    if (run) spanned += run[1] - run[0] + 1;
    if ((y - y0) % step) continue;
    if (!run) {
      spans.push([0, -1]);
      continue;
    }
    spans.push([run[0] + lim.x, run[1] + lim.x]);
    ax0 = Math.min(ax0, run[0] + lim.x);
    ax1 = Math.max(ax1, run[1] + lim.x);
  }
  if (cellCount / spanned < 0.9) return reject(`not solid ${(cellCount / spanned).toFixed(3)}`);
  const convexity = cellCount / hullArea(rowRuns, y0, y1);
  if (!rivals.length && convexity < CONVEXITY_MIN) {
    const ring = outsideUniformity(img, rowRuns, y0, y1, lim);
    if (convexity < 0.7 || ring < 0.6) return reject(`not convex ${convexity.toFixed(3)}, ring ${ring.toFixed(2)}`);
  }
  if (cellCount > text.w * text.h * 14 + 8e3) return reject(`too large ${cellCount}`);
  if (ax0 > text.x + 2 || ax1 < text.x + text.w - 3 || y0 + lim.y > text.y + 2 || y1 + lim.y < text.y + text.h - 3) return reject("text outside");
  const inText = (x, y) => x >= text.x && x < text.x + text.w && y >= text.y && y < text.y + text.h;
  const bgLuma = luma(...bg);
  const outline = (x, y) => {
    const i = ((y + lim.y) * width + (x + lim.x)) * 4;
    const l = luma(data[i], data[i + 1], data[i + 2]);
    return bgLuma >= 128 ? l < bgLuma - 50 : l > bgLuma + 50;
  };
  const piecesAt = (y) => {
    const out = [];
    let start2 = -1;
    for (let x = 0; x <= lw; x++) {
      const p = y * lw + x;
      const inside = x < lw && (visited[p] === 1 || outside[p] === 0 || inText(x + lim.x, y + lim.y)) && own(x + lim.x, y + lim.y);
      if (inside && start2 < 0) start2 = x;
      else if (!inside && start2 >= 0) {
        const last = out[out.length - 1];
        let bridge = !!last;
        for (let gx = last ? last[1] + 1 : 0; bridge && gx < start2; gx++) if (outline(gx, y) || !own(gx + lim.x, y + lim.y)) bridge = false;
        if (last && bridge) last[1] = x - 1;
        else out.push([start2, x - 1]);
        start2 = -1;
      }
    }
    return out;
  };
  const piece = new Array(lh).fill(null);
  const cy = Math.max(y0, Math.min(y1, Math.round(text.y + text.h / 2 - lim.y)));
  const cx = Math.round(text.x + text.w / 2 - lim.x);
  const gap = (s) => cx < s[0] ? s[0] - cx : cx > s[1] ? cx - s[1] : 0;
  const start = piecesAt(cy).sort((a, b) => gap(a) - gap(b))[0];
  if (!start) return reject("empty cell");
  piece[cy] = start;
  for (const dir of [-1, 1]) {
    let prev = start;
    for (let y = cy + dir; y >= y0 && y <= y1; y += dir) {
      let best = null;
      let bestOverlap = 0;
      for (const s of piecesAt(y)) {
        const overlap = Math.min(s[1], prev[1]) - Math.max(s[0], prev[0]) + 1;
        if (overlap > bestOverlap) {
          best = s;
          bestOverlap = overlap;
        }
      }
      if (!best) break;
      piece[y] = best;
      prev = best;
    }
  }
  let top = cy;
  let bottom = cy;
  while (top > y0 && piece[top - 1]) top--;
  while (bottom < y1 && piece[bottom + 1]) bottom++;
  for (let y = top; y <= bottom; y++) {
    const s = piece[y];
    let l = s[1] + 1;
    let r = s[0] - 1;
    for (let x = s[0]; x <= s[1]; x++) {
      const p = y * lw + x;
      if (visited[p] === 1 || outside[p] === 0) {
        if (l > x) l = x;
        r = x;
      }
    }
    if (r >= l) piece[y] = [l, r];
  }
  const kept = [];
  const tones = [];
  const hist = toneHistograms();
  let kx0 = Infinity;
  let kx1 = -Infinity;
  for (let y = top; y <= bottom; y += step) {
    const s = piece[y];
    kept.push([s[0] + lim.x, s[1] + lim.x]);
    kx0 = Math.min(kx0, s[0] + lim.x);
    kx1 = Math.max(kx1, s[1] + lim.x);
    const t = rowTone(img, hist, s[0] + lim.x, s[1] + lim.x, y + lim.y, (x) => {
      const p = y * lw + x - lim.x;
      return visited[p] === 1 && near[p] === 1 && !glyph(x - lim.x, y);
    });
    tones.push(t.n >= 12 ? t.rgb : null);
  }
  return { area: { x: kx0, y: top + lim.y, w: kx1 - kx0 + 1, h: bottom - top + 1 }, spans: kept, step, tones };
}
function inkInBalloon(img, balloon, bg, textColor, text, others) {
  const none = { metrics: null, foreign: [] };
  const { area, spans, step } = balloon;
  const w = area.w;
  const h = area.h;
  const mask = new Uint8Array(w * h);
  const { data, width } = img;
  const inside = (x, y) => {
    const sp = spans[Math.round((y - area.y) / step)];
    return !!sp && sp[1] >= sp[0] && x >= sp[0] && x <= sp[1];
  };
  const rivals = rivalsIn(text, others, inside);
  let count = 0;
  for (let y = 0; y < h; y++) {
    const sp = spans[Math.min(spans.length - 1, Math.floor(y / step))];
    if (!sp || sp[1] < sp[0]) continue;
    for (let x = sp[0] + 3 - area.x; x <= sp[1] - 3 - area.x; x++) {
      if (x < 0 || x >= w) continue;
      const gx = x + area.x;
      const gy = y + area.y;
      const i = (gy * width + gx) * 4;
      const c = [data[i], data[i + 1], data[i + 2]];
      const dBg = colorDistance(c, bg);
      if (dBg < 60 || colorDistance(c, textColor) > dBg) continue;
      if (rivals.length) {
        const d = rectDistance(gx, gy, text);
        if (rivals.some((r) => rectDistance(gx, gy, r) < d)) continue;
      }
      mask[y * w + x] = 1;
      count++;
    }
  }
  if (count < 12) return none;
  const comps = components(mask, w, h).filter((c) => c.count >= 3);
  const letterH = median(comps.filter((c) => c.count >= 8).map((c) => c.y1 - c.y0 + 1)) || 1;
  const letters = comps.filter((c) => c.y1 - c.y0 + 1 <= letterH * 2.5 && c.x1 - c.x0 + 1 <= w * 0.95);
  if (!letters.length) return none;
  const parent = letters.map((_, k) => k);
  const find = (k) => parent[k] === k ? k : parent[k] = find(parent[k]);
  for (let a = 0; a < letters.length; a++) {
    for (let b = a + 1; b < letters.length; b++) {
      const A = letters[a];
      const B = letters[b];
      const vo = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) + 1;
      const small = Math.min(A.y1 - A.y0 + 1, B.y1 - B.y0 + 1);
      const gap = Math.max(0, A.x0 - B.x1, B.x0 - A.x1);
      if (vo >= small * 0.5 && gap <= letterH * 1.3) parent[find(a)] = find(b);
    }
  }
  const groups = /* @__PURE__ */ new Map();
  letters.forEach((c, k) => {
    const r = find(k);
    const g = groups.get(r);
    const ch = c.y1 - c.y0 + 1;
    if (g) {
      g.x0 = Math.min(g.x0, c.x0);
      g.y0 = Math.min(g.y0, c.y0);
      g.x1 = Math.max(g.x1, c.x1);
      g.y1 = Math.max(g.y1, c.y1);
      g.n++;
      if (c.count >= 8) g.hs.push(ch);
    } else groups.set(r, { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, n: 1, hs: c.count >= 8 ? [ch] : [] });
  });
  const lines = [...groups.values()];
  const tx0 = text.x - area.x;
  const ty0 = text.y - area.y;
  const tx1 = tx0 + text.w - 1;
  const ty1 = ty0 + text.h - 1;
  const hits = (g) => g.x1 >= tx0 && g.x0 <= tx1 && g.y1 >= ty0 && g.y0 <= ty1;
  const block = lines.filter(hits);
  if (!block.length) return none;
  let bx0 = Math.min(...block.map((g) => g.x0));
  let bx1 = Math.max(...block.map((g) => g.x1));
  let by0 = Math.min(...block.map((g) => g.y0));
  let by1 = Math.max(...block.map((g) => g.y1));
  const inBlock = new Set(block);
  const blockH = median(block.flatMap((g) => g.hs)) || letterH;
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of lines) {
      if (inBlock.has(g)) continue;
      const dy = Math.max(0, by0 - g.y1, g.y0 - by1);
      const overlap = Math.min(bx1, g.x1) - Math.max(bx0, g.x0);
      const gh = median(g.hs);
      const sameSize = gh > 0 && gh >= blockH * 0.75 && gh <= blockH * 1.3;
      if (sameSize && g.n >= 2 && dy <= blockH * 1.1 && overlap >= Math.min(bx1 - bx0, g.x1 - g.x0) * 0.4) {
        inBlock.add(g);
        bx0 = Math.min(bx0, g.x0);
        bx1 = Math.max(bx1, g.x1);
        by0 = Math.min(by0, g.y0);
        by1 = Math.max(by1, g.y1);
        changed = true;
      }
    }
  }
  const foreign = lines.filter((g) => !inBlock.has(g) && g.n >= 2).map((g) => ({ x: g.x0 + area.x, y: g.y0 + area.y, w: g.x1 - g.x0 + 1, h: g.y1 - g.y0 + 1 }));
  const textBox = { x: bx0 + area.x, y: by0 + area.y, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
  if (textBox.w * textBox.h <= text.w * text.h * 1.05) return { metrics: null, foreign };
  const box = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
  const clean = new Uint8Array(w * h);
  for (const c of letters) {
    const cy = (c.y0 + c.y1) / 2;
    if (c.x1 < bx0 || c.x0 > bx1 || cy < by0 || cy > by1) continue;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (mask[y * w + x]) clean[y * w + x] = 1;
  }
  const rows = detectLines(clean, w, box);
  if (!rows.length) return { metrics: null, foreign };
  const centres = rows.map((l) => (l.y0 + l.y1) / 2);
  return {
    foreign,
    metrics: {
      textBox,
      lineCount: rows.length,
      lineInkHeight: median(rows.map((l) => l.y1 - l.y0 + 1)),
      linePitch: centres.length > 1 ? median(centres.slice(1).map((c, k) => c - centres[k])) : 0,
      lineWidths: rows.map((l) => {
        let x0 = Infinity;
        let x1 = -Infinity;
        for (let y = l.y0; y <= l.y1; y++)
          for (let x = box.x0; x <= box.x1; x++)
            if (clean[y * w + x]) {
              x0 = Math.min(x0, x);
              x1 = Math.max(x1, x);
            }
        return x1 >= x0 ? x1 - x0 + 1 : 0;
      })
    }
  };
}
function growOverBackground(img, text, bg, flat) {
  if (!flat) {
    const m = Math.round(Math.min(text.w, text.h) * 0.12) + 4;
    return clampRect({ x: text.x - m, y: text.y - m, w: text.w + m * 2, h: text.h + m * 2 }, img.width, img.height);
  }
  const { data, width } = img;
  const clean = (x02, y02, x12, y12) => {
    let bad = 0;
    let n = 0;
    for (let y = y02; y <= y12; y++) {
      for (let x = x02; x <= x12; x++) {
        const i = (y * width + x) * 4;
        n++;
        if (pixelDistance(data, i, bg) >= 30) bad++;
      }
    }
    return n > 0 && bad / n < 0.01;
  };
  let x0 = text.x;
  let y0 = text.y;
  let x1 = text.x + text.w - 1;
  let y1 = text.y + text.h - 1;
  const maxGrowX = Math.round(text.w * 0.45 + 16);
  const maxGrowY = Math.round(text.h * 0.5 + 12);
  for (let i = 0; i < maxGrowX; i++) {
    let grew = false;
    if (x0 > 0 && clean(x0 - 1, y0, x0 - 1, y1)) {
      x0--;
      grew = true;
    }
    if (x1 < img.width - 1 && clean(x1 + 1, y0, x1 + 1, y1)) {
      x1++;
      grew = true;
    }
    if (i < maxGrowY) {
      if (y0 > 0 && clean(x0, y0 - 1, x1, y0 - 1)) {
        y0--;
        grew = true;
      }
      if (y1 < img.height - 1 && clean(x0, y1 + 1, x1, y1 + 1)) {
        y1++;
        grew = true;
      }
    }
    if (!grew) break;
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function fallbackRegion(img, box, win, bg) {
  const background = bg ?? dominantColor(img, win.w > 0 ? win : box);
  const dark = luma(background[0], background[1], background[2]) > 128;
  return {
    textBox: box,
    lineCount: 1,
    lineInkHeight: box.h,
    linePitch: 0,
    lineWidths: [box.w],
    strokeThickness: Math.max(1, box.h * 0.07),
    bgColor: toHex(background),
    textColor: dark ? "#111111" : "#f5f5f5",
    enclosed: false,
    flatBackground: false,
    clearBehind: 0,
    area: box,
    step: 1,
    confident: false
  };
}

// src/refineWorker.ts
import_node_worker_threads.parentPort?.on("message", ({ id, raster, ask }) => {
  let answer;
  try {
    answer = refineRegion(raster, ask.box, { overArt: ask.overArt, others: ask.others });
  } catch (e) {
    answer = { error: e?.message ?? String(e) };
  }
  import_node_worker_threads.parentPort?.postMessage({ id, answer });
});

export function boxBlur(src, w, h, radius = 2) {
  const tmp = new Uint16Array(w * h);
  const out = new Uint16Array(w * h);
  const d = radius * 2 + 1;
  // Horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += src[row + clampIndex(x, w)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = Math.round(sum / d);
      sum -= src[row + clampIndex(x - radius, w)];
      sum += src[row + clampIndex(x + radius + 1, w)];
    }
  }
  // Vertical
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[clampIndex(y, h) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(sum / d);
      sum -= tmp[clampIndex(y - radius, h) * w + x];
      sum += tmp[clampIndex(y + radius + 1, h) * w + x];
    }
  }
  return out;
}

function clampIndex(v, n) {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

/** Difference statistics between two blurred luma frames. */
export function diffStats(a, b, w, h, blockDiv = 8) {
  let sum = 0;
  let over = 0;
  const blockW = Math.max(1, Math.floor(w / blockDiv));
  const blockH = Math.max(1, Math.floor(h / blockDiv));
  const blockMeans = [];
  for (let by = 0; by < blockDiv; by++) {
    for (let bx = 0; bx < blockDiv; bx++) {
      let bsum = 0;
      let bn = 0;
      const x0 = bx * blockW;
      const y0 = by * blockH;
      const x1 = bx === blockDiv - 1 ? w : x0 + blockW;
      const y1 = by === blockDiv - 1 ? h : y0 + blockH;
      for (let y = y0; y < y1; y++) {
        let o = y * w + x0;
        for (let x = x0; x < x1; x++, o++) {
          const d = Math.abs(a[o] - b[o]);
          sum += d;
          if (d > 6) over++;
          bsum += d;
          bn++;
        }
      }
      blockMeans.push(bsum / Math.max(1, bn));
    }
  }
  const total = w * h;
  blockMeans.sort((x, y) => x - y);
  const p90 = blockMeans[Math.min(blockMeans.length - 1, Math.floor(blockMeans.length * 0.9))];
  const maxBlock = blockMeans[blockMeans.length - 1];
  return {
    mean: sum / total,
    overFrac: over / total,
    blockP90: p90,
    blockMax: maxBlock,
  };
}

/**
 * Global translation search (integer pixels) over a downsampled pair, using
 * mean absolute difference. Returns the best shift and the improvement over
 * the zero-shift baseline. Noise-only differences gain nothing from shifting;
 * coherent motion does.
 */
export function motionSearch(a, b, w, h, radius = 3) {
  const step = 2;
  const margin = radius;
  const xs = margin;
  const ys = margin;
  const xe = w - margin;
  const ye = h - margin;
  let zeroSum = 0;
  let zeroN = 0;
  for (let y = ys; y < ye; y += step) {
    for (let x = xs; x < xe; x += step) {
      zeroSum += Math.abs(a[y * w + x] - b[y * w + x]);
      zeroN++;
    }
  }
  const zeroMean = zeroSum / Math.max(1, zeroN);
  let best = { dx: 0, dy: 0, mean: zeroMean };
  // Coarse-to-fine: test all shifts, early skip on clearly worse rows.
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      let sum = 0;
      let n = 0;
      for (let y = ys; y < ye; y += step) {
        const yo = y * w;
        const yb = (y + dy) * w;
        for (let x = xs; x < xe; x += step) {
          sum += Math.abs(a[yo + x] - b[yb + x + dx]);
          n++;
        }
      }
      const mean = sum / Math.max(1, n);
      if (mean < best.mean - 0.01) best = { dx, dy, mean };
    }
  }
  const gain = zeroMean - best.mean;
  const residual = best.mean;
  return {
    shiftX: best.dx * step,
    shiftY: best.dy * step,
    motionGain: gain,
    residual,
    zeroMean,
  };
}

/** Fraction of pixels that are exactly equal, cheap stability check. */
export function equalFraction(a, b) {
  let eq = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++;
  return eq / a.length;
}

/** Per-frame structural richness, used to avoid trusting flat/blank regions. */
export function richness(frame, w, h) {
  let sum = 0;
  let sumSq = 0;
  let edges = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v = frame[y * w + x];
      sum += v;
      sumSq += v * v;
      const gx = frame[y * w + x + 1] - frame[y * w + x - 1];
      const gy = frame[(y + 1) * w + x] - frame[(y - 1) * w + x];
      if (Math.abs(gx) + Math.abs(gy) > 24) edges++;
    }
  }
  const n = (w - 2) * (h - 2);
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return { mean, std: Math.sqrt(Math.max(0, variance)), edgeFrac: edges / n };
}

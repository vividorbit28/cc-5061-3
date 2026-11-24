import { median, quantile, clamp } from "../util/media.js";

/**
 * Declared cadence hypotheses (initial version supports these explicit source
 * rates). The expected repeat pattern is the Bresenham distribution of
 * outFps/srcFps output frames per source frame:
 *   30/12 = 2.5 -> [2,3]   30/24 = 1.25 -> [1,1,1,2]   30/10 = 3 -> [3]
 * We deliberately do not accept an arbitrary "delete every Nth frame" model.
 */
export const RHYTHM_PRESETS = [
  { id: "auto", label: "自动检测节奏", sourceFps: null },
  { id: "native", label: "无复制（源帧率 = 输出帧率）", sourceFps: "native" },
  { id: "src30", label: "30 → 30 无复制", sourceFps: 30 },
  { id: "src25", label: "25 → 30（1,1,1,1,2）", sourceFps: 25 },
  { id: "src24", label: "24 → 30（1,1,1,2）", sourceFps: 24 },
  { id: "src20", label: "20 → 30（1,2 交替）", sourceFps: 20 },
  { id: "src15", label: "15 → 30（每源帧 2 份）", sourceFps: 15 },
  { id: "src12", label: "12 → 30（2,3 交替）", sourceFps: 12 },
  { id: "src10", label: "10 → 30（每源帧 3 份）", sourceFps: 10 },
  { id: "src8", label: "8 → 30（3,4 交替）", sourceFps: 8 },
];

export function presetById(id) {
  return RHYTHM_PRESETS.find((p) => p.id === id) || RHYTHM_PRESETS[0];
}

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/** Reduce a positive ratio to n/d with a bounded denominator via continued fractions. */
export function reduceRatio(ratio, maxDen = 64) {
  if (!Number.isFinite(ratio) || ratio <= 0) return { n: 1, d: 1 };
  let best = { n: 1, d: 1, err: Math.abs(ratio - 1) };
  let h1 = 1;
  let h0 = 0;
  let k1 = 0;
  let k0 = 1;
  let x = ratio;
  for (let i = 0; i < 24 && k1 <= maxDen; i++) {
    const a = Math.floor(x);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    const value = h2 / k2;
    const err = Math.abs(value - ratio);
    if (err < best.err) best = { n: h2, d: k2, err };
    h0 = h1;
    h1 = h2;
    k0 = k1;
    k1 = k2;
    const frac = x - a;
    if (frac < 1e-9) break;
    x = 1 / frac;
  }
  const g = gcd(best.n, best.d);
  return { n: best.n / g, d: best.d / g };
}

/** Predicted run lengths for one full period of the rational cadence. */
export function predictedPattern(n, d) {
  const out = [];
  for (let s = 0; s < d; s++) {
    out.push(Math.floor(((s + 1) * n) / d) - Math.floor((s * n) / d));
  }
  return out;
}

export function otsuThreshold(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return 0;
  const sorted = [...clean].sort((a, b) => a - b);
  const n = sorted.length;
  const totalSum = sorted.reduce((a, b) => a + b, 0);
  let sumB = 0;
  let wB = 0;
  let bestVar = -1;
  let bestT = sorted[0];
  for (let i = 0; i < n; i++) {
    wB++;
    sumB += sorted[i];
    const wF = n - wB;
    if (wF === 0) break;
    const mB = sumB / wB;
    const mF = (totalSum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      bestT = (sorted[i] + sorted[Math.min(n - 1, i + 1)]) / 2;
    }
  }
  return bestT;
}

/**
 * Classify transitions using three independent pieces of evidence:
 *   - magnitude (mean absolute luma difference),
 *   - spatial structure (localized vs. uniform differences),
 *   - motion compensation gain (coherent displacement).
 * Uniform codec noise raises magnitude without structure; real content updates
 * are localized and/or motion-compensable. Runs that cannot be separated are
 * marked uncertain and are never deleted.
 */
export function classifyTransitions(pairwise, opts = {}) {
  const {
    zeroAbs = 0.75,
    structureRatio = 1.8,
    structureMinP90 = 2.2,
    motionAssist = 0.8,
    uncertainRatio = 0.22,
  } = opts;

  const rows = pairwise.slice(1);
  const values = rows.map((p) => p.diff.mean);
  if (!values.length) {
    return {
      transitions: [],
      threshold: 0,
      separation: 0,
      evidence: "empty",
      copyLevel: 0,
      changeLevel: 0,
      thresholdInfo: { method: "无帧间转变可供分析" },
    };
  }
  const otsu = otsuThreshold(values);
  const below = values.filter((v) => v < otsu);
  const above = values.filter((v) => v >= otsu);
  const copyLevel = below.length ? median(below) : 0;
  const changeLevel = above.length ? median(above) : Math.max(...values);
  const copyMass = below.length / values.length;
  const inBetween = otsu;
  const threshold = clamp(
    inBetween,
    copyLevel + 0.35 * Math.max(0.001, changeLevel - copyLevel),
    Math.max(copyLevel + 0.35 * Math.max(0.001, changeLevel - copyLevel), changeLevel - 0.15 * Math.max(0.001, changeLevel - copyLevel)),
  );
  // Copies are not bit-identical after codec noise, so the "copy" band is
  // allowed to grow with the observed copy cluster, while staying well below
  // the decision threshold.
  const noiseBand = Math.max(zeroAbs, Math.min(threshold * 0.5, copyLevel * 2.5));

  let evidence;
  if (changeLevel < zeroAbs * 2) evidence = "all-static";
  else if (copyMass < 0.06 || copyLevel >= zeroAbs * 2.5 || changeLevel - copyLevel < Math.max(1.0, copyLevel * 1.6)) {
    // No near-zero cluster of transitions: nothing looks like a duplicate,
    // or the distribution is unimodal (ordinary motion at output frame rate).
    evidence = "no-copies";
  } else evidence = "bimodal";

  const transitions = pairwise.map((p, i) => {
    if (i === 0) {
      return {
        index: 0,
        t: p.t,
        dt: 0,
        isChange: true,
        uncertain: false,
        diffMean: 0,
        blockP90: 0,
        overFrac: 0,
        motionGain: 0,
        eqFrac: 1,
        structure: 0,
        reason: "片段首帧",
        confidence: 1,
      };
    }
    const d = p.diff.mean;
    const p90 = p.diff.blockP90;
    const gain = p.motion?.motionGain ?? 0;
    const structure = p90 / Math.max(0.25, d);
    const localized = p90 >= structureMinP90 && structure >= structureRatio;
    const coherent = gain >= motionAssist;
    const structural = localized || coherent;

    let isChange;
    let uncertain;
    let reason;
    let confidence;

    if (evidence === "all-static") {
      isChange = false;
      uncertain = true;
      reason = "画面几乎不变（差异低于可分辨水平）";
      confidence = 0.1;
    } else if (evidence === "no-copies") {
      // Every transition is assumed to be real motion unless it is nearly
      // identical to the previous frame (then it is a hold/duplicate).
      if (d <= zeroAbs) {
        isChange = false;
        uncertain = true;
        reason = `与上一帧几乎一致（差异 ${d.toFixed(2)}），但全片未检出重复节奏；按静止/持帧保守保留`;
        confidence = 0.3;
      } else {
        isChange = true;
        uncertain = false;
        reason = "画面内容更新（未见复制节奏）";
        confidence = structural ? 0.9 : 0.65;
      }
    } else {
      const nearThreshold = Math.abs(d - threshold) <= uncertainRatio * Math.max(1, threshold);
      if (d <= noiseBand && !structural) {
        isChange = false;
        uncertain = false;
        reason = `与上一帧一致（差异 ${d.toFixed(2)}，在复制噪声带 ${noiseBand.toFixed(2)} 内，无空间结构变化），判定为复制/持帧`;
        confidence = d <= zeroAbs ? 0.95 : 0.8;
      } else if (d < threshold && structural) {
        isChange = true;
        uncertain = false;
        reason = `差异 ${d.toFixed(2)} 较小但存在局部结构变化/运动补偿增益 ${gain.toFixed(2)}，判定为真实更新`;
        confidence = 0.7;
      } else if (d >= threshold && !structural && !nearThreshold) {
        // Large but spatially uniform difference: typically codec noise on an
        // otherwise repeated frame, or an unusual global change. Be explicit.
        isChange = false;
        uncertain = true;
        reason = `差异偏大（${d.toFixed(2)}）但缺乏局部结构或运动证据，判据不足，保留不确定`;
        confidence = 0.3;
      } else if (nearThreshold) {
        isChange = false;
        uncertain = true;
        reason = `差异 ${d.toFixed(2)} 处于判定阈值 ${threshold.toFixed(2)} 附近，证据不足，保留不确定`;
        confidence = 0.35;
      } else {
        isChange = true;
        uncertain = false;
        reason = `画面内容更新（差异 ${d.toFixed(2)}，p90 ${p90.toFixed(1)}，运动增益 ${gain.toFixed(2)}）`;
        confidence = 0.9;
      }
    }

    return {
      index: i,
      t: p.t,
      dt: p.dt,
      isChange,
      uncertain,
      diffMean: d,
      blockP90: p90,
      overFrac: p.diff.overFrac,
      motionGain: gain,
      eqFrac: p.eqFrac,
      structure,
      localized,
      coherent,
      reason,
      confidence,
    };
  });

  return {
    transitions,
    threshold,
    copyLevel,
    changeLevel,
    separation: changeLevel - copyLevel,
    evidence,
    method: "差异幅度 + 空间结构 + 运动补偿增益（Otsu 自适应阈值）",
    thresholdInfo: {
      method: "Otsu 双峰阈值（复制簇 vs 更新簇）",
      copyLevel,
      changeLevel,
      threshold,
    },
  };
}

/** Group frames into runs of visually unchanged content. */
export function buildRuns(transitions, frameTimes) {
  const runs = [];
  let start = 0;
  for (let i = 1; i < transitions.length; i++) {
    if (transitions[i].isChange) {
      runs.push(makeRun(runs.length, start, i, transitions, frameTimes));
      start = i;
    }
  }
  runs.push(makeRun(runs.length, start, transitions.length, transitions, frameTimes));
  return runs;
}

function makeRun(id, start, end, transitions, frameTimes) {
  const t0 = frameTimes[start];
  const t1 = end < frameTimes.length ? frameTimes[end] : null;
  const opening = transitions[start];
  return {
    id,
    start,
    end,
    length: end - start,
    tStart: t0,
    tEnd: t1,
    duration: t1 != null ? t1 - t0 : null,
    opening,
    uncertainOpening: start === 0 ? false : Boolean(opening?.uncertain),
  };
}

const MIN_STATIC_DURATION = 0.32;

/**
 * Fit run lengths against each declared source-rate hypothesis.
 *
 * Key semantic: a run longer than the cadence's maximum predicted repeat is
 * *not* duplication — it is a real static hold (subject to a minimum duration).
 * Such runs are excluded from the cadence fit but are preserved with their full
 * duration. Runs longer than the prediction but too short to be a plausible
 * static hold count as unexplained evidence against the hypothesis.
 */
export function fitCadence(runs, outFps, { presets = RHYTHM_PRESETS, minStaticDuration = MIN_STATIC_DURATION, segmentEnd = null } = {}) {
  const frameDt = outFps > 0 ? 1 / outFps : 0.033;
  const runInfo = runs.map((r) => {
    const duration = r.duration ?? r.length * frameDt;
    return { ...r, duration };
  });
  const totalFrames = runInfo.reduce((a, r) => a + r.length, 0) || 1;

  const candidates = [];
  for (const preset of presets) {
    if (preset.id === "auto") continue;
    let srcFps;
    if (preset.sourceFps === "native") srcFps = outFps;
    else if (typeof preset.sourceFps === "number") srcFps = preset.sourceFps;
    else continue;
    if (!(srcFps > 0)) continue;
    const ratio = outFps / srcFps;
    if (ratio < 0.999) continue;
    const { n, d } = ratio <= 1.0001 ? { n: 1, d: 1 } : reduceRatio(ratio, 64);
    const pattern = predictedPattern(n, d);
    const maxPred = Math.max(...pattern);
    const fit = fitHypothesis(runInfo, pattern, d, maxPred, frameDt, minStaticDuration);
    candidates.push({
      presetId: preset.id,
      label: preset.label,
      sourceFps: srcFps,
      ratio,
      n,
      d,
      pattern,
      maxPred,
      period: d,
      offset: fit.segments[0]?.offset ?? 0,
      frameDt,
      totalFrames,
      ...fit,
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.coverage !== a.coverage) return b.coverage - a.coverage;
    return b.sourceFps - a.sourceFps;
  });

  const best = candidates.find((c) => c.eligibleRuns > 0) || candidates[0] || null;
  const second = candidates.find((c) => c !== best && c.eligibleRuns > 0) || null;
  // Two presets may describe the same hypothesis (e.g. "native" and "src30"
  // when the output is already 30 fps). A tie between those is not ambiguity.
  const distinctSecond =
    second && best && Math.abs(second.sourceFps - best.sourceFps) > 0.01 ? second : null;

  const allStatic = runInfo.length === 1 && best && best.eligibleRuns === 0;
  const ambiguous =
    !best ||
    best.score < 0.6 ||
    best.coverage < 0.55 ||
    (distinctSecond && best.score - distinctSecond.score < 0.06 && distinctSecond.coverage > 0.5);

  let reason;
  if (!best) reason = "没有可用的节奏假设";
  else if (allStatic) reason = "全片画面几乎不变，缺少可用于区分复制与真实静止的证据";
  else if (ambiguous) {
    if (distinctSecond && Math.abs(best.score - distinctSecond.score) < 0.06) {
      reason = `多个节奏假设得分接近（${best.label} ${(best.score * 100).toFixed(0)}% / ${distinctSecond.label} ${(distinctSecond.score * 100).toFixed(0)}%），保留多解`;
    } else if (best.coverage < 0.55) {
      reason = `最佳假设仅解释 ${(best.coverage * 100).toFixed(0)}% 的画面时长，证据不足`;
    } else {
      reason = `最佳假设匹配不足（${(best.score * 100).toFixed(0)}%）`;
    }
  } else {
    reason = `最佳假设 ${best.label}：节奏匹配 ${(best.score * 100).toFixed(0)}%，覆盖 ${(best.coverage * 100).toFixed(0)}% 画面时长`;
  }

  return {
    outFps,
    frameDt,
    candidates,
    best,
    second,
    ambiguous: Boolean(ambiguous),
    allStatic: Boolean(allStatic),
    runInfo,
    totalFrames,
    staticMinDuration: minStaticDuration,
    segmentEnd,
    reason,
  };
}

function fitHypothesis(runInfo, pattern, period, maxPred, frameDt, minStaticDuration) {
  // Break sequences at real static holds and at unexplained over-long runs.
  const segments = [];
  let current = [];
  let staticFrames = 0;
  let unexplainedFrames = 0;
  const runMeta = new Map();

  const flush = () => {
    if (current.length) segments.push(current);
    current = [];
  };

  for (const run of runInfo) {
    if (run.length > maxPred) {
      if (run.duration >= minStaticDuration) {
        staticFrames += run.length;
        runMeta.set(run.id, { kind: "static" });
        flush();
        continue;
      }
      // Too long for the cadence and too short to be a real static hold.
      unexplainedFrames += run.length;
      runMeta.set(run.id, { kind: "unexplained-long" });
      flush();
      continue;
    }
    runMeta.set(run.id, { kind: "eligible" });
    current.push(run);
  }
  flush();

  let matchedWeight = 0;
  let eligibleWeight = 0;
  const fittedSegments = [];

  for (const segment of segments) {
    let bestOffset = 0;
    let bestMatched = -1;
    for (let offset = 0; offset < period; offset++) {
      let matched = 0;
      for (let j = 0; j < segment.length; j++) {
        const run = segment[j];
        const pred = pattern[(offset + j) % period];
        const boundary = j === 0 || j === segment.length - 1;
        const ok = boundary ? run.length <= pred && run.length >= 1 : run.length === pred;
        if (ok) matched++;
      }
      if (matched > bestMatched) {
        bestMatched = matched;
        bestOffset = offset;
      }
    }
    const perRun = [];
    for (let j = 0; j < segment.length; j++) {
      const run = segment[j];
      const pred = pattern[(bestOffset + j) % period];
      const boundary = j === 0 || j === segment.length - 1;
      const ok = boundary ? run.length <= pred && run.length >= 1 : run.length === pred;
      perRun.push({ run, pred, ok, boundary, phase: (bestOffset + j) % period });
      eligibleWeight += run.length;
      if (ok) matchedWeight += run.length;
      else if (run.length > pred) {
        // Over-long but still <= maxPred: likely a genuine short hold inside a
        // would-be stretch; it still counts as a miss but is not a static
        // "free pass".
      }
      runMeta.set(run.id, {
        ...runMeta.get(run.id),
        kind: ok ? "matched" : "mismatch",
        pred,
        phase: (bestOffset + j) % period,
        boundary,
      });
    }
    fittedSegments.push({ offset: bestOffset, runs: perRun });
  }

  const denominator = eligibleWeight + unexplainedFrames;
  const score = denominator > 0 ? matchedWeight / denominator : 0;
  const coverage = (matchedWeight + staticFrames) / Math.max(1, runInfo.reduce((a, r) => a + r.length, 0));
  const eligibleRuns = [...runMeta.values()].filter((m) => m.kind === "eligible" || m.kind === "matched" || m.kind === "mismatch").length;

  return {
    score,
    coverage,
    eligibleRuns,
    matchedWeight,
    eligibleWeight,
    staticFrames,
    unexplainedFrames,
    segments: fittedSegments,
    runMeta,
    staticMinDuration: minStaticDuration,
  };
}

/**
 * Turn a fitted hypothesis into per-run and per-frame decisions.
 * Frames are only deleted when the transition is confidently a repeat AND the
 * cadence model explains the run. Everything else is preserved with a reason.
 */
export function decideFrames({ runs, fit, transitions, frameTimes, options = {} }) {
  const { keepUncertain = true, preserveStaticDuration = true } = options;
  const best = fit.best;
  const period = best?.period ?? 1;
  const runDecisions = [];

  for (const run of runs) {
    const meta = best?.runMeta?.get(run.id);
    const kind = meta?.kind ?? "unmatched";
    const pred = meta?.pred ?? null;
    const isStatic = kind === "static";
    const uncertainOpening = run.uncertainOpening;
    const opening = run.opening;
    // Transitions inside the run decide whether the frames really are copies.
    // If any of them lacks evidence, the whole run must be preserved.
    let internalUncertain = 0;
    for (let i = run.start + 1; i < run.end; i++) {
      if (transitions[i]?.uncertain) internalUncertain++;
    }

    let action;
    let reason;
    let confidence;

    if (fit.allStatic) {
      action = "keep-uncertain";
      reason = "全片画面几乎不变：无法从画面判断源帧更新，保留多解节奏与完整时长";
      confidence = 0.15;
    } else if (isStatic) {
      action = preserveStaticDuration ? "keep-static" : "keep";
      const staticDuration = run.duration ?? fit.staticMinDuration;
      reason = `真实静止停顿：连续 ${run.length} 帧（约 ${staticDuration.toFixed(2)} 秒）画面不变，超过复制节奏的最大重复数 ${best.maxPred}；保留完整时长的首个画面，不压缩静止时间`;
      confidence = 0.8;
    } else if (!best || fit.ambiguous) {
      action = keepUncertain ? "keep-uncertain" : "keep";
      reason = `节奏判定不确定（${fit.reason}），保留该区间全部 ${run.length} 帧以避免误删`;
      confidence = 0.25;
    } else if (uncertainOpening || internalUncertain > 0) {
      action = keepUncertain ? "keep-uncertain" : "keep";
      const detail = uncertainOpening
        ? `区间起始的帧间差异证据不足（${opening?.reason ?? "未定"}）`
        : `区间内有 ${internalUncertain} 处帧间差异证据不足`;
      reason = `${detail}，保留 ${run.length} 帧`;
      confidence = 0.3;
    } else if (kind === "mismatch") {
      action = keepUncertain ? "keep-uncertain" : "keep";
      reason = `与节奏模型不符：观察到 ${run.length} 帧，相位 ${meta.phase}/${period} 预期 ${pred} 帧；保留以策安全`;
      confidence = 0.3;
    } else if (kind === "unexplained-long") {
      action = keepUncertain ? "keep-uncertain" : "keep";
      reason = `观察到 ${run.length} 帧连续不变，超过节奏上限 ${best.maxPred} 但时长短于静止阈值，证据冲突；保留`;
      confidence = 0.25;
    } else if (run.length === 1) {
      action = "keep";
      reason = `该源帧在输出中只出现 1 次（相位 ${meta?.phase ?? 0}/${period}），无需删除`;
      confidence = 0.9;
    } else if (kind === "matched") {
      action = "drop-copies";
      reason = `复制重复：同一源帧在输出中重复 ${run.length} 次，符合 ${best.label} 的相位 ${meta.phase}/${period}（预期 ${pred} 次）；保留首个更新帧 #${run.start}`;
      confidence = run.length === pred ? 0.95 : 0.7;
      if (meta.boundary) {
        reason = `复制重复（片段边界截断）：观察到 ${run.length} 帧，相位 ${meta.phase}/${period} 预期 ≤${pred} 次，属于复制；保留首个更新帧 #${run.start}`;
        confidence = 0.65;
      }
    } else {
      action = keepUncertain ? "keep-uncertain" : "keep";
      reason = `节奏模型未覆盖该区间（${run.length} 帧），保留以避免误删`;
      confidence = 0.2;
    }

    runDecisions.push({
      id: run.id,
      start: run.start,
      end: run.end,
      length: run.length,
      tStart: frameTimes[run.start] ?? run.tStart,
      tEnd: run.tEnd,
      duration: run.duration,
      predicted: pred,
      phase: meta?.phase ?? null,
      period,
      isStatic,
      kind,
      isBoundary: meta?.boundary ?? false,
      action,
      confidence,
      reason,
      opening: opening
        ? {
            diffMean: opening.diffMean,
            blockP90: opening.blockP90,
            motionGain: opening.motionGain,
            eqFrac: opening.eqFrac,
            reason: opening.reason,
            uncertain: opening.uncertain,
          }
        : null,
    });
  }

  // Per-frame decisions, keeping original event times explicit.
  const frames = [];
  for (const rd of runDecisions) {
    for (let i = rd.start; i < rd.end; i++) {
      const isFirst = i === rd.start;
      let action = "keep";
      let reason = rd.reason;
      let keptFrame = null;
      let keptTime = null;
      if (rd.action === "drop-copies" && !isFirst) {
        action = "drop";
        keptFrame = rd.start;
        keptTime = frameTimes[rd.start] ?? rd.tStart;
        reason = `复制产生的重复帧；所属区间 #${rd.start}–#${rd.end - 1}，${rd.reason}`;
      } else if (rd.action === "keep-static" && !isFirst) {
        action = "drop-static";
        keptFrame = rd.start;
        keptTime = frameTimes[rd.start] ?? rd.tStart;
        reason = `真实静止停顿内的相同画面；停顿时长由保留帧 #${rd.start}（原时间 ${keptTime.toFixed(3)} 秒）的显示时长完整保留`;
      } else if (rd.action === "keep-uncertain") {
        action = "keep-uncertain";
      }
      frames.push({
        index: i,
        time: frameTimes[i],
        action,
        runId: rd.id,
        keptFrame,
        keptTime,
        reason,
        confidence: rd.confidence,
        diffMean: transitions[i]?.diffMean ?? 0,
        motionGain: transitions[i]?.motionGain ?? 0,
        eqFrac: transitions[i]?.eqFrac ?? 1,
        phase: rd.phase,
        period: rd.period,
      });
    }
  }

  // Build the kept timeline: kept frame plus how long it is displayed.
  const kept = [];
  let i = 0;
  while (i < frames.length) {
    const f = frames[i];
    if (f.action === "drop" || f.action === "drop-static") {
      i++;
      continue;
    }
    // Find the next kept frame; this one displays until then.
    let j = i + 1;
    while (j < frames.length && (frames[j].action === "drop" || frames[j].action === "drop-static")) j++;
    let endTime = j < frames.length ? frameTimes[j] : (frameTimes[frameTimes.length - 1] ?? 0) + fit.frameDt;
    // If the source runs out, extend to the true segment end when known.
    if (j >= frames.length && fit.segmentEnd != null) endTime = Math.max(endTime, fit.segmentEnd);
    kept.push({
      sourceFrame: i,
      time: f.time,
      displayStart: f.time,
      displayEnd: endTime,
      displayDuration: Math.max(0, endTime - f.time),
      action: f.action,
      runId: f.runId,
      confidence: f.confidence,
      reason: f.reason,
      phase: f.phase,
      period: f.period,
    });
    i = j;
  }

  return { runDecisions, frames, kept };
}

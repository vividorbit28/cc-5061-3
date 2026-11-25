import { median } from "../util/media.js";

/**
 * Cadence-inference trace + copy-pattern diagnosis.
 *
 * This module is strictly READ-ONLY with respect to the analysed sequence: it
 * consumes the already-computed analysis (pairwise evidence, classification,
 * runs, cadence fit, frame decisions) and never re-decides, never drops frames,
 * and never mutates its inputs. Its job is to make the evidence chain explicit
 * and to separate two very different failure explanations:
 *
 *   - "insufficient observation": pixels alone cannot tell a real static hold
 *     from a codec duplicate (they are identical by construction), or the clip
 *     is ambiguous. The safe outcome is to keep frames.
 *   - "implementation misjudgment": the code contradicted its own evidence
 *     (e.g. dropped a frame whose internal transition was not a confident
 *     copy, or produced an inconsistent source-frame mapping). These are hard
 *     invariant violations and are located to the stage that produced them.
 *
 * Every drop is backed by an explicit evidence chain: transition similarity ->
 * timestamp -> cadence candidate -> run match -> kept source frame. Log cost is
 * bounded by a fixed budget; all detail arrays are sampled.
 */

const DEFAULT_BUDGET = {
  maxTransitions: 400,
  maxRunLinks: 400,
  maxMapping: 200,
  maxDropEvidence: 200,
  maxLogLines: 200,
};

function sampleEven(list, max) {
  const total = list.length;
  if (!total || max <= 0) return { items: [], total, omitted: total, stride: total || 1 };
  if (total <= max) return { items: list.slice(), total, omitted: 0, stride: 1 };
  const stride = total / max;
  const items = [];
  for (let k = 0; k < max; k++) {
    items.push(list[Math.min(total - 1, Math.floor(k * stride))]);
  }
  return { items, total, omitted: total - items.length, stride };
}

function round(v, digits = 3) {
  if (v == null || !Number.isFinite(v)) return null;
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

/**
 * Per-transition similarity sample: the raw evidence that everything else is
 * derived from. `index` and `t` bind it to the frame timeline.
 */
function buildSimilarity(classifyBudget, transitions, budget) {
  const rows = transitions.map((t) => ({
    index: t.index,
    t: round(t.t, 4),
    dt: round(t.dt ?? null, 4),
    diff: round(t.diffMean, 3),
    p90: round(t.blockP90, 2),
    over: round(t.overFrac, 4),
    gain: round(t.motionGain, 3),
    eq: round(t.eqFrac, 3),
    structure: round(t.structure, 2),
    isChange: Boolean(t.isChange),
    uncertain: Boolean(t.uncertain),
    confidence: round(t.confidence, 2),
  }));
  const sampled = sampleEven(rows, budget.maxTransitions);
  const copyFrames = transitions.filter((t) => t.index > 0 && !t.isChange).length;
  const changeFrames = transitions.filter((t) => t.index > 0 && t.isChange).length;
  const uncertainFrames = transitions.filter((t) => t.uncertain).length;
  return {
    method: classifyBudget.method,
    evidence: classifyBudget.evidence,
    threshold: round(classifyBudget.threshold, 3),
    copyLevel: round(classifyBudget.copyLevel, 3),
    changeLevel: round(classifyBudget.changeLevel, 3),
    counts: { transitions: transitions.length - 1, copy: copyFrames, change: changeFrames, uncertain: uncertainFrames },
    sample: sampled.items,
    sampleTotal: sampled.total,
    omitted: sampled.omitted,
    stride: round(sampled.stride, 2),
  };
}

/** Detection-end copy evidence for every transition, plus the cadence-derived drop set. */
function buildPathComparison({ transitions, frames, budget }) {
  const detectionCopy = new Set();
  for (let i = 1; i < transitions.length; i++) {
    const t = transitions[i];
    if (!t.isChange && !t.uncertain) detectionCopy.add(i);
  }
  const cadenceDrops = [];
  const staticCollapses = [];
  for (const f of frames) {
    if (f.action === "drop") cadenceDrops.push(f);
    else if (f.action === "drop-static") staticCollapses.push(f);
  }
  const both = [];
  const onlyCadence = [];
  for (const f of cadenceDrops) {
    (detectionCopy.has(f.index) ? both : onlyCadence).push(f.index);
  }
  const cadenceSet = new Set(cadenceDrops.map((f) => f.index));
  const staticSet = new Set(staticCollapses.map((f) => f.index));
  const onlyDetection = [];
  for (const idx of detectionCopy) {
    if (!cadenceSet.has(idx) && !staticSet.has(idx)) onlyDetection.push(idx);
  }
  onlyDetection.sort((a, b) => a - b);
  const sample = (arr) => sampleEven(arr, budget.maxDropEvidence).items;
  return {
    detectionEnd: {
      label: "检测端建立复制证据",
      copies: detectionCopy.size,
      // Frames detection alone would treat as duplicates (confident, low-diff,
      // non-structural). It has no notion of runs or cadence.
      rule: "transition.isChange=false 且 uncertain=false",
    },
    cadenceBack: {
      label: "从恢复节奏反推候选删帧",
      drops: cadenceDrops.length,
      staticCollapses: staticCollapses.length,
      rule: "运行区匹配节奏模式（matched）后删除复制候选",
    },
    agreement: {
      both: both.length,
      onlyCadence: onlyCadence.length,
      onlyDetection: onlyDetection.length,
      bothSample: sample(both),
      onlyCadenceSample: sample(onlyCadence),
      onlyDetectionSample: sample(onlyDetection),
    },
  };
}

/** Aggregate support for every cadence candidate, with phase segments and implied mapping. */
function buildCandidates(candidates, best, runInfo, segment, frameTimes) {
  const segStart = segment?.start ?? (frameTimes[0] ?? 0);
  const segEnd = segment?.end ?? (frameTimes[frameTimes.length - 1] ?? segStart);
  return candidates.map((c) => {
    const segs = (c.segments || []).map((s) => {
      const runs = s.runs || [];
      const first = runs[0]?.run;
      const last = runs[runs.length - 1]?.run;
      return {
        offset: s.offset,
        runCount: runs.length,
        startFrame: first ? first.start : null,
        endFrame: last ? last.end : null,
        startTime: first ? round(first.tStart, 4) : null,
        endTime: last ? round(last.tEnd, 4) : null,
      };
    });
    // Implied kept frames if this candidate were chosen: each matched run of
    // length>1 keeps only its first frame; static/uncertain keep all.
    const infoById = new Map((runInfo || []).map((r) => [r.id, r]));
    let impliedKept = 0;
    let impliedDropped = 0;
    for (const [runId, meta] of c.runMeta ? c.runMeta.entries() : []) {
      const run = infoById.get(runId);
      const len = run?.length ?? 1;
      if (meta.kind === "matched" && len > 1) {
        impliedKept += 1;
        impliedDropped += len - 1;
      } else {
        impliedKept += len;
      }
    }
    return {
      presetId: c.presetId,
      label: c.label,
      sourceFps: c.sourceFps,
      ratio: `${c.n}/${c.d}`,
      pattern: c.pattern,
      maxPred: c.maxPred,
      period: c.period,
      isBest: c === best,
      support: {
        score: round(c.score, 3),
        coverage: round(c.coverage, 3),
        matchedWeight: c.matchedWeight,
        eligibleWeight: c.eligibleWeight,
        staticFrames: c.staticFrames,
        unexplainedFrames: c.unexplainedFrames,
        eligibleRuns: c.eligibleRuns,
      },
      impliedMapping: { kept: impliedKept, dropped: impliedDropped },
      phaseSegments: segs,
      staticMinDuration: c.staticMinDuration,
      segment: { start: round(segStart, 4), end: round(segEnd, 4) },
    };
  });
}

function neighbourBoundaryDiffs(runDecisions, runIndex, transitions, window = 2) {
  const diffs = [];
  for (let j = Math.max(0, runIndex - window); j <= Math.min(runDecisions.length - 1, runIndex + window); j++) {
    if (j === runIndex) continue;
    const rd = runDecisions[j];
    if (rd.start === 0) continue;
    const tr = transitions[rd.start];
    if (tr && Number.isFinite(tr.diffMean)) diffs.push(tr.diffMean);
  }
  return diffs;
}

/**
 * Per-run evidence chain. `support` states which path justified the action:
 *   detection+cadence   both agree it is a copy
 *   static-duration     real hold proven by duration > cadence maximum
 *   insufficient        ambiguous or uncertain evidence, kept
 *   cadence-only        cadence dropped it but detection was not a confident copy
 */
function buildRunLinks({ runs, runDecisions, transitions, fit, segment }, budget) {
  const best = fit.best;
  const threshold = fit.__threshold ?? 0;
  const minStatic = fit.staticMinDuration ?? 0.32;
  const byId = new Map(runDecisions.map((rd) => [rd.id, rd]));
  const runIndexById = new Map(runDecisions.map((rd, i) => [rd.id, i]));
  const links = [];
  for (const run of runs) {
    const rd = byId.get(run.id);
    if (!rd) continue;
    const runIndex = runIndexById.get(run.id);
    let confidentCopies = 0;
    let uncertainInternal = 0;
    let changeInternal = 0;
    for (let i = run.start + 1; i < run.end; i++) {
      const t = transitions[i];
      if (!t) continue;
      if (t.isChange) changeInternal++;
      else if (t.uncertain) uncertainInternal++;
      else confidentCopies++;
    }
    const opening = run.start > 0 ? transitions[run.start] : null;
    const neighbourDiffs = neighbourBoundaryDiffs(runDecisions, runIndex, transitions, 2);
    const neighbourMedian = neighbourDiffs.length >= 3 ? median(neighbourDiffs) : null;
    const windowDuration = runDecisions
      .slice(Math.max(0, runIndex - 2), Math.min(runDecisions.length, runIndex + 3))
      .reduce((a, r) => a + (r.duration ?? r.length * (fit.frameDt || 0)), 0);
    const weakNeighbourhood =
      neighbourMedian != null && threshold > 0 && neighbourMedian < threshold * 0.75 && windowDuration >= minStatic;
    const staticContextAmbiguous = rd.action === "drop-copies" && weakNeighbourhood;

    let support;
    if (rd.action === "drop-copies") {
      support = uncertainInternal === 0 && changeInternal === 0 ? "detection+cadence" : "cadence-only";
    } else if (rd.isStatic) {
      support = "static-duration";
    } else if (rd.kind === "matched" || rd.kind === "mismatch" || rd.kind === "unexplained-long") {
      support = "insufficient";
    } else {
      support = "keep";
    }

    links.push({
      runId: run.id,
      start: run.start,
      end: run.end,
      length: run.length,
      tStart: round(rd.tStart, 4),
      tEnd: round(rd.tEnd, 4),
      duration: round(rd.duration, 4),
      kind: rd.kind,
      isStatic: rd.isStatic,
      action: rd.action,
      confidence: round(rd.confidence, 2),
      phase: rd.phase,
      period: rd.period,
      predicted: rd.predicted,
      cadence: { matched: rd.kind === "matched", predicted: rd.predicted, phase: rd.phase, period: rd.period },
      detection: {
        confidentCopies,
        uncertainInternal,
        changeInternal,
        openingDiff: opening ? round(opening.diffMean, 3) : null,
        openingUncertain: opening ? Boolean(opening.uncertain) : false,
      },
      support,
      conflict:
        support === "cadence-only"
          ? "节奏反推删除，但内部帧间证据并非全部为可信复制"
          : null,
      keptSourceFrame: rd.action === "drop-copies" || rd.action === "keep-static" ? run.start : null,
      droppedInternal: rd.action === "drop-copies" || rd.action === "keep-static" ? Math.max(0, run.length - 1) : 0,
      neighbourhood: {
        boundaryMedianDiff: round(neighbourMedian, 3),
        windowDuration: round(windowDuration, 3),
        weak: weakNeighbourhood,
      },
      staticContextAmbiguous,
      reason: rd.reason,
    });
  }
  const sampled = sampleEven(links, budget.maxRunLinks);
  return { links, sample: sampled.items, total: sampled.total, omitted: sampled.omitted, stride: round(sampled.stride, 2) };
}

/** Static segments and the phase transform across each segment boundary. */
function buildPhaseStory(runs, runDecisions, fit) {
  const best = fit.best;
  const staticSegments = runDecisions
    .filter((rd) => rd.isStatic || rd.kind === "unexplained-long")
    .map((rd) => ({
      runId: rd.id,
      start: rd.start,
      end: rd.end,
      length: rd.length,
      tStart: round(rd.tStart, 4),
      tEnd: round(rd.tEnd, 4),
      duration: round(rd.duration, 4),
      kind: rd.kind,
      reason: rd.reason,
    }));

  const transforms = [];
  if (best && Array.isArray(best.segments)) {
    let prev = null;
    for (const seg of best.segments) {
      const runsInSeg = seg.runs || [];
      const firstRun = runsInSeg[0]?.run;
      if (prev && prev.offset !== seg.offset) {
        // Find the runs that separate the two fitted segments (static / long).
        const separators = runDecisions
          .filter((rd) => rd.start >= prev.lastEnd && rd.start < (firstRun?.start ?? Infinity))
          .map((rd) => ({ runId: rd.id, kind: rd.kind, length: rd.length, duration: round(rd.duration, 4) }));
        const cause = separators.some((s) => s.kind === "static")
          ? "static-hold"
          : separators.some((s) => s.kind === "unexplained-long")
            ? "unexplained-long"
            : "phase-shift";
        transforms.push({
          atFrame: firstRun ? firstRun.start : null,
          atTime: firstRun ? round(firstRun.tStart, 4) : null,
          before: prev.offset,
          after: seg.offset,
          period: best.period,
          cause,
          separators,
        });
      }
      const lastRun = runsInSeg[runsInSeg.length - 1]?.run;
      prev = { offset: seg.offset, lastEnd: lastRun ? lastRun.end : prev?.lastEnd ?? 0 };
    }
  }
  return { staticSegments, phaseTransforms: transforms };
}

/** Source-frame mapping for kept frames, plus structural invariant checks. */
function buildMappingAndInvariants({ frames, kept, frameTimes, segment, fit, transitions, runDecisions }, budget) {
  const keptSet = new Set(kept.map((k) => k.sourceFrame));
  const issues = [];
  const addIssue = (stage, code, detail, framesAffected = []) =>
    issues.push({ stage, code, detail, frames: framesAffected.slice(0, 10), frameCount: framesAffected.length });

  // 1) kept source frames strictly increasing and unique.
  for (let i = 1; i < kept.length; i++) {
    if (kept[i].sourceFrame <= kept[i - 1].sourceFrame) {
      addIssue("decide", "kept-not-monotonic", `保留源帧非严格递增：#${kept[i - 1].sourceFrame} -> #${kept[i].sourceFrame}`);
    }
  }

  // 2) Every replaced frame points to a real, earlier, kept source frame.
  const orphan = [];
  const forward = [];
  for (const f of frames) {
    if (f.action !== "drop" && f.action !== "drop-static") continue;
    if (f.keptFrame == null || !keptSet.has(f.keptFrame)) orphan.push(f.index);
    else if (f.keptFrame >= f.index) forward.push(f.index);
  }
  if (orphan.length) addIssue("decide", "drop-without-kept-source", "被替换帧缺少对应的保留源帧", orphan);
  if (forward.length) addIssue("decide", "kept-frame-not-earlier", "被替换帧映射到不早于自身的源帧", forward);

  // 3) cadence drops must rest on confident internal copy transitions.
  const badDrops = [];
  for (const rd of runDecisions) {
    if (rd.action !== "drop-copies") continue;
    for (let i = rd.start + 1; i < rd.end; i++) {
      const t = transitions[i];
      if (!t || t.isChange || t.uncertain) badDrops.push(i);
    }
  }
  if (badDrops.length) {
    addIssue("decide", "cadence-drop-without-copy-evidence", "按节奏删除的帧中，有内部帧间证据并非可信复制", badDrops);
  }

  // 4) kept timeline must cover the analysed segment without gaps.
  const span = segment && segment.end > segment.start ? segment.end - segment.start : null;
  const totalDisplay = kept.reduce((a, k) => a + (k.displayDuration || 0), 0);
  const tol = Math.max(0.15, 2 * (fit.frameDt || 0.033));
  if (span != null && Math.abs(totalDisplay - span) > tol) {
    addIssue("fit", "timeline-coverage", `保留显示时长合计 ${totalDisplay.toFixed(3)}s，与片段 ${span.toFixed(3)}s 相差超过容差`);
  }
  if (kept.length) {
    for (let i = 1; i < kept.length; i++) {
      if (!(kept[i].displayStart >= kept[i - 1].displayStart)) {
        addIssue("fit", "display-start-not-monotonic", "显示开始时间非单调");
        break;
      }
      if (kept[i].displayDuration < 0) {
        addIssue("fit", "negative-display-duration", "保留帧显示时长为负", [kept[i].sourceFrame]);
        break;
      }
    }
  }

  // 5) each run's first frame is retained (the anchor for the run).
  const missingAnchors = runDecisions.filter((rd) => !keptSet.has(rd.start)).map((rd) => rd.start);
  if (missingAnchors.length) addIssue("runs", "run-anchor-not-kept", "存在未保留首帧的区间", missingAnchors);

  const mapping = kept.map((k) => ({
    sourceFrame: k.sourceFrame,
    time: round(k.time, 4),
    displayStart: round(k.displayStart, 4),
    displayEnd: round(k.displayEnd, 4),
    displayDuration: round(k.displayDuration, 4),
    action: k.action,
    runId: k.runId,
    phase: k.phase,
    period: k.period,
  }));
  const sampled = sampleEven(mapping, budget.maxMapping);

  return {
    keptSourceFrames: mapping.length,
    mappingSample: sampled.items,
    omitted: sampled.omitted,
    invariants: {
      ok: issues.length === 0,
      issues,
      coverage: { span: round(span, 4), totalDisplay: round(totalDisplay, 4), tolerance: round(tol, 4) },
    },
  };
}

/** Per-frame drop evidence: transition similarity + cadence support + source mapping. */
function buildDropEvidence({ frames, runDecisions, transitions, kept }, budget) {
  const keptById = new Map(kept.map((k) => [k.sourceFrame, k]));
  const rdById = new Map(runDecisions.map((rd) => [rd.id, rd]));
  const rows = [];
  for (const f of frames) {
    if (f.action !== "drop") continue;
    const rd = rdById.get(f.runId);
    const t = transitions[f.index];
    const keptFrame = keptById.get(f.keptFrame);
    rows.push({
      frame: f.index,
      time: round(f.time, 4),
      keptSourceFrame: f.keptFrame,
      keptTime: round(keptFrame?.time ?? f.keptTime, 4),
      displayDuration: round(keptFrame?.displayDuration, 4),
      diff: round(t?.diffMean, 3),
      gain: round(t?.motionGain, 3),
      uncertain: Boolean(t?.uncertain),
      runId: f.runId,
      phase: f.phase,
      period: f.period,
      predicted: rd?.predicted ?? null,
      support: t && !t.isChange && !t.uncertain ? "detection+cadence" : "cadence-only",
      reason: f.reason,
    });
  }
  const sampled = sampleEven(rows, budget.maxDropEvidence);
  return { total: sampled.total, sample: sampled.items, omitted: sampled.omitted, stride: round(sampled.stride, 2) };
}

/**
 * Root-cause classification. The categories are deliberately distinct so the
 * UI never presents an observation limit as an implementation bug:
 *
 *   sufficient                 detection and cadence agree; deletions are backed
 *   insufficient-observation   pixels cannot separate a short static hold from a
 *                              codec duplicate (identical by construction)
 *   implementation-misjudgment the code contradicts its own evidence: a cadence
 *                              drop without copy evidence, or an inconsistent
 *                              source-frame mapping / timeline invariant
 *
 * The discriminator between "stable global cadence" and "static hold read as
 * copies" is the phase transform: a genuine cadence keeps one phase offset for
 * the whole clip (a proven static hold may split the fit but resumes the same
 * offset). Re-fitting the phase across *non-static* content boundaries means
 * the model is stitching local duplicate clusters together, which is exactly
 * what a static shot mistaken for a periodic pattern looks like.
 */
function classifyRootCause({ fit, classification, invariants, phaseStory, pathComparison, ambiguousStatic }) {
  if (!invariants.ok) {
    const first = invariants.issues[0];
    return {
      category: "implementation-misjudgment",
      stage: first.stage,
      code: first.code,
      detail: first.detail,
      explanation: "节奏恢复代码与自身证据链不一致（源帧映射或删除支持异常），属于实现误判，需定位到阶段修复。",
    };
  }
  if (pathComparison.agreement.onlyCadence > 0) {
    return {
      category: "implementation-misjudgment",
      stage: "decide",
      code: "cadence-only-deletion",
      detail: `有 ${pathComparison.agreement.onlyCadence} 帧由节奏反推删除，但检测端未给出可信复制证据`,
      explanation: "节奏反推与检测端证据冲突，属于实现误判。",
    };
  }
  const nonStaticTransforms = (phaseStory?.phaseTransforms || []).filter((t) => t.cause !== "static-hold");
  if (nonStaticTransforms.length > 0) {
    const at = nonStaticTransforms.map((t) => `#${t.atFrame}（相位 ${t.before}→${t.after}，分隔：${t.cause}）`).join("、");
    return {
      category: "insufficient-observation",
      stage: "fit",
      code: "static-vs-copies",
      detail: `节奏相位在内容边界处被重新拟合 ${nonStaticTransforms.length} 次：${at}`,
      explanation:
        "相位不是全片稳定的单一节奏，而是在非静止边界处反复重排；短静止保持与编码复制在像素上完全一致，无法区分。删除不改变时间轴，但“复制重复”的归因不可靠，应保留并按不确定处理。",
      phaseTransforms: nonStaticTransforms,
      ambiguousRuns: ambiguousStatic.map((l) => l.runId),
    };
  }
  if (fit.allStatic) {
    return {
      category: "insufficient-observation",
      stage: "classify",
      code: "all-static",
      detail: fit.reason,
      explanation: "全片画面几乎不变，像素证据无法区分复制重复与真实静止；应保留多解与完整时长。",
    };
  }
  if (ambiguousStatic.length > 0) {
    return {
      category: "insufficient-observation",
      stage: "fit",
      code: "static-vs-copies",
      detail: `有 ${ambiguousStatic.length} 个复制区间处于近静止上下文，可能是真实静止被节奏模式切分`,
      explanation: "该处内容静止与编码重复在像素上不可分，属于观测不足而非实现误判；删除不改变时间轴，但原因应标为不确定。",
      ambiguousRuns: ambiguousStatic.map((l) => l.runId),
    };
  }
  if (fit.ambiguous) {
    return {
      category: "insufficient-observation",
      stage: "fit",
      code: "ambiguous-fit",
      detail: fit.reason,
      explanation: "多个节奏假设得分接近或匹配不足，证据不足以唯一定判；已保留不确定区。",
    };
  }
  if (classification.evidence !== "bimodal") {
    return {
      category: "sufficient",
      stage: "classify",
      code: classification.evidence,
      detail: `证据模式 ${classification.evidence}，未发现可分离的复制簇`,
      explanation: "没有成规模的复制重复，输出不删除真实更新帧。",
    };
  }
  return {
    category: "sufficient",
    stage: "fit",
    code: "cadence-confirmed",
    detail: fit.reason,
    explanation: "检测端与节奏反推一致，删除的候选帧均有可信复制证据支撑，且节奏相位在全片稳定。",
  };
}

export function buildCadenceTrace(ctx, options = {}) {
  const budget = { ...DEFAULT_BUDGET, ...(options.budget || {}) };
  const { media, decoded, pairwise, classification, runs, fit, decisions } = ctx;
  const segment = ctx.segment || { start: decoded?.segStart ?? 0, end: decoded?.segEnd ?? media?.duration ?? 0 };
  const frameTimes = ctx.frameTimes || decoded?.frames?.map((f) => f.t) || [];
  const transitions = classification.transitions;
  // The threshold lives on the classification, not the fit; expose it to run-link
  // context checks without mutating caller objects.
  const fitWithThreshold = Object.create(fit);
  fitWithThreshold.__threshold = classification.threshold;

  const stages = [
    {
      id: "classify",
      ok: true,
      inputs: { transitions: transitions.length, outFps: media?.video?.fps ?? null },
      outputs: {
        evidence: classification.evidence,
        threshold: round(classification.threshold, 3),
        copyLevel: round(classification.copyLevel, 3),
        changeLevel: round(classification.changeLevel, 3),
      },
    },
    {
      id: "runs",
      ok: true,
      inputs: { transitions: transitions.length },
      outputs: { runs: runs.length },
    },
    {
      id: "fit",
      ok: true,
      inputs: { candidates: fit.candidates.length, outFps: fit.outFps },
      outputs: {
        best: fit.best?.presetId ?? null,
        ambiguous: Boolean(fit.ambiguous),
        allStatic: Boolean(fit.allStatic),
        locked: Boolean(fit.locked),
      },
    },
    {
      id: "decide",
      ok: true,
      inputs: { runs: runs.length },
      outputs: {
        kept: decisions.kept.length,
        frames: decisions.frames.length,
        drops: decisions.frames.filter((f) => f.action === "drop").length,
      },
    },
  ];

  const similarity = buildSimilarity(classification, transitions, budget);
  const pathComparison = buildPathComparison({ transitions, frames: decisions.frames, budget });
  const candidates = buildCandidates(fit.candidates, fit.best, fit.runInfo, segment, frameTimes);
  const runLinkOut = buildRunLinks({ runs, runDecisions: decisions.runDecisions, transitions, fit: fitWithThreshold, segment }, budget);
  const phaseStory = buildPhaseStory(runs, decisions.runDecisions, fit);
  const mapping = buildMappingAndInvariants(
    { frames: decisions.frames, kept: decisions.kept, frameTimes, segment, fit, transitions, runDecisions: decisions.runDecisions },
    budget,
  );
  const dropEvidence = buildDropEvidence(
    { frames: decisions.frames, runDecisions: decisions.runDecisions, transitions, kept: decisions.kept },
    budget,
  );

  const ambiguousStatic = runLinkOut.links.filter((l) => l.staticContextAmbiguous);
  const rootCause = classifyRootCause({
    fit,
    classification,
    invariants: mapping.invariants,
    phaseStory,
    pathComparison,
    ambiguousStatic,
  });
  if (!mapping.invariants.ok) {
    stages.find((s) => s.id === mapping.invariants.issues[0].stage).ok = false;
  }

  const trace = {
    schemaVersion: 1,
    readOnly: true,
    segment: { start: round(segment.start, 4), end: round(segment.end, 4) },
    timebase: {
      outFps: media?.video?.fps ?? null,
      frameDt: round(fit.frameDt, 6),
      frameCount: frameTimes.length,
      firstTime: round(frameTimes[0], 4),
      lastTime: round(frameTimes[frameTimes.length - 1], 4),
      timeSamples: sampleEven(
        frameTimes.map((t, i) => ({ index: i, t: round(t, 4) })),
        budget.maxTransitions,
      ).items,
    },
    stages,
    similarity,
    candidates,
    runLinks: runLinkOut.sample,
    runLinksTotal: runLinkOut.total,
    runLinksOmitted: runLinkOut.omitted,
    dropEvidence,
    phaseStory,
    pathComparison,
    mapping: {
      keptSourceFrames: mapping.keptSourceFrames,
      sample: mapping.mappingSample,
      omitted: mapping.omitted,
      invariants: mapping.invariants,
    },
    rootCause,
    budget,
  };
  trace.summary = summarizeTrace(trace);
  return trace;
}

/** Compact, bounded summary suitable for logs and UI headers. */
export function summarizeTrace(trace) {
  const r = trace.rootCause;
  return {
    category: r.category,
    stage: r.stage,
    code: r.code,
    detail: r.detail,
    runs: trace.runLinksTotal ?? trace.runLinks.length,
    drops: trace.dropEvidence.total,
    kept: trace.mapping.keptSourceFrames,
    detectionCopies: trace.pathComparison.detectionEnd.copies,
    cadenceDrops: trace.pathComparison.cadenceBack.drops,
    onlyCadenceDrops: trace.pathComparison.agreement.onlyCadence,
    onlyDetectionKept: trace.pathComparison.agreement.onlyDetection,
    staticSegments: trace.phaseStory.staticSegments.length,
    phaseTransforms: trace.phaseStory.phaseTransforms.length,
    ambiguousStaticRuns: r.ambiguousRuns?.length ?? 0,
    invariantsOk: trace.mapping.invariants.ok,
    issues: trace.mapping.invariants.issues.length,
  };
}

/** Bounded human-readable lines for CLI/log output; never exceeds the budget. */
export function traceLogLines(trace, maxLines = trace.budget?.maxLogLines ?? 200) {
  const lines = [];
  const push = (s) => {
    if (lines.length < maxLines) lines.push(s);
  };
  const s = trace.summary || summarizeTrace(trace);
  push(`诊断：${s.category}（阶段 ${s.stage}，代码 ${s.code}）`);
  push(`  ${s.detail}`);
  push(
    `  区间 ${s.runs} · 删除候选 ${s.drops} · 保留源帧 ${s.kept} · 检测端复制帧 ${s.detectionCopies} · 节奏反推删除 ${s.cadenceDrops}（仅节奏 ${s.onlyCadenceDrops} / 仅检测保留 ${s.onlyDetectionKept}）`,
  );
  push(`  静止段 ${s.staticSegments} · 相位变换 ${s.phaseTransforms} · 不变量 ${s.invariantsOk ? "通过" : `异常 ${s.issues}`}`);
  for (const issue of trace.mapping.invariants.issues.slice(0, 10)) {
    push(`  ! [${issue.stage}] ${issue.code}: ${issue.detail}`);
  }
  const conflictLinks = trace.runLinks.filter((l) => l.conflict);
  for (const l of conflictLinks.slice(0, 10)) {
    push(`  ! 区间 #${l.start}-#${l.end - 1} 冲突：${l.conflict}`);
  }
  const amb = trace.runLinks.filter((l) => l.staticContextAmbiguous);
  for (const l of amb.slice(0, 10)) {
    push(
      `  ? 区间 #${l.start}-#${l.end - 1} 近静止上下文（邻域边界差异中位 ${l.neighbourhood.boundaryMedianDiff}，窗口 ${l.neighbourhood.windowDuration}s），可能为真实静止`,
    );
  }
  push(`  候选支持（前 ${Math.min(6, trace.candidates.length)}）：`);
  for (const c of trace.candidates.slice(0, 6)) {
    push(
      `    ${c.isBest ? "*" : " "} ${c.label} 模式[${c.pattern.join("/")}] 得分 ${(c.support.score * 100).toFixed(0)}% 覆盖 ${(c.support.coverage * 100).toFixed(0)}% 相位段 ${c.phaseSegments.length} 隐含保留 ${c.impliedMapping.kept}/删除 ${c.impliedMapping.dropped}`,
    );
  }
  if (trace.dropEvidence.total > trace.dropEvidence.sample.length) {
    push(`  删除证据仅列出采样 ${trace.dropEvidence.sample.length}/${trace.dropEvidence.total}（步长 ${trace.dropEvidence.stride}）`);
  }
  if (lines.length >= maxLines) lines[maxLines - 1] = `  … 已达日志上限 ${maxLines} 行`;
  return lines;
}

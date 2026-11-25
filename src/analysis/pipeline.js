import { probeMedia } from "../util/media.js";
import { decodeFrames, computePairwise } from "./decode.js";
import {
  classifyTransitions,
  buildRuns,
  fitCadence,
  decideFrames,
  presetById,
  RHYTHM_PRESETS,
} from "./cadence.js";
import { buildCadenceTrace } from "./trace.js";

/**
 * Analyse a media file (or a [start,end) segment of it) and produce:
 *   - per-transition evidence,
 *   - content runs (copies / real static holds),
 *   - a fitted cadence hypothesis and its alternatives,
 *   - per-run and per-frame decisions with reasons,
 *   - a compact summary for the UI.
 *
 * `options.presetId` locks the cadence (null/"auto" = auto-detect).
 */
export async function analyzeMedia(file, options = {}) {
  const {
    start = 0,
    end = null,
    presetId = "auto",
    minStaticDuration,
    keepUncertain = true,
    onProgress = null,
  } = options;

  const media = await probeMedia(file);
  aassertAnalysable(media);
  if (onProgress) onProgress({ phase: "decode", progress: 0 });

  const decoded = await decodeFrames(media, { start, end, onProgress });
  if (onProgress) onProgress({ phase: "metrics", progress: 0.55 });
  const pairwise = computePairwise(decoded);
  const frameTimes = decoded.frames.map((f) => f.t);

  if (onProgress) onProgress({ phase: "classify", progress: 0.75 });
  const classification = classifyTransitions(pairwise);
  const runs = buildRuns(classification.transitions, frameTimes);

  if (onProgress) onProgress({ phase: "fit", progress: 0.86 });
  const selected = presetId && presetId !== "auto" ? presetById(presetId) : null;
  const presets = selected
    ? RHYTHM_PRESETS.filter((p) => p.id === selected.id || p.id === "native")
    : RHYTHM_PRESETS;

  const segmentEnd =
    end != null ? Math.min(end, media.duration ?? end) : media.duration ?? null;
  const fit = fitCadence(runs, media.video.fps || 30, {
    presets: presets.filter((p) => p.id !== "auto"),
    minStaticDuration,
    segmentEnd,
  });

  // If the user explicitly locked a cadence, do not let a low score silently
  // redirect the decision: keep their hypothesis as best but report the miss.
  let locked = null;
  if (selected && selected.id !== "native" && selected.sourceFps !== "native") {
    locked = fit.candidates.find((c) => c.presetId === selected.id) || null;
    if (locked) {
      fit.best = locked;
      fit.second = fit.candidates.find((c) => c !== locked) || null;
      fit.ambiguous = false;
      fit.locked = true;
      fit.reason = locked.score >= 0.6
        ? `按指定节奏 ${locked.label}：匹配 ${(locked.score * 100).toFixed(0)}%，覆盖 ${(locked.coverage * 100).toFixed(0)}% 画面时长`
        : `按指定节奏 ${locked.label}：匹配仅 ${(locked.score * 100).toFixed(0)}%，存在与节奏不符的区间，已保留`;
    }
  } else if (selected && (selected.id === "native" || selected.sourceFps === "native")) {
    const native = fit.candidates.find((c) => c.sourceFps === (media.video.fps || 30));
    if (native) {
      fit.best = native;
      fit.ambiguous = false;
      fit.locked = true;
      fit.reason = "按指定“无复制”处理：不删除任何帧（可能仍保留真实停顿）";
    }
  }

  const decisions = decideFrames({
    runs,
    fit,
    transitions: classification.transitions,
    frameTimes,
    options: { keepUncertain },
  });

  // Read-only evidence chain: trace how the cadence was inferred and where a
  // static hold could be mistaken for a copy pattern. Building it never changes
  // the decisions above (the trace takes decisions as fixed input).
  const trace = buildCadenceTrace(
    {
      media,
      decoded,
      frameTimes,
      pairwise,
      classification,
      runs,
      fit,
      decisions,
      segment: { start: decoded.segStart, end: decoded.segEnd },
    },
    { budget: options.traceBudget },
  );

  if (onProgress) onProgress({ phase: "done", progress: 1 });

  const frameTimesAll = frameTimes;
  const summary = summarize({
    media,
    decoded,
    classification,
    fit,
    decisions,
    start,
    end,
  });

  return {
    file,
    media,
    segment: { start: decoded.segStart, end: decoded.segEnd },
    frames: decoded.frames,
    frameTimes: frameTimesAll,
    decoded: {
      frameCount: decoded.frames.length,
      width: decoded.width,
      height: decoded.height,
      fps: decoded.fps,
      frameTimes: frameTimesAll,
      segStart: decoded.segStart,
      segEnd: decoded.segEnd,
    },
    classification,
    runs,
    fit,
    decisions,
    trace,
    summary,
    options: { presetId, keepUncertain, minStaticDuration: minStaticDuration ?? null },
  };
}

function aassertAnalysable(media) {
  if (!media.video.width || !media.video.height) throw new Error("视频尺寸无效");
  if (media.video.isImage) throw new Error("输入看起来是单张图片，无法进行节奏分析");
  if (media.video.interlaced) {
    // We still analyse it, but warn the user through the summary.
  }
}

function summarize({ media, decoded, classification, fit, decisions, start, end }) {
  const counts = { keep: 0, drop: 0, "keep-static": 0, "drop-static": 0, "keep-uncertain": 0 };
  for (const f of decisions.frames) counts[f.action] = (counts[f.action] || 0) + 1;
  const kept = decisions.kept.length;
  const total = decisions.frames.length;
  const best = fit.best;
  // All-static footage gives no cadence evidence; do not present a rate as if
  // it were recovered.
  const claimed = fit.allStatic ? null : best;
  const segmentEnd = decoded.segEnd ?? media.duration;
  const segmentStart = decoded.segStart ?? 0;
  const preserved = {
    duration: segmentEnd != null ? Math.max(0, segmentEnd - segmentStart) : null,
    frameCount: total,
    keptFrames: kept,
  };
  const uncertainRuns = decisions.runDecisions.filter(
    (r) => r.action === "keep-uncertain",
  ).length;
  const staticRuns = decisions.runDecisions.filter((r) => r.isStatic).length;
  return {
    title: "节奏恢复分析",
    outFps: media.video.fps,
    sourceFps: claimed?.sourceFps ?? null,
    sourceFpsLabel: claimed?.label ?? null,
    ratio: claimed?.n && claimed?.d ? `${claimed.n}/${claimed.d}` : null,
    pattern: claimed?.pattern ?? null,
    phase: claimed?.offset ?? null,
    confidence: claimed ? Math.round(claimed.score * 100) : null,
    coverage: claimed ? Math.round(claimed.coverage * 100) : null,
    ambiguous: Boolean(fit.ambiguous),
    locked: Boolean(fit.locked),
    allStatic: Boolean(fit.allStatic),
    evidence: classification.evidence,
    threshold: classification.threshold,
    copyLevel: classification.copyLevel,
    changeLevel: classification.changeLevel,
    counts,
    keptFrames: kept,
    totalFrames: total,
    keptRatio: total ? kept / total : 0,
    uncertainRuns,
    staticRuns,
    preserved,
    notes: buildNotes({ media, fit, decisions, counts }),
    warnings: buildWarnings({ media, fit, decisions, classification }),
  };
}

function buildNotes({ media, fit, decisions, counts }) {
  const notes = [];
  const best = fit.best;
  if (fit.allStatic) {
    notes.push("全片画面几乎不变：无法从画面区分“复制重复”和“真实静止”，已保留全部帧与完整时长。");
  } else if (best && !fit.ambiguous) {
    notes.push(
      `识别到源画面约 ${best.sourceFps.toFixed(2)} fps（${best.label}），在 ${fit.outFps.toFixed(2)} fps 输出中按 ${best.pattern.join("/")} 重复。`,
    );
  } else {
    notes.push(`节奏证据不足（${fit.reason}），已保留不确定区，不执行删除。`);
  }
  if (counts["keep-static"] || counts["drop-static"]) {
    const staticRuns = decisions.runDecisions.filter((r) => r.isStatic);
    const totalStatic = staticRuns.reduce((a, r) => a + r.duration, 0);
    notes.push(
      `检测到 ${staticRuns.length} 段真实静止（合计约 ${totalStatic.toFixed(2)} 秒），这些区间只保留首帧并按原时长显示，静止时间不会被压缩。`,
    );
  }
  if (counts["keep-uncertain"]) {
    notes.push(`有 ${counts["keep-uncertain"]} 帧处于不确定区，全部保留并以原因标注。`);
  }
  notes.push("输出保留原事件发生时间：每个保留帧的时间戳等于它在原片中的时间，未修改容器帧率标签冒充恢复。");
  if (media.audio) notes.push("原音轨按流复制原样写入，声音与画面事件时间保持对应。");
  return notes;
}

function buildWarnings({ media, fit, decisions, classification }) {
  const warnings = [];
  if (media.video.interlaced) warnings.push("输入为隔行视频，重复帧检测在逐行解码后进行，可能受场序影响。");
  if (!media.video.isProgressive) warnings.push("检测到非逐行帧序（field_order），结果可能不稳定。");
  if (fit.ambiguous) warnings.push("节奏判定不确定，已保留多数帧；如需裁剪请指定节奏后再试。");
  if (classification.evidence === "no-copies" && decisions.kept.length === decisions.frames.length) {
    warnings.push("未检出成规模的复制重复，输出与输入帧数相同。");
  }
  if (fit.best && fit.best.score < 0.6 && !fit.allStatic) warnings.push(`节奏模型匹配度偏低（${(fit.best.score * 100).toFixed(0)}%）。`);
  if (fit.locked && fit.best && fit.best.score < 0.6) warnings.push("指定的节奏与画面证据不符，已保留可疑区间。");
  return warnings;
}

/** Resolve a requested segment against media duration, with sanity checks. */
export function normalizeSegment(media, start, end) {
  const dur = media.duration ?? 0;
  let s = Math.max(0, Number(start) || 0);
  let e = end == null || end === "" ? dur : Math.max(0, Number(end));
  if (dur > 0) e = Math.min(e, dur);
  if (e <= s) throw new Error("片段结束时间必须大于开始时间");
  if (e - s < 0.2) throw new Error("片段过短（至少 0.2 秒）");
  return { start: s, end: e };
}

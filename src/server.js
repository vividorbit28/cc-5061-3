import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  ensureDirs,
  probeMedia,
  newId,
  UPLOAD_DIR,
  OUTPUT_DIR,
  SAMPLE_DIR,
  PROJECT_ROOT,
  formatTime,
} from "./util/media.js";
import { analyzeMedia, normalizeSegment } from "./analysis/pipeline.js";
import { renderRecovered, sanitizeName } from "./util/render.js";
import { RHYTHM_PRESETS } from "./analysis/cadence.js";
import { buildAllFixtures, fixtureSpecs } from "../test/fixtures.js";

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

const jobs = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendError(res, 403, "禁止访问");
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return sendError(res, 404, "页面不存在");
  }
  if (!stat.isFile()) return sendError(res, 404, "页面不存在");
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(filePath).pipe(res);
}

/** Range-aware media streaming (needed by <video> seeking). */
async function serveMediaFile(req, res, filePath, contentType) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return sendError(res, 404, "媒体不存在");
  }
  const size = stat.size;
  const range = req.headers.range;
  const type = contentType || MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (start >= size || end < start) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

async function saveUpload(req, filename) {
  await ensureDirs();
  const safe = sanitizeName(filename || "upload.mp4");
  const ext = path.extname(safe) || ".mp4";
  const id = newId("up_");
  const target = path.join(UPLOAD_DIR, `${id}${ext}`);
  await fsp.writeFile(target, Readable.from(req));
  const stat = await fsp.stat(target);
  if (stat.size === 0) throw new Error("上传内容为空");
  return { id, path: target, originalName: safe, size: stat.size };
}

function uploadResponse(upload) {
  return {
    id: upload.id,
    name: upload.originalName,
    size: upload.size,
    url: `/api/media/${upload.id}`,
  };
}

function resolveMediaById(id) {
  if (/^sample_/.test(id)) {
    const name = id.replace(/^sample_/, "");
    const safe = sanitizeName(name);
    const file = path.join(SAMPLE_DIR, safe.endsWith(".mp4") ? safe : `${safe}.mp4`);
    return fs.existsSync(file) ? file : null;
  }
  if (!/^up_[0-9a-f]+$/.test(id)) return null;
  const dir = UPLOAD_DIR;
  const entries = fs.readdirSync(dir).filter((f) => f.startsWith(id + "."));
  return entries.length ? path.join(dir, entries[0]) : null;
}

function resolveOutputById(id) {
  if (!/^out_[0-9a-f]+$/.test(id)) return null;
  const file = path.join(OUTPUT_DIR, `${id}.mp4`);
  return fs.existsSync(file) ? file : null;
}

async function listSamples() {
  await ensureDirs();
  const specs = fixtureSpecs();
  const out = [];
  for (const spec of specs) {
    const file = path.join(SAMPLE_DIR, `${spec.name}.mp4`);
    const manifestFile = path.join(SAMPLE_DIR, `${spec.name}.json`);
    if (!fs.existsSync(file)) continue;
    let manifest = null;
    try {
      manifest = JSON.parse(await fsp.readFile(manifestFile, "utf8"));
    } catch {
      manifest = null;
    }
    out.push({
      id: `sample_${spec.name}`,
      name: spec.name,
      title: spec.title,
      description: spec.description,
      url: `/api/media/sample_${spec.name}`,
      expected: manifest
        ? {
            sourceFps: manifest.sourceFps,
            pattern: manifest.pattern,
            sourceCount: manifest.sourceCount,
            outputCount: manifest.outputCount,
            duration: manifest.duration,
            staticRanges: manifest.staticRanges,
            beepTimes: manifest.beepTimes,
            noise: manifest.noise,
          }
        : null,
    });
  }
  return out;
}

let sampleBuild = null;
async function ensureSamples() {
  if (sampleBuild) return sampleBuild;
  sampleBuild = buildAllFixtures({ force: false }).catch((err) => {
    sampleBuild = null;
    throw err;
  });
  return sampleBuild;
}

function jobSnapshot(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    message: job.message,
    error: job.error || null,
    result: job.publicResult || null,
  };
}

const routes = {
  "GET /api/presets": async (req, res) => {
    sendJson(res, 200, { presets: RHYTHM_PRESETS });
  },

  "GET /api/samples": async (req, res) => {
    if (req.url.includes("build=1")) await ensureSamples();
    sendJson(res, 200, { samples: await listSamples() });
  },

  "POST /api/samples/build": async (req, res) => {
    const list = await buildAllFixtures({ force: true, log: (m) => console.log(m) });
    sendJson(res, 200, { built: list.length });
  },

  "POST /api/upload": async (req, res) => {
    const url = new URL(req.url, "http://x");
    const upload = await saveUpload(req, url.searchParams.get("name"));
    sendJson(res, 200, uploadResponse(upload));
  },

  "GET /api/media/:id": async (req, res, params) => {
    const file = resolveMediaById(params.id);
    if (!file) return sendError(res, 404, "媒体不存在");
    await serveMediaFile(req, res, file);
  },

  "GET /api/outputs/:id": async (req, res, params) => {
    const file = resolveOutputById(params.id);
    if (!file) return sendError(res, 404, "结果不存在");
    if (new URL(req.url, "http://x").searchParams.get("download") === "1") {
      const stat = await fsp.stat(file);
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${params.id}.mp4"`,
      });
      return fs.createReadStream(file).pipe(res);
    }
    await serveMediaFile(req, res, file);
  },

  "GET /api/info/:id": async (req, res, params) => {
    const file = resolveMediaById(params.id);
    if (!file) return sendError(res, 404, "媒体不存在");
    const media = await probeMedia(file);
    sendJson(res, 200, {
      duration: media.duration,
      fps: media.video.fps,
      width: media.video.width,
      height: media.video.height,
      videoCodec: media.video.codec,
      audioCodec: media.audio?.codec ?? null,
      audio: Boolean(media.audio),
      interlaced: media.video.interlaced,
      nbFrames: media.video.nbFrames,
      size: media.size,
    });
  },

  "POST /api/analyze": async (req, res) => {
    const body = await readJson(req);
    const file = resolveMediaById(body.mediaId);
    if (!file) return sendError(res, 404, "媒体不存在");
    const media = await probeMedia(file);
    const segment = normalizeSegment(media, body.start, body.end);
    const t0 = Date.now();
    const result = await analyzeMedia(file, {
      start: segment.start,
      end: segment.end,
      presetId: body.presetId || "auto",
      keepUncertain: body.keepUncertain !== false,
    });
    const payload = publicAnalysis(result, media, file, body.mediaId, segment);
    payload.elapsedMs = Date.now() - t0;
    sendJson(res, 200, payload);
  },

  "POST /api/render": async (req, res) => {
    const body = await readJson(req);
    const file = resolveMediaById(body.mediaId);
    if (!file) return sendError(res, 404, "媒体不存在");
    const media = await probeMedia(file);
    const segment = normalizeSegment(media, body.start, body.end);

    const analysis = await analyzeMedia(file, {
      start: segment.start,
      end: segment.end,
      presetId: body.presetId || "auto",
      keepUncertain: body.keepUncertain !== false,
    });

    // Optional manual overrides: list of source frame indices to drop.
    let kept = analysis.decisions.kept;
    let overrideInfo = null;
    if (Array.isArray(body.dropFrames) && body.dropFrames.length) {
      const drop = new Set(body.dropFrames.filter((n) => Number.isInteger(n) && n >= 0));
      const keptIndices = analysis.decisions.kept.map((k) => k.sourceFrame).filter((i) => !drop.has(i));
      if (!keptIndices.length) return sendError(res, 400, "手动裁剪会删除全部保留帧");
      kept = rebuildKept(analysis, keptIndices, segment.end);
      overrideInfo = { dropped: drop.size };
    }

    const outId = newId("out_");
    const outputPath = path.join(OUTPUT_DIR, `${outId}.mp4`);
    const render = await renderRecovered({
      media,
      kept,
      outputPath,
      options: { keepAudio: body.keepAudio !== false, crf: clampCrf(body.crf) },
    });

    const summary = analysis.summary;
    sendJson(res, 200, {
      id: outId,
      url: `/api/outputs/${outId}`,
      downloadUrl: `/api/outputs/${outId}?download=1`,
      fileName: `${sanitizeName(body.mediaName || "recovered")}_recovered.mp4`,
      keptFrames: render.keptCount,
      inputFrames: analysis.decoded.frameCount,
      duration: render.total,
      verification: render.verification,
      keptTimeline: render.keptTimeline,
      outputFrames: render.outputFrames,
      override: overrideInfo,
      rhythm: {
        sourceFps: summary.sourceFps,
        label: summary.sourceFpsLabel,
        pattern: summary.pattern,
        confidence: summary.confidence,
        coverage: summary.coverage,
      },
      segment,
    });
  },

  // Async job variants used by the UI so progress can be shown.
  "POST /api/jobs/analyze": async (req, res) => {
    const body = await readJson(req);
    const id = newId("job_");
    const job = { id, status: "queued", phase: "queued", progress: 0, message: "排队中" };
    jobs.set(id, job);
    runAnalyzeJob(job, body).catch(() => {});
    sendJson(res, 202, jobSnapshot(job));
  },

  "POST /api/jobs/render": async (req, res) => {
    const body = await readJson(req);
    const id = newId("job_");
    const job = { id, status: "queued", phase: "queued", progress: 0, message: "排队中" };
    jobs.set(id, job);
    runRenderJob(job, body).catch(() => {});
    sendJson(res, 202, jobSnapshot(job));
  },

  "GET /api/jobs/:id": async (req, res, params) => {
    const job = jobs.get(params.id);
    if (!job) return sendError(res, 404, "任务不存在");
    sendJson(res, 200, jobSnapshot(job));
  },

  "GET /api/health": async (req, res) => {
    sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  },
};

function clampCrf(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 18;
  return Math.min(35, Math.max(12, Math.round(n)));
}

function rebuildKept(analysis, keptIndices, segmentEnd) {
  const fps = analysis.media.video.fps || 30;
  const frameDt = 1 / fps;
  const sorted = [...keptIndices].sort((a, b) => a - b);
  const times = analysis.decoded.frameTimes;
  return sorted.map((idx, i) => {
    const next = i < sorted.length - 1 ? times[sorted[i + 1]] : (segmentEnd ?? times[sorted[i]]) + frameDt;
    return {
      sourceFrame: idx,
      time: times[idx],
      displayStart: times[idx],
      displayEnd: next,
      displayDuration: next - times[idx],
      action: "keep",
      reason: "手动保留",
      confidence: 1,
    };
  });
}

async function runAnalyzeJob(job, body) {
  try {
    job.status = "running";
    job.phase = "probe";
    job.message = "读取媒体信息";
    const file = resolveMediaById(body.mediaId);
    if (!file) throw new Error("媒体不存在");
    const media = await probeMedia(file);
    const segment = normalizeSegment(media, body.start, body.end);
    job.media = media;
    const result = await analyzeMedia(file, {
      start: segment.start,
      end: segment.end,
      presetId: body.presetId || "auto",
      keepUncertain: body.keepUncertain !== false,
      onProgress: (p) => {
        job.phase = p.phase;
        job.progress = p.progress ?? job.progress;
        job.message = phaseLabel(p.phase);
      },
    });
    job.publicResult = publicAnalysis(result, media, file, body.mediaId, segment);
    job.status = "done";
    job.phase = "done";
    job.progress = 1;
    job.message = "分析完成";
  } catch (err) {
    job.status = "error";
    job.error = err.message;
    job.message = err.message;
  }
}

async function runRenderJob(job, body) {
  try {
    job.status = "running";
    job.phase = "analyze";
    job.message = "分析节奏";
    const file = resolveMediaById(body.mediaId);
    if (!file) throw new Error("媒体不存在");
    const media = await probeMedia(file);
    const segment = normalizeSegment(media, body.start, body.end);
    const analysis = await analyzeMedia(file, {
      start: segment.start,
      end: segment.end,
      presetId: body.presetId || "auto",
      keepUncertain: body.keepUncertain !== false,
      onProgress: (p) => {
        job.phase = p.phase;
        job.progress = (p.progress ?? 0) * 0.6;
        job.message = phaseLabel(p.phase);
      },
    });
    let kept = analysis.decisions.kept;
    if (Array.isArray(body.dropFrames) && body.dropFrames.length) {
      const drop = new Set(body.dropFrames.filter((n) => Number.isInteger(n) && n >= 0));
      kept = rebuildKept(analysis, kept.map((k) => k.sourceFrame).filter((i) => !drop.has(i)), segment.end);
      if (!kept.length) throw new Error("手动裁剪会删除全部保留帧");
    }
    job.phase = "render";
    job.progress = 0.65;
    job.message = "重封装视频（按原时间戳）";
    const outId = newId("out_");
    const outputPath = path.join(OUTPUT_DIR, `${outId}.mp4`);
    const render = await renderRecovered({
      media,
      kept,
      outputPath,
      options: { keepAudio: body.keepAudio !== false, crf: clampCrf(body.crf) },
    });
    const summary = analysis.summary;
    job.publicResult = {
      id: outId,
      url: `/api/outputs/${outId}`,
      downloadUrl: `/api/outputs/${outId}?download=1`,
      fileName: `${sanitizeName(body.mediaName || "recovered")}_recovered.mp4`,
      keptFrames: render.keptCount,
      inputFrames: analysis.decoded.frameCount,
      duration: render.total,
      verification: render.verification,
      keptTimeline: render.keptTimeline,
      outputFrames: render.outputFrames,
      rhythm: {
        sourceFps: summary.sourceFps,
        label: summary.sourceFpsLabel,
        pattern: summary.pattern,
        confidence: summary.confidence,
        coverage: summary.coverage,
      },
      analysisSource: publicAnalysis(analysis, media, file, body.mediaId, segment),
      segment,
    };
    job.status = "done";
    job.phase = "done";
    job.progress = 1;
    job.message = "重封装完成";
  } catch (err) {
    job.status = "error";
    job.error = err.message;
    job.message = err.message;
  }
}

function phaseLabel(phase) {
  return (
    {
      probe: "读取媒体信息",
      decode: "解码并提取逐帧特征",
      metrics: "计算帧间差异与运动证据",
      classify: "区分复制帧与真实更新",
      fit: "拟合节奏相位",
      done: "完成",
      render: "按原时间戳重封装",
    }[phase] || phase
  );
}

/** Build the public analysis payload consumed by the UI. */
function publicAnalysis(result, media, file, mediaId, segment) {
  const { decoded, classification, runs, fit, decisions, summary } = result;
  const frameTimes = result.frameTimes || decoded.frameTimes || [];
  const frames = decisions.frames.map((f) => ({
    i: f.index,
    t: round(f.time, 4),
    a: f.action,
    r: f.runId,
    d: round(f.diffMean, 3),
    m: round(f.motionGain, 3),
    e: round(f.eqFrac, 3),
    c: round(f.confidence, 2),
  }));
  return {
    mediaId,
    media: {
      duration: media.duration,
      fps: media.video.fps,
      width: media.video.width,
      height: media.video.height,
      videoCodec: media.video.codec,
      audioCodec: media.audio?.codec ?? null,
      hasAudio: Boolean(media.audio),
      interlaced: media.video.interlaced,
    },
    segment,
    summary,
    rhythm: {
      outFps: fit.outFps,
      best: fit.best
        ? {
            presetId: fit.best.presetId,
            label: fit.best.label,
            sourceFps: fit.best.sourceFps,
            ratio: `${fit.best.n}/${fit.best.d}`,
            pattern: fit.best.pattern,
            phase: fit.best.offset,
            score: round(fit.best.score, 3),
            coverage: round(fit.best.coverage, 3),
            staticFrames: fit.best.staticFrames,
          }
        : null,
      second: fit.second
        ? { label: fit.second.label, score: round(fit.second.score, 3), coverage: round(fit.second.coverage, 3) }
        : null,
      candidates: fit.candidates.map((c) => ({
        presetId: c.presetId,
        label: c.label,
        sourceFps: c.sourceFps,
        ratio: `${c.n}/${c.d}`,
        pattern: c.pattern,
        score: round(c.score, 3),
        coverage: round(c.coverage, 3),
        maxPred: c.maxPred,
      })),
      ambiguous: fit.ambiguous,
      allStatic: fit.allStatic,
      locked: Boolean(fit.locked),
      reason: fit.reason,
      frameDt: fit.frameDt,
    },
    threshold: {
      value: round(classification.threshold, 3),
      copyLevel: round(classification.copyLevel, 3),
      changeLevel: round(classification.changeLevel, 3),
      evidence: classification.evidence,
      method: classification.method,
    },
    runs: decisions.runDecisions.map((r) => ({
      id: r.id,
      start: r.start,
      end: r.end,
      length: r.length,
      tStart: round(r.tStart, 4),
      tEnd: r.tEnd == null ? round(segment?.end ?? 0, 4) : round(r.tEnd, 4),
      duration: round(r.duration, 4),
      predicted: r.predicted,
      phase: r.phase,
      period: r.period,
      isStatic: r.isStatic,
      kind: r.kind,
      boundary: r.isBoundary,
      action: r.action,
      confidence: round(r.confidence, 2),
      reason: r.reason,
      opening: r.opening
        ? {
            diffMean: round(r.opening.diffMean, 3),
            blockP90: round(r.opening.blockP90, 2),
            motionGain: round(r.opening.motionGain, 3),
            eqFrac: round(r.opening.eqFrac, 3),
            reason: r.opening.reason,
            uncertain: r.opening.uncertain,
          }
        : null,
    })),
    frames,
    kept: decisions.kept.map((k) => ({
      sourceFrame: k.sourceFrame,
      time: round(k.time, 4),
      displayEnd: round(k.displayEnd, 4),
      displayDuration: round(k.displayDuration, 4),
      action: k.action,
      runId: k.runId,
      confidence: round(k.confidence, 2),
      reason: k.reason,
      phase: k.phase,
      period: k.period,
    })),
    timeline: buildTimelinePayload({ frameTimes }, decisions, fit),
    notes: summary.notes,
    warnings: summary.warnings,
    elapsedMs: null,
  };
}

function buildTimelinePayload(decoded, decisions, fit) {
  return {
    frameTimes: (decoded.frameTimes || []).map((t) => round(t, 4)),
    frameActions: decisions.frames.map((f) => f.action),
    frameDiffs: decisions.frames.map((f) => round(f.diffMean, 3)),
    frameMotions: decisions.frames.map((f) => round(f.motionGain, 3)),
    runs: decisions.runDecisions.map((r) => ({
      start: r.start,
      end: r.end,
      action: r.action,
      isStatic: r.isStatic,
      tStart: round(r.tStart, 4),
      tEnd: r.tEnd == null ? null : round(r.tEnd, 4),
    })),
  };
}

function round(v, digits = 3) {
  if (v == null || !Number.isFinite(v)) return null;
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }
  if (pathname.startsWith("/api/")) {
    try {
      for (const [key, handler] of Object.entries(routes)) {
        const [method, pattern] = key.split(" ");
        if (method !== req.method) continue;
        const params = matchPattern(pattern, pathname);
        if (params) return await handler(req, res, params);
      }
      return sendError(res, 404, "接口不存在");
    } catch (err) {
      console.error("[api]", err);
      return sendError(res, 500, err.message || "服务器错误");
    }
  }
  return serveStatic(req, res, pathname);
}

function matchPattern(pattern, pathname) {
  const pSeg = pattern.split("/");
  const uSeg = pathname.split("/");
  if (pSeg.length !== uSeg.length) return null;
  const params = {};
  for (let i = 0; i < pSeg.length; i++) {
    if (pSeg[i].startsWith(":")) params[pSeg[i].slice(1)] = uSeg[i];
    else if (pSeg[i] !== uSeg[i]) return null;
  }
  return params;
}

export async function startServer({ port = PORT, host = HOST } = {}) {
  await ensureDirs();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendError(res, 500, err.message || "服务器错误");
      else res.end();
    });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  return {
    server,
    port: address.port,
    host: address.host,
    url: `http://${host}:${address.port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export { formatTime };

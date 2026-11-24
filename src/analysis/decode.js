import { spawn } from "node:child_process";
import { FFMPEG } from "../util/media.js";
import { boxBlur, diffStats, motionSearch, richness } from "./features.js";

const ANALYSIS_W = 160;
const ANALYSIS_H = 90;
const MOTION_W = 80;
const MOTION_H = 45;

/**
 * Decode a video (optionally a [start,end) segment) into downsampled luma
 * frames plus their presentation timestamps, in display order.
 *
 * Returns:
 *  {
 *    width, height,           // source dimensions
 *    analysisSize, motionSize,
 *    fps,                     // nominal container fps
 *    frames: [{ index, t, pts, luma(Uint8), blur(Uint8), rich }],
 *    audio: [ { t, rms, peak } ]   // optional rough audio envelope per ~10ms
 *  }
 */
export async function decodeFrames(media, { start = 0, end = null, onProgress = null } = {}) {
  const duration = media.duration ?? 0;
  const segStart = Math.max(0, start);
  const segEnd = end == null ? duration : Math.min(duration, end);
  const segLen = Math.max(0, segEnd - segStart);

  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  // Input-side seek plus -copyts keeps original presentation timestamps.
  if (segStart > 0.0005) args.push("-ss", segStart.toFixed(6));
  args.push("-copyts", "-i", media.file);
  if (segLen > 0) args.push("-t", segLen.toFixed(6));
  args.push(
    "-map",
    "0:v:0",
    "-vf",
    `scale=${ANALYSIS_W}:${ANALYSIS_H}:flags=area,format=gray,showinfo`,
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    "pipe:1",
  );

  const frameSize = ANALYSIS_W * ANALYSIS_H;
  const frames = [];
  let stderrTail = "";
  let pending = Buffer.alloc(0);
  const pts = [];
  const expectedW = ANALYSIS_W;
  const expectedH = ANALYSIS_H;

  await new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameSize) {
        const luma = new Uint8Array(pending.subarray(0, frameSize));
        pending = pending.subarray(frameSize);
        const blur = boxBlur(luma, expectedW, expectedH, 2);
        const rich = richness(luma, expectedW, expectedH);
        frames.push({ luma, blur, rich });
      }
    });
    child.stderr.on("data", (d) => {
      stderrTail += d.toString();
      if (stderrTail.length > 200000) stderrTail = stderrTail.slice(-100000);
      const re = /pts_time:([0-9.]+)/g;
      let m;
      while ((m = re.exec(stderrTail))) {
        pts.push(Number(m[1]));
      }
      // Trim processed part of the buffer up to the last match to avoid re-reading.
      const lastNl = stderrTail.lastIndexOf("\n");
      if (lastNl > 0) stderrTail = stderrTail.slice(lastNl + 1);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`解码失败（退出码 ${code}）`));
    });
  });

  if (!frames.length) throw new Error("未能从视频中解码出任何帧");

  // PTS collected from showinfo; if counts mismatch (should be rare), synthesize.
  for (let i = 0; i < frames.length; i++) {
    const t = i < pts.length ? pts[i] : segStart + i / (media.video.fps || 30);
    frames[i].index = i;
    frames[i].t = t;
    frames[i].pts = t;
  }

  return {
    width: media.video.width,
    height: media.video.height,
    analysisSize: [expectedW, expectedH],
    motionSize: [MOTION_W, MOTION_H],
    fps: media.video.fps,
    segStart,
    segEnd: segEnd,
    frames,
  };
}

/** Downsample an analysis luma frame to the motion computation size. */
export function toMotion(luma, w = ANALYSIS_W, h = ANALYSIS_H) {
  const out = new Uint8Array(MOTION_W * MOTION_H);
  const sx = w / MOTION_W;
  const sy = h / MOTION_H;
  for (let y = 0; y < MOTION_H; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < MOTION_W; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          sum += luma[yy * w + xx];
          n++;
        }
      }
      out[y * MOTION_W + x] = Math.round(sum / Math.max(1, n));
    }
  }
  return out;
}

/**
 * Compute pairwise evidence for consecutive frames.
 * Each entry: { t, dt, prev, diff:{mean,overFrac,blockP90,blockMax}, motion:{...}, eqFrac }
 */
export function computePairwise(decoded) {
  const { frames } = decoded;
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const cur = frames[i];
    if (i === 0) {
      out.push({ index: i, t: cur.t, dt: 0, diff: null, motion: null, eqFrac: 1 });
      continue;
    }
    const prev = frames[i - 1];
    const diff = diffStats(prev.blur, cur.blur, ANALYSIS_W, ANALYSIS_H, 8);
    const am = toMotion(prev.luma);
    const bm = toMotion(cur.luma);
    const motion = motionSearch(am, bm, MOTION_W, MOTION_H, 3);
    let eq = 0;
    for (let k = 0; k < cur.luma.length; k++) if (cur.luma[k] === prev.luma[k]) eq++;
    out.push({
      index: i,
      t: cur.t,
      dt: cur.t - prev.t,
      diff,
      motion,
      eqFrac: eq / cur.luma.length,
    });
  }
  return out;
}

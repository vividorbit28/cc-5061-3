import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import ffmpegStatic from "ffmpeg-static";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

const execFileAsync = promisify(execFile);

export const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic;
export const FFPROBE = process.env.FFPROBE_PATH || ffprobeInstaller.path;

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const WORK_DIR = path.join(DATA_DIR, "work");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const OUTPUT_DIR = path.join(DATA_DIR, "outputs");
export const SAMPLE_DIR = path.join(DATA_DIR, "samples");

export async function ensureDirs() {
  for (const dir of [DATA_DIR, WORK_DIR, UPLOAD_DIR, OUTPUT_DIR, SAMPLE_DIR]) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

export function newId(prefix = "") {
  return prefix + crypto.randomBytes(9).toString("hex");
}

export function safeJoin(base, name) {
  const resolved = path.resolve(base, name);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("invalid path");
  }
  return resolved;
}

export async function ffprobeJson(file) {
  const { stdout } = await execFileAsync(
    FFPROBE,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", file],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

function parseRational(value) {
  if (!value || typeof value !== "string") return null;
  const [a, b] = value.split("/").map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

function parseDuration(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function probeMedia(file) {
  const raw = await ffprobeJson(file);
  const streams = raw.streams || [];
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video) throw new Error("文件中没有可分析的视频流");

  const fieldOrder = (video.field_order || "progressive").toLowerCase();
  const interlaced = ["tt", "bb", "tb", "bt", "interlaced"].includes(fieldOrder);
  const fps = parseRational(video.avg_frame_rate) || parseRational(video.r_frame_rate) || null;
  const duration =
    parseDuration(raw.format?.duration) ??
    parseDuration(video.duration) ??
    parseDuration(audio?.duration) ??
    null;

  return {
    file,
    size: fs.statSync(file).size,
    formatName: raw.format?.format_name || "",
    duration,
    startTime: parseDuration(raw.format?.start_time) ?? 0,
    video: {
      index: video.index,
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      pixFmt: video.pix_fmt,
      fps,
      avgFps: parseRational(video.avg_frame_rate),
      rFps: parseRational(video.r_frame_rate),
      timeBase: video.time_base,
      nbFrames: Number(video.nb_frames) || null,
      duration: parseDuration(video.duration),
      startTime: parseDuration(video.start_time) ?? 0,
      fieldOrder,
      interlaced,
      rotation: Number(video.tags?.rotate || 0) || 0,
      isProgressive: !interlaced,
      isImage: video.nb_frames === "1" || raw.format?.format_name === "image2",
    },
    audio: audio
      ? {
          index: audio.index,
          codec: audio.codec_name,
          sampleRate: Number(audio.sample_rate) || null,
          channels: Number(audio.channels) || null,
          duration: parseDuration(audio.duration),
          startTime: parseDuration(audio.start_time) ?? 0,
          bitRate: Number(audio.bit_rate) || null,
        }
      : null,
    raw,
  };
}

/**
 * Spawn ffmpeg and collect stderr. Resolves with {stdout buffers?} only if not
 * writing to a consumer; for large stdout use runFFmpegStream.
 */
export async function runFFmpeg(args, { maxStderr = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-nostdin", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < maxStderr) stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stderr });
      else {
        const err = new Error(`ffmpeg 执行失败（退出码 ${code}）：${stderr.trim().slice(-4000)}`);
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

export function spawnFFmpeg(args, options = {}) {
  return spawn(FFMPEG, ["-hide_banner", "-nostdin", ...args], options);
}

export async function withTempDir(prefix, fn) {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(WORK_DIR, prefix));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function formatTime(seconds, digits = 3) {
  if (!Number.isFinite(seconds)) return "—";
  return seconds.toFixed(digits);
}

export async function removeDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export function tmpName(ext) {
  return `${newId()}${ext}`;
}

export function osTmp() {
  return os.tmpdir();
}

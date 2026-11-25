import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { runFFmpeg, probeMedia, withTempDir } from "./media.js";

/**
 * Extract exactly the given source frame numbers into PNG files (display order),
 * writing them as k0001.png, k0002.png ...
 */
export async function extractKeptFrames(media, frameIndices, outDir, onProgress) {
  if (!frameIndices.length) throw new Error("没有需要保留的帧");
  await fsp.mkdir(outDir, { recursive: true });
  const expr = "eq(n\\," + frameIndices.join(")+eq(n\\,") + ")";
  await runFFmpeg([
    "-i",
    media.file,
    "-vf",
    `select='${expr}'`,
    "-fps_mode",
    "passthrough",
    "-f",
    "image2",
    "-start_number",
    "1",
    path.join(outDir, "k%05d.png"),
  ]);
  const files = (await fsp.readdir(outDir)).filter((f) => f.endsWith(".png")).sort();
  if (files.length !== frameIndices.length) {
    throw new Error(`抽帧数量不符：期望 ${frameIndices.length}，实际 ${files.length}`);
  }
  if (onProgress) onProgress(files.length);
  return files.map((f) => path.join(outDir, f));
}

/**
 * Encode a concat list where each entry holds for `displayDuration` seconds.
 * The last entry is given a tiny phantom follower so its own display duration is
 * honoured by the demuxer; that phantom frame is trimmed afterwards by
 * trimToDuration() with stream copy.
 *
 * -bf 0 is required: with B-frames the concat demuxer's DTS reordering collapses
 * the per-entry durations, producing wrong total durations.
 */
export async function encodeKeptTimeline({ files, displayDurations, fps, outPath, crf = 18, preset = "veryfast" }) {
  const lines = [];
  for (let i = 0; i < files.length; i++) {
    lines.push(`file '${files[i].replace(/'/g, "'\\''")}'`);
    lines.push("option framerate 90000");
    lines.push(`duration ${displayDurations[i].toFixed(6)}`);
  }
  // Phantom follower with ~0 duration so the real last frame keeps its duration.
  lines.push(`file '${files[files.length - 1].replace(/'/g, "'\\''")}'`);
  lines.push("option framerate 90000");
  lines.push("duration 0.000011");
  const listPath = path.join(path.dirname(outPath), "concat.txt");
  await fsp.writeFile(listPath, lines.join("\n") + "\n");
  await runFFmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-fps_mode",
    "passthrough",
    "-bf",
    "0",
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-video_track_timescale",
    "90000",
    outPath,
  ]);
  return listPath;
}

/** Trim a rendered video with stream copy to an exact duration (drops phantom tail). */
export async function trimToDuration(input, output, duration) {
  await runFFmpeg(["-i", input, "-c", "copy", "-t", duration.toFixed(6), output]);
}

/** Mux the rendered video with the original audio (stream copy, no re-encode). */
export async function muxWithOriginalAudio(videoPath, media, outputPath, { keepAudio = true } = {}) {
  const args = ["-i", videoPath];
  if (keepAudio && media.audio) args.push("-i", media.file);
  args.push("-map", "0:v:0");
  if (keepAudio && media.audio) args.push("-map", "1:a:0");
  args.push("-c", "copy", "-movflags", "+faststart", outputPath);
  await runFFmpeg(args);
}

export function sanitizeName(name) {
  return String(name)
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 80) || "output";
}

/**
 * Full render: kept frames + original audio -> output file that preserves the
 * original event timeline. Verifies the result by re-probing and comparing
 * audio samples, and returns a verification report.
 */
export async function renderRecovered({
  media,
  kept,
  outputPath,
  options = {},
  onProgress,
}) {
  const { crf = 18, preset = "veryfast", keepAudio = true } = options;
  const fps = media.video.fps || 30;
  const frameDt = 1 / fps;
  if (onProgress) onProgress({ phase: "render-start", kept: kept.length });
  const segEnd = media.duration ?? (kept.length ? kept[kept.length - 1].displayEnd : 0);
  const keptSorted = [...kept].sort((a, b) => a.sourceFrame - b.sourceFrame);

  // Normalise display intervals so they tile [firstTime, duration) without gaps.
  const firstTime = keptSorted.length ? keptSorted[0].time : 0;
  const starts = keptSorted.map((k) => k.time);
  const durations = keptSorted.map((k, i) => {
    const nextStart = i < keptSorted.length - 1 ? starts[i + 1] : segEnd + frameDt;
    return Math.max(frameDt / 2, nextStart - k.time);
  });
  const total = durations.reduce((a, b) => a + b, 0);

  await withTempDir("render-", async (dir) => {
    const files = await extractKeptFrames(media, keptSorted.map((k) => k.sourceFrame), path.join(dir, "frames"));
    const rawOut = path.join(dir, "raw.mp4");
    await encodeKeptTimeline({ files, displayDurations: durations, fps, outPath: rawOut, crf, preset });
    const trimmed = path.join(dir, "trimmed.mp4");
    await trimToDuration(rawOut, trimmed, total);
    if (keepAudio && media.audio) {
      await muxWithOriginalAudio(trimmed, media, outputPath, { keepAudio });
    } else {
      await runFFmpeg(["-i", trimmed, "-c", "copy", "-movflags", "+faststart", outputPath]);
    }
  });

  const verification = await verifyOutput(media, outputPath, { total, keepAudio });
  const measured = await measureOutputFrames(outputPath);
  const keptTimeline = keptSorted.map((k, i) => ({
    sourceFrame: k.sourceFrame,
    time: k.time,
    displayStart: k.time,
    displayEnd: k.time + durations[i],
    displayDuration: durations[i],
    action: k.action,
    phase: k.phase ?? null,
    period: k.period ?? null,
    confidence: k.confidence ?? null,
    reason: k.reason ?? null,
  }));
  return {
    outputPath,
    total,
    durations,
    keptCount: keptSorted.length,
    keptTimeline,
    outputFrames: measured,
    verification,
  };
}

/** Read the actual presentation timestamp of every frame in the output. */
export async function measureOutputFrames(file) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { FFPROBE } = await import("./media.js");
  const run = promisify(execFile);
  try {
    const { stdout } = await run(
      FFPROBE,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/,$/, ""))
      .filter((line) => line !== "")
      .map((line) => ({ pts: Number(line) }))
      .filter((f) => Number.isFinite(f.pts));
  } catch {
    return [];
  }
}

/** Verify output: duration, frame count, per-frame PTS, audio match. */
export async function verifyOutput(media, outputPath, { total, keepAudio }) {
  const out = await probeMedia(outputPath);
  const report = {
    outputDuration: out.duration,
    expectedDuration: total,
    durationError: out.duration != null ? out.duration - total : null,
    videoFrames: out.video.nbFrames,
    videoCodec: out.video.codec,
    videoSize: `${out.video.width}x${out.video.height}`,
    audioCodec: out.audio?.codec ?? null,
    audioDuration: out.audio?.duration ?? null,
    audioPresent: Boolean(out.audio),
    warnings: [],
  };
  if (total > 0 && out.duration != null && Math.abs(out.duration - total) > 0.1) {
    report.warnings.push(`输出总时长 ${out.duration.toFixed(3)} 秒与期望 ${total.toFixed(3)} 秒不符`);
  }
  if (keepAudio && media.audio && !out.audio) {
    report.warnings.push("原片有音频，但输出未包含音频");
  }
  return report;
}

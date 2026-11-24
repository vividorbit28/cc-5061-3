import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { analyzeMedia } from "../src/analysis/pipeline.js";
import { renderRecovered } from "../src/util/render.js";
import { probeMedia, FFPROBE, OUTPUT_DIR } from "../src/util/media.js";
import { readBarcodes, buildAllFixtures } from "./fixtures.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const SAMPLE_DIR = path.resolve(import.meta.dirname, "..", "data", "samples");

// Fixtures live under data/ (gitignored): generate any that are missing.
const REQUIRED = ["alt23", "alt23_static", "alt23_noisy", "pulldown2430", "const3", "native30", "static_only"];
if (REQUIRED.some((n) => !fs.existsSync(path.join(SAMPLE_DIR, `${n}.mp4`)) || !fs.existsSync(path.join(SAMPLE_DIR, `${n}.json`)))) {
  await buildAllFixtures();
}

function manifest(name) {
  return JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, `${name}.json`), "utf8"));
}

function videoPath(name) {
  return path.join(SAMPLE_DIR, `${name}.mp4`);
}

async function audioMd5(file) {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,sample_rate,channels",
    "-of", "default=nw=1",
    file,
  ]);
  if (!stdout.trim()) return null;
  // Extract the raw audio stream and hash it. Stream-copy muxing must keep it bit-identical.
  const { FFMPEG } = await import("../src/util/media.js");
  const tmp = path.join(OUTPUT_DIR, `audio-${crypto.randomBytes(4).toString("hex")}.bin`);
  await run(FFMPEG, ["-v", "error", "-i", file, "-map", "0:a:0", "-c", "copy", "-f", "data", tmp]);
  const hash = crypto.createHash("md5").update(await fsp.readFile(tmp)).digest("hex");
  await fsp.rm(tmp, { force: true });
  return hash;
}

const cases = [
  {
    name: "alt23",
    sourceFps: 12,
    pattern: [2, 3],
    sourceCount: 48,
    staticRanges: [],
  },
  {
    name: "alt23_static",
    sourceFps: 12,
    pattern: [2, 3],
    sourceCount: 72,
    staticRanges: [[24, 35]],
  },
  {
    name: "alt23_noisy",
    sourceFps: 12,
    pattern: [2, 3],
    sourceCount: 48,
    staticRanges: [],
  },
  {
    name: "pulldown2430",
    sourceFps: 24,
    pattern: [1, 1, 1, 2],
    sourceCount: 96,
    staticRanges: [],
  },
  {
    name: "const3",
    sourceFps: 10,
    pattern: [3],
    sourceCount: 50,
    staticRanges: [],
  },
  {
    name: "native30",
    sourceFps: 30,
    pattern: [1],
    sourceCount: 150,
    staticRanges: [[90, 119]],
  },
];

for (const c of cases) {
  test(`${c.name}: 识别节奏、源帧选择与时长`, async () => {
    const m = manifest(c.name);
    const result = await analyzeMedia(videoPath(c.name));
    const s = result.summary;

    assert.equal(s.sourceFps, c.sourceFps, "估计源帧率");
    assert.deepEqual(s.pattern, c.pattern, "重复模式");
    assert.equal(s.ambiguous, false);
    assert.equal(s.allStatic, false);

    // Every kept frame must be one of the expected source update positions.
    // A source update happens at the first output frame of each run in outputToSource.
    const expectedKept = [];
    let last = -1;
    m.outputToSource.forEach((src, i) => {
      if (src !== last) expectedKept.push(i);
      last = src;
    });
    // static runs are collapsed, so only check the non-static fixture exactly.
    if (!c.staticRanges.length) {
      assert.deepEqual(
        result.decisions.kept.map((k) => k.sourceFrame),
        expectedKept,
        "保留帧必须落在源画面更新处",
      );
    }

    // Kept frames must cover the full segment duration (no time compression).
    const totalKeptMs = result.decisions.kept.reduce((a, k) => a + k.displayDuration, 0);
    assert.ok(
      Math.abs(totalKeptMs - m.duration) < 0.05,
      `保留时间应覆盖全片 ${m.duration}s，实际 ${totalKeptMs.toFixed(3)}s`,
    );
  });
}

test("alt23_static: 真实静止不被压缩，保留完整时长", async () => {
  const m = manifest("alt23_static");
  const result = await analyzeMedia(videoPath("alt23_static"));
  const s = result.summary;
  assert.equal(s.staticRuns, 1);

  const staticDecision = result.decisions.runDecisions.find((r) => r.isStatic);
  assert.ok(staticDecision, "应识别出真实静止段");
  assert.equal(staticDecision.action, "keep-static");

  // Static range source frames 24..35 (12 frames @12fps = 1.0s). Its output span
  // must be preserved as display duration on the single kept frame.
  const keptStatic = result.decisions.kept.find((k) => k.sourceFrame === staticDecision.start);
  assert.ok(keptStatic);
  assert.ok(
    keptStatic.displayDuration >= 0.99,
    `静止段应保留约 1 秒显示时长，实际 ${keptStatic.displayDuration}`,
  );

  const totalKeptMs = result.decisions.kept.reduce((a, k) => a + k.displayDuration, 0);
  assert.ok(Math.abs(totalKeptMs - m.duration) < 0.1, "静止段不压缩总时长");
});

test("native30: 无复制时不得删除真实运动帧", async () => {
  const result = await analyzeMedia(videoPath("native30"));
  const s = result.summary;
  assert.equal(s.sourceFps, 30);
  assert.equal(s.ambiguous, false);
  assert.equal(s.staticRuns, 1);

  // No plain drops at all: every content update is preserved.
  const plainDrops = result.decisions.frames.filter((f) => f.action === "drop");
  assert.equal(plainDrops.length, 0, "无复制素材不应删除任何真实更新帧");

  // Only the genuine static hold is collapsed, and it keeps its duration.
  const staticRun = result.decisions.runDecisions.find((r) => r.isStatic);
  assert.ok(staticRun);
  const keptStatic = result.decisions.kept.find((k) => k.sourceFrame === staticRun.start);
  assert.ok(keptStatic.displayDuration >= 0.99, "真实静止保留约 1 秒时长");
});

test("static_only: 证据不足时保留全部帧与多解节奏", async () => {
  const m = manifest("static_only");
  const result = await analyzeMedia(videoPath("static_only"));
  const s = result.summary;
  assert.equal(s.allStatic, true);
  assert.equal(s.ambiguous, true);
  assert.equal(s.keptFrames, s.totalFrames, "全静止时不得删除任何帧");
  const totalKeptMs = result.decisions.kept.reduce((a, k) => a + k.displayDuration, 0);
  assert.ok(Math.abs(totalKeptMs - m.duration) < 0.05, "全静止时保留完整时长");
});

test("alt23_noisy: 压缩噪声下复制帧不逐像素相同，仍按证据恢复", async () => {
  const result = await analyzeMedia(videoPath("alt23_noisy"));
  // Duplicate transitions must not be bit-identical after encoding.
  const dupDiff = result.decisions.frames
    .filter((f) => f.action === "drop")
    .map((f) => f.diffMean);
  assert.ok(dupDiff.length > 0, "应检出复制帧");
  assert.ok(
    dupDiff.some((d) => d > 1e-4),
    `复制帧应存在非零差异（压缩噪声），实际最大 ${Math.max(...dupDiff)}`,
  );
  // Yet detection must remain confident: copies differ far less than updates.
  const updateDiff = result.decisions.frames
    .filter((f) => f.action === "keep")
    .map((f) => f.diffMean);
  const median = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] ?? 0;
  assert.ok(median(dupDiff) < median(updateDiff) / 4, "复制帧差异应显著低于更新帧");
  assert.equal(result.summary.sourceFps, 12);
  assert.deepEqual(result.summary.pattern, [2, 3]);
});

test("alt23: 重封装保留原事件时间、音轨比特一致", async () => {
  const file = videoPath("alt23");
  const m = manifest("alt23");
  const analysis = await analyzeMedia(file);
  const outPath = path.join(OUTPUT_DIR, `test-${crypto.randomBytes(4).toString("hex")}.mp4`);
  try {
    const render = await renderRecovered({
      media: analysis.media,
      kept: analysis.decisions.kept,
      outputPath: outPath,
      options: { keepAudio: true },
    });

    // Output frame count equals kept count.
    assert.equal(render.keptCount, analysis.decisions.kept.length);
    assert.equal(render.outputFrames.length, render.keptCount);

    // Duration preserved within one frame.
    const probe = await probeMedia(outPath);
    assert.ok(Math.abs(probe.duration - m.duration) < 0.05, `输出时长 ${probe.duration} 应接近 ${m.duration}`);

    // Container fps is NOT the claim: actual PTS spacing must be non-uniform
    // (2,3 repeats), proving frames were re-timed rather than relabelled.
    const pts = render.outputFrames.map((f) => f.pts);
    const gaps = pts.slice(1).map((p, i) => +(p - pts[i]).toFixed(4));
    const uniqueGaps = [...new Set(gaps)].sort((a, b) => a - b);
    assert.ok(uniqueGaps.length > 1, "PTS 间隔应非均匀，说明按原事件时间重排而非改标签");
    assert.ok(Math.abs(uniqueGaps[0] - 2 / 30) < 0.002, "帧间隔应出现 2/30 秒（2 次复制的来源帧）");
    assert.ok(Math.abs(uniqueGaps[uniqueGaps.length - 1] - 3 / 30) < 0.002, "帧间隔应出现 3/30 秒（3 次复制的来源帧）");

    // Barcodes: each output frame must decode to the same content key as the
    // source frame it was taken from.
    const decoded = await readBarcodes(outPath);
    assert.equal(decoded.length, render.keptCount);
    const sourceKeys = analysis.decisions.kept.map((k) => m.sourceToKey[m.outputToSource[k.sourceFrame]]);
    decoded.forEach((d, i) => {
      assert.equal(d.key, sourceKeys[i], `第 ${i} 个保留帧画面内容应源自源帧 ${sourceKeys[i]}`);
    });

    // Audio stream must be bit-identical to the original.
    const srcMd5 = await audioMd5(file);
    const outMd5 = await audioMd5(outPath);
    assert.ok(srcMd5 && outMd5, "原片与输出都应包含音轨");
    assert.equal(outMd5, srcMd5, "音轨流复制后应比特一致");
  } finally {
    await fsp.rm(outPath, { force: true });
  }
});

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { FFMPEG, SAMPLE_DIR, ensureDirs } from "../src/util/media.js";

const SRC_W = 320;
const SRC_H = 180;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function fillRect(buf, x0, y0, w, h, r, g, b) {
  const x1 = Math.min(SRC_W, x0 + w);
  const y1 = Math.min(SRC_H, y0 + h);
  for (let y = Math.max(0, y0); y < y1; y++) {
    let o = (y * SRC_W + Math.max(0, x0)) * 3;
    for (let x = Math.max(0, x0); x < x1; x++) {
      buf[o++] = r;
      buf[o++] = g;
      buf[o++] = b;
    }
  }
}

/** Draws a frame whose content is determined by `contentKey` (usually source frame index). */
function renderSourceFrame(contentKey) {
  const buf = Buffer.alloc(SRC_W * SRC_H * 3);
  // Background: gentle diagonal gradient plus faint checker grid.
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++) {
      const o = (y * SRC_W + x) * 3;
      const gx = (x * 255) / SRC_W;
      const gy = (y * 255) / SRC_H;
      let v = 18 + gx * 0.08 + gy * 0.10;
      if ((x >> 5) % 2 === (y >> 5) % 2) v += 4;
      buf[o] = clamp255(v * 0.55);
      buf[o + 1] = clamp255(v * 0.75);
      buf[o + 2] = clamp255(v * 1.05);
    }
  }

  // Index barcode: 7 bits + inverted 7 bits, 16 px cells across the top.
  const bits = 7;
  for (let bit = 0; bit < bits; bit++) {
    const on = (contentKey >> bit) & 1;
    const v = on ? 235 : 20;
    fillRect(buf, bit * 16 + 4, 4, 12, 18, v, v, v);
    const inv = on ? 20 : 235;
    fillRect(buf, (bit + bits) * 16 + 4, 4, 12, 18, inv, inv, inv);
  }

  // A moving, uniquely colored marker so every contentKey is visually distinct.
  const cx = 24 + ((contentKey * 37 + 11) % (SRC_W - 96));
  const cy = 62 + ((contentKey * 23 + 7) % (SRC_H - 110));
  const color = [
    (contentKey * 53 + 40) % 256,
    (contentKey * 97 + 90) % 256,
    (contentKey * 151 + 140) % 256,
  ];
  fillRect(buf, cx, cy, 52, 34, ...color);
  fillRect(buf, cx + 8, cy + 8, 52 - 16, 34 - 16, 250, 250, 250);
  fillRect(buf, cx + 16, cy + 14, 52 - 32, 34 - 28, ...color);

  // A second, smaller marker moving the other way, giving localized motion.
  const mx = 16 + ((contentKey * 61 + 3) % (SRC_W - 40));
  const my = SRC_H - 40 - ((contentKey * 17) % 24);
  fillRect(buf, mx, my, 22, 18, 30, 220, 120);

  // Corner ticks: stable reference.
  fillRect(buf, 2, SRC_H - 8, 10, 6, 200, 200, 200);
  fillRect(buf, SRC_W - 12, SRC_H - 8, 10, 6, 200, 200, 200);
  return buf;
}

function addNoise(buf, rand, amplitude) {
  if (!amplitude) return;
  for (let i = 0; i < buf.length; i++) {
    if (rand() < 0.35) {
      const d = Math.round((rand() * 2 - 1) * amplitude);
      buf[i] = clamp255(buf[i] + d);
    }
  }
}

function makeWav(beepTimes, durationSec, sampleRate = 48000) {
  const n = Math.ceil(durationSec * sampleRate);
  const samples = Buffer.alloc(44 + n * 2);
  samples.write("RIFF", 0, "ascii");
  samples.writeUInt32LE(36 + n * 2, 4);
  samples.write("WAVE", 8, "ascii");
  samples.write("fmt ", 12, "ascii");
  samples.writeUInt32LE(16, 16);
  samples.writeUInt16LE(1, 20);
  samples.writeUInt16LE(1, 22);
  samples.writeUInt32LE(sampleRate, 24);
  samples.writeUInt32LE(sampleRate * 2, 28);
  samples.writeUInt16LE(2, 32);
  samples.writeUInt16LE(16, 34);
  samples.write("data", 36, "ascii");
  samples.writeUInt32LE(n * 2, 40);
  const beepLen = Math.floor(0.06 * sampleRate);
  for (const t of beepTimes) {
    const start = Math.floor(t * sampleRate);
    for (let i = 0; i < beepLen && start + i < n; i++) {
      const env = Math.min(1, i / 240, (beepLen - i) / 240);
      const v = Math.sin((2 * Math.PI * 1046.5 * i) / sampleRate) * 0.55 * env;
      samples.writeInt16LE(Math.round(v * 32767), 44 + (start + i) * 2);
    }
  }
  return samples;
}

function buildUpsampleMap(sourceCount, pattern) {
  const map = [];
  let s = 0;
  let p = 0;
  while (s < sourceCount) {
    const repeats = pattern[p % pattern.length];
    for (let k = 0; k < repeats && s < sourceCount; k++) {
      map.push(s);
    }
    s += 1;
    p += 1;
  }
  return map;
}

async function runFFmpegPiped(args, feed, log) {
  const child = spawn(FFMPEG, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`fixture encode failed ${code}: ${stderr}`)),
    );
  });
  await feed(child.stdin, log);
  child.stdin.end();
  await done;
}

async function encodeFrames({ frames, fps, wavPath, outPath, crf, log }) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgb24",
    "-video_size",
    `${SRC_W}x${SRC_H}`,
    "-framerate",
    String(fps),
    "-i",
    "pipe:0",
  ];
  if (wavPath) args.push("-i", wavPath);
  args.push(
    "-map",
    "0:v:0",
    ...(wavPath ? ["-map", "1:a:0"] : []),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(crf ?? 27),
    "-g",
    String(Math.max(10, Math.round(fps))),
    "-bf",
    "2",
    "-pix_fmt",
    "yuv420p",
    ...(wavPath ? ["-c:a", "aac", "-b:a", "96k", "-shortest"] : []),
    "-movflags",
    "+faststart",
    "-y",
    outPath,
  );
  await runFFmpegPiped(args, async (stdin) => {
    for (let i = 0; i < frames.length; i++) {
      if (!stdin.write(frames[i])) {
        await new Promise((res) => stdin.once("drain", res));
      }
      if (log && i % 60 === 0) log(`encode ${i}/${frames.length}`);
    }
  });
}

/**
 * Build a "camera-like" clip: no repeated frames at all (true 30 fps motion),
 * plus a static hold. Used to verify the tool does not delete real frames.
 */
async function encodeNative({ outPath, fps, frameCount, log }) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgb24",
    "-video_size",
    `${SRC_W}x${SRC_H}`,
    "-framerate",
    String(fps),
    "-i",
    "pipe:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-g",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-y",
    outPath,
  ];
  await runFFmpegPiped(args, async (stdin) => {
    for (let i = 0; i < frameCount; i++) {
      // Static hold from frame 90..119; otherwise content advances every frame.
      const key = i >= 90 && i < 120 ? 90 : i;
      const frame = renderSourceFrame(key + 1000);
      if (!stdin.write(frame)) await new Promise((res) => stdin.once("drain", res));
      if (log && i % 60 === 0) log(`native ${i}/${frameCount}`);
    }
  });
}

function decodeBarcodeFromRGB(rgb, w, h) {
  let key = 0;
  let ok = 0;
  for (let bit = 0; bit < 7; bit++) {
    const x0 = Math.round(((bit * 16 + 10) / SRC_W) * w);
    const y0 = Math.round((13 / SRC_H) * h);
    let sum = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = Math.min(w - 1, Math.max(0, x0 + dx));
        const y = Math.min(h - 1, Math.max(0, y0 + dy));
        const o = (y * w + x) * 3;
        sum += rgb[o] + rgb[o + 1] + rgb[o + 2];
        n++;
      }
    }
    const v = sum / n;
    if (v > 128) key |= 1 << bit;
    // Inverse cell for sanity.
    const xi = Math.round((((bit + 7) * 16 + 10) / SRC_W) * w);
    let isum = 0;
    let inum = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = Math.min(w - 1, Math.max(0, xi + dx));
        const y = Math.min(h - 1, Math.max(0, y0 + dy));
        const o = (y * w + x) * 3;
        isum += rgb[o] + rgb[o + 1] + rgb[o + 2];
        inum++;
      }
    }
    const iv = isum / inum;
    if ((v > 128) !== (iv > 128)) ok++;
  }
  return { key, valid: ok >= 6 };
}

// Exported for tests: read decoded RGB frames from a video and decode barcodes.
export async function readBarcodes(videoPath, fpsHint = 30) {
  return new Promise((resolve, reject) => {
    const w = 160;
    const h = 90;
    const frameSize = w * h * 3;
    const child = spawn(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        videoPath,
        "-map",
        "0:v:0",
        "-vf",
        `scale=${w}:${h}:flags=area,format=rgb24`,
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const out = [];
    let buf = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= frameSize) {
        const frame = buf.subarray(0, frameSize);
        out.push(decodeBarcodeFromRGB(frame, w, h));
        buf = buf.subarray(frameSize);
      }
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || `decode failed ${code}`)),
    );
  });
}

const FIXTURES = [
  {
    name: "alt23",
    title: "12→30 交替复制（内容每源帧更新）",
    description: "源 12 fps，按 2/3 交替重复到 30 fps；每个源帧内容都不同，用于验证复制组识别。",
    sourceFps: 12,
    highFps: 30,
    sourceCount: 48,
    pattern: [2, 3],
    noise: 0,
    staticRanges: [],
    beepSourceFrames: [4, 12, 20, 28, 36, 44],
  },
  {
    name: "alt23_static",
    title: "12→30 交替复制 + 1 秒真实静止",
    description: "源帧 24..35 的画面完全相同（真实停顿），其余源帧逐帧更新；复制模式仍为 2/3。",
    sourceFps: 12,
    highFps: 30,
    sourceCount: 72,
    pattern: [2, 3],
    noise: 0,
    staticRanges: [[24, 35]],
    beepSourceFrames: [4, 12, 20, 40, 48, 60],
  },
  {
    name: "alt23_noisy",
    title: "12→30 交替复制 + 压缩噪声",
    description: "重复帧叠加 ±3 级噪声并高压缩编码，使复制帧不再逐像素相同；不能依赖文件哈希去重。",
    sourceFps: 12,
    highFps: 30,
    sourceCount: 48,
    pattern: [2, 3],
    noise: 30,
    crf: 18,
    staticRanges: [],
    beepSourceFrames: [4, 12, 20, 28, 36, 44],
  },
  {
    name: "pulldown2430",
    title: "24→30 低重复（1/1/1/2）",
    description: "源 24 fps，按 1,1,1,2 循环重复到 30 fps；部分源帧没有复制。",
    sourceFps: 24,
    highFps: 30,
    sourceCount: 96,
    pattern: [1, 1, 1, 2],
    noise: 0,
    staticRanges: [],
    beepSourceFrames: [8, 24, 40, 56, 72, 88],
  },
  {
    name: "const3",
    title: "10→30 恒定 3 次复制",
    description: "源 10 fps，每个源帧重复 3 次到 30 fps；最基础的恒定节奏。",
    sourceFps: 10,
    highFps: 30,
    sourceCount: 50,
    pattern: [3],
    noise: 0,
    staticRanges: [],
    beepSourceFrames: [5, 15, 25, 35, 45],
  },
  {
    name: "native30",
    title: "30→30 原生帧率 + 1 秒真实静止",
    description: "没有任何复制，每个源帧都是新内容；中段 1 秒真实静止，用于验证不会删除真实运动帧。",
    sourceFps: 30,
    highFps: 30,
    sourceCount: 150,
    pattern: [1],
    noise: 0,
    staticRanges: [[90, 119]],
    beepSourceFrames: [10, 40, 70, 100, 130],
  },
  {
    name: "static_only",
    title: "全静止画面（节奏证据不足）",
    description: "所有源帧画面相同；视觉上无法区分复制与真实停顿，应保留多解并提示不确定。",
    sourceFps: 12,
    highFps: 30,
    sourceCount: 36,
    pattern: [2, 3],
    noise: 0,
    staticRanges: [[0, 35]],
    beepSourceFrames: [6, 18, 30],
  },
  {
    name: "splice_static",
    title: "24→30 剪接后静止保持（静止易被当复制）",
    description:
      "按 1,1,1,2 复制到 30 fps，第 8 源帧处一次剪接；剪接后源帧 8–10 画面相同（真实静止保持），像素上与其周围的复制重复完全一致。用于对照“静止镜头被误当周期复制”。",
    sourceFps: 24,
    highFps: 30,
    sourceCount: 30,
    pattern: [1, 1, 1, 2],
    noise: 0,
    staticRanges: [],
    keyOverrides: { 8: 600, 9: 600, 10: 600 },
    beepSourceFrames: [4, 12, 20, 28],
  },
  {
    name: "splice_motion",
    title: "24→30 剪接后继续运动（对照）",
    description:
      "与 splice_static 相同的复制节奏与剪接位置，但剪接后源帧 8–10 逐帧更新；仅缺少“静态保持”这一因素，用于区分观测不足与实现误判。",
    sourceFps: 24,
    highFps: 30,
    sourceCount: 30,
    pattern: [1, 1, 1, 2],
    noise: 0,
    staticRanges: [],
    keyOverrides: { 8: 600 },
    beepSourceFrames: [4, 12, 20, 28],
  },
];

export async function buildFixture(spec) {
  await ensureDirs();
  const tmp = await fsp.mkdtemp(path.join(SAMPLE_DIR, ".tmp-"));
  const map = buildUpsampleMap(spec.sourceCount, spec.pattern);
  const duration = map.length / spec.highFps;
  const uniqueContent = new Map(); // contentKey -> Buffer
  const keyOverrides = spec.keyOverrides || {};
  const contentKeyFor = (sourceIndex) => {
    if (Object.prototype.hasOwnProperty.call(keyOverrides, sourceIndex)) return keyOverrides[sourceIndex];
    for (const [a, b] of spec.staticRanges) {
      if (sourceIndex >= a && sourceIndex <= b) return a;
    }
    return sourceIndex;
  };
  const sourceToKey = [];
  for (let s = 0; s < spec.sourceCount; s++) {
    const key = contentKeyFor(s);
    sourceToKey.push(key);
    if (!uniqueContent.has(key)) uniqueContent.set(key, renderSourceFrame(key));
  }
  const rand = mulberry32(0xc0ffee + spec.sourceCount);
  const frames = map.map((s, outIdx) => {
    const key = sourceToKey[s];
    const base = uniqueContent.get(key);
    // Deep copy only when noise is applied; otherwise reuse (encoder only reads).
    if (!spec.noise) return base;
    const copy = Buffer.from(base);
    addNoise(copy, rand, spec.noise);
    return copy;
  });
  const wav = makeWav(spec.beepSourceFrames.map((s) => s / spec.sourceFps), duration);
  const wavPath = path.join(tmp, "audio.wav");
  await fsp.writeFile(wavPath, wav);
  const outPath = path.join(SAMPLE_DIR, `${spec.name}.mp4`);
  await encodeFrames({ frames, fps: spec.highFps, wavPath, outPath, crf: spec.crf });
  const manifest = {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    file: `${spec.name}.mp4`,
    sourceFps: spec.sourceFps,
    highFps: spec.highFps,
    pattern: spec.pattern,
    sourceCount: spec.sourceCount,
    outputCount: map.length,
    duration,
    noise: spec.noise,
    staticRanges: spec.staticRanges,
    beepTimes: spec.beepSourceFrames.map((s) => s / spec.sourceFps),
    outputToSource: map,
    sourceToKey,
    generatedAt: new Date().toISOString(),
  };
  await fsp.writeFile(path.join(SAMPLE_DIR, `${spec.name}.json`), JSON.stringify(manifest, null, 2));
  await fsp.rm(tmp, { recursive: true, force: true });
  return manifest;
}

export async function buildAllFixtures({ force = false, log = null } = {}) {
  await ensureDirs();
  const out = [];
  for (const spec of FIXTURES) {
    const manifestPath = path.join(SAMPLE_DIR, `${spec.name}.json`);
    const videoPath = path.join(SAMPLE_DIR, `${spec.name}.mp4`);
    if (!force && fs.existsSync(manifestPath) && fs.existsSync(videoPath)) {
      out.push(JSON.parse(await fsp.readFile(manifestPath, "utf8")));
      continue;
    }
    if (log) log(`生成 ${spec.name} …`);
    out.push(await buildFixture(spec));
  }
  return out;
}

export function fixtureSpecs() {
  return FIXTURES;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildAllFixtures({ force: process.argv.includes("--force"), log: (m) => console.log(m) })
    .then((list) => console.log(`已生成 ${list.length} 个素材`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

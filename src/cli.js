#!/usr/bin/env node
/**
 * 命令辅助工具：仅用于节奏恢复的分析与批处理。
 * 交互式的相位/证据查看、片段选择与结果播放请使用图形界面：
 *
 *     npm start        →  http://127.0.0.1:4173/
 *
 * 子命令：
 *   analyze <文件>  [--start 0] [--end 4] [--preset auto] [--json]
 *   render  <文件>  [--start 0] [--end 4] [--preset auto] [--out 结果.mp4] [--no-audio]
 *   presets
 */
import path from "node:path";
import fs from "node:fs";
import { parseArgs } from "node:util";

import { analyzeMedia, normalizeSegment } from "../src/analysis/pipeline.js";
import { probeMedia, OUTPUT_DIR, ensureDirs } from "../src/util/media.js";
import { renderRecovered, sanitizeName } from "../src/util/render.js";
import { RHYTHM_PRESETS } from "../src/analysis/cadence.js";

const HELP = `逐行重复帧节奏恢复 —— 命令辅助

用法：
  node src/cli.js presets
  node src/cli.js analyze <文件> [选项]
  node src/cli.js render  <文件> [选项]

选项：
  --start <秒>     片段开始（默认 0）
  --end <秒>       片段结束（默认到片尾）
  --preset <id>    锁定节奏假设（默认 auto；见 presets）
  --json           仅输出 JSON 结果
  --out <路径>     输出文件（render，默认 data/outputs/<名称>_recovered.mp4）
  --no-audio       不保留原音轨

说明：命令行仅辅助节奏恢复与批处理。相位条、阈值证据、
逐候选解释与运动分析播放等交互功能请使用图形界面：
  npm start   →  http://127.0.0.1:4173/
`;

function progressPrinter(label) {
  const marks = new Set();
  return (p) => {
    const pct = Math.round((p.progress ?? 0) * 100);
    const key = `${p.phase}:${Math.floor(pct / 25)}`;
    if (marks.has(key)) return;
    marks.add(key);
    process.stderr.write(`  [${label}] ${p.phase} ${pct}%\n`);
  };
}

function formatResult(result, file) {
  const s = result.summary;
  const lines = [];
  lines.push(`文件：${file}`);
  lines.push(
    `输出帧率：${s.outFps?.toFixed(2) ?? "—"} fps   片段：${result.segment.start.toFixed(3)}–${result.segment.end.toFixed(3)} s`,
  );
  lines.push(
    s.allStatic
      ? "估计源节奏：未确定（全静止，缺少区分依据）"
      : `估计源节奏：${s.sourceFps ? s.sourceFps.toFixed(2) + " fps" : "未确定"}  模式 ${s.pattern ? s.pattern.join("/") : "—"}  相位 ${s.phase ?? "—"}`,
  );
  lines.push(`匹配 ${s.confidence ?? "—"}%  覆盖 ${s.coverage ?? "—"}%  多解：${s.ambiguous ? "是" : "否"}  全静止：${s.allStatic ? "是" : "否"}`);
  lines.push(`保留帧：${s.keptFrames}/${s.totalFrames}  静止段：${s.staticRuns}  不确定区：${s.uncertainRuns}`);
  lines.push(`证据：${s.evidence}  复制簇 ${s.copyLevel?.toFixed(3)}  更新簇 ${s.changeLevel?.toFixed(3)}  阈值 ${s.threshold?.toFixed(3)}`);
  lines.push("结论：");
  for (const n of s.notes) lines.push(`  · ${n}`);
  if (s.warnings.length) {
    lines.push("提示：");
    for (const w of s.warnings) lines.push(`  ! ${w}`);
  }
  lines.push("处理的区间（前 20 个）：");
  for (const r of result.decisions.runDecisions.slice(0, 20)) {
    lines.push(
      `  #${String(r.start).padStart(3)}–${String(r.end - 1).padEnd(3)} ${r.length}帧 ${r.action.padEnd(13)} 相位 ${r.phase ?? "-"}/${r.period}  ${r.reason}`,
    );
  }
  if (result.decisions.runDecisions.length > 20) {
    lines.push(`  … 其余 ${result.decisions.runDecisions.length - 20} 个区间见图形界面`);
  }
  return lines.join("\n");
}

async function cmdAnalyze(file, opts) {
  if (!file) throw new Error("缺少输入文件");
  const media = await probeMedia(file);
  const segment = normalizeSegment(media, opts.start ?? 0, opts.end ?? null);
  const result = await analyzeMedia(file, {
    start: segment.start,
    end: segment.end,
    presetId: opts.preset || "auto",
    onProgress: progressPrinter("分析"),
  });
  if (opts.json) {
    const payload = {
      file,
      segment: result.segment,
      summary: result.summary,
      runs: result.decisions.runDecisions,
      kept: result.decisions.kept,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    process.stdout.write(formatResult(result, file) + "\n");
  }
}

async function cmdRender(file, opts) {
  if (!file) throw new Error("缺少输入文件");
  await ensureDirs();
  const media = await probeMedia(file);
  const segment = normalizeSegment(media, opts.start ?? 0, opts.end ?? null);
  const result = await analyzeMedia(file, {
    start: segment.start,
    end: segment.end,
    presetId: opts.preset || "auto",
    onProgress: progressPrinter("分析"),
  });
  const base = path.basename(file, path.extname(file));
  const outPath = path.resolve(
    opts.out || path.join(OUTPUT_DIR, `${sanitizeName(base)}_recovered.mp4`),
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const render = await renderRecovered({
    media,
    kept: result.decisions.kept,
    outputPath: outPath,
    options: { keepAudio: opts["no-audio"] !== true },
    onProgress: progressPrinter("重封装"),
  });
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          file,
          output: outPath,
          summary: result.summary,
          render: {
            keptCount: render.keptCount,
            duration: render.total,
            outputFrames: render.outputFrames.length,
            verification: render.verification,
            keptTimeline: render.keptTimeline,
          },
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(formatResult(result, file) + "\n\n");
    process.stdout.write(`已输出：${outPath}\n`);
    process.stdout.write(
      `保留 ${render.keptCount} 帧，总时长 ${render.total.toFixed(3)} 秒，音轨：${render.verification.audioPresent ? "已保留（流复制）" : "无"}\n`,
    );
    for (const w of render.verification.warnings) process.stdout.write(`! ${w}\n`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      start: { type: "string" },
      end: { type: "string" },
      preset: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      "no-audio": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, file] = positionals;
  if (values.help || !cmd || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  const opts = {
    start: values.start != null ? Number(values.start) : 0,
    end: values.end != null ? Number(values.end) : null,
    preset: values.preset || "auto",
    out: values.out,
    json: values.json,
    "no-audio": values["no-audio"],
  };
  if (cmd === "presets") {
    const list = RHYTHM_PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      sourceFps: p.sourceFps,
    }));
    if (values.json) process.stdout.write(JSON.stringify(list, null, 2) + "\n");
    else for (const p of list) process.stdout.write(`${p.id.padEnd(8)} ${p.label}\n`);
    return;
  }
  if (cmd === "analyze") return cmdAnalyze(file, opts);
  if (cmd === "render") return cmdRender(file, opts);
  throw new Error(`未知子命令：${cmd}`);
}

main().catch((err) => {
  process.stderr.write(`错误：${err.message}\n`);
  process.exit(1);
});

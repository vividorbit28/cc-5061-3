const state = {
  presets: [],
  samples: [],
  media: null, // { id, name, url, size }
  info: null,
  analysis: null,
  result: null,
  mode: "source",
  speed: 1,
  playing: false,
  stepKeep: false,
  activeJob: null,
  motionPrev: null,
  keptPlayhead: 0,
  keptRaf: null,
  keptLastTs: 0,
};

const $ = (sel) => document.querySelector(sel);
const el = {
  fileInput: $("#file-input"),
  sampleSelect: $("#sample-select"),
  sampleNote: $("#sample-note"),
  segStart: $("#seg-start"),
  segEnd: $("#seg-end"),
  durationHint: $("#duration-hint"),
  btnAnalyze: $("#btn-analyze"),
  btnRender: $("#btn-render"),
  presetSelect: $("#preset-select"),
  keepUncertain: $("#keep-uncertain"),
  keepAudio: $("#keep-audio"),
  statusDot: $("#status-dot"),
  statusText: $("#status-text"),
  statusDetail: $("#status-detail"),
  progressBar: $("#progress-bar"),
  errorList: $("#error-list"),
  video: $("#video"),
  videoEmpty: $("#video-empty"),
  motion: $("#motion-canvas"),
  ovMode: $("#ov-mode"),
  ovTime: $("#ov-time"),
  ovFrame: $("#ov-frame"),
  ovAction: $("#ov-action"),
  timeline: $("#timeline"),
  btnPlay: $("#btn-play"),
  scrub: $("#scrub"),
  timeReadout: $("#time-readout"),
  stepKeep: $("#step-keep"),
  evidenceTag: $("#evidence-tag"),
  mSourceFps: $("#m-source-fps"),
  mSourceLabel: $("#m-source-label"),
  mPattern: $("#m-pattern"),
  mPhase: $("#m-phase"),
  mConfidence: $("#m-confidence"),
  mCoverage: $("#m-coverage"),
  mKept: $("#m-kept"),
  mStatic: $("#m-static"),
  phaseStrip: $("#phase-strip"),
  phaseScale: $("#phase-scale"),
  thresholdChart: $("#threshold-chart"),
  thresholdDetail: $("#threshold-detail"),
  candBody: $("#cand-body"),
  rhythmReason: $("#rhythm-reason"),
  notesList: $("#notes-list"),
  warnList: $("#warn-list"),
  runsBody: $("#runs-body"),
  runsHint: $("#runs-hint"),
  framesBody: $("#frames-body"),
  resultVideo: $("#result-video"),
  resultEmpty: $("#result-empty"),
  resultTag: $("#result-tag"),
  rKept: $("#r-kept"),
  rKeptSub: $("#r-kept-sub"),
  rDuration: $("#r-duration"),
  rDurationSub: $("#r-duration-sub"),
  rAudio: $("#r-audio"),
  rAudioSub: $("#r-audio-sub"),
  downloadLink: $("#download-link"),
  btnReveal: $("#btn-reveal"),
  verifyList: $("#verify-list"),
  keptBody: $("#kept-body"),
  helpDialog: $("#help-dialog"),
  btnHelp: $("#btn-help"),
};

const motionCtx = el.motion.getContext("2d");
const tlCtx = el.timeline.getContext("2d");
const off = document.createElement("canvas");
off.width = 96;
off.height = 54;
const offCtx = off.getContext("2d", { willReadFrequently: true });

init();

async function init() {
  el.btnHelp.addEventListener("click", () => el.helpDialog.showModal());
  el.fileInput.addEventListener("change", onFile);
  el.sampleSelect.addEventListener("change", onSample);
  el.btnAnalyze.addEventListener("click", () => runAnalysis());
  el.btnRender.addEventListener("click", () => runRender());
  el.btnPlay.addEventListener("click", togglePlay);
  el.stepKeep.addEventListener("change", () => {
    state.stepKeep = el.stepKeep.checked;
    if (state.mode === "kept") syncModeButtons();
  });
  el.scrub.addEventListener("input", onScrub);
  el.video.addEventListener("timeupdate", () => {
    if (state.mode === "source") updatePlayheadUI();
  });
  el.video.addEventListener("play", () => setPlayingUI(true));
  el.video.addEventListener("pause", () => setPlayingUI(false));
  el.video.addEventListener("seeked", () => {
    if (state.mode === "source") {
      updatePlayheadUI();
      if (el.stepKeep.checked) drawMotionEvidence(true);
    }
  });
  document.querySelectorAll(".speed button").forEach((b) =>
    b.addEventListener("click", () => {
      state.speed = Number(b.dataset.speed);
      el.video.playbackRate = state.speed;
      document.querySelectorAll(".speed button").forEach((x) => x.classList.toggle("active", x === b));
    }),
  );
  document.querySelectorAll(".player-modes .mode").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode)),
  );
  el.btnReveal.addEventListener("click", () => {
    if (state.result) document.querySelector("#result-panel").scrollIntoView({ behavior: "smooth" });
  });
  el.timeline.addEventListener("click", onTimelineClick);
  window.addEventListener("resize", () => {
    drawTimeline();
    drawPhaseStrip();
  });
  el.segStart.addEventListener("change", updateSegHint);
  el.segEnd.addEventListener("change", updateSegHint);

  document.addEventListener("keydown", (ev) => {
    if (!state.stepKeep || !state.analysis) return;
    if (ev.target instanceof HTMLInputElement) {
      const type = ev.target.type;
      if (type !== "checkbox" && type !== "radio" && type !== "range") return;
    }
    if (ev.target instanceof HTMLSelectElement || ev.target instanceof HTMLTextAreaElement) return;
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      stepKeptFrame(ev.key === "ArrowRight" ? 1 : -1);
    }
  });

  await Promise.all([loadPresets(), loadSamples()]);
  setStatus("idle", "等待素材", "选择内置测试素材或上传本地视频");
}

async function loadPresets() {
  try {
    const res = await fetch("/api/presets");
    const data = await res.json();
    state.presets = data.presets || [];
    el.presetSelect.innerHTML = "";
    for (const p of state.presets) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      el.presetSelect.appendChild(opt);
    }
    el.presetSelect.value = "auto";
  } catch (err) {
    pushError(`无法加载节奏类型：${err.message}`);
  }
}

async function loadSamples() {
  try {
    const res = await fetch("/api/samples");
    const data = await res.json();
    state.samples = data.samples || [];
    el.sampleSelect.innerHTML = '<option value="">选择内置素材…</option>';
    for (const s of state.samples) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.title;
      el.sampleSelect.appendChild(opt);
    }
    if (state.samples.length && !state.media) {
      el.sampleSelect.value = state.samples[0].id;
      await onSample();
    }
  } catch (err) {
    pushError(`无法加载素材：${err.message}`);
  }
}

async function onSample() {
  const id = el.sampleSelect.value;
  const sample = state.samples.find((s) => s.id === id);
  if (!sample) return;
  el.sampleNote.textContent = sample.description || "";
  await loadMedia({ id: sample.id, name: sample.title, url: sample.url, sample });
}

async function onFile() {
  const file = el.fileInput.files?.[0];
  if (!file) return;
  el.sampleSelect.value = "";
  el.sampleNote.textContent = "";
  setStatus("running", "上传中", file.name);
  try {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
      headers: { "Content-Type": "application/octet-stream" },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "上传失败");
    await loadMedia({ id: data.id, name: file.name, url: data.url });
  } catch (err) {
    setStatus("error", "上传失败", err.message);
    pushError(err.message);
  }
}

async function loadMedia(media) {
  resetAnalysis();
  state.media = media;
  setStatus("running", "读取媒体信息", media.name);
  try {
    const res = await fetch(`/api/info/${encodeURIComponent(media.id)}`);
    const info = await res.json();
    if (!res.ok) throw new Error(info.error || "读取失败");
    state.info = info;
    el.segStart.value = "0";
    el.segEnd.value = (info.duration ?? 0).toFixed(2);
    el.segStart.max = info.duration ?? 0;
    el.segEnd.max = info.duration ?? 0;
    el.video.src = media.url;
    el.video.playbackRate = state.speed;
    el.videoEmpty.classList.add("hidden");
    el.resultVideo.removeAttribute("src");
    el.resultEmpty.classList.remove("hidden");
    el.btnAnalyze.disabled = false;
    el.btnRender.disabled = true;
    updateSegHint();
    setStatus("idle", "素材已就绪", `${info.width}×${info.height} · ${fmt(info.fps, 2)} fps · ${fmt(info.duration, 2)} 秒${info.audio ? " · 有音轨" : " · 无音轨"}`);
    drawTimeline();
  } catch (err) {
    setStatus("error", "读取失败", err.message);
    pushError(err.message);
  }
}

function updateSegHint() {
  if (!state.info) {
    el.durationHint.textContent = "未加载素材";
    return;
  }
  const dur = state.info.duration ?? 0;
  const s = Number(el.segStart.value) || 0;
  const e = Number(el.segEnd.value) || dur;
  const len = Math.max(0, e - s);
  el.durationHint.textContent = `总时长 ${fmt(dur, 2)} 秒 · 当前片段 ${fmt(s, 2)}–${fmt(e, 2)} 秒（${fmt(len, 2)} 秒）`;
}

function resetAnalysis() {
  state.analysis = null;
  state.result = null;
  stopKeptPlayback();
  el.btnRender.disabled = true;
  document.querySelectorAll(".player-modes .mode").forEach((b) => {
    if (b.dataset.mode !== "source") b.disabled = true;
  });
  setMode("source");
  el.evidenceTag.textContent = "未分析";
  el.evidenceTag.className = "tag";
  el.mSourceFps.textContent = "—";
  el.mSourceLabel.textContent = "—";
  el.mPattern.textContent = "—";
  el.mPhase.textContent = "相位 —";
  el.mConfidence.textContent = "—";
  el.mCoverage.textContent = "覆盖 —";
  el.mKept.textContent = "—";
  el.mStatic.textContent = "静止段 —";
  el.phaseStrip.innerHTML = "";
  el.thresholdChart.innerHTML = "";
  el.thresholdDetail.textContent = "—";
  el.candBody.innerHTML = '<tr><td colspan="4" class="hint">—</td></tr>';
  el.rhythmReason.textContent = "尚未分析。";
  el.notesList.innerHTML = "";
  el.warnList.innerHTML = "";
  el.runsBody.innerHTML = '<tr><td colspan="8" class="hint">尚未分析。</td></tr>';
  el.framesBody.innerHTML = "";
  el.keptBody.innerHTML = '<tr><td colspan="6" class="hint">尚未生成结果。</td></tr>';
  el.resultTag.textContent = "未生成";
  el.resultTag.className = "tag";
  el.rKept.textContent = "—";
  el.rKeptSub.textContent = "—";
  el.rDuration.textContent = "—";
  el.rDurationSub.textContent = "—";
  el.rAudio.textContent = "—";
  el.rAudioSub.textContent = "—";
  el.verifyList.innerHTML = "";
  el.downloadLink.classList.add("disabled");
  el.downloadLink.removeAttribute("href");
  el.btnReveal.disabled = true;
  el.errorList.innerHTML = "";
  drawTimeline();
}

function segment() {
  const dur = state.info?.duration ?? 0;
  const s = Math.max(0, Number(el.segStart.value) || 0);
  const e = Math.min(dur, Number(el.segEnd.value) || dur);
  return { start: s, end: e };
}

async function runAnalysis() {
  if (!state.media) return;
  clearErrors();
  const { start, end } = segment();
  if (!(end > start)) {
    pushError("片段结束时间必须大于开始时间");
    return;
  }
  el.btnAnalyze.disabled = true;
  el.btnRender.disabled = true;
  setStatus("running", "分析中", "提交任务");
  try {
    const res = await fetch("/api/jobs/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mediaId: state.media.id,
        start,
        end,
        presetId: el.presetSelect.value,
        keepUncertain: el.keepUncertain.checked,
      }),
    });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || "提交失败");
    const result = await pollJob(job.id);
    state.analysis = result;
    applyAnalysis(result);
    el.btnRender.disabled = false;
    el.btnAnalyze.disabled = false;
    setStatus("done", "分析完成", `用时 ${(result.elapsedMs / 1000).toFixed(1)} 秒`);
  } catch (err) {
    el.btnAnalyze.disabled = false;
    setStatus("error", "分析失败", err.message);
    pushError(err.message);
  }
}

async function runRender() {
  if (!state.analysis || !state.media) return;
  clearErrors();
  el.btnRender.disabled = true;
  setStatus("running", "重封装中", "按原时间戳重建视频");
  const { start, end } = segment();
  try {
    const res = await fetch("/api/jobs/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mediaId: state.media.id,
        mediaName: state.media.sample?.name || state.media.name,
        start,
        end,
        presetId: el.presetSelect.value,
        keepUncertain: el.keepUncertain.checked,
        keepAudio: el.keepAudio.checked,
      }),
    });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || "提交失败");
    const result = await pollJob(job.id);
    state.result = result;
    applyResult(result);
    setStatus("done", "重封装完成", `${result.keptFrames} 帧 · ${fmt(result.duration, 2)} 秒`);
  } catch (err) {
    setStatus("error", "重封装失败", err.message);
    pushError(err.message);
  } finally {
    el.btnRender.disabled = !state.analysis;
  }
}

async function pollJob(id) {
  while (true) {
    const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || "任务查询失败");
    setStatus("running", phaseText(job), job.message || "");
    if (job.progress != null) el.progressBar.style.width = `${Math.round(job.progress * 100)}%`;
    if (job.status === "done") return job.result;
    if (job.status === "error") throw new Error(job.error || "任务失败");
    await new Promise((r) => setTimeout(r, 320));
  }
}

function phaseText(job) {
  return (
    {
      queued: "排队中",
      probe: "读取媒体",
      decode: "解码与分析",
      metrics: "运动与差异证据",
      classify: "复制帧分类",
      fit: "节奏拟合",
      analyze: "分析中",
      render: "重封装",
      done: "完成",
    }[job.phase] || "处理中"
  );
}

function applyAnalysis(a) {
  const s = a.summary;
  const r = a.rhythm;
  el.evidenceTag.textContent =
    s.evidence === "bimodal" ? "双峰可分" : s.evidence === "all-static" ? "全静止" : s.evidence === "no-copies" ? "未见复制" : "证据不足";
  el.evidenceTag.className =
    "tag " + (s.ambiguous || s.allStatic ? "warn" : s.evidence === "bimodal" ? "ok" : "warn");

  const undetermined = s.allStatic || s.ambiguous;
  el.mSourceFps.textContent = s.allStatic ? "未确定" : s.sourceFps ? `${fmt(s.sourceFps, 2)} fps` : "—";
  el.mSourceLabel.textContent = s.allStatic ? "全静止，缺少区分依据" : s.sourceFpsLabel || "—";
  el.mPattern.textContent = s.allStatic ? "多解" : s.pattern ? `[${s.pattern.join(", ")}]` : "—";
  el.mPhase.textContent = s.allStatic
    ? "相位 —"
    : s.phase != null
      ? `相位 ${s.phase} · 周期 ${r.best?.pattern?.length ?? 1}`
      : "相位 —";
  el.mConfidence.textContent = s.confidence != null ? `${s.confidence}%` : "—";
  el.mCoverage.textContent = s.coverage != null ? `覆盖 ${s.coverage}%` : "覆盖 —";
  el.mKept.textContent = `${s.keptFrames} / ${s.totalFrames}`;
  el.mStatic.textContent = `静止段 ${s.staticRuns} · 不确定 ${s.uncertainRuns}`;
  el.mKept.parentElement.classList.toggle("warn-metric", undetermined);

  drawPhaseStrip();
  drawThreshold(a);
  drawCandidates(a);
  el.rhythmReason.textContent = r.reason || "—";
  el.notesList.innerHTML = "";
  for (const note of a.notes || []) {
    const li = document.createElement("li");
    li.textContent = note;
    el.notesList.appendChild(li);
  }
  el.warnList.innerHTML = "";
  for (const w of a.warnings || []) {
    const li = document.createElement("li");
    li.textContent = w;
    el.warnList.appendChild(li);
  }
  renderRuns(a);
  renderFrames(a);
  drawTimeline();

  document.querySelectorAll(".player-modes .mode").forEach((b) => {
    b.disabled = b.dataset.mode === "result";
  });
}

function drawThreshold(a) {
  const t = a.threshold;
  const max = Math.max(t.changeLevel, 1);
  const rows = [
    { label: "复制簇", value: t.copyLevel, cls: "copy" },
    { label: "判定阈值", value: t.value, cls: "threshold" },
    { label: "更新簇", value: t.changeLevel, cls: "change" },
  ];
  el.thresholdChart.innerHTML = "";
  for (const row of rows) {
    const div = document.createElement("div");
    div.className = "bar-row";
    div.innerHTML = `<span>${row.label}</span><span class="bar-track"><span class="bar-fill ${row.cls}" style="width:${Math.min(100, (row.value / max) * 100).toFixed(1)}%"></span></span><span class="bar-val">${fmt(row.value, 2)}</span>`;
    el.thresholdChart.appendChild(div);
  }
  el.thresholdDetail.textContent = `方法：${t.method}。复制簇与更新簇的中位差异分别为 ${fmt(t.copyLevel, 2)} 与 ${fmt(t.changeLevel, 2)}，阈值 ${fmt(t.value, 2)}。`;
}

function drawCandidates(a) {
  const r = a.rhythm;
  el.candBody.innerHTML = "";
  const rows = r.candidates.slice(0, 8);
  if (!rows.length) {
    el.candBody.innerHTML = '<tr><td colspan="4" class="hint">无候选</td></tr>';
    return;
  }
  for (const c of rows) {
    const tr = document.createElement("tr");
    if (r.best && c.presetId === r.best.presetId) tr.className = r.locked ? "locked" : "best";
    tr.innerHTML = `<td>${escapeHtml(c.label)}</td><td class="mono">[${c.pattern.join(",")}]</td><td class="mono">${Math.round(c.score * 100)}%</td><td class="mono">${Math.round(c.coverage * 100)}%</td>`;
    el.candBody.appendChild(tr);
  }
}

function drawPhaseStrip() {
  const a = state.analysis;
  if (!a || !a.rhythm.best) {
    el.phaseStrip.innerHTML = '<span class="hint">尚无节奏数据</span>';
    el.phaseScale.textContent = "";
    return;
  }
  const runs = a.runs.filter((r) => !r.isStatic).slice(0, 64);
  el.phaseStrip.innerHTML = "";
  const period = a.rhythm.best.pattern.length || 1;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const cell = document.createElement("div");
    const phase = r.phase ?? 0;
    cell.className = `phase-cell p${(phase % 4) + 1}`;
    if (r.action === "drop-copies") cell.classList.add("kept");
    if (r.action === "keep-uncertain") cell.classList.add("uncertain");
    cell.title = `区间 #${r.start}–#${r.end - 1}：${r.length} 帧 · 预期 ${r.predicted ?? "?"} · 相位 ${phase}/${period} · ${r.action}`;
    cell.innerHTML = `${r.predicted ?? "?"}<small>${phase}</small>`;
    el.phaseStrip.appendChild(cell);
  }
  el.phaseScale.textContent = `周期 ${period} 个源帧 · 显示前 ${Math.min(64, runs.length)} 段`;
}

function renderRuns(a) {
  el.runsBody.innerHTML = "";
  el.runsHint.textContent = `共 ${a.runs.length} 段；每个被丢弃的候选帧都记录原因`;
  if (!a.runs.length) {
    el.runsBody.innerHTML = '<tr><td colspan="8" class="hint">没有可显示的区间。</td></tr>';
    return;
  }
  for (const r of a.runs) {
    const tr = document.createElement("tr");
    tr.dataset.start = r.tStart;
    tr.innerHTML = `
      <td class="mono">#${r.start}–#${r.end - 1}</td>
      <td class="mono">${fmt(r.tStart, 3)}–${r.tEnd != null ? fmt(r.tEnd, 3) : "?"}</td>
      <td class="mono">${r.length}</td>
      <td class="mono">${r.predicted ?? "—"}</td>
      <td class="mono">${r.phase != null ? `${r.phase}/${r.period}` : "—"}</td>
      <td class="why">${escapeHtml(r.reason)}</td>
      <td><span class="pill ${r.action}">${actionText(r.action)}</span></td>
      <td class="mono">${Math.round(r.confidence * 100)}%</td>`;
    tr.addEventListener("click", () => seekTo(r.tStart));
    el.runsBody.appendChild(tr);
  }
}

function renderFrames(a) {
  el.framesBody.innerHTML = "";
  const rows = a.frames;
  const limit = 1200;
  const view = rows.length > limit ? rows.slice(0, limit) : rows;
  for (const f of view) {
    const tr = document.createElement("tr");
    const cls =
      f.a === "drop" ? "row-drop" : f.a === "drop-static" ? "row-static" : f.a === "keep-uncertain" ? "row-uncertain" : "";
    if (cls) tr.className = cls;
    tr.dataset.frame = f.i;
    tr.innerHTML = `<td class="mono">${f.i}</td><td class="mono">${fmt(f.t, 3)}</td><td class="mono">${fmt(f.d, 2)}</td><td class="mono">${fmt(f.m, 2)}</td><td><span class="pill ${framePill(f.a)}">${frameText(f.a)}</span></td><td class="why">${escapeHtml(f.reason || "")}</td>`;
    tr.addEventListener("click", () => seekTo(f.t));
    el.framesBody.appendChild(tr);
  }
  if (rows.length > limit) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="hint">仅显示前 ${limit} 帧（共 ${rows.length} 帧）。</td>`;
    el.framesBody.appendChild(tr);
  }
}

function framePill(a) {
  return a === "drop" ? "drop-copies" : a === "drop-static" ? "keep-static" : a === "keep-uncertain" ? "keep-uncertain" : "keep";
}
function frameText(a) {
  return (
    { keep: "保留", drop: "丢弃（复制）", "drop-static": "静止内相同画面", "keep-uncertain": "保留（不确定）" }[a] || a
  );
}
function actionText(a) {
  return (
    {
      "drop-copies": "保留首帧 / 去除复制",
      "keep": "全部保留",
      "keep-static": "保留时长（真实静止）",
      "keep-uncertain": "保留（不确定区）",
    }[a] || a
  );
}

/* ---------------- playback ---------------- */

function setMode(mode) {
  if (mode === "kept" && !state.analysis) return;
  if (mode === "result" && !state.result) return;
  state.mode = mode;
  document.querySelectorAll(".player-modes .mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  el.ovMode.textContent = { source: "原片", kept: "保留帧（实际运算）", result: "结果" }[mode];
  stopKeptPlayback();
  if (mode === "kept") {
    el.video.pause();
    enterKeptMode();
  } else {
    el.motion.classList.remove("on");
    el.video.classList.remove("hidden");
    if (mode === "result") {
      setStatus("done", "结果模式", "正在播放重封装后的视频");
      document.querySelector("#result-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      el.resultVideo.play().catch(() => {});
    } else {
      updatePlayheadUI();
    }
  }
  syncModeButtons();
}

function syncModeButtons() {
  el.stepKeep.disabled = state.mode === "result";
}

function enterKeptMode() {
  if (!state.analysis) return;
  const kept = state.analysis.kept;
  if (!kept.length) return;
  const t0 = state.analysis.segment.start;
  state.keptPlayhead = Math.max(t0, 0);
  el.video.classList.add("hidden");
  state.keptPlaying = state.playing;
  startKeptLoop();
}

function startKeptLoop() {
  stopKeptLoopOnly();
  state.keptLastTs = performance.now();
  const loop = (ts) => {
    const dt = (ts - state.keptLastTs) / 1000;
    state.keptLastTs = ts;
    const segEnd = state.analysis.segment.end;
    if (state.keptPlaying) {
      state.keptPlayhead += dt * state.speed;
      if (state.keptPlayhead >= segEnd) {
        state.keptPlayhead = segEnd - 0.0001;
        setKeptPlaying(false);
      }
    }
    renderKeptFrame();
    updatePlayheadUI();
    state.keptRaf = requestAnimationFrame(loop);
  };
  state.keptRaf = requestAnimationFrame(loop);
}

function stopKeptLoopOnly() {
  if (state.keptRaf) cancelAnimationFrame(state.keptRaf);
  state.keptRaf = null;
}

function stopKeptPlayback() {
  stopKeptLoopOnly();
  state.keptPlaying = false;
  el.motion.classList.remove("on");
  el.video.classList.remove("hidden");
}

function setKeptPlaying(v) {
  state.keptPlaying = v;
  setPlayingUI(v);
}

function renderKeptFrame() {
  const a = state.analysis;
  if (!a || !a.kept.length) return;
  const kept = a.kept;
  const t = state.keptPlayhead;
  const idx = findKeptIndex(kept, t);
  const k = kept[idx];
  el.ovFrame.textContent = `源帧 #${k.sourceFrame}`;
  el.ovTime.textContent = `${fmt(t, 3)} s`;
  el.ovAction.textContent = `${frameText(k.action)} · 显示 ${fmt(k.displayDuration, 3)} s`;
  el.ovAction.className = "badge action " + pillClassForKept(k.action);
  // Draw the currently held source frame.
  const target = k.time;
  if (Math.abs(el.video.currentTime - target) > 0.002) {
    if (el.video.readyState >= 1) el.video.currentTime = target;
  }
  drawVideoToMotionCanvas(target);
  highlightFrameRow(k.sourceFrame);
}

function drawVideoToMotionCanvas() {
  if (el.video.readyState < 2) return;
  el.motion.classList.add("on");
  const w = el.motion.width = el.motion.clientWidth || 640;
  const h = el.motion.height = el.motion.clientHeight || 360;
  motionCtx.drawImage(el.video, 0, 0, w, h);
}

function findKeptIndex(kept, t) {
  let lo = 0;
  let hi = kept.length - 1;
  if (t <= kept[0].time) return 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = kept[mid];
    const next = mid < kept.length - 1 ? kept[mid + 1].time : Infinity;
    if (t >= k.time && t < next) return mid;
    if (t < k.time) hi = mid - 1;
    else lo = mid + 1;
  }
  return kept.length - 1;
}

function pillClassForKept(a) {
  if (a === "keep-uncertain") return "uncertain";
  if (a === "drop-static") return "static";
  return "keep";
}

function togglePlay() {
  if (state.mode === "kept") {
    setKeptPlaying(!state.keptPlaying);
    return;
  }
  if (el.video.paused) el.video.play().catch(() => {});
  else el.video.pause();
}

function setPlayingUI(playing) {
  state.playing = playing;
  el.btnPlay.textContent = playing ? "❚❚" : "▶";
}

function onScrub() {
  const dur = state.analysis?.segment ?? { start: 0, end: state.info?.duration ?? 0 };
  const frac = Number(el.scrub.value) / 1000;
  const t = dur.start + frac * (dur.end - dur.start);
  seekTo(t);
}

function seekTo(t) {
  if (state.mode === "kept" && state.analysis) {
    state.keptPlayhead = Math.max(state.analysis.segment.start, Math.min(state.analysis.segment.end - 0.0001, t));
    renderKeptFrame();
    updatePlayheadUI();
    return;
  }
  if (!state.video.duration) return;
  el.video.currentTime = Math.max(0, Math.min(state.video.duration - 0.001, t));
  if (el.stepKeep.checked && state.analysis) drawMotionEvidence(true);
}

function stepKeptFrame(dir) {
  const a = state.analysis;
  if (!a || !a.kept.length) return;
  const kept = a.kept;
  const cur = state.mode === "kept" ? state.keptPlayhead : el.video.currentTime;
  let idx = findKeptIndex(kept, cur);
  if (dir > 0) {
    const next = kept[idx + 1];
    if (next) idx += 1;
    else idx = kept.length - 1;
  } else {
    const target = kept[idx].time;
    if (Math.abs(cur - target) > 0.001) {
      // Snap to the start of the held frame first.
    } else if (idx > 0) idx -= 1;
  }
  const k = kept[idx];
  if (state.mode === "kept") {
    setKeptPlaying(false);
    state.keptPlayhead = Math.max(a.segment.start, k.time);
    renderKeptFrame();
    updatePlayheadUI();
  } else {
    el.video.pause();
    seekTo(k.time);
    state.keptPlayhead = k.time;
    el.ovAction.textContent = `保留帧源 #${k.sourceFrame} · 显示 ${fmt(k.displayDuration, 3)} s`;
    el.ovAction.className = "badge action " + pillClassForKept(k.action);
    highlightFrameRow(k.sourceFrame);
  }
}

function onTimelineClick(ev) {  const rect = el.timeline.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
  const seg = state.analysis?.segment ?? { start: 0, end: state.info?.duration ?? 0 };
  seekTo(seg.start + frac * (seg.end - seg.start));
}

function updatePlayheadUI() {
  const seg = state.analysis?.segment ?? { start: 0, end: state.info?.duration ?? 0 };
  const t = state.mode === "kept" ? state.keptPlayhead : el.video.currentTime;
  const frac = seg.end > seg.start ? (t - seg.start) / (seg.end - seg.start) : 0;
  el.scrub.value = String(Math.round(Math.max(0, Math.min(1, frac)) * 1000));
  el.timeReadout.textContent = `${fmt(t, 3)} / ${fmt(seg.end, 3)} s`;
  el.ovTime.textContent = `${fmt(t, 3)} s`;
  if (state.mode !== "kept") updateFrameBadge(t);
  drawTimeline(t);
}

function updateFrameBadge(t) {
  if (!state.analysis) return;
  const times = state.analysis.timeline.frameTimes;
  const idx = nearestIndex(times, t);
  const f = state.analysis.frames[idx];
  if (!f) return;
  el.ovFrame.textContent = `帧 #${idx}`;
  const cls =
    f.a === "drop" ? "drop" : f.a === "drop-static" ? "static" : f.a === "keep-uncertain" ? "uncertain" : "keep";
  el.ovAction.textContent = `${frameText(f.a)} · ${f.a === "drop" || f.a === "drop-static" ? "已由前帧替代" : "保留"}`;
  el.ovAction.className = "badge action " + cls;
  highlightFrameRow(idx);
}

function highlightFrameRow(idx) {
  const prev = el.framesBody.querySelector(".row-current");
  if (prev) prev.classList.remove("row-current");
  const row = el.framesBody.querySelector(`tr[data-frame="${idx}"]`);
  if (row) {
    row.classList.add("row-current");
    const details = row.closest("details");
    if (details && details.open) row.scrollIntoView({ block: "nearest" });
  }
}

function nearestIndex(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  if (!times.length) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t)) return lo - 1;
  return lo;
}

/* live motion overlay (real computation on decoded frames) */
let motionTimer = null;
function drawMotionEvidence(force = false) {
  if (!el.stepKeep.checked && !force) return;
  if (el.video.readyState < 2) return;
  offCtx.drawImage(el.video, 0, 0, off.width, off.height);
  const cur = offCtx.getImageData(0, 0, off.width, off.height).data;
  if (state.motionPrev) {
    const w = el.motion.width = el.motion.clientWidth || 640;
    const h = el.motion.height = el.motion.clientHeight || 360;
    const tmp = document.createElement("canvas");
    tmp.width = off.width;
    tmp.height = off.height;
    const tctx = tmp.getContext("2d");
    const img = tctx.createImageData(off.width, off.height);
    for (let i = 0; i < cur.length; i += 4) {
      const d = Math.abs(cur[i] - state.motionPrev[i]) + Math.abs(cur[i + 1] - state.motionPrev[i + 1]) + Math.abs(cur[i + 2] - state.motionPrev[i + 2]);
      const v = Math.min(255, d * 3);
      img.data[i] = v;
      img.data[i + 1] = v < 60 ? v : 40;
      img.data[i + 2] = 90 + (255 - v) * 0.25;
      img.data[i + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    motionCtx.imageSmoothingEnabled = false;
    motionCtx.drawImage(tmp, 0, 0, w, h);
    el.motion.classList.add("on");
  }
  state.motionPrev = cur;
}

el.video.addEventListener("timeupdate", () => {
  if (state.mode === "source" && el.stepKeep.checked) {
    clearTimeout(motionTimer);
    motionTimer = setTimeout(() => drawMotionEvidence(), 60);
  }
});

/* ---------------- timeline canvas ---------------- */

function drawTimeline(playhead = null) {
  const canvas = el.timeline;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 640;
  const h = 96;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  tlCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tlCtx.clearRect(0, 0, w, h);
  const a = state.analysis;
  const seg = a?.segment ?? { start: 0, end: state.info?.duration ?? 0 };
  const span = Math.max(0.001, seg.end - seg.start);
  const padX = 2;
  const trackY = 22;
  const trackH = 34;

  tlCtx.fillStyle = "#0f151d";
  tlCtx.fillRect(0, 0, w, h);

  // grid
  tlCtx.strokeStyle = "rgba(120,140,160,0.12)";
  tlCtx.fillStyle = "#65727f";
  tlCtx.font = "10px ui-monospace, monospace";
  const step = niceStep(span, 6);
  for (let t = Math.ceil(seg.start / step) * step; t <= seg.end + 1e-6; t += step) {
    const x = padX + ((t - seg.start) / span) * (w - padX * 2);
    tlCtx.beginPath();
    tlCtx.moveTo(x, 6);
    tlCtx.lineTo(x, trackY + trackH + 6);
    tlCtx.stroke();
    tlCtx.fillText(`${fmt(t, t < 10 ? 2 : 1)}`, x + 2, h - 4);
  }

  if (a) {
    const runs = a.runs;
    for (const r of runs) {
      const x0 = padX + ((Math.max(seg.start, r.tStart) - seg.start) / span) * (w - padX * 2);
      const tEnd = r.tEnd ?? seg.end;
      const x1 = padX + ((Math.min(seg.end, tEnd) - seg.start) / span) * (w - padX * 2);
      const width = Math.max(1, x1 - x0);
      let color = "#2a4054";
      if (r.isStatic) color = "rgba(185,140,255,0.55)";
      else if (r.action === "drop-copies") color = "rgba(88,192,122,0.6)";
      else if (r.action === "keep-uncertain") color = "rgba(123,135,148,0.55)";
      else color = "rgba(88,192,122,0.35)";
      tlCtx.fillStyle = color;
      const gap = width > 3 ? 1 : 0;
      tlCtx.fillRect(x0, trackY, Math.max(1, width - gap), trackH);
      if (r.action === "drop-copies" && width > 5) {
        // show dropped portion
        tlCtx.fillStyle = "rgba(196,87,87,0.55)";
        const innerW = Math.max(1, width - 2);
        tlCtx.fillRect(x0 + innerW * 0.42, trackY + trackH * 0.32, innerW * 0.56, trackH * 0.36);
      }
      if (r.isStatic && width > 8) {
        tlCtx.fillStyle = "rgba(255,255,255,0.55)";
        tlCtx.font = "10px sans-serif";
        tlCtx.fillText("静止", x0 + 3, trackY + 13);
      }
    }
    // kept frame ticks
    tlCtx.fillStyle = "rgba(157,240,188,0.85)";
    for (const k of a.kept) {
      const x = padX + ((k.time - seg.start) / span) * (w - padX * 2);
      tlCtx.fillRect(x, trackY + trackH - 6, 1.5, 6);
    }
  } else {
    tlCtx.fillStyle = "rgba(74,163,255,0.25)";
    tlCtx.fillRect(padX, trackY, w - padX * 2, trackH);
  }

  const tNow = playhead != null ? playhead : state.mode === "kept" ? state.keptPlayhead : el.video.currentTime;
  if (Number.isFinite(tNow) && tNow >= seg.start && tNow <= seg.end) {
    const x = padX + ((tNow - seg.start) / span) * (w - padX * 2);
    tlCtx.strokeStyle = "#4aa3ff";
    tlCtx.lineWidth = 1.5;
    tlCtx.beginPath();
    tlCtx.moveTo(x, 2);
    tlCtx.lineTo(x, trackY + trackH + 4);
    tlCtx.stroke();
    tlCtx.fillStyle = "#4aa3ff";
    tlCtx.beginPath();
    tlCtx.arc(x, 2, 3, 0, Math.PI * 2);
    tlCtx.fill();
  }
}

function niceStep(span, count) {
  const raw = span / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const candidates = [1, 2, 5, 10].map((m) => m * pow);
  return candidates.find((c) => c >= raw) || pow * 10;
}

/* ---------------- result ---------------- */

function applyResult(res) {
  state.result = res;
  el.resultVideo.src = res.url;
  el.resultEmpty?.classList.add("hidden");
  el.resultTag.textContent = "已生成";
  el.resultTag.className = "tag ok";
  el.rKept.textContent = `${res.keptFrames} 帧`;
  el.rKeptSub.textContent = `输入 ${res.inputFrames} 帧，去除 ${res.inputFrames - res.keptFrames} 个复制候选帧`;
  el.rDuration.textContent = `${fmt(res.duration, 3)} 秒`;
  el.rDurationSub.textContent = `原片段 ${fmt(res.segment.end - res.segment.start, 3)} 秒 · 事件时间保持不变`;
  const v = res.verification || {};
  el.rAudio.textContent = v.audioPresent ? `${v.audioCodec?.toUpperCase() || "有"} · ${fmt(v.audioDuration, 2)} s` : "无音频";
  el.rAudioSub.textContent = v.audioPresent ? "原音轨流复制，未重新编码" : "输入没有音频轨";
  el.downloadLink.href = res.downloadUrl;
  el.downloadLink.classList.remove("disabled");
  el.btnReveal.disabled = false;
  el.verifyList.innerHTML = "";
  const items = [
    `输出时长 ${fmt(v.outputDuration, 3)} 秒（期望 ${fmt(v.expectedDuration, 3)} 秒，误差 ${fmt(v.durationError, 4)} 秒）`,
    `输出视频 ${v.videoFrames ?? "?"} 帧 · ${v.videoCodec || ""} · ${v.videoSize || ""}`,
    `音轨 ${v.audioPresent ? `${v.audioCodec} ${fmt(v.audioDuration, 3)} 秒` : "无"}`,
    "已按原 PTS 逐帧重编码；未修改容器帧率标签冒充恢复。",
  ];
  for (const w of v.warnings || []) items.push(`警告：${w}`);
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    el.verifyList.appendChild(li);
  }

  // Kept frames table drawn from the actual render timeline (server-computed).
  el.keptBody.innerHTML = "";
  const timeline = res.keptTimeline || [];
  const outputFrames = res.outputFrames || [];
  if (!timeline.length) {
    el.keptBody.innerHTML = '<tr><td colspan="7" class="hint">结果未返回逐帧时间。</td></tr>';
  } else {
    for (let i = 0; i < timeline.length; i++) {
      const k = timeline[i];
      const tr = document.createElement("tr");
      const actualPts = outputFrames[i]?.pts;
      const phase = k.phase != null && k.period ? `${k.phase}/${k.period}` : "—";
      tr.innerHTML = `<td>#${k.sourceFrame}</td><td>${fmt(k.time, 3)}</td><td>${fmt(k.displayStart, 3)}</td><td>${fmt(k.displayEnd, 3)}</td><td class="dur">${fmt(k.displayDuration, 3)} s</td><td class="mono">${phase}</td><td>${actualPts != null ? `<span class="mono">${fmt(actualPts, 3)}</span>` : "—"}</td>`;
      el.keptBody.appendChild(tr);
    }
  }
  document.querySelectorAll(".player-modes .mode").forEach((b) => (b.disabled = false));
  el.resultVideo.onloadedmetadata = () => {
    const li = document.createElement("li");
    li.textContent = `结果文件实测时长 ${fmt(el.resultVideo.duration, 3)} 秒。`;
    el.verifyList.appendChild(li);
  };
}

/* ---------------- UI helpers ---------------- */

function setStatus(kind, text, detail) {
  el.statusDot.className = `dot ${kind}`;
  el.statusText.textContent = text;
  el.statusDetail.textContent = detail || "";
  if (kind === "done") el.progressBar.style.width = "100%";
  else if (kind === "idle") el.progressBar.style.width = "0";
  else if (kind === "error") el.progressBar.style.width = "0";
}

function pushError(msg) {
  const li = document.createElement("li");
  li.textContent = msg;
  el.errorList.appendChild(li);
}

function clearErrors() {
  el.errorList.innerHTML = "";
}

function fmt(v, digits = 3) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toFixed(digits);
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

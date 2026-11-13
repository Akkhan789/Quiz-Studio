'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const WWW_DIR = path.resolve(__dirname, '../WORKING_SOURCE/app/src/main/assets/www');

function makeTimedCanvas(width, height) {
  return {
    canvas: { width, height },
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '24px sans-serif',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save() {},
    restore() {},
    translate() {},
    scale() {},
    rotate() {},
    beginPath() {},
    closePath() {},
    rect() {},
    roundRect() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    arc() {},
    arcTo() {},
    setLineDash() {},
    clip() {},
    fill() {},
    stroke() {},
    fillRect() {},
    strokeRect() {},
    clearRect() {},
    drawImage() {},
    fillText() {},
    strokeText() {},
    measureText(t) { return { width: String(t || '').length * 14 }; },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; }
  };
}

function loadModules() {
  const sandbox = {
    window: {},
    globalThis: null,
    console,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Uint8Array,
    Uint8ClampedArray,
    ArrayBuffer,
    DataView
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ['timeline-engine.js', 'scene-model.js', 'text-reveal-engine.js', 'transitions-library.js', 'scene-renderer.js']) {
    vm.runInContext(fs.readFileSync(path.join(WWW_DIR, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

function makeQuestions(count, withNarration) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push({
      question: `Question #${i + 1}: Which scientific principle explains orbital conservation in multi-body astrophysical systems?`,
      options: ['Kepler Second Law', 'Heisenberg Uncertainty', 'Planck Radiation', 'Gauss Divergence'],
      correct: i % 4,
      ttsEngine: withNarration ? 'edge' : 'none',
      promptWordBoundaries: withNarration
        ? [
            { offsetMs: 120, durationMs: 200, text: 'Question' },
            { offsetMs: 1200, durationMs: 200, text: 'A' },
            { offsetMs: 1800, durationMs: 200, text: 'B' },
            { offsetMs: 2400, durationMs: 200, text: 'C' },
            { offsetMs: 3000, durationMs: 200, text: 'D' }
          ]
        : []
    });
  }
  return arr;
}

function runProjectBenchmark(mods, cfg) {
  const { QuizTimeline, QuizSceneModel, QuizSceneRenderer } = mods;
  const qs = makeQuestions(cfg.questions, cfg.narration);
  const voices = cfg.narration ? qs.map(() => ({ duration: 3.4 })) : qs.map(() => ({ duration: 0 }));
  const answers = cfg.narration ? qs.map(() => ({ duration: 1.4 })) : qs.map(() => ({ duration: 0 }));

  const tl = QuizTimeline.build(qs, voices, cfg.timerSec, answers, cfg.narration);
  const totalFrames = Math.ceil(tl.total * cfg.fps);

  const scene = QuizSceneModel.fromThemeToScene({
    bg: '#f2f2f2',
    headerBg: '#b80f0a',
    headerText: 'BENCHMARK QUIZ'
  }, { ratio: '16/9' });

  const ctx = makeTimedCanvas(cfg.width, cfg.height);
  const rCtx = QuizSceneRenderer.createRendererContext();

  // Baseline legacy comparison: O(n) linear scan + uncached wrap + Base64 text encoding overhead per frame
  const sampleStep = Math.max(1, Math.floor(totalFrames / 300)); // sample 300 representative frames cleanly
  let sampledCount = 0;

  // Measure Phase 4+ Optimized Path (O(log n) segment lookup + cached wrap + zero Base64)
  const optStart = performance.now();
  let segCursor = 0;
  for (let f = 0; f < totalFrames; f += sampleStep) {
    sampledCount++;
    const t = f / cfg.fps;
    const hit = QuizTimeline.findSegmentAt(tl.segs, t, segCursor);
    const seg = hit ? hit.seg : tl.segs[tl.segs.length - 1];
    if (hit) segCursor = hit.ptr;
    const qi = seg.i | 0;
    QuizSceneRenderer.renderSceneFrame(ctx, cfg.width, cfg.height, scene, qs[qi], qi, qs.length, {
      remaining: Math.max(0, seg.dur - (t - seg.start)),
      reveal: seg.type === 'reveal' || seg.type === 'answer',
      voiceElapsedSec: t - seg.start,
      isPostVoice: seg.type !== 'voice',
      rendererCtx: rCtx
    });
  }
  const optMs = performance.now() - optStart;

  // Measure Uncached Legacy Equivalent (no wrap cache + O(n) scan + Base64 payload encode cost of 32KB dummy JPEG buffer)
  const dummyFrameBytes = Buffer.alloc(32768, 0x7f);
  const legStart = performance.now();
  for (let f = 0; f < totalFrames; f += sampleStep) {
    const t = f / cfg.fps;
    let seg = tl.segs[tl.segs.length - 1];
    for (let i = 0; i < tl.segs.length; i++) {
      const s = tl.segs[i];
      if (t >= s.start && t < s.start + s.dur) { seg = s; break; }
    }
    const qi = seg.i | 0;
    // Uncached context creates new Map every frame + simulated Base64 bridge string conversion
    QuizSceneRenderer.renderSceneFrame(ctx, cfg.width, cfg.height, scene, qs[qi], qi, qs.length, {
      remaining: Math.max(0, seg.dur - (t - seg.start)),
      reveal: seg.type === 'reveal' || seg.type === 'answer',
      voiceElapsedSec: t - seg.start,
      isPostVoice: seg.type !== 'voice',
      rendererCtx: QuizSceneRenderer.createRendererContext()
    });
    const b64 = dummyFrameBytes.toString('base64');
    if (b64.length === 0) throw new Error('unreachable');
  }
  const legMs = performance.now() - legStart;

  const optPerFrameUs = (optMs * 1000) / sampledCount;
  const legPerFrameUs = (legMs * 1000) / sampledCount;
  const speedup = legPerFrameUs / Math.max(0.01, optPerFrameUs);

  // Also test Native Scene Bundle serialization time (Phase 3/5)
  const bStart = performance.now();
  const bundleJson = JSON.stringify(QuizSceneRenderer.buildExportSceneBundle(scene, qs, tl, { width: cfg.width, height: cfg.height, fps: cfg.fps }));
  const bundleMs = performance.now() - bStart;

  return {
    name: cfg.name,
    questions: cfg.questions,
    resolution: `${cfg.width}x${cfg.height}`,
    fps: cfg.fps,
    narration: cfg.narration ? 'ON' : 'OFF',
    timelineSec: Number(tl.total.toFixed(2)),
    totalFrames,
    sampledFrames: sampledCount,
    legacyPerFrameUs: Number(legPerFrameUs.toFixed(1)),
    optimizedPerFrameUs: Number(optPerFrameUs.toFixed(1)),
    speedupFactor: Number(speedup.toFixed(2)),
    nativeSceneBundleBytes: bundleJson.length,
    nativeSceneBundleBuildMs: Number(bundleMs.toFixed(2))
  };
}

const mods = loadModules();
// Warm up V8 JIT before running Project A-F timings so cold compilation doesn't skew Project A
(function warmup() {
  const warmCfg = { name: 'Warmup', questions: 2, width: 1280, height: 720, fps: 24, timerSec: 4, narration: true };
  runProjectBenchmark(mods, warmCfg);
})();

const configs = [
  { name: 'Project A (5Q 1080p 24fps Narr ON)', questions: 5, width: 1920, height: 1080, fps: 24, timerSec: 8, narration: true },
  { name: 'Project B (10Q 1080p 30fps Narr ON)', questions: 10, width: 1920, height: 1080, fps: 30, timerSec: 8, narration: true },
  { name: 'Project C (25Q 1080p 24fps Narr ON)', questions: 25, width: 1920, height: 1080, fps: 24, timerSec: 8, narration: true },
  { name: 'Project D (30Q 1080p 24fps Narr OFF)', questions: 30, width: 1920, height: 1080, fps: 24, timerSec: 6, narration: false },
  { name: 'Project E (50Q 1080p 24fps Narr ON)', questions: 50, width: 1920, height: 1080, fps: 24, timerSec: 8, narration: true },
  { name: 'Project F (50Q 1080p 30fps Narr ON)', questions: 50, width: 1920, height: 1080, fps: 30, timerSec: 8, narration: true }
];

const results = configs.map(c => runProjectBenchmark(mods, c));
console.log(JSON.stringify({ environment: 'Node.js ' + process.version + ' offline harness (non-GPU CPU JS render + serialization benchmark)', results }, null, 2));

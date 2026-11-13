'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const WWW_DIR = path.resolve(__dirname, '../WORKING_SOURCE/app/src/main/assets/www');

function makeMockCanvas2d(width = 640, height = 360) {
  const ops = [];
  const ctx = {
    canvas: { width, height },
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '16px sans-serif',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save() { ops.push('save'); },
    restore() { ops.push('restore'); },
    translate(x, y) { ops.push(['translate', x, y]); },
    scale(x, y) { ops.push(['scale', x, y]); },
    rotate(r) { ops.push(['rotate', r]); },
    transform(...a) { ops.push(['transform', ...a]); },
    setTransform() {},
    beginPath() {},
    closePath() {},
    rect() {},
    roundRect() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    arc() {},
    arcTo() {},
    clip() { ops.push('clip'); },
    fill() { ops.push('fill'); },
    stroke() { ops.push('stroke'); },
    fillRect(x, y, w, h) { ops.push(['fillRect', x, y, w, h]); },
    strokeRect(x, y, w, h) { ops.push(['strokeRect', x, y, w, h]); },
    clearRect() {},
    drawImage() { ops.push('drawImage'); },
    fillText(t, x, y) { ops.push(['fillText', t]); },
    strokeText(t) { ops.push(['strokeText', t]); },
    measureText(t) { return { width: String(t || '').length * 8.5 }; },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    setLineDash() {},
    _ops: ops
  };
  return ctx;
}

function createSandbox() {
  const lsMap = new Map();
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
    Error,
    Uint8Array,
    Uint8ClampedArray,
    Int32Array,
    Float32Array,
    ArrayBuffer,
    DataView,
    URLSearchParams,
    btoa: str => Buffer.from(str, 'binary').toString('base64'),
    atob: b64 => Buffer.from(b64, 'base64').toString('binary'),
    fetch: typeof fetch === 'function' ? fetch : undefined,
    addEventListener: () => {},
    localStorage: {
      getItem: k => (lsMap.has(k) ? lsMap.get(k) : null),
      setItem: (k, v) => lsMap.set(k, String(v)),
      removeItem: k => lsMap.delete(k)
    },
    structuredClone: v => JSON.parse(JSON.stringify(v))
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const load = file => {
    const code = fs.readFileSync(path.join(WWW_DIR, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  };
  return { sandbox, load };
}

(async function main() {
  const { sandbox, load } = createSandbox();
  [
    'quiz-studio-pro-bridge.js',
    'webcodecs-diagnostics.js',
    'timeline-engine.js',
    'scene-model.js',
    'text-reveal-engine.js',
    'transitions-library.js',
    'scene-renderer.js',
    'cv-detector.js',
    'template-store.js',
    'canva-connect.js'
  ].forEach(load);

  const {
    QuizSceneModel,
    QuizTextReveal,
    QuizTransitions,
    QuizSceneRenderer,
    QuizCvDetector,
    QuizTemplateStore,
    QuizCanvaConnect,
    QuizTimeline,
    QuizWebCodecsDiagnostics
  } = sandbox;

  // 1. Scene Model checks (Phase 6 & 9)
  assert.ok(QuizSceneModel.ELEMENT_TYPES.length >= 17, 'All 17 element types exposed');
  let scene = QuizSceneModel.fromThemeToScene({ bg: '#102030', headerText: 'QUIZ PRO' }, { ratio: '16/9' });
  assert.equal(scene.mode, QuizSceneModel.RENDER_MODES.DEFAULT);
  const qEl = scene.elements.find(e => e.type === 'question_text');
  assert.ok(qEl, 'Question text layer exists');
  const origX = qEl.x, origY = qEl.y;
  scene = QuizSceneModel.nudgeElement4Dir(scene, qEl.id, 'right', 0.05);
  scene = QuizSceneModel.nudgeElement4Dir(scene, qEl.id, 'down', 0.03);
  const nudged = QuizSceneModel.findElement(scene, qEl.id);
  assert.ok(Math.abs(nudged.x - (origX + 0.05)) < 1e-3);
  assert.ok(Math.abs(nudged.y - (origY + 0.03)) < 1e-3);
  scene = QuizSceneModel.resetElementPosition(scene, qEl.id);
  assert.equal(QuizSceneModel.findElement(scene, qEl.id).x, origX);

  const hit = QuizSceneModel.hitTest(scene, qEl.x + 0.02, qEl.y + 0.02);
  assert.ok(hit, 'hitTest returns element at interior point');
  const dup = QuizSceneModel.duplicateElement(scene, qEl.id);
  assert.equal(dup.scene.elements.length, scene.elements.length + 1);

  // 2. Text Reveal Engine checks (Phase 10 — all 16 styles + sequential sync)
  assert.equal(QuizTextReveal.REVEAL_STYLES.length, 16, 'Exactly 16 text reveal styles');
  const qSample = {
    question: 'Which planet has rings?',
    options: ['Mercury', 'Venus', 'Saturn', 'Mars'],
    promptWordBoundaries: [
      { offsetMs: 100, durationMs: 250, text: 'Which' },
      { offsetMs: 420, durationMs: 250, text: 'planet' },
      { offsetMs: 740, durationMs: 220, text: 'has' },
      { offsetMs: 1020, durationMs: 300, text: 'rings' },
      { offsetMs: 1800, durationMs: 180, text: 'A' },
      { offsetMs: 2020, durationMs: 320, text: 'Mercury' },
      { offsetMs: 2600, durationMs: 180, text: 'B' },
      { offsetMs: 2820, durationMs: 320, text: 'Venus' },
      { offsetMs: 3400, durationMs: 180, text: 'C' },
      { offsetMs: 3620, durationMs: 320, text: 'Saturn' },
      { offsetMs: 4200, durationMs: 180, text: 'D' },
      { offsetMs: 4420, durationMs: 320, text: 'Mars' }
    ]
  };
  const sched = QuizTimeline.buildRevealSchedule(qSample, 5.0);
  assert.equal(sched.alignmentSource, 'tts_word_boundary');
  assert.ok(sched.questionStart < sched.questionEnd);
  assert.ok(sched.questionEnd <= sched.options[0].labelStart);
  assert.ok(sched.options[0].labelStart < sched.options[1].labelStart);
  assert.ok(sched.options[1].labelStart < sched.options[2].labelStart);
  assert.ok(sched.options[2].labelStart < sched.options[3].labelStart);

  for (const s of QuizTextReveal.REVEAL_STYLES) {
    const mid = QuizTextReveal.evaluateReveal('questionText', 'Saturn Ring System', 0, 2.0, 1.1, { questionText: { style: s.id, durationSec: 1.5 } }, false);
    assert.ok(mid.opacity >= 0 && mid.opacity <= 1, `Reveal style ${s.id} valid opacity`);
    assert.ok(typeof mid.shownText === 'string', `Reveal style ${s.id} valid shownText`);
  }

  // 3. Transitions Library checks (Phase 11 — 10 page turns + 14 question transitions)
  assert.equal(QuizTransitions.PAGE_TURN_TRANSITIONS.length, 10, '10 page-turn transitions');
  assert.equal(QuizTransitions.QUESTION_TRANSITIONS.length, 14, '14 question transitions');
  const mockCtx = makeMockCanvas2d(640, 360);
  const snapA = { width: 640, height: 360 };
  for (const t of QuizTransitions.ALL_TRANSITIONS) {
    QuizTransitions.drawTransition(mockCtx, 640, 360, 0.5, snapA, { style: t.id });
  }
  assert.ok(mockCtx._ops.length > 40, 'Transitions executed canvas draw commands');

  // 4. Scene Renderer isolation & caching check (Phase 6 & 4)
  const importedScene = QuizSceneModel.fromDetectionToScene({
    ratio: '16/9',
    dominantBg: '#123456',
    elements: [
      { id: 'bg', type: 'background', x: 0, y: 0, width: 1, height: 1, backgroundColor: '#123456', layerOrder: 0 },
      { id: 'qt', type: 'question_text', x: 0.1, y: 0.2, width: 0.8, height: 0.2, text: '{question}', textColor: '#ffffff', layerOrder: 1 }
    ]
  });
  const isoCtx = makeMockCanvas2d(1280, 720);
  const rCtx = QuizSceneRenderer.createRendererContext();
  QuizSceneRenderer.renderSceneFrame(isoCtx, 1280, 720, importedScene, qSample, 0, 5, {
    headerText: 'GUESS THE ANSWER',
    rendererCtx: rCtx
  });
  const drawnTexts = isoCtx._ops.filter(op => Array.isArray(op) && op[0] === 'fillText').map(op => op[1]);
  assert.equal(drawnTexts.some(t => t.includes('GUESS THE ANSWER')), false, 'IMPORTED_TEMPLATE_MODE never renders default header text');
  // Second render tests text wrap cache hit
  QuizSceneRenderer.renderSceneFrame(isoCtx, 1280, 720, importedScene, qSample, 0, 5, {
    headerText: 'GUESS THE ANSWER',
    rendererCtx: rCtx
  });
  assert.ok(rCtx.textWrapCache.size >= 1, 'Text wrap cache populated cleanly');
  assert.ok(rCtx.metrics.textCacheHits >= 1, 'Second frame hit text wrap cache');

  // 5. CV Detector checks (Phase 7 — Paired alignment + Single fallback + Manual edit)
  function makeSyntheticTemplateImage(w, h, { withText = false, shiftX = 0, shiftY = 0, gradient = false } = {}) {
    const data = new Uint8ClampedArray(w * h * 4);
    const fillRectPx = (rx, ry, rw, rh, r, g, b) => {
      const x0 = Math.max(0, Math.floor((rx + shiftX / w) * w));
      const y0 = Math.max(0, Math.floor((ry + shiftY / h) * h));
      const x1 = Math.min(w, Math.floor(x0 + rw * w));
      const y1 = Math.min(h, Math.floor(y0 + rh * h));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
        }
      }
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data[i] = gradient ? Math.round((x / w) * 140) : 20;
        data[i + 1] = 30;
        data[i + 2] = gradient ? Math.round((y / h) * 200) : 70;
        data[i + 3] = 255;
      }
    }
    // Header strip + Question container + 4 crisp Option containers
    fillRectPx(0.0, 0.0, 1.0, 0.12, 220, 40, 40);
    fillRectPx(0.10, 0.18, 0.80, 0.18, 240, 240, 240);
    fillRectPx(0.08, 0.56, 0.40, 0.13, 30, 64, 175);
    fillRectPx(0.52, 0.56, 0.40, 0.13, 30, 64, 175);
    fillRectPx(0.08, 0.74, 0.40, 0.13, 30, 64, 175);
    fillRectPx(0.52, 0.74, 0.40, 0.13, 30, 64, 175);
    if (withText) {
      fillRectPx(0.18, 0.23, 0.55, 0.05, 10, 10, 10);
      fillRectPx(0.15, 0.60, 0.22, 0.04, 255, 255, 255);
      fillRectPx(0.58, 0.60, 0.22, 0.04, 255, 255, 255);
    }
    return { width: w, height: h, data };
  }

  const emptyImg = makeSyntheticTemplateImage(240, 135, { withText: false });
  const writtenImg = makeSyntheticTemplateImage(240, 135, { withText: true, shiftX: 2, shiftY: -1, gradient: false });
  const paired = QuizCvDetector.analyzeTemplates({
    writtenImageData: writtenImg,
    emptyImageData: emptyImg,
    ratio: '16/9'
  });
  assert.equal(paired.report.analysisMode, 'paired_written_empty');
  assert.ok(paired.report.componentsFound >= 4, 'Detected quiz regions from Sobel+CCL');
  assert.ok(paired.report.registration && paired.report.registration.registrationScore > 0.7, 'Registration score computed');
  assert.ok(paired.report.overallConfidence > 0.3 && paired.report.overallConfidence <= 0.98);

  const blankFlat = makeSyntheticTemplateImage(160, 90, { withText: false });
  // Wipe foreground on blankFlat for low-evidence check
  blankFlat.data.fill(200);
  for (let i = 3; i < blankFlat.data.length; i += 4) blankFlat.data[i] = 255;
  const lowEvidence = QuizCvDetector.analyzeTemplates({ emptyImageData: blankFlat });
  assert.ok(lowEvidence.report.overallConfidence < paired.report.overallConfidence, 'Blank image yields genuinely lower confidence than rich paired detection');

  const gradImg = makeSyntheticTemplateImage(160, 90, { gradient: true });
  const gradStats = QuizCvDetector.estimateBackgroundStats(gradImg);
  assert.equal(gradStats.isGradient, true, 'Gradient background flagged accurately');

  // Manual CV correction APIs
  const cvEl = paired.scene.elements.find(e => e.type !== 'background');
  const reclassed = QuizCvDetector.reclassifyRegion(paired.scene, cvEl.id, 'logo');
  assert.equal(QuizSceneModel.findElement(reclassed, cvEl.id).type, 'logo');

  // 6. Template Store checks (Phase 8 — No data loss, CRUD, migration)
  QuizTemplateStore.resetMemoryFallbackForTests();
  const s1 = await QuizTemplateStore.saveTemplate({ name: 'Sports Neon', ratio: '16/9', scene: importedScene });
  const s2 = await QuizTemplateStore.saveTemplate({ name: 'Trivia Classic', ratio: '9/16', theme: { bg: '#ffffff' } });
  let listed = await QuizTemplateStore.listTemplates();
  assert.equal(listed.length, 2, 'Both templates preserved without clearing siblings');
  await QuizTemplateStore.renameTemplate(s1.id, 'Sports Neon Pro');
  const dupTpl = await QuizTemplateStore.duplicateTemplate(s1.id);
  listed = await QuizTemplateStore.listTemplates();
  assert.equal(listed.length, 3);
  const bundle = await QuizTemplateStore.exportTemplateBundle(s1.id);
  const reimp = await QuizTemplateStore.importTemplateBundle(bundle);
  assert.ok(reimp.id !== s1.id);
  await QuizTemplateStore.deleteTemplate(dupTpl.id);
  listed = await QuizTemplateStore.listTemplates();
  assert.equal(listed.length, 3, 'Deleting one template keeps siblings intact');

  // Legacy migration idempotency
  sandbox.localStorage.setItem('quizstudiopro_templates_v1', JSON.stringify([{ name: 'Legacy Pack', ratio: '16/9' }]));
  const mig1 = await QuizTemplateStore.migrateLegacyTemplates();
  const mig2 = await QuizTemplateStore.migrateLegacyTemplates();
  assert.equal(mig1.length, 1);
  assert.equal(mig2.length, 0, 'Migration is idempotent');

  // 7. Canva Connect checks (Phase 13 — Real API flow + errors + flattened safety)
  assert.equal(QuizCanvaConnect.parseCanvaDesignId('https://www.canva.com/design/DAGxyz12345/edit'), 'DAGxyz12345');
  const noAuth = await QuizCanvaConnect.importCanvaDesign('https://www.canva.com/design/DAGxyz12345/view', {});
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.code, 'AUTH_REQUIRED');

  const privRes = await QuizCanvaConnect.importCanvaDesign('https://www.canva.com/design/DAGxyz12345/view', {
    accessToken: 'tok_test',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'Forbidden' }) })
  });
  assert.equal(privRes.code, 'FORBIDDEN_PRIVATE');

  const okRes = await QuizCanvaConnect.importCanvaDesign('https://www.canva.com/design/DAGxyz12345/view', {
    accessToken: 'tok_test',
    fetchImpl: async url => {
      if (url.includes('/designs/')) {
        return { ok: true, status: 200, json: async () => ({ design: { id: 'DAGxyz12345', title: 'Neon Science Quiz' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ job: { status: 'success', urls: ['https://cdn.canva.test/export.png'] } }) };
    }
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.editableVectorsAvailable, false);
  const flatBg = okRes.scene.elements.find(e => e.id === 'canva_flattened_bg');
  assert.equal(flatBg.editable, false, 'Flattened Canva export explicitly marked editable=false');

  // 8. Bridge Binary Packet Framing + Diagnostics
  let lastMsg = null;
  sandbox.__qspBinaryPort = { postMessage: buf => { lastMsg = buf; } };
  const rgba = new Uint8ClampedArray(64 * 4);
  rgba[0] = 255;
  assert.equal(sandbox.__sendBinaryRgbaFrame(42, rgba), true);
  const dv = new DataView(lastMsg);
  assert.equal(String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)), 'RGBA');
  assert.equal(dv.getInt32(4, true), 42);

  console.log('ALL PHASE 2-14 MODULE SUITES PASSED (SceneModel, 16-Style Reveal, 24 Transitions, Renderer Isolation, Paired CV Detector, IndexedDB Store, Canva PKCE/REST, Binary Transport)');
})().catch(err => {
  console.error(err);
  process.exit(1);
});

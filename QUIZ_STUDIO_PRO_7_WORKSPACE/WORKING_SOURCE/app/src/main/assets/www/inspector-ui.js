/* Quiz Studio Pro 7 — Phase 7, 8, 9, 10, 11, 13, 14: Universal Inspector, Reveal/Transition Controls, Canva OAuth & Benchmark UI */
(function (root) {
  'use strict';

  const $ = id => document.getElementById(id);

  const state = {
    scene: null,
    selectedId: null,
    revealConfig: null,
    transitionConfig: null,
    cvAnalysis: null,
    dragging: null,
    rendererCtx: null,
    nudgeStep: 0.01
  };

  function getDeps() {
    return {
      SceneModel: root.QuizSceneModel,
      SceneRenderer: root.QuizSceneRenderer,
      TextReveal: root.QuizTextReveal,
      Transitions: root.QuizTransitions,
      CvDetector: root.QuizCvDetector,
      TemplateStore: root.QuizTemplateStore,
      CanvaConnect: root.QuizCanvaConnect,
      Diagnostics: root.QuizWebCodecsDiagnostics
    };
  }

  function ensureInitialized() {
    const { SceneModel, SceneRenderer, TextReveal, Transitions } = getDeps();
    if (!state.rendererCtx && SceneRenderer) {
      state.rendererCtx = SceneRenderer.createRendererContext();
    }
    if (!state.revealConfig && TextReveal) {
      state.revealConfig = TextReveal.normalizeRevealConfig({});
    }
    if (!state.transitionConfig && Transitions) {
      state.transitionConfig = Transitions.normalizeTransitionConfig({});
    }
    if (!state.scene && SceneModel && typeof root.THEME !== 'undefined') {
      const ratio = ($('ratio') && $('ratio').value) || '16/9';
      state.scene = SceneModel.fromThemeToScene(root.THEME, { ratio });
    }
  }

  function syncSceneFromTheme() {
    const { SceneModel } = getDeps();
    if (!SceneModel || typeof root.THEME === 'undefined') return;
    const ratio = ($('ratio') && $('ratio').value) || '16/9';
    if (!state.scene || state.scene.mode === SceneModel.RENDER_MODES.DEFAULT) {
      const prevCustom = state.scene && Array.isArray(state.scene.elements)
        ? state.scene.elements.filter(e => e.isUserAdded)
        : [];
      state.scene = SceneModel.fromThemeToScene(root.THEME, { ratio });
      prevCustom.forEach(customEl => {
        state.scene = SceneModel.addElement(state.scene, customEl).scene;
      });
    } else {
      const aspect = SceneModel.parseAspectRatio(ratio);
      state.scene.ratio = aspect.ratio;
      state.scene.baseWidth = aspect.width;
      state.scene.baseHeight = aspect.height;
    }
    refreshInspectorLists();
  }

  function setImportedScene(scene, cvAnalysis = null) {
    ensureInitialized();
    state.scene = scene;
    state.cvAnalysis = cvAnalysis;
    state.selectedId = (scene && scene.elements && scene.elements.length > 1) ? scene.elements[1].id : (scene && scene.elements && scene.elements[0] ? scene.elements[0].id : null);
    refreshInspectorLists();
    if (typeof root.renderPreview === 'function') root.renderPreview();
  }

  function switchToDefaultMode() {
    const { SceneModel } = getDeps();
    if (!SceneModel) return;
    const ratio = ($('ratio') && $('ratio').value) || '16/9';
    state.scene = SceneModel.fromThemeToScene(root.THEME || {}, { ratio });
    state.cvAnalysis = null;
    state.selectedId = null;
    refreshInspectorLists();
    if (typeof root.renderPreview === 'function') root.renderPreview();
  }

  function switchToBlankCanvas() {
    const { SceneModel } = getDeps();
    if (!SceneModel) return;
    const ratio = ($('ratio') && $('ratio').value) || '16/9';
    state.scene = SceneModel.createBlankScene({ ratio, bg: '#0f172a' });
    state.cvAnalysis = null;
    state.selectedId = state.scene.elements[0] ? state.scene.elements[0].id : null;
    refreshInspectorLists();
    if (typeof root.renderPreview === 'function') root.renderPreview();
  }

  function buildInspectorPanelDom() {
    const tplMgr = $('templateManager');
    if (!tplMgr || $('qspInspectorPanel')) return;

    const content = tplMgr.querySelector('.content');
    if (!content) return;

    const panel = document.createElement('div');
    panel.id = 'qspInspectorPanel';
    panel.className = 'section';
    panel.style.cssText = 'margin-top:16px;padding:14px;background:#13151b;border:1px solid #2b3240;border-radius:12px';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <label class="label" style="margin:0;color:#38bdf8">🎛 Universal Layer &amp; Element Inspector</label>
        <span id="inspModeBadge" class="badge" style="font-size:11px">DEFAULT_TEMPLATE_MODE</span>
      </div>
      <div class="row" style="gap:6px;margin-bottom:10px">
        <button type="button" class="btn mini" id="inspUseDefault">Use Default Template Mode</button>
        <button type="button" class="btn mini" id="inspBlankCanvas">New Blank Scene</button>
        <button type="button" class="btn mini" id="inspAddText">+ Text</button>
        <button type="button" class="btn mini" id="inspAddShape">+ Shape</button>
        <button type="button" class="btn mini" id="inspAddIcon">+ Icon</button>
        <label class="btn mini" for="inspAddImageInput" style="cursor:pointer">+ Image</label>
        <input id="inspAddImageInput" type="file" accept="image/*" class="hidden">
      </div>
      <div style="display:grid;grid-template-columns:1fr;gap:10px">
        <div>
          <label class="hint" style="margin:0 0 4px;display:block">Layers (tap canvas or choose below)</label>
          <div id="inspLayerList" class="q-list" style="max-height:170px;margin-top:0"></div>
        </div>
        <div id="inspPropsBox" style="background:#181b22;border:1px solid #2c3342;border-radius:10px;padding:12px">
          <div id="inspNoSel" class="hint" style="margin:0">Tap any element in Preview or select a layer above to move, nudge, resize, recolor, reorder, or restyle it.</div>
          <div id="inspControls" class="hidden">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap">
              <strong id="inspSelTitle" style="font-size:13px;color:#fff">Element</strong>
              <div class="row" style="gap:4px">
                <button type="button" class="btn mini" id="inspLayerUp" title="Bring Forward">↑ Layer</button>
                <button type="button" class="btn mini" id="inspLayerDown" title="Send Backward">↓ Layer</button>
                <button type="button" class="btn mini" id="inspDupEl">Duplicate</button>
                <button type="button" class="btn mini ghost" id="inspLockEl">🔓</button>
                <button type="button" class="btn mini ghost" id="inspDelEl">🗑</button>
              </div>
            </div>
            <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
              <div>
                <div class="hint" style="margin:0 0 4px">4-Dir Nudge (<select id="inspStep" style="width:auto;padding:2px 4px;font-size:11px"><option value="0.005">0.5%</option><option value="0.01" selected>1%</option><option value="0.025">2.5%</option></select>)</div>
                <div style="display:grid;grid-template-columns:repeat(3,40px);gap:4px">
                  <span></span><button type="button" class="btn mini" data-el-nudge="up">▲</button><span></span>
                  <button type="button" class="btn mini" data-el-nudge="left">◀</button>
                  <button type="button" class="btn mini ghost" id="inspResetPos" title="Reset Position">⟲</button>
                  <button type="button" class="btn mini" data-el-nudge="right">▶</button>
                  <span></span><button type="button" class="btn mini" data-el-nudge="down">▼</button><span></span>
                </div>
              </div>
              <div style="flex:1;min-width:190px;display:grid;grid-template-columns:1fr 1fr;gap:6px">
                <div><label class="hint" style="margin:0">X (%)</label><input type="number" step="0.5" id="inspX"></div>
                <div><label class="hint" style="margin:0">Y (%)</label><input type="number" step="0.5" id="inspY"></div>
                <div><label class="hint" style="margin:0">Width (%)</label><input type="number" step="0.5" id="inspW"></div>
                <div><label class="hint" style="margin:0">Height (%)</label><input type="number" step="0.5" id="inspH"></div>
              </div>
            </div>
            <div class="grid2" style="gap:8px;margin-bottom:8px">
              <div><label class="hint" style="margin:0">Element Type</label><select id="inspType"></select></div>
              <div><label class="hint" style="margin:0">Rotation (deg)</label><input type="number" step="1" min="-180" max="180" id="inspRot"></div>
              <div><label class="hint" style="margin:0">Text Color</label><input type="color" id="inspTextCol" style="height:34px;padding:2px"></div>
              <div><label class="hint" style="margin:0">Background Color</label><input type="color" id="inspBgCol" style="height:34px;padding:2px"></div>
              <div><label class="hint" style="margin:0">Border Color</label><input type="color" id="inspBorderCol" style="height:34px;padding:2px"></div>
              <div><label class="hint" style="margin:0">Opacity (<span id="inspOpV">100%</span>)</label><input type="range" min="0" max="1" step="0.05" id="inspOp" style="padding:0"></div>
              <div><label class="hint" style="margin:0">Font Size (% H)</label><input type="number" step="0.2" min="1" max="25" id="inspFontSize"></div>
              <div><label class="hint" style="margin:0">Border Radius</label><input type="number" step="0.05" min="0" max="0.5" id="inspRadius"></div>
            </div>
            <div style="margin-bottom:8px"><label class="hint" style="margin:0">Text / Token ({question}, {option_0}, {header}, {num}/{total})</label><input id="inspText"></div>
            <div class="row" style="gap:6px">
              <button type="button" class="btn mini" id="inspResetSize">Reset Size</button>
              <button type="button" class="btn mini" id="inspTransparentBg">Transparent Bg</button>
              <button type="button" class="btn mini" id="inspToggleVis">Hide / Show</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const tplList = $('templateList');
    if (tplList && tplList.parentNode === content) content.insertBefore(panel, tplList);
    else content.appendChild(panel);

    wireInspectorEvents();
  }

  function buildRevealAndTransitionUi() {
    const vs = $('videoSettings');
    if (!vs || $('qspAnimSection')) return;
    const content = vs.querySelector('.content');
    if (!content) return;

    const { TextReveal, Transitions } = getDeps();
    const sec = document.createElement('div');
    sec.id = 'qspAnimSection';
    sec.className = 'section';
    sec.style.cssText = 'margin:14px 0;padding:12px;background:#14161d;border:1px solid #2b3240;border-radius:10px';

    const revOpts = (TextReveal ? TextReveal.REVEAL_STYLES : []).map(s => `<option value="${s.id}">${s.label}</option>`).join('');
    const pageOpts = (Transitions ? Transitions.PAGE_TURN_TRANSITIONS : []).map(t => `<option value="${t.id}">${t.label}</option>`).join('');
    const qOpts = (Transitions ? Transitions.QUESTION_TRANSITIONS : []).map(t => `<option value="${t.id}">${t.label}</option>`).join('');

    sec.innerHTML = `
      <label class="label" style="color:#a78bfa;margin-bottom:8px">✨ Text Reveal Animations &amp; Transitions (Phases 10 &amp; 11)</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
        <div>
          <label class="hint" style="margin:0 0 3px;display:block">Question Reveal Style (16)</label>
          <select id="revQStyle">${revOpts}</select>
        </div>
        <div>
          <label class="hint" style="margin:0 0 3px;display:block">Option Text Reveal Style</label>
          <select id="revOptStyle">${revOpts}</select>
        </div>
        <div>
          <label class="hint" style="margin:0 0 3px;display:block">Option Badge Reveal</label>
          <select id="revLblStyle">${revOpts}</select>
        </div>
        <div>
          <label class="hint" style="margin:0 0 3px;display:block">Question Transition (24)</label>
          <select id="transStyle">
            <optgroup label="Page-Turn Transitions (10)">${pageOpts}</optgroup>
            <optgroup label="Question Transitions (14)">${qOpts}</optgroup>
          </select>
        </div>
        <div>
          <label class="hint" style="margin:0 0 3px;display:block">Transition Duration (s)</label>
          <input type="number" id="transDur" min="0.3" max="2.0" step="0.05" value="0.72">
        </div>
        <div>
          <label class="hint" style="margin:0 0 3px;display:block">Transition Easing</label>
          <select id="transEase"><option value="ease-in-out" selected>Ease In-Out</option><option value="ease-out">Ease Out</option><option value="linear">Linear</option></select>
        </div>
      </div>
      <div class="row" style="gap:8px;align-items:center">
        <label class="hint" style="margin:0;display:inline-flex;align-items:center;gap:5px"><input type="checkbox" id="revSyncEnabled" checked style="width:auto"> Voice-Synced Reveal</label>
        <label class="hint" style="margin:0;display:inline-flex;align-items:center;gap:5px"><input type="checkbox" id="transShadows" checked style="width:auto"> Page Shadows</label>
        <button type="button" class="btn mini" id="btnPreviewReveal">▶ Preview Reveal</button>
        <button type="button" class="btn mini" id="btnPreviewTransition">▶ Preview Transition</button>
      </div>
    `;

    const ttsPanel = $('ttsPanel');
    if (ttsPanel && ttsPanel.parentNode === content) content.insertBefore(sec, ttsPanel);
    else content.appendChild(sec);

    // Phase 14 Diagnostics & Micro-Benchmark Button inside videoSettings
    const diagBox = document.createElement('div');
    diagBox.id = 'qspDiagnosticsBox';
    diagBox.style.cssText = 'margin-top:12px;padding:10px;background:#111318;border:1px solid #262c38;border-radius:8px';
    diagBox.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:12px;font-weight:700;color:#93c5fd">⚙ Hardware &amp; Encoder Diagnostics</span>
        <button type="button" class="btn mini" id="btnRunEncoderDiag">Run Capability &amp; Speed Benchmark</button>
      </div>
      <pre id="diagOutput" class="hint" style="margin:6px 0 0;white-space:pre-wrap;font-family:monospace;font-size:11px;max-height:140px;overflow:auto"></pre>
    `;
    content.appendChild(diagBox);

    wireAnimationAndDiagEvents();
  }

  function enhanceCanvaOAuthUi() {
    const canvaInput = $('canvaUrlInput');
    if (!canvaInput || $('canvaOAuthRow')) return;
    const parent = canvaInput.closest('.section');
    if (!parent) return;

    const { CanvaConnect } = getDeps();
    const row = document.createElement('div');
    row.id = 'canvaOAuthRow';
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px';
    const currentId = CanvaConnect ? CanvaConnect.getConfiguredClientId() : '';
    const hasTok = CanvaConnect ? !!CanvaConnect.getStoredToken() : false;
    row.innerHTML = `
      <input id="canvaClientIdInput" placeholder="Canva OAuth Client ID (optional if built-in)" value="${currentId}" style="flex:1;min-width:190px;font-size:12px">
      <button type="button" class="btn mini" id="canvaAuthBtn">${hasTok ? '✓ Canva Connected (Reconnect)' : '🔗 Connect Canva OAuth'}</button>
    `;
    const statusEl = $('canvaStatus');
    parent.insertBefore(row, statusEl);

    if ($('canvaAuthBtn')) {
      $('canvaAuthBtn').onclick = async () => {
        if (!CanvaConnect) return;
        const cid = ($('canvaClientIdInput') && $('canvaClientIdInput').value.trim()) || '';
        if (cid) CanvaConnect.setClientId(cid);
        const res = await CanvaConnect.startOAuthFlow(cid);
        if (!res.ok) {
          if (statusEl) { statusEl.textContent = res.message; statusEl.style.color = '#f59e0b'; }
          return;
        }
        if (statusEl) {
          statusEl.textContent = res.launched
            ? 'Canva sign-in opened in browser. Complete authorization to return to Quiz Studio Pro.'
            : 'Open Canva authorization URL: ' + res.authUrl;
          statusEl.style.color = '#60a5fa';
        }
      };
    }

    root.onCanvaAuthCallback = async (payload) => {
      if (!CanvaConnect) return;
      try {
        await CanvaConnect.exchangeAuthCallback(payload);
        if ($('canvaAuthBtn')) $('canvaAuthBtn').textContent = '✓ Canva Connected';
        if (statusEl) { statusEl.textContent = '✓ Canva OAuth connected! Click Import Canva Project.'; statusEl.style.color = '#3ddc84'; }
      } catch (err) {
        if (statusEl) { statusEl.textContent = 'Canva OAuth failed: ' + err.message; statusEl.style.color = '#ff6b6b'; }
      }
    };

    try {
      if (root.AndroidBridge && root.AndroidBridge.consumePendingCanvaCallback) {
        const pending = root.AndroidBridge.consumePendingCanvaCallback();
        if (pending && pending !== '{}') {
          const parsed = JSON.parse(pending);
          if (parsed && (parsed.code || parsed.error)) root.onCanvaAuthCallback(parsed);
        }
      }
    } catch (_) {}
  }

  function wireAnimationAndDiagEvents() {
    const { TextReveal, Transitions, Diagnostics } = getDeps();
    const syncReveal = () => {
      ensureInitialized();
      if (!TextReveal) return;
      state.revealConfig = TextReveal.normalizeRevealConfig({
        enabled: $('revSyncEnabled') ? $('revSyncEnabled').checked : true,
        questionText: { style: $('revQStyle').value },
        optionText: { style: $('revOptStyle').value },
        optionLabel: { style: $('revLblStyle').value }
      });
    };
    const syncTrans = () => {
      ensureInitialized();
      if (!Transitions) return;
      state.transitionConfig = Transitions.normalizeTransitionConfig({
        style: $('transStyle').value,
        durationSec: Number($('transDur').value) || 0.72,
        easing: $('transEase').value,
        shadows: $('transShadows').checked
      });
    };

    ['revQStyle', 'revOptStyle', 'revLblStyle', 'revSyncEnabled'].forEach(id => {
      if ($(id)) $(id).addEventListener('change', syncReveal);
    });
    ['transStyle', 'transDur', 'transEase', 'transShadows'].forEach(id => {
      if ($(id)) $(id).addEventListener('change', syncTrans);
    });

    if ($('revOptStyle')) $('revOptStyle').value = 'typewriter-word';
    if ($('revLblStyle')) $('revLblStyle').value = 'pop-in';

    if ($('btnPreviewReveal')) {
      $('btnPreviewReveal').onclick = async () => {
        ensureInitialized();
        const { SceneRenderer, Timeline } = getDeps();
        const cv = $('pvCanvas');
        if (!cv || !SceneRenderer || !Timeline) return;
        const q = (root.questions && root.questions[root.current]) || { question: 'Preview reveal animation sample question?', options: ['Alpha', 'Beta', 'Gamma', 'Delta'], correct: 1 };
        const schedule = Timeline.buildRevealSchedule(q, 2.4, { timerDuration: 10 });
        const ctx = cv.getContext('2d');
        const start = performance.now();
        while (true) {
          const elapsed = (performance.now() - start) / 1000;
          if (elapsed > 2.4) break;
          SceneRenderer.renderSceneFrame(ctx, cv.width, cv.height, state.scene, q, Math.max(0, root.current || 0), Math.max(1, (root.questions || []).length), {
            reveal: false,
            remaining: 10,
            timerDuration: 10,
            revealConfig: state.revealConfig,
            revealSchedule: schedule,
            voiceElapsedSec: elapsed,
            isPostVoice: false,
            rendererCtx: state.rendererCtx
          });
          await new Promise(r => setTimeout(r, 32));
        }
        if (typeof root.renderPreview === 'function') root.renderPreview();
      };
    }

    if ($('btnPreviewTransition')) {
      $('btnPreviewTransition').onclick = async () => {
        ensureInitialized();
        const { Transitions, SceneRenderer } = getDeps();
        const cv = $('pvCanvas');
        if (!cv || !Transitions || !SceneRenderer) return;
        const snap = document.createElement('canvas');
        snap.width = cv.width; snap.height = cv.height;
        snap.getContext('2d').drawImage(cv, 0, 0);
        const ctx = cv.getContext('2d');
        const nextQ = (root.questions && root.questions[(root.current + 1) % Math.max(1, root.questions.length)]) || { question: 'Next question transition preview', options: ['One', 'Two', 'Three', 'Four'], correct: 0 };
        const durMs = (state.transitionConfig.durationSec || 0.72) * 1000;
        const t0 = performance.now();
        while (true) {
          const p = Math.min(1, (performance.now() - t0) / durMs);
          SceneRenderer.renderSceneFrame(ctx, cv.width, cv.height, state.scene, nextQ, 1, Math.max(1, (root.questions || []).length), {
            reveal: false,
            remaining: 10,
            rendererCtx: state.rendererCtx
          });
          Transitions.drawTransition(ctx, cv.width, cv.height, p, snap, state.transitionConfig);
          if (p >= 1) break;
          await new Promise(r => setTimeout(r, 20));
        }
        if (typeof root.renderPreview === 'function') root.renderPreview();
      };
    }

    if ($('btnRunEncoderDiag') && Diagnostics) {
      $('btnRunEncoderDiag').onclick = async () => {
        const out = $('diagOutput');
        if (out) out.textContent = 'Probing WebCodecs / Android MediaCodec capabilities & running micro-benchmark…';
        try {
          const probe = await Diagnostics.probeCapabilities(1920, 1080, 24);
          let bench = null;
          if (probe.webcodecsAvailable) {
            bench = await Diagnostics.runComparativeBenchmark(1280, 720, 24, 24);
          }
          const bridgeMode = (root.AndroidBridge && root.AndroidBridge.prepareNativeSceneExport)
            ? 'NATIVE_SCENE_DIRECT + NATIVE_RGBA_STREAM (Kotlin EGL+MediaCodec)'
            : 'Browser Only';
          const summary = {
            androidBridge: bridgeMode,
            webcodecsProbe: probe,
            microBenchmark720p: bench || 'WebCodecs VideoEncoder unavailable in this WebView; using Native Kotlin MediaCodec direct pipeline.'
          };
          if (out) out.textContent = JSON.stringify(summary, null, 2);
        } catch (err) {
          if (out) out.textContent = 'Diagnostics error: ' + err.message;
        }
      };
    }
  }

  function wireInspectorEvents() {
    const { SceneModel } = getDeps();
    if (!SceneModel) return;

    const typeSel = $('inspType');
    if (typeSel) {
      typeSel.innerHTML = SceneModel.ELEMENT_TYPES.map(t => `<option value="${t}">${t}</option>`).join('');
      typeSel.onchange = () => mutateSelected({ type: typeSel.value });
    }

    if ($('inspUseDefault')) $('inspUseDefault').onclick = switchToDefaultMode;
    if ($('inspBlankCanvas')) $('inspBlankCanvas').onclick = switchToBlankCanvas;

    if ($('inspAddText')) {
      $('inspAddText').onclick = () => {
        ensureInitialized();
        const res = SceneModel.addElement(state.scene, {
          type: 'text',
          name: 'Custom Text',
          text: 'YOUR TEXT HERE',
          x: 0.25, y: 0.42, width: 0.50, height: 0.12,
          fontSize: 0.05, textColor: '#ffffff', backgroundColor: 'transparent', isUserAdded: true
        });
        state.scene = res.scene;
        state.selectedId = res.element.id;
        refreshInspectorLists();
        if (typeof root.renderPreview === 'function') root.renderPreview();
      };
    }
    if ($('inspAddShape')) {
      $('inspAddShape').onclick = () => {
        ensureInitialized();
        const res = SceneModel.addElement(state.scene, {
          type: 'shape',
          name: 'Accent Shape',
          x: 0.30, y: 0.38, width: 0.40, height: 0.16,
          backgroundColor: '#2563eb', borderColor: '#ffffff', borderWidth: 2, borderRadius: 0.2, isUserAdded: true
        });
        state.scene = res.scene;
        state.selectedId = res.element.id;
        refreshInspectorLists();
        if (typeof root.renderPreview === 'function') root.renderPreview();
      };
    }
    if ($('inspAddIcon')) {
      $('inspAddIcon').onclick = () => {
        ensureInitialized();
        const res = SceneModel.addElement(state.scene, {
          type: 'icon',
          name: 'Star Badge Icon',
          iconGlyph: '★',
          x: 0.84, y: 0.18, width: 0.09, height: 0.12,
          textColor: '#facc15', backgroundColor: 'transparent', isUserAdded: true
        });
        state.scene = res.scene;
        state.selectedId = res.element.id;
        refreshInspectorLists();
        if (typeof root.renderPreview === 'function') root.renderPreview();
      };
    }
    if ($('inspAddImageInput')) {
      $('inspAddImageInput').onchange = e => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!f) return;
        const fr = new FileReader();
        fr.onload = ev => {
          ensureInitialized();
          const key = 'user_img_' + Date.now();
          state.scene.assets = state.scene.assets || {};
          state.scene.assets[key] = ev.target.result;
          const res = SceneModel.addElement(state.scene, {
            type: 'image',
            name: f.name.slice(0, 24),
            assetRef: key,
            x: 0.35, y: 0.30, width: 0.30, height: 0.30, borderRadius: 0.08, isUserAdded: true
          });
          state.scene = res.scene;
          state.selectedId = res.element.id;
          refreshInspectorLists();
          if (typeof root.renderPreview === 'function') root.renderPreview();
        };
        fr.readAsDataURL(f);
      };
    }

    document.querySelectorAll('[data-el-nudge]').forEach(btn => {
      btn.onclick = () => {
        if (!state.selectedId || !state.scene) return;
        const step = Number($('inspStep') ? $('inspStep').value : 0.01) || 0.01;
        state.scene = SceneModel.nudgeElement4Dir(state.scene, state.selectedId, btn.dataset.elNudge, step);
        refreshInspectorFields();
        if (typeof root.renderPreview === 'function') root.renderPreview();
      };
    });

    const numBind = (id, fn) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', () => fn(Number(el.value)));
    };
    numBind('inspX', v => mutateSelected({ x: v / 100 }));
    numBind('inspY', v => mutateSelected({ y: v / 100 }));
    numBind('inspW', v => mutateSelected({ width: Math.max(1, v) / 100 }));
    numBind('inspH', v => mutateSelected({ height: Math.max(1, v) / 100 }));
    numBind('inspRot', v => mutateSelected({ rotation: v }));
    numBind('inspFontSize', v => mutateSelected({ fontSize: Math.max(1, v) / 100 }));
    numBind('inspRadius', v => mutateSelected({ borderRadius: v }));

    if ($('inspTextCol')) $('inspTextCol').oninput = e => mutateSelected({ textColor: e.target.value });
    if ($('inspBgCol')) $('inspBgCol').oninput = e => mutateSelected({ backgroundColor: e.target.value });
    if ($('inspBorderCol')) $('inspBorderCol').oninput = e => mutateSelected({ borderColor: e.target.value, borderWidth: Math.max(1, (selectedEl() && selectedEl().borderWidth) || 2) });
    if ($('inspOp')) $('inspOp').oninput = e => { if ($('inspOpV')) $('inspOpV').textContent = Math.round(e.target.value * 100) + '%'; mutateSelected({ opacity: Number(e.target.value) }); };
    if ($('inspText')) $('inspText').oninput = e => mutateSelected({ text: e.target.value });

    if ($('inspLayerUp')) $('inspLayerUp').onclick = () => { if (!state.selectedId) return; state.scene = SceneModel.reorderLayer(state.scene, state.selectedId, 'up'); refreshInspectorLists(); if (root.renderPreview) root.renderPreview(); };
    if ($('inspLayerDown')) $('inspLayerDown').onclick = () => { if (!state.selectedId) return; state.scene = SceneModel.reorderLayer(state.scene, state.selectedId, 'down'); refreshInspectorLists(); if (root.renderPreview) root.renderPreview(); };
    if ($('inspDupEl')) $('inspDupEl').onclick = () => { if (!state.selectedId) return; const r = SceneModel.duplicateElement(state.scene, state.selectedId); state.scene = r.scene; if (r.element) state.selectedId = r.element.id; refreshInspectorLists(); if (root.renderPreview) root.renderPreview(); };
    if ($('inspLockEl')) $('inspLockEl').onclick = () => { const el = selectedEl(); if (!el) return; state.scene = SceneModel.updateElement(state.scene, el.id, { locked: !el.locked }); refreshInspectorFields(); };
    if ($('inspDelEl')) $('inspDelEl').onclick = () => { if (!state.selectedId) return; state.scene = SceneModel.deleteElement(state.scene, state.selectedId); state.selectedId = null; refreshInspectorLists(); if (root.renderPreview) root.renderPreview(); };
    if ($('inspResetPos')) $('inspResetPos').onclick = () => { if (!state.selectedId) return; state.scene = SceneModel.resetElementPosition(state.scene, state.selectedId); refreshInspectorFields(); if (root.renderPreview) root.renderPreview(); };
    if ($('inspResetSize')) $('inspResetSize').onclick = () => { if (!state.selectedId) return; state.scene = SceneModel.resetElementSize(state.scene, state.selectedId); refreshInspectorFields(); if (root.renderPreview) root.renderPreview(); };
    if ($('inspTransparentBg')) $('inspTransparentBg').onclick = () => mutateSelected({ backgroundColor: 'transparent' });
    if ($('inspToggleVis')) $('inspToggleVis').onclick = () => { const el = selectedEl(); if (el) mutateSelected({ visible: !el.visible }); };
  }

  function selectedEl() {
    const { SceneModel } = getDeps();
    return (SceneModel && state.scene && state.selectedId) ? SceneModel.findElement(state.scene, state.selectedId) : null;
  }

  function mutateSelected(patch) {
    const { SceneModel } = getDeps();
    if (!SceneModel || !state.scene || !state.selectedId) return;
    state.scene = SceneModel.updateElement(state.scene, state.selectedId, patch);
    refreshInspectorFields();
    if (typeof root.renderPreview === 'function') root.renderPreview();
  }

  function refreshInspectorLists() {
    ensureInitialized();
    const badge = $('inspModeBadge');
    if (badge && state.scene) {
      badge.textContent = state.scene.mode;
      badge.style.color = state.scene.mode === 'IMPORTED_TEMPLATE_MODE' ? '#38bdf8' : '#ffb8b3';
    }
    const list = $('inspLayerList');
    if (list && state.scene) {
      list.innerHTML = '';
      const els = [...state.scene.elements].sort((a, b) => (b.layerOrder || 0) - (a.layerOrder || 0));
      els.forEach(el => {
        const row = document.createElement('div');
        row.className = 'q-item' + (el.id === state.selectedId ? ' active' : '');
        row.style.cursor = 'pointer';
        const conf = el.confidence !== null && el.confidence !== undefined ? ` (${Math.round(el.confidence * 100)}%)` : '';
        row.innerHTML = `<span class="num">${el.layerOrder}</span><span class="qtext">${el.visible ? '' : '🚫 '}${el.locked ? '🔒 ' : ''}${el.name}${conf}</span><span class="hint" style="margin:0;font-size:10px">${el.type}</span>`;
        row.onclick = () => {
          state.selectedId = el.id;
          refreshInspectorLists();
          if (typeof root.renderPreview === 'function') root.renderPreview();
        };
        list.appendChild(row);
      });
    }
    refreshInspectorFields();
  }

  function refreshInspectorFields() {
    const el = selectedEl();
    const noSel = $('inspNoSel');
    const ctrls = $('inspControls');
    if (!noSel || !ctrls) return;
    if (!el) {
      noSel.classList.remove('hidden');
      ctrls.classList.add('hidden');
      return;
    }
    noSel.classList.add('hidden');
    ctrls.classList.remove('hidden');

    if ($('inspSelTitle')) $('inspSelTitle').textContent = `${el.name} [${el.type}]` + (el.editable === false ? ' · Flattened' : '');
    if ($('inspLockEl')) $('inspLockEl').textContent = el.locked ? '🔒' : '🔓';
    if ($('inspX')) $('inspX').value = (el.x * 100).toFixed(1);
    if ($('inspY')) $('inspY').value = (el.y * 100).toFixed(1);
    if ($('inspW')) $('inspW').value = (el.width * 100).toFixed(1);
    if ($('inspH')) $('inspH').value = (el.height * 100).toFixed(1);
    if ($('inspRot')) $('inspRot').value = Math.round(el.rotation || 0);
    if ($('inspType')) $('inspType').value = el.type;
    if ($('inspTextCol') && /^#[0-9a-f]{6}$/i.test(el.textColor || '')) $('inspTextCol').value = el.textColor;
    if ($('inspBgCol') && /^#[0-9a-f]{6}$/i.test(el.backgroundColor || '')) $('inspBgCol').value = el.backgroundColor;
    if ($('inspBorderCol') && /^#[0-9a-f]{6}$/i.test(el.borderColor || '')) $('inspBorderCol').value = el.borderColor;
    if ($('inspOp')) $('inspOp').value = el.opacity !== undefined ? el.opacity : 1;
    if ($('inspOpV')) $('inspOpV').textContent = Math.round((el.opacity !== undefined ? el.opacity : 1) * 100) + '%';
    if ($('inspFontSize')) $('inspFontSize').value = ((el.fontSize || 0.045) * 100).toFixed(1);
    if ($('inspRadius')) $('inspRadius').value = el.borderRadius || 0;
    if ($('inspText')) $('inspText').value = el.text || '';
  }

  function wireCanvasPointerSelection() {
    const cv = $('pvCanvas');
    const { SceneModel } = getDeps();
    if (!cv || !SceneModel || cv.__qspPointerWired) return;
    cv.__qspPointerWired = true;

    const normCoords = e => {
      const r = cv.getBoundingClientRect();
      return {
        nx: Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))),
        ny: Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)))
      };
    };

    cv.addEventListener('pointerdown', e => {
      ensureInitialized();
      if (!state.scene) return;
      const { nx, ny } = normCoords(e);
      const hit = SceneModel.hitTest(state.scene, nx, ny, false);
      state.selectedId = hit ? hit.id : null;
      if (hit && !hit.locked && document.body.classList.contains('studio')) {
        state.dragging = { id: hit.id, startNx: nx, startNy: ny, origX: hit.x, origY: hit.y };
        try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      }
      refreshInspectorLists();
      if (typeof root.renderPreview === 'function') root.renderPreview();
    });

    cv.addEventListener('pointermove', e => {
      if (!state.dragging || !state.scene) return;
      const { nx, ny } = normCoords(e);
      const dx = nx - state.dragging.startNx;
      const dy = ny - state.dragging.startNy;
      state.scene = SceneModel.moveElement(state.scene, state.dragging.id, state.dragging.origX + dx, state.dragging.origY + dy);
      refreshInspectorFields();
      if (typeof root.renderPreview === 'function') root.renderPreview();
    });

    const endDrag = () => { state.dragging = null; };
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', endDrag);
  }

  function init() {
    ensureInitialized();
    buildInspectorPanelDom();
    buildRevealAndTransitionUi();
    enhanceCanvaOAuthUi();
    wireCanvasPointerSelection();
    refreshInspectorLists();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  root.QuizInspectorUI = {
    getState: () => state,
    syncSceneFromTheme,
    setImportedScene,
    switchToDefaultMode,
    switchToBlankCanvas,
    refreshInspectorLists
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

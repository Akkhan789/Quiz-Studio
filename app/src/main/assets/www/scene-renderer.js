/* Quiz Studio Pro 7 — Phase 4, 5, 8, 10, 11: Unified Scene Canvas Renderer + Performance Caches */
(function (root, factory) {
  const api = factory(
    root.QuizSceneModel || (typeof require === 'function' ? require('./scene-model.js') : null),
    root.QuizTextReveal || (typeof require === 'function' ? require('./text-reveal-engine.js') : null),
    root.QuizTimeline || (typeof require === 'function' ? require('./timeline-engine.js') : null),
    root.QuizTransitions || (typeof require === 'function' ? require('./transitions-library.js') : null)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QuizSceneRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SceneModel, TextReveal, Timeline, Transitions) {
  'use strict';

  function createRendererContext() {
    return {
      textWrapCache: new Map(),
      imageCache: new Map(),
      staticCanvas: null,
      staticCtx: null,
      staticCacheKey: '',
      snapCanvas: null,
      snapCtx: null,
      snappedQuestionIdx: -99,
      lastSeg: null,
      segPtr: 0,
      metrics: {
        framesRendered: 0,
        staticCacheHits: 0,
        textCacheHits: 0
      }
    };
  }

  function makeOffscreenCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }
    return null;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const rad = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  function resolveAssetImage(assets, assetRef, rendererCtx, onReady) {
    if (!assetRef || !assets || !assets[assetRef]) return null;
    const src = assets[assetRef];
    if (typeof src !== 'string') return src; // Allows passing preloaded bitmap/canvas in Node tests
    const cached = rendererCtx.imageCache.get(assetRef);
    if (cached && cached.src === src) return cached.complete ? cached.img : null;
    if (typeof Image === 'undefined') return null;
    const img = new Image();
    const rec = { src, img, complete: false };
    rendererCtx.imageCache.set(assetRef, rec);
    img.onload = () => { rec.complete = true; if (onReady) onReady(); };
    img.src = src;
    return img.complete ? img : null;
  }

  function wrapTextCached(ctx, text, font, maxW, rendererCtx) {
    const key = font + '|' + Math.round(maxW) + '|' + text;
    if (rendererCtx && rendererCtx.textWrapCache.has(key)) {
      rendererCtx.metrics.textCacheHits++;
      return rendererCtx.textWrapCache.get(key);
    }
    ctx.font = font;
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (let i = 0; i < words.length; i++) {
      const candidate = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(candidate).width > maxW && line) {
        lines.push(line);
        line = words[i];
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    if (!lines.length && text) lines.push(text);
    if (rendererCtx) {
      if (rendererCtx.textWrapCache.size > 1500) rendererCtx.textWrapCache.clear();
      rendererCtx.textWrapCache.set(key, lines);
    }
    return lines;
  }

  function drawWrappedText(ctx, text, rect, el, h, revealState, rendererCtx) {
    const family = `'${el.fontFamily || 'League Spartan'}','Arial Black',Arial,sans-serif`;
    const weight = el.fontWeight || 700;
    let fs = Math.max(12, (el.fontSize || 0.045) * h);
    let lines = [];
    const maxW = Math.max(24, rect.w * 0.94);

    // Auto-fit font size when text overflows container vertically
    for (let step = 0; step < 12; step++) {
      const font = `${weight} ${Math.round(fs)}px ${family}`;
      lines = wrapTextCached(ctx, text, font, maxW, rendererCtx);
      const totalH = lines.length * fs * 1.15;
      if (totalH <= rect.h * 0.95 || fs <= 12) break;
      fs = Math.max(12, fs * 0.88);
    }

    ctx.font = `${weight} ${Math.round(fs)}px ${family}`;
    ctx.textAlign = el.alignment === 'left' ? 'left' : el.alignment === 'right' ? 'right' : 'center';
    ctx.textBaseline = 'alphabetic';

    const lh = fs * 1.15;
    const totalH = lines.length * lh;
    const startY = rect.y + (rect.h - totalH) / 2 + fs * 0.86;
    const anchorX = el.alignment === 'left'
      ? rect.x + rect.w * 0.03
      : el.alignment === 'right'
        ? rect.x + rect.w * 0.97
        : rect.x + rect.w / 2;

    const strokeCol = el.strokeEnabled ? (el.strokeColor || '#000000') : null;
    const lw = Math.max(1.5, fs * 0.06);

    for (let i = 0; i < lines.length; i++) {
      const ly = startY + i * lh;
      if (strokeCol) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = lw;
        ctx.strokeStyle = strokeCol;
        ctx.strokeText(lines[i], anchorX, ly, maxW);
      }
      ctx.fillStyle = el.textColor || '#ffffff';
      ctx.fillText(lines[i], anchorX, ly, maxW);
    }
  }

  function substituteTokens(str, q, qIdx, totalQ, runtime) {
    const opts = (q && Array.isArray(q.options)) ? q.options : ['', '', '', ''];
    return String(str || '')
      .replace(/\{header\}/gi, (runtime.headerText || 'GUESS THE ANSWER').toUpperCase())
      .replace(/\{channel\}/gi, (runtime.channelName || runtime.projectTitle || '').toUpperCase())
      .replace(/\{counter\}/gi, `${qIdx + 1} / ${totalQ}`)
      .replace(/\{num\}/gi, String(qIdx + 1))
      .replace(/\{total\}/gi, String(totalQ))
      .replace(/\{question\}/gi, (q && q.question ? q.question : '').toUpperCase())
      .replace(/\{option_0\}/gi, String(opts[0] || '').toUpperCase())
      .replace(/\{option_1\}/gi, String(opts[1] || '').toUpperCase())
      .replace(/\{option_2\}/gi, String(opts[2] || '').toUpperCase())
      .replace(/\{option_3\}/gi, String(opts[3] || '').toUpperCase());
  }

  function drawGenericTimer(ctx, rect, remaining, total, el) {
    const dur = Math.max(1, Number(total) || 10);
    const sec = remaining === null || remaining === undefined ? dur : Math.max(0, remaining);
    const frac = Math.max(0, Math.min(1, sec / dur));
    const shown = Math.min(dur, Math.ceil(sec - 1e-6));

    // Delegate to page's rich 10-style drawTimerLook when available in browser
    if (typeof globalThis !== 'undefined' && typeof globalThis.drawTimerLook === 'function') {
      const oldLook = globalThis.THEME && globalThis.THEME.timerLook;
      const oldTx = globalThis.THEME && globalThis.THEME.timerX;
      const oldTy = globalThis.THEME && globalThis.THEME.timerY;
      const oldTs = globalThis.THEME && globalThis.THEME.timerSize;
      if (globalThis.THEME) {
        globalThis.THEME.timerLook = el.timerLook || oldLook || 'capsule';
        globalThis.THEME.timerX = 0;
        globalThis.THEME.timerY = 0;
        globalThis.THEME.timerSize = 1;
      }
      try {
        // Compute normalized centering relative to element box
        ctx.save();
        const defaultW = ctx.canvas ? ctx.canvas.width : 1280;
        const defaultH = ctx.canvas ? ctx.canvas.height : 720;
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        const dx = cx - defaultW / 2;
        const dy = cy - (rect.y + rect.h / 2);
        if (Math.abs(dx) > 1) ctx.translate(dx, 0);
        globalThis.drawTimerLook(ctx, defaultW, defaultH, rect.y, rect.h, remaining);
        ctx.restore();
        return;
      } finally {
        if (globalThis.THEME) {
          globalThis.THEME.timerLook = oldLook;
          globalThis.THEME.timerX = oldTx;
          globalThis.THEME.timerY = oldTy;
          globalThis.THEME.timerSize = oldTs;
        }
      }
    }

    // Portable Canvas fallback for headless / standalone rendering
    const r = Math.min(rect.h / 2, 24);
    ctx.fillStyle = el.backgroundColor || '#d9d9d9';
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, r);
    ctx.fill();
    if (frac > 0) {
      ctx.fillStyle = el.textColor || '#ff4a14';
      roundRectPath(ctx, rect.x, rect.y, Math.max(rect.h, rect.w * frac), rect.h, r);
      ctx.fill();
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${Math.round(rect.h * 0.65)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(shown), rect.x + rect.h * 0.6, rect.y + rect.h / 2);
  }

  function resolveElementReveal(el, revealSchedule, revealState, revealConfig, elapsedSec, isPostVoice, q) {
    if (!TextReveal || !revealSchedule || !revealConfig || !revealConfig.enabled || isPostVoice) {
      return { visible: true, opacity: 1, offsetXFrac: 0, offsetYFrac: 0, scale: 1, blurPx: 0, clipFrac: 1, shownText: null };
    }
    const t = elapsedSec;
    const qText = (q && q.question) || (revealSchedule.question && revealSchedule.question.text) || '';
    if (el.type === 'question_text') {
      const startSec = revealSchedule.questionStart !== undefined ? revealSchedule.questionStart : ((revealSchedule.question && revealSchedule.question.startSec) || 0);
      const endSec = revealSchedule.questionEnd !== undefined ? revealSchedule.questionEnd : ((revealSchedule.question && revealSchedule.question.endSec) || Math.max(0.5, revealSchedule.durationSec ? revealSchedule.durationSec * 0.4 : 1.2));
      return TextReveal.evaluateReveal('questionText', qText, startSec, endSec, t, revealConfig, false);
    }
    if ((el.type === 'option_label' || el.type === 'option_container' || el.type === 'option_text') && el.optionIndex >= 0 && el.optionIndex < 4) {
      const slots = Array.isArray(revealSchedule.options) ? revealSchedule.options : [];
      const slot = slots[el.optionIndex];
      const opts = (q && Array.isArray(q.options)) ? q.options : [];
      const optText = (slot && slot.text) || opts[el.optionIndex] || el.text || '';
      const labelText = (slot && slot.label) || ('ABCD'[el.optionIndex] || 'A');

      if (el.type === 'option_label') {
        const lStart = slot ? (slot.labelStart !== undefined ? slot.labelStart : (slot.textStart !== undefined ? slot.textStart - 0.15 : 0)) : 0;
        const lEnd = slot ? (slot.labelEnd !== undefined ? slot.labelEnd : (slot.textStart !== undefined ? slot.textStart : 0.3)) : 0.3;
        return TextReveal.evaluateReveal('optionLabel', labelText, lStart, lEnd, t, revealConfig, false);
      } else {
        const tStart = slot ? (slot.textStart !== undefined ? slot.textStart : (slot.startSec !== undefined ? slot.startSec : 0.2)) : 0.2;
        const tEnd = slot ? (slot.textEnd !== undefined ? slot.textEnd : (slot.endSec !== undefined ? slot.endSec : 0.8)) : 0.8;
        return TextReveal.evaluateReveal('optionText', optText, tStart, tEnd, t, revealConfig, false);
      }
    }
    if (el.type === 'header' || el.type === 'question_number') {
      return TextReveal.evaluateReveal('header', el.text || '', 0, 0.35, t, revealConfig, false);
    }
    return { visible: true, opacity: 1, offsetXFrac: 0, offsetYFrac: 0, scale: 1, blurPx: 0, clipFrac: 1, shownText: null };
  }

  /**
   * Renders one single element with geometry, fill, border, image asset, icon, timer, progress, and text.
   */
  function drawSceneElement(ctx, el, w, h, q, qIdx, totalQ, runtime, revealFlag, remaining, animState, rendererCtx) {
    if (!el.visible) return;
    if (runtime.sceneMode === 'IMPORTED_TEMPLATE_MODE' && el.isDefaultTemplateOnly) return;

    const rev = resolveElementReveal(el, runtime.revealSchedule, revealFlag, runtime.revealConfig, runtime.voiceElapsedSec || 0, runtime.isPostVoice !== false, q);
    if (!rev.visible) return;

    const baseRect = {
      x: el.x * w + (rev.offsetXFrac || 0) * w,
      y: el.y * h + (rev.offsetYFrac || 0) * h,
      w: el.width * w,
      h: el.height * h
    };

    const isCorrectOpt = revealFlag && el.optionIndex === (q ? q.correct : -1);
    const alpha = Math.max(0, Math.min(1, (el.opacity !== undefined ? el.opacity : 1) * (rev.opacity !== undefined ? rev.opacity : 1)));
    const scale = rev.scale !== undefined ? rev.scale : 1;
    const rad = Math.max(0, (el.borderRadius || 0) * Math.min(baseRect.w, baseRect.h));

    ctx.save();
    ctx.globalAlpha *= alpha;

    if (rev.blurPx > 0.2 && typeof ctx.filter === 'string') {
      ctx.filter = `blur(${rev.blurPx.toFixed(1)}px)`;
    }

    if ((el.rotation && el.rotation !== 0) || Math.abs(scale - 1) > 0.002) {
      const cx = baseRect.x + baseRect.w / 2;
      const cy = baseRect.y + baseRect.h / 2;
      ctx.translate(cx, cy);
      if (el.rotation) ctx.rotate((el.rotation * Math.PI) / 180);
      if (Math.abs(scale - 1) > 0.002) ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);
    }

    if (rev.clipFrac !== undefined && rev.clipFrac < 0.999) {
      ctx.beginPath();
      if (rev.clipDir === 'top-to-bottom') {
        ctx.rect(baseRect.x, baseRect.y, baseRect.w, baseRect.h * rev.clipFrac);
      } else if (rev.clipDir === 'right-to-left') {
        const cw = baseRect.w * rev.clipFrac;
        ctx.rect(baseRect.x + baseRect.w - cw, baseRect.y, cw, baseRect.h);
      } else {
        ctx.rect(baseRect.x, baseRect.y, baseRect.w * rev.clipFrac, baseRect.h);
      }
      ctx.clip();
    }

    // Draw background / container fill
    const img = el.assetRef ? resolveAssetImage(runtime.assets, el.assetRef, rendererCtx, runtime.onAssetReady) : null;
    if (img) {
      if (rad > 0) {
        ctx.save();
        roundRectPath(ctx, baseRect.x, baseRect.y, baseRect.w, baseRect.h, rad);
        ctx.clip();
        ctx.drawImage(img, baseRect.x, baseRect.y, baseRect.w, baseRect.h);
        ctx.restore();
      } else {
        ctx.drawImage(img, baseRect.x, baseRect.y, baseRect.w, baseRect.h);
      }
    } else {
      let fill = el.backgroundColor;
      if (el.type === 'option_container' && isCorrectOpt) {
        fill = (runtime.theme && runtime.theme.correctFill) || '#16a34a';
      }
      if (fill && fill !== 'transparent') {
        ctx.fillStyle = fill;
        if (el.shapeKind === 'circle') {
          ctx.beginPath();
          ctx.ellipse(baseRect.x + baseRect.w / 2, baseRect.y + baseRect.h / 2, baseRect.w / 2, baseRect.h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        } else if (rad > 0) {
          roundRectPath(ctx, baseRect.x, baseRect.y, baseRect.w, baseRect.h, rad);
          ctx.fill();
        } else {
          ctx.fillRect(baseRect.x, baseRect.y, baseRect.w, baseRect.h);
        }
        if (el.type === 'header' && el.headerDesign === 'stripe' && el.borderColor) {
          ctx.fillStyle = el.borderColor;
          ctx.fillRect(baseRect.x, baseRect.y + baseRect.h, baseRect.w, Math.max(3, h * 0.008));
        }
      }
    }

    // Border outline
    if (el.borderWidth > 0 && el.borderColor && el.borderColor !== 'transparent') {
      ctx.lineWidth = el.borderWidth * (w / 1280);
      ctx.strokeStyle = el.borderColor;
      if (el.shapeKind === 'circle') {
        ctx.beginPath();
        ctx.ellipse(baseRect.x + baseRect.w / 2, baseRect.y + baseRect.h / 2, baseRect.w / 2, baseRect.h / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (rad > 0) {
        roundRectPath(ctx, baseRect.x, baseRect.y, baseRect.w, baseRect.h, rad);
        ctx.stroke();
      } else {
        ctx.strokeRect(baseRect.x, baseRect.y, baseRect.w, baseRect.h);
      }
    }

    // Foreground content by element type
    switch (el.type) {
      case 'timer':
        drawGenericTimer(ctx, baseRect, remaining, runtime.timerDuration || 10, el);
        break;
      case 'progress_bar': {
        const prog = (qIdx + 1) / Math.max(1, totalQ);
        ctx.fillStyle = el.textColor || '#ff4a14';
        roundRectPath(ctx, baseRect.x, baseRect.y, Math.max(baseRect.h, baseRect.w * prog), baseRect.h, rad);
        ctx.fill();
        break;
      }
      case 'icon': {
        const glyph = el.iconGlyph || el.text || '★';
        ctx.fillStyle = el.textColor || '#ffd700';
        ctx.font = `700 ${Math.round(Math.min(baseRect.w, baseRect.h) * 0.72)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(glyph, baseRect.x + baseRect.w / 2, baseRect.y + baseRect.h / 2);
        break;
      }
      case 'question_text': {
        const full = q && q.question ? String(q.question).toUpperCase() : substituteTokens(el.text, q, qIdx, totalQ, runtime);
        const textToDraw = (rev.shownText !== null && rev.shownText !== undefined) ? String(rev.shownText).toUpperCase() : full;
        if (textToDraw) drawWrappedText(ctx, textToDraw, baseRect, el, h, rev, rendererCtx);
        break;
      }
      case 'option_label': {
        const idx = el.optionIndex;
        const lbl = isCorrectOpt ? '✓' : (idx >= 0 && idx < 4 ? 'ABCD'[idx] : (el.text || 'A'));
        drawWrappedText(ctx, lbl, baseRect, el, h, rev, rendererCtx);
        break;
      }
      case 'option_text': {
        const idx = el.optionIndex;
        const opts = q && Array.isArray(q.options) ? q.options : [];
        const full = (idx >= 0 && idx < opts.length) ? String(opts[idx]).toUpperCase() : substituteTokens(el.text, q, qIdx, totalQ, runtime);
        const textToDraw = (rev.shownText !== null && rev.shownText !== undefined) ? String(rev.shownText).toUpperCase() : full;
        if (textToDraw) drawWrappedText(ctx, textToDraw, baseRect, el, h, rev, rendererCtx);
        break;
      }
      case 'question_number':
      case 'text': {
        const resolved = substituteTokens(el.text, q, qIdx, totalQ, runtime);
        if (resolved) drawWrappedText(ctx, resolved, baseRect, el, h, rev, rendererCtx);
        break;
      }
      default:
        break;
    }

    if (typeof ctx.filter === 'string' && rev.blurPx > 0.2) {
      ctx.filter = 'none';
    }
    ctx.restore();
  }

  /**
   * Draws selection box + handles around currently selected element during interactive preview only.
   */
  function drawSelectionOverlay(ctx, w, h, scene, selectedId) {
    if (!selectedId || !scene || !Array.isArray(scene.elements)) return;
    const el = scene.elements.find(e => e.id === selectedId);
    if (!el || !el.visible) return;
    const x = el.x * w;
    const y = el.y * h;
    const bw = el.width * w;
    const bh = el.height * h;

    ctx.save();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = Math.max(2, w * 0.0025);
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(x, y, bw, bh);
    ctx.setLineDash([]);

    const hs = Math.max(8, w * 0.01);
    ctx.fillStyle = '#38bdf8';
    const corners = [[x, y], [x + bw, y], [x, y + bh], [x + bw, y + bh]];
    corners.forEach(([cx, cy]) => {
      ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
    });
    ctx.restore();
  }

  /**
   * Renders a full frame from `scene` at given question/timing state.
   */
  function renderSceneFrame(ctx, w, h, scene, q, qIdx, totalQ, options = {}) {
    const rCtx = options.rendererCtx || createRendererContext();
    rCtx.metrics.framesRendered++;

    if (!scene || !Array.isArray(scene.elements) || !scene.elements.length) {
      ctx.fillStyle = '#111827';
      ctx.fillRect(0, 0, w, h);
      return;
    }

    const revealFlag = !!options.reveal;
    const remaining = options.remaining !== undefined ? options.remaining : null;
    const runtime = {
      sceneMode: scene.mode || 'DEFAULT_TEMPLATE_MODE',
      theme: scene.theme || {},
      assets: scene.assets || {},
      timerDuration: options.timerDuration || 10,
      headerText: options.headerText || 'GUESS THE ANSWER',
      channelName: options.channelName || '',
      projectTitle: options.projectTitle || '',
      revealConfig: options.revealConfig || null,
      revealSchedule: options.revealSchedule || null,
      voiceElapsedSec: options.voiceElapsedSec || 0,
      isPostVoice: options.isPostVoice !== undefined ? options.isPostVoice : true,
      onAssetReady: options.onAssetReady || null
    };

    // Strict isolation: IMPORTED_TEMPLATE_MODE clears with neutral black and NEVER draws default template bars
    ctx.clearRect(0, 0, w, h);
    if (runtime.sceneMode === 'DEFAULT_TEMPLATE_MODE' && runtime.theme && runtime.theme.bg) {
      ctx.fillStyle = runtime.theme.bg;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, w, h);
    }

    const sorted = [...scene.elements].sort((a, b) => (a.layerOrder || 0) - (b.layerOrder || 0));
    for (let i = 0; i < sorted.length; i++) {
      drawSceneElement(ctx, sorted[i], w, h, q, qIdx, totalQ, runtime, revealFlag, remaining, options.anim || null, rCtx);
    }

    if (options.interactiveOverlay && options.selectedElementId) {
      drawSelectionOverlay(ctx, w, h, scene, options.selectedElementId);
    }
  }

  /**
   * Renders an exact video timeline frame `gt` (seconds) using cached snapshots & reusable transition buffer.
   */
  function renderTimelineFrame(ctx, w, h, scene, timeline, questions, gt, options = {}) {
    const rCtx = options.rendererCtx || createRendererContext();
    if (!timeline || !timeline.segs || !timeline.segs.length || !questions || !questions.length) {
      renderSceneFrame(ctx, w, h, scene, null, 0, 1, { ...options, rendererCtx: rCtx });
      return;
    }

    let seg;
    if (Timeline && Timeline.findSegmentAt) {
      const hit = Timeline.findSegmentAt(timeline.segs, gt, rCtx.segPtr || 0);
      rCtx.segPtr = hit.ptr;
      seg = hit.seg;
    } else {
      seg = timeline.segs.find(s => gt >= s.start && gt < s.start + s.dur) || timeline.segs[timeline.segs.length - 1];
    }

    const q = questions[seg.i] || questions[0];
    const lt = Math.max(0, gt - seg.start);
    const totalQ = questions.length;
    const timerD = options.timerDuration || 10;

    if (seg.type === 'page') {
      if (rCtx.lastSeg && (rCtx.lastSeg.type === 'reveal' || rCtx.lastSeg.type === 'answer') && rCtx.snappedQuestionIdx !== rCtx.lastSeg.i) {
        if (!rCtx.snapCanvas || rCtx.snapCanvas.width !== w || rCtx.snapCanvas.height !== h) {
          rCtx.snapCanvas = makeOffscreenCanvas(w, h);
          rCtx.snapCtx = rCtx.snapCanvas ? rCtx.snapCanvas.getContext('2d') : null;
        }
        if (rCtx.snapCtx) {
          rCtx.snapCtx.clearRect(0, 0, w, h);
          rCtx.snapCtx.drawImage(ctx.canvas, 0, 0, w, h);
          rCtx.snappedQuestionIdx = rCtx.lastSeg.i;
        }
      }
      const p = Math.max(0, Math.min(1, lt / Math.max(0.001, seg.dur)));
      const schedule = Timeline && Timeline.buildRevealSchedule ? Timeline.buildRevealSchedule(q, seg.dur, { timerDuration: timerD }) : null;
      renderSceneFrame(ctx, w, h, scene, q, seg.i, totalQ, {
        ...options,
        remaining: timerD,
        reveal: false,
        voiceElapsedSec: 0,
        isPostVoice: false,
        revealSchedule: schedule,
        rendererCtx: rCtx
      });
      if (Transitions && Transitions.drawTransition && rCtx.snapCanvas) {
        Transitions.drawTransition(ctx, w, h, p, rCtx.snapCanvas, options.transitionConfig);
      }
      rCtx.lastSeg = seg;
      return;
    }

    const schedule = Timeline && Timeline.buildRevealSchedule ? Timeline.buildRevealSchedule(q, seg.dur, { timerDuration: timerD }) : null;
    if (seg.type === 'voice') {
      renderSceneFrame(ctx, w, h, scene, q, seg.i, totalQ, {
        ...options,
        remaining: timerD,
        reveal: false,
        voiceElapsedSec: lt,
        isPostVoice: false,
        revealSchedule: schedule,
        rendererCtx: rCtx
      });
    } else if (seg.type === 'count') {
      renderSceneFrame(ctx, w, h, scene, q, seg.i, totalQ, {
        ...options,
        remaining: Math.max(0, seg.dur - lt),
        reveal: false,
        voiceElapsedSec: seg.dur,
        isPostVoice: true,
        revealSchedule: schedule,
        rendererCtx: rCtx
      });
    } else {
      renderSceneFrame(ctx, w, h, scene, q, seg.i, totalQ, {
        ...options,
        remaining: 0,
        reveal: true,
        voiceElapsedSec: seg.dur,
        isPostVoice: true,
        revealSchedule: schedule,
        rendererCtx: rCtx
      });
    }
    rCtx.lastSeg = seg;
  }

  function buildExportSceneBundle(scene, questions, timeline, opts = {}) {
    return {
      width: opts.width || 1920,
      height: opts.height || 1080,
      fps: opts.fps || 24,
      scene: scene || null,
      assets: (scene && scene.assets) || {},
      theme: (scene && scene.theme) || opts.theme || {},
      questions: (questions || []).map(q => ({
        question: q.question,
        options: q.options,
        correct: q.correct,
        promptWordBoundaries: q.promptWordBoundaries || []
      })),
      timeline,
      revealConfig: opts.revealConfig || { enabled: true, questionStyle: 'typewriter-word' },
      transitionConfig: opts.transitionConfig || { style: 'classic-page-turn' },
      timerDuration: opts.timerDuration || 10,
      projectTitle: opts.projectTitle || '',
      channelName: opts.channelName || '',
      headerText: opts.headerText || 'GUESS THE ANSWER'
    };
  }

  return {
    createRendererContext,
    wrapTextCached,
    renderSceneFrame,
    renderTimelineFrame,
    buildExportSceneBundle
  };
});

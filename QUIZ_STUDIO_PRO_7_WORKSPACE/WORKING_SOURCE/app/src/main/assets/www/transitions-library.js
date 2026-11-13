/* Quiz Studio Pro 7 — Phase 11: Expanded Transitions Library (10 Page-Turn + 14 Question Transitions) */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QuizTransitions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PAGE_TURN_TRANSITIONS = Object.freeze([
    { id: 'classic-page-turn', category: 'page-turn', label: 'Classic Page Turn (R → L)' },
    { id: 'reverse-page-turn', category: 'page-turn', label: 'Reverse Page Turn (L → R)' },
    { id: 'horizontal-flip', category: 'page-turn', label: 'Horizontal Book Flip' },
    { id: 'vertical-flip', category: 'page-turn', label: 'Vertical Page Flip' },
    { id: 'card-flip-3d', category: 'page-turn', label: '3D Card Flip' },
    { id: 'fold-left', category: 'page-turn', label: 'Paper Fold Left' },
    { id: 'fold-right', category: 'page-turn', label: 'Paper Fold Right' },
    { id: 'center-split', category: 'page-turn', label: 'Center Book Split' },
    { id: 'page-curl', category: 'page-turn', label: 'Diagonal Page Curl' },
    { id: 'magazine-turn', category: 'page-turn', label: 'Magazine Spine Turn' }
  ]);

  const QUESTION_TRANSITIONS = Object.freeze([
    { id: 'fade', category: 'question', label: 'Fade Out / In' },
    { id: 'crossfade', category: 'question', label: 'Smooth Crossfade' },
    { id: 'slide-left', category: 'question', label: 'Slide Left' },
    { id: 'slide-right', category: 'question', label: 'Slide Right' },
    { id: 'slide-up', category: 'question', label: 'Slide Up' },
    { id: 'slide-down', category: 'question', label: 'Slide Down' },
    { id: 'zoom-in', category: 'question', label: 'Zoom In' },
    { id: 'zoom-out', category: 'question', label: 'Zoom Out' },
    { id: 'push', category: 'question', label: 'Push Slide' },
    { id: 'wipe', category: 'question', label: 'Directional Wipe' },
    { id: 'blur', category: 'question', label: 'Focus Blur Dissolve' },
    { id: 'rotate', category: 'question', label: 'Spin & Scale' },
    { id: 'flip-card', category: 'question', label: 'Quick Flip Card' },
    { id: 'none', category: 'question', label: 'None (Hard Cut)' }
  ]);

  const ALL_TRANSITIONS = Object.freeze([...PAGE_TURN_TRANSITIONS, ...QUESTION_TRANSITIONS]);
  const ALL_IDS = ALL_TRANSITIONS.map(t => t.id);

  const DEFAULT_TRANSITION_CONFIG = Object.freeze({
    style: 'classic-page-turn',
    durationSec: 0.72,
    direction: 'left',
    easing: 'ease-in-out',
    pageBackColor: '#f0ebe1',
    shadows: true
  });

  function normalizeTransitionConfig(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
      style: ALL_IDS.includes(r.style) ? r.style : DEFAULT_TRANSITION_CONFIG.style,
      durationSec: Math.max(0.25, Math.min(2.5, Number(r.durationSec) || DEFAULT_TRANSITION_CONFIG.durationSec)),
      direction: ['left', 'right', 'up', 'down'].includes(r.direction) ? r.direction : 'left',
      easing: ['linear', 'ease-out', 'ease-in-out'].includes(r.easing) ? r.easing : 'ease-in-out',
      pageBackColor: /^#[0-9a-f]{6}$/i.test(String(r.pageBackColor || '')) ? r.pageBackColor : '#f0ebe1',
      shadows: r.shadows !== undefined ? !!r.shadows : true
    };
  }

  function applyEasing(p, easing) {
    const t = Math.max(0, Math.min(1, p));
    if (easing === 'linear') return t;
    if (easing === 'ease-out') return 1 - Math.pow(1 - t, 3);
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function hexToRgba(hex, a) {
    const h = String(hex || '#f0ebe1').replace('#', '');
    const n = parseInt(h.length === 6 ? h : 'f0ebe1', 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /**
   * Draws one of the 24 transitions onto `ctx`.
   * Assumes the new frame is already painted onto `ctx` (underneath) and `snap` holds the previous frame.
   */
  function drawTransition(ctx, w, h, progress, snap, rawConfig) {
    const cfg = normalizeTransitionConfig(rawConfig);
    const p = Math.max(0, Math.min(1, progress));
    if (!snap || p >= 1 || cfg.style === 'none') return;

    const e = applyEasing(p, cfg.easing);
    const sh = cfg.shadows;

    switch (cfg.style) {
      case 'classic-page-turn': {
        const pw = w * (1 - e);
        if (pw <= 1) return;
        if (sh) {
          const g = ctx.createLinearGradient(pw, 0, pw + w * 0.05, 0);
          g.addColorStop(0, 'rgba(0,0,0,0.32)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.fillRect(pw, 0, w * 0.05, h);
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, pw, h);
        ctx.clip();
        ctx.scale(pw / w, 1);
        ctx.drawImage(snap, 0, 0, w, h);
        ctx.restore();
        if (p > 0.48) {
          ctx.save();
          ctx.fillStyle = hexToRgba(cfg.pageBackColor, Math.min(0.88, (p - 0.48) * 1.45));
          ctx.fillRect(0, 0, pw, h);
          ctx.restore();
        }
        if (sh) {
          const fg = ctx.createLinearGradient(Math.max(0, pw - w * 0.06), 0, pw, 0);
          fg.addColorStop(0, 'rgba(0,0,0,0)');
          fg.addColorStop(1, 'rgba(0,0,0,0.38)');
          ctx.fillStyle = fg;
          ctx.fillRect(Math.max(0, pw - w * 0.06), 0, Math.min(pw, w * 0.06), h);
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.fillRect(pw - 2, 0, 2, h);
        }
        break;
      }

      case 'reverse-page-turn': {
        const left = w * e;
        const pw = w - left;
        if (pw <= 1) return;
        if (sh) {
          const g = ctx.createLinearGradient(left - w * 0.05, 0, left, 0);
          g.addColorStop(0, 'rgba(0,0,0,0)');
          g.addColorStop(1, 'rgba(0,0,0,0.32)');
          ctx.fillStyle = g;
          ctx.fillRect(left - w * 0.05, 0, w * 0.05, h);
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, 0, pw, h);
        ctx.clip();
        ctx.translate(left, 0);
        ctx.scale(pw / w, 1);
        ctx.drawImage(snap, 0, 0, w, h);
        ctx.restore();
        if (p > 0.5) {
          ctx.fillStyle = hexToRgba(cfg.pageBackColor, Math.min(0.85, (p - 0.5) * 1.4));
          ctx.fillRect(left, 0, pw, h);
        }
        break;
      }

      case 'horizontal-flip':
      case 'card-flip-3d':
      case 'flip-card': {
        const half = e < 0.5;
        const sx = half ? Math.max(0.02, 1 - e * 2) : Math.max(0.02, (e - 0.5) * 2);
        if (half) {
          ctx.save();
          ctx.fillStyle = 'rgba(0,0,0,0.92)';
          ctx.fillRect(0, 0, w, h);
          ctx.translate(w / 2, h / 2);
          ctx.scale(sx, 1 - (1 - sx) * (cfg.style === 'card-flip-3d' ? 0.14 : 0.06));
          ctx.drawImage(snap, -w / 2, -h / 2, w, h);
          ctx.restore();
        } else if (sh) {
          ctx.save();
          ctx.fillStyle = `rgba(0,0,0,${(1 - sx) * 0.35})`;
          ctx.fillRect(0, 0, w, h);
          ctx.restore();
        }
        break;
      }

      case 'vertical-flip': {
        const sy = Math.max(0.01, 1 - e);
        ctx.save();
        ctx.translate(0, h * (1 - sy));
        ctx.scale(1, sy);
        ctx.drawImage(snap, 0, 0, w, h);
        if (p > 0.5) {
          ctx.fillStyle = hexToRgba(cfg.pageBackColor, Math.min(0.8, (p - 0.5) * 1.4));
          ctx.fillRect(0, 0, w, h);
        }
        ctx.restore();
        break;
      }

      case 'fold-left':
      case 'fold-right': {
        const toRight = cfg.style === 'fold-right';
        const foldX = toRight ? w * e : w * (1 - e);
        ctx.save();
        ctx.beginPath();
        if (toRight) ctx.rect(foldX, 0, w - foldX, h);
        else ctx.rect(0, 0, foldX, h);
        ctx.clip();
        ctx.drawImage(snap, 0, 0, w, h);
        ctx.restore();
        const flapW = Math.min(w * 0.3, toRight ? foldX : w - foldX);
        if (flapW > 2) {
          ctx.save();
          const x0 = toRight ? foldX - flapW : foldX;
          ctx.fillStyle = hexToRgba(cfg.pageBackColor, 0.92);
          ctx.fillRect(x0, 0, flapW, h);
          if (sh) {
            const fg = ctx.createLinearGradient(x0, 0, x0 + flapW, 0);
            fg.addColorStop(0, toRight ? 'rgba(0,0,0,0.08)' : 'rgba(0,0,0,0.35)');
            fg.addColorStop(1, toRight ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.08)');
            ctx.fillStyle = fg;
            ctx.fillRect(x0, 0, flapW, h);
          }
          ctx.restore();
        }
        break;
      }

      case 'center-split': {
        const halfW = (w / 2) * (1 - e);
        if (halfW <= 1) return;
        ctx.save();
        ctx.drawImage(snap, 0, 0, w / 2, h, 0, 0, halfW, h);
        ctx.drawImage(snap, w / 2, 0, w / 2, h, w - halfW, 0, halfW, h);
        if (sh) {
          ctx.fillStyle = 'rgba(0,0,0,0.28)';
          ctx.fillRect(halfW, 0, 8, h);
          ctx.fillRect(w - halfW - 8, 0, 8, h);
        }
        ctx.restore();
        break;
      }

      case 'page-curl': {
        const diag = (1 - e);
        const clipW = w * diag;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(clipW + w * 0.25 * (1 - diag), 0);
        ctx.lineTo(Math.max(0, clipW - w * 0.25 * Math.sin(e * Math.PI)), h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(snap, 0, 0, w, h);
        ctx.restore();
        // Curl triangular flap
        const fx = clipW;
        const curlSize = Math.sin(e * Math.PI) * w * 0.14;
        if (curlSize > 2) {
          ctx.save();
          ctx.fillStyle = hexToRgba(cfg.pageBackColor, 0.94);
          ctx.beginPath();
          ctx.moveTo(fx, 0);
          ctx.lineTo(fx + curlSize, h * 0.35);
          ctx.lineTo(Math.max(0, fx - curlSize * 0.4), h);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        break;
      }

      case 'magazine-turn': {
        const pw = w * (1 - e);
        if (pw <= 1) return;
        const arch = Math.sin(e * Math.PI) * h * 0.05;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(pw * 0.65, -arch, pw, arch);
        ctx.lineTo(pw, h - arch);
        ctx.quadraticCurveTo(pw * 0.65, h + arch, 0, h);
        ctx.closePath();
        ctx.clip();
        ctx.scale(pw / w, 1);
        ctx.drawImage(snap, 0, 0, w, h);
        ctx.restore();
        if (sh) {
          const mg = ctx.createLinearGradient(pw - w * 0.07, 0, pw + w * 0.04, 0);
          mg.addColorStop(0, 'rgba(0,0,0,0)');
          mg.addColorStop(0.65, 'rgba(0,0,0,0.42)');
          mg.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = mg;
          ctx.fillRect(Math.max(0, pw - w * 0.07), 0, w * 0.11, h);
        }
        break;
      }

      case 'fade':
      case 'crossfade': {
        ctx.save();
        ctx.globalAlpha = 1 - e;
        ctx.drawImage(snap, 0, 0, w, h);
        ctx.restore();
        break;
      }

      case 'slide-left':
      case 'push': {
        ctx.save();
        ctx.translate(-w * e, 0);
        ctx.drawImage(snap, 0, 0, w, h);
        ctx.restore();
        break;
      }

      case 'slide-right': {
        ctx.save();
        ctx.translate(w * e, 0);
        ctx.drawImage(snap, 0, 0, w, h);
        ctx.restore();
        break;
      }

      case 'slide-up': {
        ctx.save();
        ctx.translate(0, -h * e);
        ctx.drawImage(snap, 0, 0, w, h);
        ctx.restore();
        break;
      }

      case 'slide-down': {
        ctx.save();
        ctx.translate(0, h * e);
        ctx.drawImage(snap, 0, 0, w, h);
        ctx.restore();
        break;
      }

      case 'zoom-in': {
        const sc = 1 + e * 0.45;
        ctx.save();
        ctx.globalAlpha = 1 - e;
        ctx.translate(w / 2, h / 2);
        ctx.scale(sc, sc);
        ctx.drawImage(snap, -w / 2, -h / 2, w, h);
        ctx.restore();
        break;
      }

      case 'zoom-out': {
        const sc = Math.max(0.15, 1 - e * 0.7);
        ctx.save();
        ctx.globalAlpha = 1 - e;
        ctx.translate(w / 2, h / 2);
        ctx.scale(sc, sc);
        ctx.drawImage(snap, -w / 2, -h / 2, w, h);
        ctx.restore();
        break;
      }

      case 'wipe': {
        const dir = cfg.direction;
        ctx.save();
        ctx.beginPath();
        if (dir === 'right') ctx.rect(0, 0, w * (1 - e), h);
        else if (dir === 'up') ctx.rect(0, 0, w, h * (1 - e));
        else if (dir === 'down') ctx.rect(0, h * e, w, h * (1 - e));
        else ctx.rect(w * e, 0, w * (1 - e), h);
        ctx.clip();
        ctx.drawImage(snap, 0, 0, w, h);
        ctx.restore();
        break;
      }

      case 'blur': {
        ctx.save();
        ctx.globalAlpha = 1 - e;
        if (typeof ctx.filter === 'string') {
          ctx.filter = `blur(${(e * 18).toFixed(1)}px)`;
        }
        ctx.drawImage(snap, 0, 0, w, h);
        if (typeof ctx.filter === 'string') ctx.filter = 'none';
        ctx.restore();
        break;
      }

      case 'rotate': {
        const sc = Math.max(0.05, 1 - e * 0.85);
        ctx.save();
        ctx.globalAlpha = 1 - e;
        ctx.translate(w / 2, h / 2);
        ctx.rotate(e * Math.PI * 0.5);
        ctx.scale(sc, sc);
        ctx.drawImage(snap, -w / 2, -h / 2, w, h);
        ctx.restore();
        break;
      }

      default:
        break;
    }
  }

  return {
    PAGE_TURN_TRANSITIONS,
    QUESTION_TRANSITIONS,
    ALL_TRANSITIONS,
    ALL_IDS,
    DEFAULT_TRANSITION_CONFIG,
    normalizeTransitionConfig,
    drawTransition
  };
});

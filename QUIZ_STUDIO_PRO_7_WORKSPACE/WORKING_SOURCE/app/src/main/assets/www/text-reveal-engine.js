/* Quiz Studio Pro 7 — Phase 10: Animated Text & Element Reveal Engine (16 Styles) */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QuizTextReveal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REVEAL_STYLES = Object.freeze([
    { id: 'typewriter-word', label: 'Typewriter (Word-by-Word)' },
    { id: 'typewriter-char', label: 'Typewriter (Char-by-Char)' },
    { id: 'fade-in', label: 'Fade In' },
    { id: 'slide-left', label: 'Slide Left' },
    { id: 'slide-right', label: 'Slide Right' },
    { id: 'slide-top', label: 'Slide Top' },
    { id: 'slide-bottom', label: 'Slide Bottom' },
    { id: 'scale-in', label: 'Scale In' },
    { id: 'pop-in', label: 'Pop In' },
    { id: 'blur-clear', label: 'Blur Clear' },
    { id: 'mask-reveal', label: 'Mask Reveal' },
    { id: 'wipe-reveal', label: 'Wipe Reveal' },
    { id: 'letter-by-letter', label: 'Letter-by-Letter' },
    { id: 'word-by-word', label: 'Word-by-Word' },
    { id: 'line-by-line', label: 'Line-by-Line' },
    { id: 'none', label: 'None (Instant)' }
  ]);

  const STYLE_IDS = REVEAL_STYLES.map(s => s.id);
  const EASINGS = ['linear', 'ease-out', 'ease-in-out', 'spring'];

  function makeRoleConfig(style = 'typewriter-word', durationSec = 0.5, delaySec = 0, staggerSec = 0.06, easing = 'ease-out', direction = 'auto') {
    return {
      style: STYLE_IDS.includes(style) ? style : 'typewriter-word',
      durationSec: Math.max(0.05, Math.min(10, Number(durationSec) || 0.5)),
      delaySec: Math.max(0, Math.min(5, Number(delaySec) || 0)),
      staggerSec: Math.max(0, Math.min(1, Number(staggerSec) || 0.06)),
      easing: EASINGS.includes(easing) ? easing : 'ease-out',
      direction: ['auto', 'left', 'right', 'top', 'bottom'].includes(direction) ? direction : 'auto'
    };
  }

  const DEFAULT_REVEAL_CONFIG = Object.freeze({
    enabled: true,
    questionStyle: 'typewriter-word',
    questionText: makeRoleConfig('typewriter-word', 0.9, 0, 0.05, 'ease-out', 'auto'),
    optionLabel: makeRoleConfig('pop-in', 0.28, 0, 0.04, 'spring', 'auto'),
    optionText: makeRoleConfig('typewriter-word', 0.45, 0.04, 0.05, 'ease-out', 'auto'),
    header: makeRoleConfig('none', 0.25, 0, 0, 'ease-out', 'auto'),
    answerReveal: makeRoleConfig('pop-in', 0.35, 0, 0, 'spring', 'auto')
  });

  function normalizeRole(raw, fallback) {
    if (!raw || typeof raw !== 'object') return { ...fallback };
    return makeRoleConfig(
      raw.style || fallback.style,
      raw.durationSec !== undefined ? raw.durationSec : fallback.durationSec,
      raw.delaySec !== undefined ? raw.delaySec : fallback.delaySec,
      raw.staggerSec !== undefined ? raw.staggerSec : fallback.staggerSec,
      raw.easing || fallback.easing,
      raw.direction || fallback.direction
    );
  }

  function normalizeRevealConfig(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const qRole = normalizeRole(r.questionText, DEFAULT_REVEAL_CONFIG.questionText);
    if (r.questionStyle && STYLE_IDS.includes(r.questionStyle) && (!r.questionText || !r.questionText.style)) {
      qRole.style = r.questionStyle;
    }
    return {
      enabled: r.enabled !== undefined ? !!r.enabled : true,
      questionStyle: qRole.style,
      questionText: qRole,
      optionLabel: normalizeRole(r.optionLabel, DEFAULT_REVEAL_CONFIG.optionLabel),
      optionText: normalizeRole(r.optionText, DEFAULT_REVEAL_CONFIG.optionText),
      header: normalizeRole(r.header, DEFAULT_REVEAL_CONFIG.header),
      answerReveal: normalizeRole(r.answerReveal, DEFAULT_REVEAL_CONFIG.answerReveal)
    };
  }

  function applyEasing(t, easing) {
    const p = Math.max(0, Math.min(1, t));
    if (easing === 'linear') return p;
    if (easing === 'ease-in-out') return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    if (easing === 'spring') {
      const c4 = (2 * Math.PI) / 3;
      if (p <= 0) return 0;
      if (p >= 1) return 1;
      return Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1;
    }
    return 1 - Math.pow(1 - p, 3);
  }

  function sliceProgressiveText(fullText, progress, style, linesPrecomputed) {
    const text = String(fullText || '');
    const p = Math.max(0, Math.min(1, progress));
    if (p >= 0.999) return text;
    if (p <= 0) return '';

    if (style === 'typewriter-char' || style === 'letter-by-letter') {
      const count = Math.max(0, Math.min(text.length, Math.ceil(text.length * p)));
      return text.slice(0, count);
    }

    if (style === 'line-by-line') {
      const lines = Array.isArray(linesPrecomputed) && linesPrecomputed.length
        ? linesPrecomputed
        : text.split(/\r?\n/);
      if (lines.length <= 1) {
        const words = text.trim().split(/\s+/).filter(Boolean);
        return words.slice(0, Math.ceil(words.length * p)).join(' ');
      }
      const lineCount = Math.max(0, Math.min(lines.length, Math.ceil(lines.length * p)));
      return lines.slice(0, lineCount).join('\n');
    }

    // typewriter-word / word-by-word
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const count = Math.max(0, Math.min(words.length, Math.ceil(words.length * p)));
    return words.slice(0, count).join(' ');
  }

  /**
   * Computes deterministic visual reveal state for an element at `elapsedSec` inside a voice/count/reveal segment.
   */
  function evaluateReveal(role, fullText, slotStartSec, slotEndSec, elapsedSec, configInput, isPostVoiceSegment = false, wrappedLines = null) {
    const cfg = normalizeRevealConfig(configInput);
    const full = String(fullText || '');

    if (!cfg.enabled || isPostVoiceSegment) {
      return {
        visible: true,
        progress: 1,
        opacity: 1,
        offsetXFrac: 0,
        offsetYFrac: 0,
        scale: 1,
        blurPx: 0,
        clipFrac: 1,
        clipDir: 'left-to-right',
        shownText: full,
        style: 'none'
      };
    }

    const roleCfg = cfg[role] || cfg.questionText;
    const style = roleCfg.style;

    const span = Math.max(0.05, (slotEndSec - slotStartSec));
    const adjustedStart = slotStartSec + Math.min(span * 0.45, roleCfg.delaySec);
    if (elapsedSec < adjustedStart) {
      return {
        visible: false,
        progress: 0,
        opacity: 0,
        offsetXFrac: 0,
        offsetYFrac: 0,
        scale: 1,
        blurPx: 0,
        clipFrac: 0,
        clipDir: 'left-to-right',
        shownText: '',
        style
      };
    }

    if (style === 'none') {
      return {
        visible: true,
        progress: 1,
        opacity: 1,
        offsetXFrac: 0,
        offsetYFrac: 0,
        scale: 1,
        blurPx: 0,
        clipFrac: 1,
        clipDir: 'left-to-right',
        shownText: full,
        style
      };
    }

    const isTextProgressive = (
      style === 'typewriter-word' ||
      style === 'typewriter-char' ||
      style === 'word-by-word' ||
      style === 'letter-by-letter' ||
      style === 'line-by-line'
    );

    const activeSpan = isTextProgressive
      ? Math.max(0.05, slotEndSec - adjustedStart)
      : Math.max(0.05, Math.min(slotEndSec - adjustedStart, roleCfg.durationSec));
    const rawP = Math.max(0, Math.min(1, (elapsedSec - adjustedStart) / activeSpan));
    const eased = applyEasing(rawP, roleCfg.easing);

    const state = {
      visible: true,
      progress: rawP,
      opacity: 1,
      offsetXFrac: 0,
      offsetYFrac: 0,
      scale: 1,
      blurPx: 0,
      clipFrac: 1,
      clipDir: 'left-to-right',
      shownText: full,
      style
    };

    switch (style) {
      case 'typewriter-char':
      case 'typewriter-word':
      case 'letter-by-letter':
      case 'word-by-word':
      case 'line-by-line':
        state.shownText = sliceProgressiveText(full, rawP, style, wrappedLines);
        state.opacity = Math.min(1, rawP * 6 + 0.15);
        break;
      case 'fade-in':
        state.opacity = eased;
        break;
      case 'slide-left':
        state.offsetXFrac = -(1 - eased) * 0.25;
        state.opacity = Math.min(1, rawP * 3);
        break;
      case 'slide-right':
        state.offsetXFrac = (1 - eased) * 0.25;
        state.opacity = Math.min(1, rawP * 3);
        break;
      case 'slide-top':
        state.offsetYFrac = -(1 - eased) * 0.22;
        state.opacity = Math.min(1, rawP * 3);
        break;
      case 'slide-bottom':
        state.offsetYFrac = (1 - eased) * 0.22;
        state.opacity = Math.min(1, rawP * 3);
        break;
      case 'scale-in':
        state.scale = 0.6 + 0.4 * eased;
        state.opacity = Math.min(1, rawP * 2.5);
        break;
      case 'pop-in': {
        const sp = applyEasing(rawP, 'spring');
        state.scale = 0.45 + 0.55 * sp;
        state.opacity = Math.min(1, rawP * 4);
        break;
      }
      case 'blur-clear':
        state.blurPx = Math.max(0, (1 - eased) * 14);
        state.opacity = 0.2 + 0.8 * eased;
        break;
      case 'mask-reveal':
        state.clipFrac = eased;
        state.clipDir = roleCfg.direction === 'top' ? 'top-to-bottom' : 'left-to-right';
        break;
      case 'wipe-reveal':
        state.clipFrac = eased;
        state.clipDir = roleCfg.direction === 'right' ? 'right-to-left' : 'left-to-right';
        break;
      default:
        break;
    }

    return state;
  }

  return {
    REVEAL_STYLES,
    STYLE_IDS,
    EASINGS,
    DEFAULT_REVEAL_CONFIG,
    normalizeRevealConfig,
    applyEasing,
    sliceProgressiveText,
    evaluateReveal
  };
});

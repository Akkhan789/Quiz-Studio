/* Quiz Studio Pro 7 — Phase 5, 8, 9: Unified Scene & Layer Data Model */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QuizSceneModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCENE_SCHEMA_VERSION = 2;

  const RENDER_MODES = Object.freeze({
    DEFAULT: 'DEFAULT_TEMPLATE_MODE',
    IMPORTED: 'IMPORTED_TEMPLATE_MODE'
  });

  const ELEMENT_TYPES = Object.freeze([
    'background',
    'image',
    'text',
    'shape',
    'header',
    'question_number',
    'question_text',
    'question_container',
    'option_container',
    'option_label',
    'option_text',
    'timer',
    'progress_bar',
    'logo',
    'icon',
    'decorative',
    'group'
  ]);

  const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
  const round4 = v => Math.round((Number(v) || 0) * 10000) / 10000;

  function makeId(prefix = 'el') {
    return prefix + '_' + Math.random().toString(36).slice(2, 8) + '_' + Date.now().toString(36).slice(-4);
  }

  function normalizeElement(raw, index = 0) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const type = ELEMENT_TYPES.includes(r.type) ? r.type : 'shape';
    const x = round4(clamp(r.x !== undefined ? r.x : 0.1, -0.5, 1.5));
    const y = round4(clamp(r.y !== undefined ? r.y : 0.1, -0.5, 1.5));
    const width = round4(clamp(r.width !== undefined ? r.width : 0.2, 0.01, 2.0));
    const height = round4(clamp(r.height !== undefined ? r.height : 0.1, 0.01, 2.0));

    const el = {
      id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : makeId(type),
      type,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : (type.replace(/_/g, ' ') + ' ' + (index + 1)),
      x,
      y,
      width,
      height,
      rotation: round4(clamp(r.rotation || 0, -360, 360)),
      text: r.text !== undefined && r.text !== null ? String(r.text) : '',
      fontFamily: typeof r.fontFamily === 'string' && r.fontFamily ? r.fontFamily : 'League Spartan',
      fontSize: round4(clamp(r.fontSize !== undefined ? r.fontSize : 0.045, 0.01, 0.35)),
      fontWeight: clamp(r.fontWeight !== undefined ? r.fontWeight : 700, 100, 900),
      textColor: typeof r.textColor === 'string' ? r.textColor : '#ffffff',
      backgroundColor: typeof r.backgroundColor === 'string' ? r.backgroundColor : 'transparent',
      borderColor: typeof r.borderColor === 'string' ? r.borderColor : '#000000',
      borderWidth: round4(clamp(r.borderWidth || 0, 0, 24)),
      borderRadius: round4(clamp(r.borderRadius !== undefined ? r.borderRadius : 0.12, 0, 1.0)),
      opacity: round4(clamp(r.opacity !== undefined ? r.opacity : 1.0, 0, 1)),
      alignment: ['left', 'center', 'right'].includes(r.alignment) ? r.alignment : 'center',
      visible: r.visible !== undefined ? !!r.visible : true,
      layerOrder: Number.isFinite(Number(r.layerOrder)) ? Number(r.layerOrder) : index,
      assetRef: typeof r.assetRef === 'string' ? r.assetRef : '',
      confidence: r.confidence !== undefined && r.confidence !== null ? clamp(r.confidence, 0, 1) : null,
      sourceImageRef: typeof r.sourceImageRef === 'string' ? r.sourceImageRef : '',
      groupId: typeof r.groupId === 'string' ? r.groupId : '',
      locked: !!r.locked,
      editable: r.editable !== undefined ? !!r.editable : true,
      // Extended metadata needed for clean Default/Imported parity & resets
      optionIndex: Number.isInteger(r.optionIndex) ? r.optionIndex : (typeof r.optionIndex === 'number' ? r.optionIndex : -1),
      strokeColor: typeof r.strokeColor === 'string' ? r.strokeColor : '',
      strokeEnabled: r.strokeEnabled !== undefined ? !!r.strokeEnabled : false,
      timerLook: typeof r.timerLook === 'string' ? r.timerLook : 'capsule',
      headerDesign: typeof r.headerDesign === 'string' ? r.headerDesign : 'bar',
      optShape: typeof r.optShape === 'string' ? r.optShape : 'pill',
      shapeKind: ['rect', 'rounded', 'circle', 'pill', 'line'].includes(r.shapeKind) ? r.shapeKind : 'rounded',
      iconGlyph: typeof r.iconGlyph === 'string' ? r.iconGlyph : '★',
      isDefaultTemplateOnly: !!r.isDefaultTemplateOnly,
      defaultBounds: (r.defaultBounds && typeof r.defaultBounds === 'object')
        ? {
            x: round4(r.defaultBounds.x),
            y: round4(r.defaultBounds.y),
            width: round4(r.defaultBounds.width),
            height: round4(r.defaultBounds.height)
          }
        : { x, y, width, height }
    };
    return el;
  }

  function parseAspectRatio(ratioStr) {
    if (ratioStr === '9/16') return { ratio: '9/16', width: 1080, height: 1920 };
    if (ratioStr === '1/1') return { ratio: '1/1', width: 1080, height: 1080 };
    return { ratio: '16/9', width: 1920, height: 1080 };
  }

  function createBlankScene(options = {}) {
    const aspect = parseAspectRatio(options.ratio || '16/9');
    return {
      schemaVersion: SCENE_SCHEMA_VERSION,
      mode: RENDER_MODES.IMPORTED,
      ratio: aspect.ratio,
      baseWidth: aspect.width,
      baseHeight: aspect.height,
      theme: options.theme ? { ...options.theme } : {},
      assets: options.assets ? { ...options.assets } : {},
      elements: [
        normalizeElement({
          id: 'bg_main',
          type: 'background',
          name: 'Background Layer',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          backgroundColor: options.bg || '#111827',
          layerOrder: 0,
          borderRadius: 0
        }, 0)
      ]
    };
  }

  /**
   * Builds a complete, decomposed Unified Scene from legacy `THEME` + current ratio/header config.
   * Ensures every visual component (header bar, header num, header title, question text,
   * option A-D containers/labels/texts, timer, footer brand) is a selectable, movable, resizable element.
   */
  function fromThemeToScene(themeInput, options = {}) {
    const t = themeInput && typeof themeInput === 'object' ? themeInput : {};
    const aspect = parseAspectRatio(options.ratio || t.ratio || '16/9');
    const portrait = aspect.height > aspect.width;
    const sq = !portrait && Math.abs(aspect.width - aspect.height) < 5;
    const szMul = s => (s === 'small' ? 0.85 : s === 'large' ? 1.18 : 1);

    const fontFamily = t.font || 'League Spartan';
    const assets = { ...(options.assets || {}) };
    let bgAssetRef = '';
    if (t.bgImage && typeof t.bgImage === 'string') {
      bgAssetRef = 'theme_bg';
      assets[bgAssetRef] = t.bgImage;
    }

    const elements = [];
    let order = 0;

    elements.push(normalizeElement({
      id: 'bg_main',
      type: 'background',
      name: 'Canvas Background',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      backgroundColor: t.bg || '#e6e6e6',
      assetRef: bgAssetRef,
      borderRadius: 0,
      layerOrder: order++,
      locked: false
    }, order));

    // Header group (can be toggled or nudged/resized)
    const showHdr = t.headerShow !== 'hide';
    const hdrH = (showHdr ? (portrait ? 0.10 : 0.165) * szMul(t.headerSize) : 0) * (t.headerHeightScale || 1);
    const hdrY = ((t.headerY || 0) / 100);
    if (showHdr && hdrH > 0) {
      elements.push(normalizeElement({
        id: 'hdr_bg',
        type: 'header',
        name: 'Header Bar',
        groupId: 'grp_header',
        x: 0,
        y: hdrY,
        width: 1,
        height: hdrH,
        backgroundColor: t.headerBg || '#1e1b08',
        borderColor: t.headerNum || '#ffff00',
        headerDesign: t.headerDesign || 'bar',
        borderRadius: t.headerDesign === 'round' ? 0.16 : 0,
        layerOrder: order++,
        isDefaultTemplateOnly: false
      }, order));

      elements.push(normalizeElement({
        id: 'hdr_num',
        type: 'question_number',
        name: 'Question Number Badge',
        groupId: 'grp_header',
        x: 0.03,
        y: hdrY + hdrH * 0.12,
        width: 0.16,
        height: hdrH * 0.76,
        text: '{num}/{total}',
        fontFamily,
        fontSize: hdrH * 0.56,
        fontWeight: 800,
        textColor: t.headerNum || '#ffff00',
        strokeColor: t.headerStroke || '#000000',
        strokeEnabled: t.outHeader !== 'off',
        alignment: 'left',
        layerOrder: order++
      }, order));

      elements.push(normalizeElement({
        id: 'hdr_title',
        type: 'text',
        name: 'Header Title',
        groupId: 'grp_header',
        x: 0.20,
        y: hdrY + hdrH * 0.14,
        width: 0.76,
        height: hdrH * 0.72,
        text: '{header}',
        fontFamily,
        fontSize: hdrH * 0.52,
        fontWeight: 800,
        textColor: t.headerText || '#ffffff',
        strokeColor: t.headerStroke || '#000000',
        strokeEnabled: t.outHeader !== 'off',
        alignment: 'left',
        layerOrder: order++
      }, order));
    }

    // Options layout calculation mirrors legacy `drawSpanish` geometry exactly
    const optCount = Math.max(2, Math.min(4, parseInt(t.optCount || 4, 10) || 4));
    const cols = portrait ? 1 : 2;
    const rows = portrait ? optCount : Math.ceil(optCount / 2);
    const gapX = 0.025;
    const gapY = portrait ? 0.02 : 0.03;
    const sideM = portrait ? 0.07 : 0.05;
    const boxW = (1 - sideM * 2 - gapX * (cols - 1)) / cols;
    const optScaleMul = t.optScale || 1;
    const boxH = (portrait ? 0.085 : sq ? 0.11 : 0.125) * szMul(t.optSize) * optScaleMul;
    const optRad = t.optShape === 'pill' ? 0.5 : t.optShape === 'rounded' ? 0.22 : t.optShape === 'none' ? 0 : 0.06;
    const optOffY = (t.optY || 0) / 100;
    const optTop = 1 - (rows * boxH + (rows - 1) * gapY) - (portrait ? 0.08 : 0.065) + optOffY;

    // Timer
    const tH = portrait ? 0.04 : 0.055;
    const tY = optTop - 0.03 - tH + ((t.timerY || 0) / 100);
    const tX = 0.20 + ((t.timerX || 0) / 100);
    const tScale = clamp(t.timerSize || 1, 0.5, 2.0);
    elements.push(normalizeElement({
      id: 'timer_main',
      type: 'timer',
      name: 'Countdown Timer',
      x: tX,
      y: tY,
      width: 0.60 * tScale,
      height: tH * tScale,
      backgroundColor: t.timerTrack || '#d9d9d9',
      textColor: t.timerA || '#ff4a14',
      borderColor: t.timerBorder || '#ffffff',
      timerLook: t.timerLook || 'capsule',
      layerOrder: order++
    }, order));

    // Question text box between header and timer
    const qTop = Math.max(0.03, hdrH + hdrY + 0.05) + ((t.qY || 0) / 100);
    const qBot = Math.max(qTop + 0.08, tY - 0.025);
    elements.push(normalizeElement({
      id: 'q_text',
      type: 'question_text',
      name: 'Question Text',
      x: 0.06,
      y: qTop,
      width: 0.88,
      height: qBot - qTop,
      text: '{question}',
      fontFamily,
      fontSize: (portrait ? 0.048 : 0.056) * szMul(t.qSize) * (t.qScale || 1),
      fontWeight: 800,
      textColor: t.qText || '#000000',
      strokeColor: t.qStroke || '#ffffff',
      strokeEnabled: t.outQ !== 'off',
      alignment: 'center',
      layerOrder: order++
    }, order));

    // Options A-D decomposed into independent container + letter badge + text children
    const aspectRatio = aspect.width / aspect.height;
    for (let i = 0; i < optCount; i++) {
      const c = portrait ? 0 : i % 2;
      const r = portrait ? i : Math.floor(i / 2);
      let bx = sideM + c * (boxW + gapX);
      if (!portrait && optCount === 3 && i === 2) bx = sideM + (boxW + gapX) / 2;
      const by = optTop + r * (boxH + gapY);
      const grp = 'grp_opt_' + i;

      elements.push(normalizeElement({
        id: 'opt_' + i + '_container',
        type: 'option_container',
        name: 'Option ' + 'ABCD'[i] + ' Container',
        groupId: grp,
        optionIndex: i,
        x: bx,
        y: by,
        width: boxW,
        height: boxH,
        backgroundColor: t.optShape === 'none' ? 'transparent' : (t.optFill || '#050505'),
        borderColor: t.optStroke || '#000000',
        borderWidth: 0,
        borderRadius: optRad,
        optShape: t.optShape || 'pill',
        layerOrder: order++
      }, order));

      // Badge width corrected for canvas aspect ratio so circles/pills stay crisp
      const badgeH = boxH * 0.80;
      const badgeW = clamp(badgeH / aspectRatio, 0.03, boxW * 0.25);
      elements.push(normalizeElement({
        id: 'opt_' + i + '_label',
        type: 'option_label',
        name: 'Option ' + 'ABCD'[i] + ' Badge',
        groupId: grp,
        optionIndex: i,
        x: bx + (boxH * 0.10) / aspectRatio,
        y: by + boxH * 0.10,
        width: badgeW,
        height: badgeH,
        text: 'ABCD'[i],
        fontFamily,
        fontSize: badgeH * 0.58,
        fontWeight: 800,
        textColor: t.badgeText || '#000000',
        backgroundColor: t.optShape === 'none' ? 'transparent' : (t.badgeFill || '#ffff00'),
        borderColor: t.badgeStroke || '#000000',
        borderWidth: t.optShape === 'none' ? 0 : 2,
        borderRadius: t.optShape === 'pill' ? 0.5 : 0.2,
        strokeColor: t.badgeStroke || '#000000',
        strokeEnabled: t.outBadge === 'on',
        alignment: 'center',
        layerOrder: order++
      }, order));

      const textX = bx + badgeW + (boxH * 0.20) / aspectRatio;
      elements.push(normalizeElement({
        id: 'opt_' + i + '_text',
        type: 'option_text',
        name: 'Option ' + 'ABCD'[i] + ' Text',
        groupId: grp,
        optionIndex: i,
        x: textX,
        y: by + boxH * 0.08,
        width: Math.max(0.08, bx + boxW - textX - 0.015),
        height: boxH * 0.84,
        text: '{option_' + i + '}',
        fontFamily,
        fontSize: boxH * 0.42,
        fontWeight: 800,
        textColor: t.optText || '#ffffff',
        strokeColor: t.optStroke || '#000000',
        strokeEnabled: t.outOpt !== 'off',
        alignment: 'center',
        layerOrder: order++
      }, order));
    }

    // Channel watermark & footer counter
    elements.push(normalizeElement({
      id: 'footer_channel',
      type: 'text',
      name: 'Channel Watermark',
      x: 0.035,
      y: 0.955,
      width: 0.40,
      height: 0.035,
      text: '{channel}',
      fontFamily,
      fontSize: 0.022,
      fontWeight: 400,
      textColor: '#555555',
      opacity: 0.75,
      alignment: 'left',
      layerOrder: order++
    }, order));

    elements.push(normalizeElement({
      id: 'footer_counter',
      type: 'text',
      name: 'Slide Counter',
      x: 0.78,
      y: 0.955,
      width: 0.185,
      height: 0.035,
      text: '{counter}',
      fontFamily,
      fontSize: 0.022,
      fontWeight: 400,
      textColor: '#555555',
      opacity: 0.75,
      alignment: 'right',
      layerOrder: order++
    }, order));

    return {
      schemaVersion: SCENE_SCHEMA_VERSION,
      mode: RENDER_MODES.DEFAULT,
      ratio: aspect.ratio,
      baseWidth: aspect.width,
      baseHeight: aspect.height,
      theme: { ...t },
      assets,
      elements
    };
  }

  /**
   * Builds an IMPORTED_TEMPLATE_MODE scene strictly from CV or Canva analysis output.
   * Zero default header/pill layers are injected beneath the imported artwork.
   */
  function fromDetectionToScene(detection, options = {}) {
    const det = detection && typeof detection === 'object' ? detection : {};
    const aspect = parseAspectRatio(options.ratio || det.ratio || '16/9');
    const assets = { ...(det.assets || {}), ...(options.assets || {}) };
    const elements = [];

    if (Array.isArray(det.elements) && det.elements.length) {
      det.elements.forEach((raw, idx) => {
        elements.push(normalizeElement({
          ...raw,
          isDefaultTemplateOnly: false
        }, idx));
      });
    } else {
      elements.push(normalizeElement({
        id: 'imported_bg',
        type: 'background',
        name: 'Imported Background',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        backgroundColor: det.dominantBg || '#111827',
        assetRef: det.cleanBgAssetRef || det.sourceAssetRef || '',
        borderRadius: 0,
        layerOrder: 0
      }, 0));
    }

    elements.sort((a, b) => a.layerOrder - b.layerOrder);

    return {
      schemaVersion: SCENE_SCHEMA_VERSION,
      mode: RENDER_MODES.IMPORTED,
      ratio: aspect.ratio,
      baseWidth: det.width || aspect.width,
      baseHeight: det.height || aspect.height,
      theme: det.theme ? { ...det.theme } : {},
      assets,
      detectionReport: det.report || null,
      elements
    };
  }

  function cloneScene(scene) {
    return JSON.parse(JSON.stringify(scene));
  }

  function findElement(scene, id) {
    if (!scene || !Array.isArray(scene.elements)) return null;
    return scene.elements.find(e => e.id === id) || null;
  }

  function addElement(scene, rawElement) {
    const next = cloneScene(scene);
    const maxOrder = next.elements.reduce((m, e) => Math.max(m, e.layerOrder || 0), 0);
    const el = normalizeElement({
      ...rawElement,
      layerOrder: rawElement && rawElement.layerOrder !== undefined ? rawElement.layerOrder : (maxOrder + 1)
    }, next.elements.length);
    next.elements.push(el);
    next.elements.sort((a, b) => a.layerOrder - b.layerOrder);
    return { scene: next, element: el };
  }

  function updateElement(scene, id, patch) {
    const next = cloneScene(scene);
    const idx = next.elements.findIndex(e => e.id === id);
    if (idx < 0) return next;
    const prev = next.elements[idx];
    if (prev.locked && patch.locked !== false) return next;
    next.elements[idx] = normalizeElement({
      ...prev,
      ...patch,
      id: prev.id,
      defaultBounds: prev.defaultBounds
    }, idx);
    next.elements.sort((a, b) => a.layerOrder - b.layerOrder);
    return next;
  }

  function moveElement(scene, id, x, y) {
    return updateElement(scene, id, { x, y });
  }

  function nudgeElement4Dir(scene, id, direction, step = 0.01) {
    const el = findElement(scene, id);
    if (!el || el.locked) return scene;
    const delta = Number(step) || 0.01;
    let dx = 0, dy = 0;
    if (direction === 'left') dx = -delta;
    else if (direction === 'right') dx = delta;
    else if (direction === 'up') dy = -delta;
    else if (direction === 'down') dy = delta;
    return updateElement(scene, id, {
      x: round4(el.x + dx),
      y: round4(el.y + dy)
    });
  }

  function resizeElement(scene, id, width, height) {
    return updateElement(scene, id, { width, height });
  }

  function rotateElement(scene, id, rotationDeg) {
    return updateElement(scene, id, { rotation: rotationDeg });
  }

  function duplicateElement(scene, id) {
    const el = findElement(scene, id);
    if (!el) return { scene, element: null };
    return addElement(scene, {
      ...el,
      id: makeId(el.type),
      name: el.name + ' Copy',
      x: round4(clamp(el.x + 0.02, -0.4, 1.3)),
      y: round4(clamp(el.y + 0.02, -0.4, 1.3)),
      locked: false
    });
  }

  function deleteElement(scene, id) {
    const next = cloneScene(scene);
    next.elements = next.elements.filter(e => e.id !== id || e.locked);
    return next;
  }

  function groupElements(scene, ids, groupId) {
    const gid = groupId || makeId('grp');
    const idSet = new Set(ids || []);
    const next = cloneScene(scene);
    next.elements = next.elements.map(e => idSet.has(e.id) ? { ...e, groupId: gid } : e);
    return { scene: next, groupId: gid };
  }

  function ungroupElement(scene, groupId) {
    const next = cloneScene(scene);
    next.elements = next.elements.map(e => e.groupId === groupId ? { ...e, groupId: '' } : e);
    return next;
  }

  function reorderLayer(scene, id, directionOrOrder) {
    const next = cloneScene(scene);
    next.elements.sort((a, b) => a.layerOrder - b.layerOrder);
    const idx = next.elements.findIndex(e => e.id === id);
    if (idx < 0) return next;
    if (typeof directionOrOrder === 'number') {
      next.elements[idx].layerOrder = directionOrOrder;
    } else if (directionOrOrder === 'up' && idx < next.elements.length - 1) {
      const tmp = next.elements[idx + 1].layerOrder;
      next.elements[idx + 1].layerOrder = next.elements[idx].layerOrder;
      next.elements[idx].layerOrder = tmp === next.elements[idx].layerOrder ? tmp + 1 : tmp;
    } else if (directionOrOrder === 'down' && idx > 0) {
      const tmp = next.elements[idx - 1].layerOrder;
      next.elements[idx - 1].layerOrder = next.elements[idx].layerOrder;
      next.elements[idx].layerOrder = tmp === next.elements[idx].layerOrder ? tmp - 1 : tmp;
    } else if (directionOrOrder === 'front') {
      const maxO = next.elements.reduce((m, e) => Math.max(m, e.layerOrder), 0);
      next.elements[idx].layerOrder = maxO + 1;
    } else if (directionOrOrder === 'back') {
      const minO = next.elements.reduce((m, e) => Math.min(m, e.layerOrder), 0);
      next.elements[idx].layerOrder = minO - 1;
    }
    next.elements.sort((a, b) => a.layerOrder - b.layerOrder);
    next.elements.forEach((e, i) => { e.layerOrder = i; });
    return next;
  }

  function resetElementPosition(scene, id) {
    const el = findElement(scene, id);
    if (!el || !el.defaultBounds) return scene;
    return updateElement(scene, id, { x: el.defaultBounds.x, y: el.defaultBounds.y, rotation: 0 });
  }

  function resetElementSize(scene, id) {
    const el = findElement(scene, id);
    if (!el || !el.defaultBounds) return scene;
    return updateElement(scene, id, { width: el.defaultBounds.width, height: el.defaultBounds.height });
  }

  /**
   * Top-most interactive hit-test in normalized coordinates [0..1].
   * Skips background and hidden elements so foreground layers are easily selectable.
   */
  function hitTest(scene, nx, ny, includeBackground = false) {
    if (!scene || !Array.isArray(scene.elements)) return null;
    const sorted = [...scene.elements].sort((a, b) => (b.layerOrder || 0) - (a.layerOrder || 0));
    for (const el of sorted) {
      if (!el.visible) continue;
      if (!includeBackground && el.type === 'background') continue;
      if (nx >= el.x && nx <= el.x + el.width && ny >= el.y && ny <= el.y + el.height) {
        return el;
      }
    }
    return null;
  }

  return {
    SCENE_SCHEMA_VERSION,
    RENDER_MODES,
    ELEMENT_TYPES,
    normalizeElement,
    parseAspectRatio,
    createBlankScene,
    fromThemeToScene,
    fromDetectionToScene,
    cloneScene,
    findElement,
    addElement,
    updateElement,
    moveElement,
    nudgeElement4Dir,
    resizeElement,
    rotateElement,
    duplicateElement,
    deleteElement,
    groupElements,
    ungroupElement,
    reorderLayer,
    resetElementPosition,
    resetElementSize,
    hitTest
  };
});

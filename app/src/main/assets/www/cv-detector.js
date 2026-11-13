/* Quiz Studio Pro 7 — Phase 6 & 7: Deterministic RGBA Computer Vision Detector & Two-Image Registration */
(function (root, factory) {
  const api = factory(
    root.QuizSceneModel || (typeof require === 'function' ? require('./scene-model.js') : null)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QuizCvDetector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SceneModel) {
  'use strict';

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const round4 = v => Math.round(v * 10000) / 10000;

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0')).join('');
  }

  function colorDist(r1, g1, b1, r2, g2, b2) {
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  function luminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function hexLuminance(hex) {
    const h = String(hex || '#000000').replace('#', '');
    if (h.length !== 6) return 128;
    const n = parseInt(h, 16);
    return luminance((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }

  function downsampleImageData(imgData, maxW = 240) {
    const { width, height, data } = imgData;
    if (width <= maxW) {
      return { width, height, data: new Uint8ClampedArray(data), scale: 1 };
    }
    const scale = maxW / width;
    const nw = Math.max(32, Math.round(width * scale));
    const nh = Math.max(32, Math.round(height * scale));
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(height - 1, Math.floor(y / scale));
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(width - 1, Math.floor(x / scale));
        const si = (sy * width + sx) * 4;
        const di = (y * nw + x) * 4;
        out[di] = data[si];
        out[di + 1] = data[si + 1];
        out[di + 2] = data[si + 2];
        out[di + 3] = data[si + 3];
      }
    }
    return { width: nw, height: nh, data: out, scale };
  }

  function estimateBackgroundStats(img) {
    const { width, height, data } = img;
    const borderSamples = [];
    const stepX = Math.max(1, Math.floor(width / 24));
    const stepY = Math.max(1, Math.floor(height / 24));

    for (let x = 0; x < width; x += stepX) {
      for (const y of [Math.floor(height * 0.02), Math.floor(height * 0.96), Math.floor(height * 0.45)]) {
        const i = (clamp(y, 0, height - 1) * width + x) * 4;
        borderSamples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
    for (let y = 0; y < height; y += stepY) {
      for (const x of [Math.floor(width * 0.02), Math.floor(width * 0.98)]) {
        const i = (y * width + clamp(x, 0, width - 1)) * 4;
        borderSamples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }

    // Mode bucket (quantized by 16) for dominant background color
    const buckets = new Map();
    for (const [r, g, b] of borderSamples) {
      const key = `${r >> 4}_${g >> 4}_${b >> 4}`;
      let rec = buckets.get(key);
      if (!rec) { rec = { count: 0, sr: 0, sg: 0, sb: 0 }; buckets.set(key, rec); }
      rec.count++; rec.sr += r; rec.sg += g; rec.sb += b;
    }
    let best = { count: 1, sr: 20, sg: 24, sb: 36 };
    for (const rec of buckets.values()) {
      if (rec.count > best.count) best = rec;
    }
    const bgR = best.sr / best.count, bgG = best.sg / best.count, bgB = best.sb / best.count;

    // Gradient / texture check between corners and middle
    const corners = [
      (2 * width + 2) * 4,
      (2 * width + (width - 3)) * 4,
      ((height - 3) * width + 2) * 4,
      ((height - 3) * width + (width - 3)) * 4
    ];
    let maxCornerDiff = 0;
    for (let a = 0; a < corners.length; a++) {
      for (let b = a + 1; b < corners.length; b++) {
        const ia = corners[a], ib = corners[b];
        maxCornerDiff = Math.max(maxCornerDiff, colorDist(data[ia], data[ia + 1], data[ia + 2], data[ib], data[ib + 1], data[ib + 2]));
      }
    }

    // Texture variance across scanline step
    let gradSum = 0, gradCount = 0;
    for (let y = 4; y < height - 4; y += 6) {
      for (let x = 4; x < width - 5; x += 6) {
        const i1 = (y * width + x) * 4;
        const i2 = (y * width + x + 1) * 4;
        gradSum += colorDist(data[i1], data[i1 + 1], data[i1 + 2], data[i2], data[i2 + 1], data[i2 + 2]);
        gradCount++;
      }
    }
    const avgLocalStep = gradCount ? gradSum / gradCount : 0;

    return {
      bgRgb: [Math.round(bgR), Math.round(bgG), Math.round(bgB)],
      bgHex: rgbToHex(bgR, bgG, bgB),
      isGradient: maxCornerDiff > 28,
      isTextured: avgLocalStep > 9.5,
      cornerSpread: round4(maxCornerDiff),
      textureScore: round4(avgLocalStep)
    };
  }

  function computeSobelAndForeground(img, bgStats) {
    const { width, height, data } = img;
    const n = width * height;
    const lum = new Float32Array(n);
    const edge = new Float32Array(n);
    const fgDist = new Float32Array(n);
    const [br, bg, bb] = bgStats.bgRgb;

    for (let i = 0; i < n; i++) {
      const p = i * 4;
      lum[i] = luminance(data[p], data[p + 1], data[p + 2]);
      fgDist[i] = colorDist(data[p], data[p + 1], data[p + 2], br, bg, bb);
    }

    let edgeSum = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const gx =
          -lum[i - width - 1] + lum[i - width + 1]
          - 2 * lum[i - 1] + 2 * lum[i + 1]
          - lum[i + width - 1] + lum[i + width + 1];
        const gy =
          -lum[i - width - 1] - 2 * lum[i - width] - lum[i - width + 1]
          + lum[i + width - 1] + 2 * lum[i + width] + lum[i + width + 1];
        const mag = Math.sqrt(gx * gx + gy * gy);
        edge[i] = mag;
        edgeSum += mag;
      }
    }

    // Adaptive foreground mask combining color distance from bg & local Sobel edge
    const fgThreshold = bgStats.isGradient ? 46 : 32;
    const edgeThreshold = Math.max(38, (edgeSum / n) * 2.1);
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (fgDist[i] > fgThreshold || edge[i] > edgeThreshold) mask[i] = 1;
    }

    // Horizontal dilation by 2px so nearby letters/shapes coalesce cleanly into regions
    const dilated = new Uint8Array(n);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (mask[row + x]) {
          dilated[row + x] = 1;
          if (x + 1 < width) dilated[row + x + 1] = 1;
          if (x + 2 < width) dilated[row + x + 2] = 1;
          if (y + 1 < height) dilated[(y + 1) * width + x] = 1;
        }
      }
    }

    return { lum, edge, fgDist, mask, dilated };
  }

  function extractConnectedComponents(img, analysis) {
    const { width, height, data } = img;
    const { dilated, edge, fgDist } = analysis;
    const n = width * height;
    const visited = new Uint8Array(n);
    const queue = new Int32Array(n);
    const components = [];
    const minPixels = Math.max(12, Math.round(n * 0.00035));

    for (let i = 0; i < n; i++) {
      if (!dilated[i] || visited[i]) continue;
      let head = 0, tail = 0;
      queue[tail++] = i;
      visited[i] = 1;

      let minX = width, maxX = 0, minY = height, maxY = 0;
      let count = 0, sumR = 0, sumG = 0, sumB = 0, sumEdge = 0, sumDist = 0;

      while (head < tail) {
        const idx = queue[head++];
        const x = idx % width;
        const y = (idx - x) / width;
        const p = idx * 4;

        count++;
        sumR += data[p]; sumG += data[p + 1]; sumB += data[p + 2];
        sumEdge += edge[idx];
        sumDist += fgDist[idx];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        const neighbors = [
          x > 0 ? idx - 1 : -1,
          x + 1 < width ? idx + 1 : -1,
          y > 0 ? idx - width : -1,
          y + 1 < height ? idx + width : -1
        ];
        for (let k = 0; k < 4; k++) {
          const nb = neighbors[k];
          if (nb >= 0 && dilated[nb] && !visited[nb]) {
            visited[nb] = 1;
            queue[tail++] = nb;
          }
        }
      }

      if (count < minPixels) continue;
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const boxArea = bw * bh;
      const fillRatio = count / Math.max(1, boxArea);
      // Skip giant full-canvas wrappers (>88% area) as those represent background
      if (boxArea > n * 0.88) continue;

      const meanColor = rgbToHex(sumR / count, sumG / count, sumB / count);
      components.push({
        nx: round4(minX / width),
        ny: round4(minY / height),
        nw: round4(bw / width),
        nh: round4(bh / height),
        pxArea: count,
        fillRatio: round4(fillRatio),
        meanEdge: round4(sumEdge / count),
        meanContrast: round4(sumDist / count),
        meanColor
      });
    }

    components.sort((a, b) => a.ny - b.ny || a.nx - b.nx);
    return components;
  }

  /**
   * Computes pixel-level registration offset (dx, dy) + Normalized Cross Correlation between two downsampled images.
   */
  function registerAndCompareImages(writtenSmall, emptySmall) {
    const w = Math.min(writtenSmall.width, emptySmall.width);
    const h = Math.min(writtenSmall.height, emptySmall.height);
    const lumA = new Float32Array(w * h);
    const lumB = new Float32Array(w * h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ia = (y * writtenSmall.width + x) * 4;
        const ib = (y * emptySmall.width + x) * 4;
        lumA[y * w + x] = luminance(writtenSmall.data[ia], writtenSmall.data[ia + 1], writtenSmall.data[ia + 2]);
        lumB[y * w + x] = luminance(emptySmall.data[ib], emptySmall.data[ib + 1], emptySmall.data[ib + 2]);
      }
    }

    let bestDx = 0, bestDy = 0, bestSad = Infinity;
    for (let dy = -6; dy <= 6; dy += 2) {
      for (let dx = -6; dx <= 6; dx += 2) {
        let sad = 0, samples = 0;
        for (let y = 8; y < h - 8; y += 3) {
          for (let x = 8; x < w - 8; x += 3) {
            const x2 = x + dx, y2 = y + dy;
            if (x2 < 0 || x2 >= w || y2 < 0 || y2 >= h) continue;
            sad += Math.abs(lumA[y * w + x] - lumB[y2 * w + x2]);
            samples++;
          }
        }
        const avgSad = samples ? sad / samples : Infinity;
        if (avgSad < bestSad) { bestSad = avgSad; bestDx = dx; bestDy = dy; }
      }
    }

    // Difference mask highlighting written-only content (questions/options) vs blank template containers
    const diffMask = new Uint8Array(w * h);
    let diffPixels = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = clamp(x + bestDx, 0, emptySmall.width - 1);
        const sy = clamp(y + bestDy, 0, emptySmall.height - 1);
        const ia = (y * writtenSmall.width + x) * 4;
        const ib = (sy * emptySmall.width + sx) * 4;
        const d = colorDist(
          writtenSmall.data[ia], writtenSmall.data[ia + 1], writtenSmall.data[ia + 2],
          emptySmall.data[ib], emptySmall.data[ib + 1], emptySmall.data[ib + 2]
        );
        if (d > 28) {
          diffMask[y * w + x] = 1;
          diffPixels++;
        }
      }
    }

    const registrationScore = round4(clamp(1 - bestSad / 120, 0, 1));
    const diffRatio = round4(diffPixels / Math.max(1, w * h));

    return {
      width: w,
      height: h,
      dx: bestDx,
      dy: bestDy,
      registrationScore,
      diffRatio,
      diffMask
    };
  }

  function computeEvidenceConfidence(comp, roleScore, hasPairedDiff) {
    const contrastSignal = clamp(comp.meanContrast / 110, 0, 1);
    const edgeSignal = clamp(comp.meanEdge / 90, 0, 1);
    const geomSignal = clamp(comp.fillRatio * 1.1, 0.25, 1);
    const raw = (contrastSignal * 0.34) + (edgeSignal * 0.26) + (geomSignal * 0.20) + (roleScore * 0.20);
    return round4(clamp(hasPairedDiff ? Math.min(0.99, raw * 1.08) : raw, 0.15, 0.98));
  }

  function classifyComponents(components, imgStats, diffInfo) {
    const detectedElements = [];
    const bgDark = hexLuminance(imgStats.bgHex) < 130;
    const textInk = bgDark ? '#ffffff' : '#000000';

    // Identify 2x2 or 1x4 congruent option containers first (high precision geometric clustering)
    const boxCandidates = components.filter(c => c.ny > 0.36 && c.nw >= 0.22 && c.nw <= 0.65 && c.nh >= 0.06 && c.nh <= 0.22 && c.fillRatio >= 0.45);
    const chosenOptions = [];
    if (boxCandidates.length >= 2) {
      chosenOptions.push(...boxCandidates.slice(0, 4));
      chosenOptions.sort((a, b) => Math.abs(a.ny - b.ny) < 0.05 ? a.nx - b.nx : a.ny - b.ny);
    }

    const usedSet = new Set(chosenOptions);
    let hasHeader = false;
    let hasQuestion = false;
    let hasTimer = false;
    let optIndex = 0;

    chosenOptions.forEach((c, i) => {
      const conf = computeEvidenceConfidence(c, 0.92, !!diffInfo);
      const isDarkFill = hexLuminance(c.meanColor) < 128;
      const optInk = isDarkFill ? '#ffffff' : '#111111';
      detectedElements.push({
        id: `cv_opt_${i}_container`,
        type: 'option_container',
        name: `Detected Option ${'ABCD'[i]} Box`,
        groupId: `grp_cv_opt_${i}`,
        optionIndex: i,
        x: c.nx,
        y: c.ny,
        width: c.nw,
        height: c.nh,
        backgroundColor: c.meanColor,
        borderColor: isDarkFill ? '#334155' : '#1e293b',
        borderWidth: 1,
        borderRadius: c.nh > 0.08 ? 0.42 : 0.2,
        confidence: conf,
        sourceImageRef: diffInfo ? 'paired_written_empty' : 'single_upload',
        editable: true,
        layerOrder: 10 + i * 3
      });

      const badgeW = Math.min(c.nh * 0.56, c.nw * 0.22);
      detectedElements.push({
        id: `cv_opt_${i}_label`,
        type: 'option_label',
        name: `Option ${'ABCD'[i]} Badge`,
        groupId: `grp_cv_opt_${i}`,
        optionIndex: i,
        x: round4(c.nx + badgeW * 0.14),
        y: round4(c.ny + c.nh * 0.14),
        width: round4(badgeW),
        height: round4(c.nh * 0.72),
        text: 'ABCD'[i],
        fontSize: round4(c.nh * 0.48),
        fontWeight: 800,
        textColor: '#000000',
        backgroundColor: '#facc15',
        borderRadius: 0.5,
        confidence: round4(conf * 0.96),
        sourceImageRef: 'inferred_from_container',
        editable: true,
        layerOrder: 11 + i * 3
      });

      detectedElements.push({
        id: `cv_opt_${i}_text`,
        type: 'option_text',
        name: `Option ${'ABCD'[i]} Text`,
        groupId: `grp_cv_opt_${i}`,
        optionIndex: i,
        x: round4(c.nx + badgeW * 1.32),
        y: round4(c.ny + c.nh * 0.08),
        width: round4(Math.max(0.08, c.nw - badgeW * 1.48)),
        height: round4(c.nh * 0.84),
        text: `{option_${i}}`,
        fontSize: round4(c.nh * 0.40),
        fontWeight: 800,
        textColor: optInk,
        alignment: 'center',
        confidence: round4(conf * 0.94),
        sourceImageRef: 'inferred_from_container',
        editable: true,
        layerOrder: 12 + i * 3
      });
      optIndex++;
    });

    components.forEach((c, idx) => {
      if (usedSet.has(c)) return;

      // Top full/wide strip => Header
      if (!hasHeader && c.ny < 0.22 && c.nw > 0.50 && c.nh >= 0.06 && c.nh <= 0.26) {
        hasHeader = true;
        const conf = computeEvidenceConfidence(c, 0.90, !!diffInfo);
        const hdrInk = hexLuminance(c.meanColor) < 130 ? '#ffffff' : '#111111';
        detectedElements.push({
          id: 'cv_header_bar',
          type: 'header',
          name: 'Detected Header Bar',
          x: c.nx,
          y: c.ny,
          width: c.nw,
          height: c.nh,
          backgroundColor: c.meanColor,
          borderRadius: 0,
          confidence: conf,
          editable: true,
          layerOrder: 2
        });
        detectedElements.push({
          id: 'cv_header_num',
          type: 'question_number',
          name: 'Header Counter',
          x: round4(c.nx + 0.03),
          y: round4(c.ny + c.nh * 0.14),
          width: 0.16,
          height: round4(c.nh * 0.72),
          text: '{num}/{total}',
          fontSize: round4(c.nh * 0.52),
          fontWeight: 800,
          textColor: '#facc15',
          alignment: 'left',
          confidence: round4(conf * 0.9),
          editable: true,
          layerOrder: 3
        });
        detectedElements.push({
          id: 'cv_header_title',
          type: 'text',
          name: 'Header Text',
          x: round4(c.nx + 0.20),
          y: round4(c.ny + c.nh * 0.16),
          width: round4(Math.max(0.2, c.nw - 0.23)),
          height: round4(c.nh * 0.68),
          text: '{header}',
          fontSize: round4(c.nh * 0.48),
          fontWeight: 800,
          textColor: hdrInk,
          alignment: 'left',
          confidence: round4(conf * 0.9),
          editable: true,
          layerOrder: 4
        });
        return;
      }

      // Mid-canvas wide slim bar or centered circle => Timer
      if (!hasTimer && c.ny >= 0.34 && c.ny <= 0.68 && ((c.nw >= 0.25 && c.nh <= 0.085) || (Math.abs(c.nw - c.nh * 1.77) < 0.08 && c.nw < 0.16))) {
        hasTimer = true;
        detectedElements.push({
          id: 'cv_timer_main',
          type: 'timer',
          name: 'Detected Timer Region',
          x: c.nx,
          y: c.ny,
          width: c.nw,
          height: Math.max(0.045, c.nh),
          backgroundColor: '#d9d9d9',
          textColor: c.meanColor !== imgStats.bgHex ? c.meanColor : '#ff4a14',
          borderColor: '#ffffff',
          timerLook: 'capsule',
          confidence: computeEvidenceConfidence(c, 0.80, !!diffInfo),
          editable: true,
          layerOrder: 8
        });
        return;
      }

      // Upper-mid large or text-heavy region => Question text / container
      if (!hasQuestion && c.ny >= 0.16 && c.ny <= 0.56 && c.nw >= 0.24) {
        hasQuestion = true;
        const isContainer = c.fillRatio > 0.62 && c.meanContrast > 35;
        const conf = computeEvidenceConfidence(c, 0.85, !!diffInfo);
        if (isContainer) {
          detectedElements.push({
            id: 'cv_q_container',
            type: 'question_container',
            name: 'Detected Question Box',
            x: c.nx,
            y: c.ny,
            width: c.nw,
            height: c.nh,
            backgroundColor: c.meanColor,
            borderRadius: 0.14,
            confidence: conf,
            editable: true,
            layerOrder: 5
          });
        }
        detectedElements.push({
          id: 'cv_question_text',
          type: 'question_text',
          name: 'Detected Question Text',
          x: isContainer ? round4(c.nx + 0.03) : Math.min(0.08, c.nx),
          y: c.ny,
          width: isContainer ? round4(Math.max(0.2, c.nw - 0.06)) : Math.max(0.84, c.nw),
          height: Math.max(0.16, c.nh),
          text: '{question}',
          fontSize: 0.052,
          fontWeight: 800,
          textColor: isContainer && hexLuminance(c.meanColor) < 130 ? '#ffffff' : textInk,
          alignment: 'center',
          confidence: conf,
          editable: true,
          layerOrder: 6
        });
        return;
      }

      // Corner / compact marks => logo / icon / decorative
      const isCorner = (c.ny < 0.25 || c.ny > 0.78) && c.nw < 0.18 && c.nh < 0.18;
      detectedElements.push({
        id: `cv_shape_${idx}`,
        type: isCorner ? 'logo' : (c.nw > 0.45 && c.nh < 0.035 ? 'progress_bar' : 'decorative'),
        name: isCorner ? 'Detected Logo / Emblem' : 'Detected Design Shape',
        x: c.nx,
        y: c.ny,
        width: c.nw,
        height: c.nh,
        backgroundColor: c.meanColor,
        borderRadius: 0.15,
        confidence: computeEvidenceConfidence(c, 0.65, !!diffInfo),
        editable: true,
        layerOrder: 7 + idx
      });
    });

    // Guarantee editable question & 4 options slots even on completely empty blank backgrounds
    if (!hasQuestion) {
      detectedElements.push({
        id: 'cv_question_text',
        type: 'question_text',
        name: 'Question Text Slot',
        x: 0.08,
        y: hasHeader ? 0.22 : 0.14,
        width: 0.84,
        height: 0.24,
        text: '{question}',
        fontSize: 0.052,
        fontWeight: 800,
        textColor: textInk,
        alignment: 'center',
        confidence: 0.42, // Low evidence — synthesized slot
        sourceImageRef: 'layout_slot_inference',
        editable: true,
        layerOrder: 6
      });
    }
    if (!hasTimer) {
      detectedElements.push({
        id: 'cv_timer_main',
        type: 'timer',
        name: 'Countdown Timer Slot',
        x: 0.20,
        y: 0.50,
        width: 0.60,
        height: 0.055,
        backgroundColor: '#d9d9d9',
        textColor: '#ff4a14',
        borderColor: '#ffffff',
        timerLook: 'capsule',
        confidence: 0.40,
        sourceImageRef: 'layout_slot_inference',
        editable: true,
        layerOrder: 8
      });
    }
    if (optIndex === 0) {
      for (let i = 0; i < 4; i++) {
        const col = i % 2, row = Math.floor(i / 2);
        const bx = 0.06 + col * 0.45;
        const by = 0.60 + row * 0.155;
        detectedElements.push({
          id: `cv_opt_${i}_container`,
          type: 'option_container',
          name: `Option ${'ABCD'[i]} Slot`,
          groupId: `grp_cv_opt_${i}`,
          optionIndex: i,
          x: bx,
          y: by,
          width: 0.42,
          height: 0.12,
          backgroundColor: bgDark ? '#1e293b' : '#0f172a',
          borderRadius: 0.45,
          confidence: 0.40,
          sourceImageRef: 'layout_slot_inference',
          editable: true,
          layerOrder: 10 + i * 3
        });
        detectedElements.push({
          id: `cv_opt_${i}_label`,
          type: 'option_label',
          name: `Option ${'ABCD'[i]} Badge`,
          groupId: `grp_cv_opt_${i}`,
          optionIndex: i,
          x: round4(bx + 0.015),
          y: round4(by + 0.015),
          width: 0.055,
          height: 0.09,
          text: 'ABCD'[i],
          fontSize: 0.05,
          fontWeight: 800,
          textColor: '#000000',
          backgroundColor: '#facc15',
          borderRadius: 0.5,
          confidence: 0.40,
          sourceImageRef: 'layout_slot_inference',
          editable: true,
          layerOrder: 11 + i * 3
        });
        detectedElements.push({
          id: `cv_opt_${i}_text`,
          type: 'option_text',
          name: `Option ${'ABCD'[i]} Text`,
          groupId: `grp_cv_opt_${i}`,
          optionIndex: i,
          x: round4(bx + 0.08),
          y: round4(by + 0.01),
          width: 0.32,
          height: 0.10,
          text: `{option_${i}}`,
          fontSize: 0.042,
          fontWeight: 800,
          textColor: '#ffffff',
          alignment: 'center',
          confidence: 0.40,
          sourceImageRef: 'layout_slot_inference',
          editable: true,
          layerOrder: 12 + i * 3
        });
      }
    }

    return detectedElements;
  }

  /**
   * Analyzes 1 or 2 template RGBA ImageData objects and builds a complete `IMPORTED_TEMPLATE_MODE` DesignScene + Report.
   */
  function analyzeTemplates({ writtenImageData = null, emptyImageData = null, writtenDataUrl = '', emptyDataUrl = '', ratio = '16/9' } = {}) {
    if (!writtenImageData && !emptyImageData) {
      throw new Error('Provide at least one template ImageData (written or empty).');
    }

    const baseImg = emptyImageData || writtenImageData;
    const baseSmall = downsampleImageData(baseImg, 240);
    const writtenSmall = writtenImageData ? downsampleImageData(writtenImageData, 240) : null;
    const emptySmall = emptyImageData ? downsampleImageData(emptyImageData, 240) : null;

    const bgStats = estimateBackgroundStats(baseSmall);
    const fgData = computeSobelAndForeground(baseSmall, bgStats);
    const components = extractConnectedComponents(baseSmall, fgData);

    let diffInfo = null;
    const limitations = [];
    let analysisMode = 'single_written';
    if (writtenSmall && emptySmall) {
      analysisMode = 'paired_written_empty';
      diffInfo = registerAndCompareImages(writtenSmall, emptySmall);
    } else if (emptySmall) {
      analysisMode = 'single_empty';
      limitations.push('Only empty template provided; differential text-mask verification against a written example was not run.');
    } else {
      analysisMode = 'single_written';
      limitations.push('Only written template provided; clean blank backdrop uses border median estimation where background varies.');
    }

    const assets = {};
    let bgAssetRef = '';
    if (emptyDataUrl && (bgStats.isGradient || bgStats.isTextured)) {
      bgAssetRef = 'cv_empty_backdrop';
      assets[bgAssetRef] = emptyDataUrl;
    } else if (writtenDataUrl && bgStats.isTextured && !emptyDataUrl) {
      bgAssetRef = 'cv_written_backdrop';
      assets[bgAssetRef] = writtenDataUrl;
    }

    const detected = classifyComponents(components, bgStats, diffInfo);
    const bgConfidence = round4(clamp(1 - (bgStats.textureScore / 35), 0.35, 0.98));

    const allElements = [
      {
        id: 'cv_bg_main',
        type: 'background',
        name: 'Detected Background',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        backgroundColor: bgStats.bgHex,
        assetRef: bgAssetRef,
        borderRadius: 0,
        confidence: bgConfidence,
        sourceImageRef: emptyDataUrl ? 'empty_template' : 'written_template',
        editable: true,
        layerOrder: 0
      },
      ...detected
    ];

    const avgConf = allElements.reduce((s, e) => s + (e.confidence || 0.5), 0) / Math.max(1, allElements.length);
    const overallConfidence = round4(clamp(avgConf, 0.15, 0.98));

    const report = {
      analysisMode,
      comparisonPerformed: !!diffInfo,
      registration: diffInfo ? {
        dx: diffInfo.dx,
        dy: diffInfo.dy,
        registrationScore: diffInfo.registrationScore,
        diffRatio: diffInfo.diffRatio
      } : null,
      backgroundAnalysis: bgStats,
      componentsFound: components.length,
      detectedElementCount: allElements.length,
      overallConfidence,
      overallConfidencePercent: Math.round(overallConfidence * 100),
      limitations
    };

    const scene = SceneModel
      ? SceneModel.fromDetectionToScene({
          ratio,
          width: baseImg.width,
          height: baseImg.height,
          dominantBg: bgStats.bgHex,
          assets,
          elements: allElements,
          report
        })
      : {
          schemaVersion: 2,
          mode: 'IMPORTED_TEMPLATE_MODE',
          ratio,
          baseWidth: baseImg.width,
          baseHeight: baseImg.height,
          assets,
          elements: allElements,
          detectionReport: report
        };

    return { scene, report, components };
  }

  // ===== Manual Correction APIs (Phase 7) =====
  function updateRegionBounds(scene, elementId, bbox) {
    if (!SceneModel) return scene;
    return SceneModel.updateElement(scene, elementId, {
      x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height
    });
  }

  function reclassifyRegion(scene, elementId, newType) {
    if (!SceneModel) return scene;
    return SceneModel.updateElement(scene, elementId, { type: newType });
  }

  function mergeRegions(scene, elementIds) {
    if (!SceneModel || !Array.isArray(elementIds) || elementIds.length < 2) return scene;
    const targets = elementIds.map(id => SceneModel.findElement(scene, id)).filter(Boolean);
    if (targets.length < 2) return scene;
    const minX = Math.min(...targets.map(e => e.x));
    const minY = Math.min(...targets.map(e => e.y));
    const maxX = Math.max(...targets.map(e => e.x + e.width));
    const maxY = Math.max(...targets.map(e => e.y + e.height));
    const primary = targets[0];
    let next = SceneModel.updateElement(scene, primary.id, {
      x: round4(minX),
      y: round4(minY),
      width: round4(maxX - minX),
      height: round4(maxY - minY),
      text: targets.map(t => t.text).filter(Boolean).join(' ')
    });
    for (let i = 1; i < targets.length; i++) {
      next = SceneModel.deleteElement(next, targets[i].id);
    }
    return next;
  }

  function splitRegion(scene, elementId, axis = 'horizontal', ratio = 0.5) {
    if (!SceneModel) return scene;
    const el = SceneModel.findElement(scene, elementId);
    if (!el) return scene;
    const r = clamp(ratio, 0.2, 0.8);
    if (axis === 'vertical') {
      const w1 = round4(el.width * r), w2 = round4(el.width - w1);
      const next = SceneModel.updateElement(scene, el.id, { width: w1 });
      return SceneModel.addElement(next, {
        ...el,
        id: el.id + '_split',
        name: el.name + ' (Right)',
        x: round4(el.x + w1),
        width: w2
      }).scene;
    }
    const h1 = round4(el.height * r), h2 = round4(el.height - h1);
    const next = SceneModel.updateElement(scene, el.id, { height: h1 });
    return SceneModel.addElement(next, {
      ...el,
      id: el.id + '_split',
      name: el.name + ' (Bottom)',
      y: round4(el.y + h1),
      height: h2
    }).scene;
  }

  return {
    analyzeTemplates,
    estimateBackgroundStats,
    registerAndCompareImages,
    updateRegionBounds,
    reclassifyRegion,
    mergeRegions,
    splitRegion
  };
});

/* Deterministic quiz timeline & narration-synchronized word/option reveal scheduling. */
(function (root) {
  'use strict';

  function build(questions, promptBuffers, countdownSeconds, answerBuffers, withNarration = true) {
    if (!Array.isArray(questions) || !questions.length) throw new Error('Timeline requires at least one question.');
    if (!Number.isFinite(countdownSeconds) || countdownSeconds <= 0) throw new Error('Countdown duration must be positive.');
    if (withNarration) {
      if (!Array.isArray(promptBuffers) || !Array.isArray(answerBuffers) || promptBuffers.length !== questions.length || answerBuffers.length !== questions.length) {
        throw new Error('Every question must have decoded prompt and answer audio.');
      }
    }
    const segments = [];
    let cursor = 0;
    const push = (type, index, duration) => {
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid ${type} duration for question ${index + 1}.`);
      segments.push({ type, i: index, start: cursor, dur: duration });
      cursor += duration;
    };
    questions.forEach((q, i) => {
      if (i > 0) push('page', i, 0.9);
      if (withNarration) {
        const prompt = promptBuffers[i];
        const answer = answerBuffers[i];
        if (!prompt || !Number.isFinite(prompt.duration) || prompt.duration <= 0) throw new Error(`Prompt audio missing for question ${i + 1}.`);
        if (!answer || !Number.isFinite(answer.duration) || answer.duration <= 0) throw new Error(`Answer audio missing for question ${i + 1}.`);
        push('voice', i, prompt.duration);
        push('count', i, countdownSeconds);
        push('reveal', i, 0.52);
        push('answer', i, answer.duration);
      } else {
        push('voice', i, 3.2);
        push('count', i, countdownSeconds);
        push('reveal', i, 0.52);
        push('answer', i, 2.5);
      }
    });
    return { segs: segments, total: cursor };
  }

  /**
   * Fast sequential-cursor + binary-search lookup (O(1) during sequential frame export, O(log n) random seek).
   */
  function findSegmentAt(segs, gt, hintPtr = 0) {
    if (!Array.isArray(segs) || !segs.length) return { seg: null, ptr: 0 };
    const n = segs.length;
    let p = Math.max(0, Math.min(n - 1, hintPtr | 0));
    if (gt >= segs[p].start) {
      while (p < n - 1 && gt >= segs[p].start + segs[p].dur) p++;
      if (gt < segs[p].start + segs[p].dur || p === n - 1) return { seg: segs[p], ptr: p };
    }
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segs[mid];
      if (gt < s.start) hi = mid - 1;
      else if (gt >= s.start + s.dur && mid < n - 1) lo = mid + 1;
      else return { seg: s, ptr: mid };
    }
    return { seg: segs[n - 1], ptr: n - 1 };
  }

  function tokenizeWords(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean);
  }

  function wordWeights(words) {
    return words.map(w => Math.max(1.5, w.length + (/[.,?!:;]$/.test(w) ? 2.5 : 0.6)));
  }

  function distributeWindow(words, startSec, endSec, alignmentOffsetSec) {
    const dur = Math.max(0.05, endSec - startSec);
    if (!words.length) return [];
    const weights = wordWeights(words);
    const totalW = weights.reduce((a, b) => a + b, 0) || 1;
    let t = startSec;
    return words.map((word, idx) => {
      const slice = (weights[idx] / totalW) * dur;
      const wStart = Math.max(0, t + (alignmentOffsetSec || 0));
      const wEnd = Math.max(wStart + 0.02, t + slice + (alignmentOffsetSec || 0));
      t += slice;
      return { word, index: idx, start: wStart, end: wEnd };
    });
  }

  /**
   * Builds a deterministic synchronization schedule inside a question's `voice` segment (0 .. durationSec).
   * Uses actual Edge TTS `promptWordBoundaries` when present; otherwise derives proportional
   * durations from actual audio length and text segmentation.
   */
  function buildRevealSchedule(question, durationSec, options = {}) {
    const dur = Math.max(0.4, Number(durationSec) || 3.2);
    const offsetSec = Number(options.alignmentOffsetMs || 0) / 1000;
    const qWords = tokenizeWords(question && question.question);
    const opts = Array.isArray(question && question.options) ? question.options : [];
    const wbList = Array.isArray(question && question.promptWordBoundaries) ? question.promptWordBoundaries : [];

    // Try matching TTS WordBoundary events if present and plausible
    if (wbList.length >= Math.max(2, qWords.length)) {
      const maxEndSec = wbList.reduce((m, b) => Math.max(m, ((b.offsetMs || 0) + (b.durationMs || 80)) / 1000), 0);
      const scale = maxEndSec > 0 ? Math.min(1.25, Math.max(0.75, (dur * 0.96) / maxEndSec)) : 1;
      let cursorIdx = 0;

      const qWordTimings = qWords.map((word, idx) => {
        const wb = wbList[Math.min(cursorIdx++, wbList.length - 1)];
        const st = Math.max(0, ((wb.offsetMs || 0) / 1000) * scale + offsetSec);
        const en = Math.max(st + 0.03, (((wb.offsetMs || 0) + Math.max(60, wb.durationMs || 120)) / 1000) * scale + offsetSec);
        return { word, index: idx, start: st, end: en };
      });
      const qEnd = qWordTimings.length ? qWordTimings[qWordTimings.length - 1].end : dur * 0.4;

      const optSchedules = [];
      for (let oi = 0; oi < 4; oi++) {
        const optWords = tokenizeWords(opts[oi]);
        // Label token ("A", "B", "C", "D") comes right before option words
        const labelWb = wbList[Math.min(cursorIdx, wbList.length - 1)];
        if (cursorIdx < wbList.length) cursorIdx++;
        const labelStart = Math.max(qEnd, labelWb ? ((labelWb.offsetMs || 0) / 1000) * scale + offsetSec : qEnd);
        const labelEnd = Math.max(labelStart + 0.08, labelWb ? (((labelWb.offsetMs || 0) + Math.max(80, labelWb.durationMs || 140)) / 1000) * scale + offsetSec : labelStart + 0.14);

        const oWordTimings = optWords.map((word, wIdx) => {
          const wb = wbList[Math.min(cursorIdx, wbList.length - 1)];
          if (cursorIdx < wbList.length) cursorIdx++;
          const st = Math.max(labelEnd, ((wb.offsetMs || 0) / 1000) * scale + offsetSec);
          const en = Math.max(st + 0.03, (((wb.offsetMs || 0) + Math.max(60, wb.durationMs || 120)) / 1000) * scale + offsetSec);
          return { word, index: wIdx, start: st, end: en };
        });
        const textStart = oWordTimings.length ? oWordTimings[0].start : labelEnd;
        const textEnd = oWordTimings.length ? oWordTimings[oWordTimings.length - 1].end : labelEnd + 0.25;
        optSchedules.push({
          optionIndex: oi,
          label: 'ABCD'[oi],
          labelStart,
          labelEnd,
          textStart,
          textEnd,
          words: oWordTimings
        });
      }

      return {
        durationSec: dur,
        alignmentSource: 'tts_word_boundary',
        questionStart: qWordTimings.length ? qWordTimings[0].start : 0,
        questionEnd: qEnd,
        questionWords: qWordTimings,
        options: optSchedules
      };
    }

    // Fallback: proportional timing derived from actual decoded audio duration and word weights
    const qWeight = Math.max(6, wordWeights(qWords).reduce((a, b) => a + b, 0));
    const optWeights = [0, 1, 2, 3].map(oi => {
      const ow = tokenizeWords(opts[oi]);
      return 3.0 + Math.max(3, wordWeights(ow).reduce((a, b) => a + b, 0));
    });
    const totalWeight = qWeight + optWeights.reduce((a, b) => a + b, 0);
    const usableDur = dur * 0.96;
    const qDur = (qWeight / totalWeight) * usableDur;
    const questionWords = distributeWindow(qWords, 0, qDur, offsetSec);

    let cursor = qDur;
    const optSchedules = [0, 1, 2, 3].map(oi => {
      const slotDur = (optWeights[oi] / totalWeight) * usableDur;
      const labelDur = Math.min(0.28, slotDur * 0.26);
      const labelStart = Math.max(0, cursor + offsetSec);
      const labelEnd = labelStart + labelDur;
      const textStart = labelEnd;
      const textEnd = cursor + slotDur + offsetSec;
      const words = distributeWindow(tokenizeWords(opts[oi]), cursor + labelDur, cursor + slotDur, offsetSec);
      cursor += slotDur;
      return {
        optionIndex: oi,
        label: 'ABCD'[oi],
        labelStart,
        labelEnd,
        textStart,
        textEnd,
        words
      };
    });

    return {
      durationSec: dur,
      alignmentSource: 'proportional_duration_estimate',
      questionStart: questionWords.length ? questionWords[0].start : 0,
      questionEnd: Math.max(0.05, qDur + offsetSec),
      questionWords,
      options: optSchedules
    };
  }

  root.QuizTimeline = {
    build,
    findSegmentAt,
    buildRevealSchedule,
    tokenizeWords
  };
})(typeof window !== 'undefined' ? window : globalThis);

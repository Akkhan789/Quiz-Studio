/* Deterministic quiz timeline. All durations come from decoded audio or explicit settings. */
(function (root) {
  'use strict';
  function build(questions, promptBuffers, countdownSeconds, answerBuffers) {
    if (!Array.isArray(questions) || !questions.length) throw new Error('Timeline requires at least one question.');
    if (!Array.isArray(promptBuffers) || !Array.isArray(answerBuffers) || promptBuffers.length !== questions.length || answerBuffers.length !== questions.length) throw new Error('Every question must have decoded prompt and answer audio.');
    if (!Number.isFinite(countdownSeconds) || countdownSeconds <= 0) throw new Error('Countdown duration must be positive.');
    const segments = []; let cursor = 0;
    const push = (type, index, duration) => {
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid ${type} duration for question ${index + 1}.`);
      segments.push({ type, i: index, start: cursor, dur: duration }); cursor += duration;
    };
    questions.forEach((q, i) => {
      const prompt = promptBuffers[i], answer = answerBuffers[i];
      if (!prompt || !Number.isFinite(prompt.duration) || prompt.duration <= 0) throw new Error(`Prompt audio missing for question ${i + 1}.`);
      if (!answer || !Number.isFinite(answer.duration) || answer.duration <= 0) throw new Error(`Answer audio missing for question ${i + 1}.`);
      if (i > 0) push('page', i, 0.9);
      push('voice', i, prompt.duration);
      push('count', i, countdownSeconds);
      push('reveal', i, 0.52);
      push('answer', i, answer.duration);
    });
    return { segs: segments, total: cursor };
  }
  root.QuizTimeline = { build };
})(window);

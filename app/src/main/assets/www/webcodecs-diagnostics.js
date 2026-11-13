/* Phase 3: WebCodecs Hardware Verification, Controlled Micro-Benchmark & Event-Driven Adaptive Backpressure */
(function (root) {
  'use strict';

  const CODEC_CANDIDATES = ['avc1.640028', 'avc1.4d401f', 'avc1.42e01f'];
  const AUDIO_CANDIDATES = ['mp4a.40.2', 'opus'];
  const HW_PREFS = ['prefer-hardware', 'prefer-software', 'no-preference'];

  function readMemorySnapshot() {
    const perf = root.performance || {};
    const mem = perf.memory;
    if (!mem || !Number.isFinite(mem.usedJSHeapSize)) {
      return { available: false, usedBytes: null, totalBytes: null, limitBytes: null, pressureRatio: null };
    }
    const ratio = mem.jsHeapSizeLimit > 0 ? mem.usedJSHeapSize / mem.jsHeapSizeLimit : 0;
    return {
      available: true,
      usedBytes: mem.usedJSHeapSize,
      totalBytes: mem.totalJSHeapSize,
      limitBytes: mem.jsHeapSizeLimit,
      pressureRatio: Math.round(ratio * 1000) / 1000
    };
  }

  /**
   * Probes VideoEncoder/AudioEncoder support across all hardwareAcceleration preferences.
   * Never invents hardware/software status: WebCodecs spec does not expose underlying driver/codec
   * implementation name, so actual HW/SW status is marked "UNVERIFIED" unless externally measured.
   */
  async function probeCapabilities(width, height, fps, bitrate) {
    const w = Math.max(2, (width | 0) & ~1);
    const h = Math.max(2, (height | 0) & ~1);
    const rate = Number.isFinite(fps) && fps > 0 ? fps : 24;
    const targetBitrate = Number.isFinite(bitrate) && bitrate > 0 ? bitrate : (w >= 1920 ? 10_000_000 : 6_000_000);

    const report = {
      webCodecsAvailable: typeof root.VideoEncoder === 'function' && typeof root.AudioEncoder === 'function',
      muxerAvailable: !!(root.Mp4Muxer && root.Mp4Muxer.Muxer),
      browserExposesUnderlyingCodecName: false,
      hardwareVerificationStatus: 'UNVERIFIED',
      note: 'W3C WebCodecs isConfigSupported() reports requested config compatibility, not actual silicon vs software encoder execution.',
      videoProbes: [],
      audioProbes: [],
      recommendedVideo: null,
      recommendedAudio: null
    };

    if (!report.webCodecsAvailable) {
      return report;
    }

    for (const hwPref of HW_PREFS) {
      for (const vc of CODEC_CANDIDATES) {
        const cfg = {
          codec: vc,
          width: w,
          height: h,
          bitrate: targetBitrate,
          framerate: rate,
          hardwareAcceleration: hwPref,
          avc: { format: 'avc' }
        };
        try {
          const res = await root.VideoEncoder.isConfigSupported(cfg);
          const exposedFields = res && typeof res === 'object' ? Object.keys(res) : [];
          report.videoProbes.push({
            codec: vc,
            hardwareAcceleration: hwPref,
            supported: !!(res && res.supported),
            exposedFields,
            returnedConfig: res && res.config ? { ...res.config } : null,
            actualImplExposed: false,
            hardwareStatus: 'UNVERIFIED'
          });
        } catch (err) {
          report.videoProbes.push({
            codec: vc,
            hardwareAcceleration: hwPref,
            supported: false,
            error: err && err.message ? err.message : String(err),
            actualImplExposed: false,
            hardwareStatus: 'UNVERIFIED'
          });
        }
      }
    }

    for (const ac of AUDIO_CANDIDATES) {
      try {
        const res = await root.AudioEncoder.isConfigSupported({
          codec: ac,
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: 192000
        });
        report.audioProbes.push({
          codec: ac,
          supported: !!(res && res.supported),
          returnedConfig: res && res.config ? { ...res.config } : null
        });
      } catch (err) {
        report.audioProbes.push({
          codec: ac,
          supported: false,
          error: err && err.message ? err.message : String(err)
        });
      }
    }

    report.recommendedVideo =
      report.videoProbes.find(p => p.supported && p.hardwareAcceleration === 'prefer-hardware') ||
      report.videoProbes.find(p => p.supported && p.hardwareAcceleration === 'no-preference') ||
      report.videoProbes.find(p => p.supported && p.hardwareAcceleration === 'prefer-software') ||
      null;

    report.recommendedAudio = report.audioProbes.find(p => p.supported) || null;
    return report;
  }

  /**
   * Controlled comparative micro-benchmark using identical synthetic frames across
   * prefer-hardware, prefer-software, and no-preference.
   */
  async function runComparativeBenchmark(opts = {}) {
    const width = opts.width || 1280;
    const height = opts.height || 720;
    const fps = opts.fps || 24;
    const frameCount = Math.max(12, Math.min(120, opts.frameCount || 24));
    const bitrate = opts.bitrate || 6_000_000;

    if (typeof root.VideoEncoder !== 'function' || typeof root.VideoFrame !== 'function') {
      return { ok: false, reason: 'WebCodecs VideoEncoder/VideoFrame API unavailable in this environment.', results: [] };
    }

    const canvas = root.document && root.document.createElement ? root.document.createElement('canvas') : null;
    if (!canvas) {
      return { ok: false, reason: 'HTMLCanvasElement unavailable for frame generation.', results: [] };
    }
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const probe = await probeCapabilities(width, height, fps, bitrate);
    const codec = (probe.recommendedVideo && probe.recommendedVideo.codec) || 'avc1.42e01f';
    const results = [];

    for (const hwPref of HW_PREFS) {
      const supportedProbe = probe.videoProbes.find(p => p.codec === codec && p.hardwareAcceleration === hwPref && p.supported);
      if (!supportedProbe) {
        results.push({
          hardwareAcceleration: hwPref,
          codec,
          supported: false,
          hardwareStatus: 'UNSUPPORTED'
        });
        continue;
      }

      let chunksCount = 0;
      let totalOutputBytes = 0;
      let encodeError = null;
      let peakMemBytes = readMemorySnapshot().usedBytes || 0;
      const startMs = performance.now();

      const encoder = new root.VideoEncoder({
        output(chunk) {
          chunksCount++;
          totalOutputBytes += chunk.byteLength || 0;
        },
        error(e) {
          encodeError = e;
        }
      });

      const queueCtrl = createAdaptiveQueue(encoder, { initialLimit: 4, minLimit: 2, maxLimit: 8 });
      try {
        encoder.configure({
          codec,
          width,
          height,
          bitrate,
          framerate: fps,
          hardwareAcceleration: hwPref,
          avc: { format: 'avc' }
        });

        for (let f = 0; f < frameCount; f++) {
          if (encodeError) throw encodeError;
          // Deterministic moving graphic so bitrate/quality reflects real motion
          ctx.fillStyle = '#111827';
          ctx.fillRect(0, 0, width, height);
          ctx.fillStyle = '#ffb340';
          ctx.fillRect(((f * 37) % Math.max(64, width - 160)), Math.floor(height * 0.35), 140, 140);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 48px sans-serif';
          ctx.fillText(`BENCH ${hwPref} #${f}`, 60, 100);

          const vf = new root.VideoFrame(canvas, {
            timestamp: Math.round((f * 1e6) / fps),
            duration: Math.round(1e6 / fps)
          });
          const tEnc0 = performance.now();
          encoder.encode(vf, { keyFrame: f % fps === 0 });
          vf.close();
          queueCtrl.recordEnqueue(performance.now() - tEnc0);
          await queueCtrl.waitIfBackpressured();

          const memNow = readMemorySnapshot();
          if (memNow.usedBytes && memNow.usedBytes > peakMemBytes) peakMemBytes = memNow.usedBytes;
        }

        await encoder.flush();
        encoder.close();
        const elapsedMs = Math.max(1, performance.now() - startMs);
        const videoDurSec = frameCount / fps;
        const actualBitrate = Math.round((totalOutputBytes * 8) / videoDurSec);
        results.push({
          hardwareAcceleration: hwPref,
          hardwareStatus: 'UNVERIFIED',
          codec,
          supported: true,
          framesInput: frameCount,
          encodedChunks: chunksCount,
          droppedFrames: Math.max(0, frameCount - chunksCount),
          elapsedMs: Math.round(elapsedMs),
          throughputFps: Math.round((frameCount / (elapsedMs / 1000)) * 100) / 100,
          outputBytes: totalOutputBytes,
          actualBitrateBps: actualBitrate,
          peakHeapBytes: peakMemBytes || null,
          adaptiveQueueSummary: queueCtrl.getSummary()
        });
      } catch (err) {
        try { encoder.close(); } catch (_) {}
        results.push({
          hardwareAcceleration: hwPref,
          hardwareStatus: 'UNVERIFIED',
          codec,
          supported: true,
          error: err && err.message ? err.message : String(err)
        });
      }
    }

    const validRuns = results.filter(r => r.supported && !r.error && r.encodedChunks === frameCount);
    validRuns.sort((a, b) => b.throughputFps - a.throughputFps);
    return {
      ok: validRuns.length > 0,
      width,
      height,
      fps,
      frameCount,
      selectedFastestPreference: validRuns[0] ? validRuns[0].hardwareAcceleration : null,
      hardwareVerificationStatus: 'UNVERIFIED',
      results
    };
  }

  /**
   * Event-driven adaptive backpressure controller using `encoder.ondequeue`
   * instead of fixed `while (encodeQueueSize > 4) setTimeout(4)` polling.
   */
  function createAdaptiveQueue(encoder, options = {}) {
    const minLimit = Math.max(1, options.minLimit || 2);
    const maxLimit = Math.max(minLimit, options.maxLimit || 8);
    let currentLimit = Math.max(minLimit, Math.min(maxLimit, options.initialLimit || 4));
    let emaEncodeCallMs = 2.0;
    let totalWaits = 0;
    let totalDequeueEvents = 0;
    let peakQueueDepth = 0;
    let pendingWaiters = [];

    const flushWaiters = () => {
      if (!pendingWaiters.length) return;
      const depth = encoder && typeof encoder.encodeQueueSize === 'number' ? encoder.encodeQueueSize : 0;
      if (depth <= currentLimit) {
        const list = pendingWaiters;
        pendingWaiters = [];
        list.forEach(resolve => resolve());
      }
    };

    if (encoder) {
      const prevDequeue = encoder.ondequeue;
      encoder.ondequeue = function (ev) {
        totalDequeueEvents++;
        if (typeof prevDequeue === 'function') {
          try { prevDequeue.call(this, ev); } catch (_) {}
        }
        flushWaiters();
      };
    }

    function adaptLimit() {
      const mem = readMemorySnapshot();
      const depth = encoder && typeof encoder.encodeQueueSize === 'number' ? encoder.encodeQueueSize : 0;
      if (depth > peakQueueDepth) peakQueueDepth = depth;

      if (mem.available && mem.pressureRatio !== null && mem.pressureRatio > 0.80) {
        currentLimit = minLimit;
      } else if (emaEncodeCallMs > 18) {
        currentLimit = Math.max(minLimit, currentLimit - 1);
      } else if (emaEncodeCallMs < 4 && depth <= currentLimit - 1 && (!mem.available || (mem.pressureRatio || 0) < 0.65)) {
        currentLimit = Math.min(maxLimit, currentLimit + 1);
      }
      return currentLimit;
    }

    function recordEnqueue(callDurationMs) {
      if (Number.isFinite(callDurationMs) && callDurationMs >= 0) {
        emaEncodeCallMs = emaEncodeCallMs * 0.8 + callDurationMs * 0.2;
      }
      adaptLimit();
    }

    function waitIfBackpressured(timeoutMs = 150) {
      const depth = encoder && typeof encoder.encodeQueueSize === 'number' ? encoder.encodeQueueSize : 0;
      if (depth > peakQueueDepth) peakQueueDepth = depth;
      if (depth <= currentLimit) return Promise.resolve();
      totalWaits++;
      return new Promise(resolve => {
        let settled = false;
        const done = () => {
          if (settled) return;
          const currentDepth = encoder && typeof encoder.encodeQueueSize === 'number' ? encoder.encodeQueueSize : 0;
          if (currentDepth > currentLimit && !encoder?.closed && !encoder?.error) {
            // Queue is still backpressured; extend wait rather than prematurely releasing
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        pendingWaiters.push(done);
      });
    }

    function notifyDequeued() {
      totalDequeueEvents++;
      flushWaiters();
    }

    function getSummary() {
      return {
        currentLimit,
        minLimit,
        maxLimit,
        peakQueueDepth,
        totalWaits,
        totalDequeueEvents,
        emaEncodeCallMs: Math.round(emaEncodeCallMs * 100) / 100
      };
    }

    return {
      recordEnqueue,
      waitIfBackpressured,
      notifyDequeued,
      adaptLimit,
      getCurrentLimit: () => currentLimit,
      getSummary
    };
  }

  root.QuizWebCodecsDiagnostics = {
    probeCapabilities,
    runComparativeBenchmark,
    createAdaptiveQueue,
    readMemorySnapshot
  };
})(typeof window !== 'undefined' ? window : globalThis);

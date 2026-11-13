/* Quiz Studio Pro Direct Native Edge TTS + Zero-JPEG MediaCodec Export Bridge */
(function () {
  'use strict';
  window.__MOBILE_APP = true;
  window.__qspBinaryPort = null;

  window.addEventListener('message', function (ev) {
    if (ev && ev.data === '__QSP_BINARY_PORT__' && ev.ports && ev.ports[0]) {
      window.__qspBinaryPort = ev.ports[0];
      try { window.__qspBinaryPort.start && window.__qspBinaryPort.start(); } catch (_) {}
      if (window.onQuizLog) window.onQuizLog('Binary ArrayBuffer transport channel ready.', 'info');
    }
  });

  /**
   * Sends a binary packet over WebMessagePortCompat without Base64 or JPEG compression.
   * Magic: "PCM0" or "RGBA" (4 ASCII bytes) + Int32LE frameIndex (4 bytes) + raw payload.
   */
  function sendBinaryPacket(magic4, frameIndex, uint8Payload) {
    const port = window.__qspBinaryPort;
    if (!port) return false;
    const buf = new ArrayBuffer(8 + uint8Payload.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, magic4.charCodeAt(0));
    view.setUint8(1, magic4.charCodeAt(1));
    view.setUint8(2, magic4.charCodeAt(2));
    view.setUint8(3, magic4.charCodeAt(3));
    view.setInt32(4, frameIndex | 0, true);
    new Uint8Array(buf, 8).set(uint8Payload);
    port.postMessage(buf, [buf]);
    return true;
  }

  window.__hasBinaryChannel = function () {
    return !!window.__qspBinaryPort;
  };

  window.__sendBinaryPcm = function (pcm16Int16Array) {
    if (!window.__qspBinaryPort || !pcm16Int16Array) return false;
    const chunkSamples = 32768; // 64KB PCM packets
    const bytes = new Uint8Array(pcm16Int16Array.buffer, pcm16Int16Array.byteOffset, pcm16Int16Array.byteLength);
    for (let off = 0; off < bytes.length; off += chunkSamples * 2) {
      const slice = bytes.subarray(off, Math.min(off + chunkSamples * 2, bytes.length));
      sendBinaryPacket('PCM0', 0, slice);
    }
    return true;
  };

  window.__sendBinaryRgbaFrame = function (frameIndex, rgbaUint8ClampedArray) {
    if (!window.__qspBinaryPort || !rgbaUint8ClampedArray) return false;
    const u8 = new Uint8Array(
      rgbaUint8ClampedArray.buffer,
      rgbaUint8ClampedArray.byteOffset,
      rgbaUint8ClampedArray.byteLength
    );
    return sendBinaryPacket('RGBA', frameIndex, u8);
  };

  window.__downloadDocument = function (filename, mimeType, content, isBase64) {
    if (window.AndroidBridge && window.AndroidBridge.saveDocumentFile) {
      try {
        const raw = AndroidBridge.saveDocumentFile(filename, mimeType, content, !!isBase64);
        const res = JSON.parse(raw || '{}');
        if (res.ok) {
          if (AndroidBridge.toast) AndroidBridge.toast('Saved: ' + res.path);
          if (window.onQuizLog) window.onQuizLog('Saved file to ' + res.path, 'success');
          return { ok: true, path: res.path };
        }
        return { ok: false, error: res.error || 'Failed to save file' };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    }
    try {
      const blob = isBase64
        ? new Blob([Uint8Array.from(atob(content), c => c.charCodeAt(0))], { type: mimeType })
        : new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return { ok: true, path: filename };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  };

  window.__saveBlobToPhone = async function (blob, name) {
    if (!window.AndroidBridge || !AndroidBridge.saveBegin || !blob) return false;
    try {
      if (AndroidBridge.notifyExportStarted) AndroidBridge.notifyExportStarted('Saving video to device…');
      if (!AndroidBridge.saveBegin(name)) throw new Error('Could not create Gallery video entry');
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const chunkSize = 65536;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        let binary = '';
        for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
        if (!AndroidBridge.saveChunk(btoa(binary))) throw new Error('Writing video chunk failed');
      }
      if (!AndroidBridge.saveEnd()) throw new Error('Finalizing the video failed');
      return true;
    } catch (e) {
      try { AndroidBridge.saveFailed(String(e.message || e)); } catch (_) {}
      return true;
    }
  };

  window.onFileSaved = function (message) {
    const el = document.getElementById('exportStatus');
    if (el) el.textContent = message ? ('✓ ' + message) : '❌ Saving failed — could not save MP4 to device.';
    const details = document.getElementById('videoPreviewDetails');
    if (details && message) details.textContent = message;
    if (window.onQuizLog) window.onQuizLog(message || 'Video save failed', message ? 'success' : 'error');
  };

  window.onExportProgress = function (percent, status) {
    const el = document.getElementById('exportStatus');
    if (el) el.textContent = `[Native Encoder ${percent}%] ${status}`;
    const fill = document.getElementById('exportProgressFill');
    const pctEl = document.getElementById('exportPercent');
    const opEl = document.getElementById('exportOpStatus');
    if (fill) fill.style.width = `${percent}%`;
    if (pctEl) pctEl.textContent = `${percent}%`;
    if (opEl) opEl.textContent = status || 'Encoding…';
  };
})();

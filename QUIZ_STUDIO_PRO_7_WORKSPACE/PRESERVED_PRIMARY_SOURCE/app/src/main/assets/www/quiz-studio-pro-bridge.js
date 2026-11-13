/* Quiz Studio Pro Direct Native Edge TTS + Native MediaCodec Export Bridge */
(function () {
  'use strict';
  window.__MOBILE_APP = true;

  window.__saveBlobToPhone = function (blob, name) {
    if (!window.AndroidBridge || !blob) return false;
    try { if (!AndroidBridge.saveBegin(name)) throw new Error('Could not create a Gallery video entry'); }
    catch (e) { try { AndroidBridge.saveFailed(String(e.message || e)); } catch (_) {} return true; }
    const chunkSize = 196605;
    let offset = 0;
    const readNext = function () {
      if (offset >= blob.size) {
        try { if (!AndroidBridge.saveEnd()) throw new Error('Finalizing the video failed'); }
        catch (e) { try { AndroidBridge.saveFailed(String(e.message || e)); } catch (_) {} }
        return;
      }
      const reader = new FileReader();
      reader.onerror = function () { try { AndroidBridge.saveFailed('Could not read exported MP4'); } catch (_) {} };
      reader.onload = function () {
        try {
          const b64 = String(reader.result).split(',')[1] || '';
          if (!AndroidBridge.saveChunk(b64)) throw new Error('Writing the video failed');
          offset += Math.min(chunkSize, blob.size - offset);
          readNext();
        } catch (e) { try { AndroidBridge.saveFailed(String(e.message || e)); } catch (_) {} }
      };
      reader.readAsDataURL(blob.slice(offset, Math.min(offset + chunkSize, blob.size)));
    };
    readNext();
    return true;
  };

  window.onFileSaved = function (message) {
    const el = document.getElementById('exportStatus');
    if (el) el.textContent = message ? ('Video saved to phone (MP4) — ' + message) : '❌ Saving failed — could not save the MP4 to the phone.';
  };

  window.onExportProgress = function (percent, status) {
    const el = document.getElementById('exportStatus');
    if (el) el.textContent = `[Native Encoder ${percent}%] ${status}`;
  };
})();

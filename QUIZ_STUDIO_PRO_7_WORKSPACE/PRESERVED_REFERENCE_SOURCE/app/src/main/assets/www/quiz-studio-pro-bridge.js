/* Quiz Studio Pro Android bridge + explicit remote TTS endpoint configuration. */
(function () {
  'use strict';
  window.__MOBILE_APP = true;
  const KEY = 'quizstudiopro_tts_base_url';
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    let raw = '';
    try { raw = String(input && input.url ? input.url : input); } catch (_) {}
    if (/^\/?api\//.test(raw)) {
      const base = (localStorage.getItem(KEY) || '').trim().replace(/\/+$/, '');
      if (!base) return Promise.reject(new Error('TTS backend URL is not configured. Enter your deployed TTS server URL in Voice Settings.'));
      const path = raw.replace(/^\//, '');
      return originalFetch(base + '/' + path, init);
    }
    return originalFetch(input, init);
  };

  window.__saveBlobToPhone = function (blob, name) {
    if (!window.AndroidBridge || !blob) return false;
    try { if (!AndroidBridge.saveBegin(name)) throw new Error('Could not create a Gallery video entry'); }
    catch (e) { try { AndroidBridge.saveFailed(String(e.message || e)); } catch (_) {} return true; }
    const chunkSize = 196605; // divisible by three, so each independently encoded chunk has no padding
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

  document.addEventListener('DOMContentLoaded', function () {
    const panel = document.getElementById('ttsPanel');
    if (!panel || document.getElementById('qspTtsBase')) return;
    const box = document.createElement('div');
    box.className = 'section';
    box.style.cssText = 'padding:12px;border:1px solid #343d4e;border-radius:10px;margin:10px 0;background:#111';
    box.innerHTML = '<label class="label" for="qspTtsBase">TTS backend URL</label>' +
      '<input id="qspTtsBase" type="url" inputmode="url" placeholder="https://your-tts-server.example.com" autocomplete="url">' +
      '<p class="hint">Required for real narration. The backend must provide /api/health, /api/voices and /api/tts. No fake local server is assumed.</p>' +
      '<div class="row" style="margin-top:8px"><button type="button" class="btn" id="qspTtsSave">Save backend URL</button><button type="button" class="btn ghost" id="qspTtsCheck">Check connection</button></div>';
    panel.insertBefore(box, panel.firstChild);
    const field = box.querySelector('#qspTtsBase');
    field.value = localStorage.getItem(KEY) || '';
    box.querySelector('#qspTtsSave').onclick = function () {
      const value = field.value.trim().replace(/\/+$/, '');
      if (value && !/^https?:\/\//i.test(value)) { alert('Enter a valid http:// or https:// backend URL.'); return; }
      localStorage.setItem(KEY, value);
      const status = document.getElementById('ttsStatus');
      if (status) status.textContent = value ? 'Backend URL saved. Check the connection before generating narration.' : 'TTS backend URL cleared.';
      if (typeof window.ttsInit === 'function') window.ttsInit();
    };
    box.querySelector('#qspTtsCheck').onclick = async function () {
      const value = field.value.trim().replace(/\/+$/, '');
      if (!value) { alert('Enter your backend URL first.'); return; }
      try {
        const response = await originalFetch(value + '/api/health', { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        const names = Object.entries(data.engines || {}).map(([k, v]) => k + ': ' + (v.available ? 'available' : 'unavailable')).join(', ');
        const status = document.getElementById('ttsStatus');
        if (status) status.textContent = 'Backend connected. ' + names;
      } catch (e) { const status = document.getElementById('ttsStatus'); if (status) status.textContent = 'Backend connection failed: ' + e.message; }
    };
  });
})();

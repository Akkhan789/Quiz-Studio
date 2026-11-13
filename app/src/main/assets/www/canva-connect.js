/* Quiz Studio Pro 7 — Phase 13: Real Canva Connect OAuth2 PKCE + Design/Export Client */
(function (root, factory) {
  const api = factory(
    root.QuizSceneModel || (typeof require === 'function' ? require('./scene-model.js') : null)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QuizCanvaConnect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SceneModel) {
  'use strict';

  const STORAGE_KEY_CLIENT_ID = 'qsp_canva_client_id';
  const STORAGE_KEY_TOKEN = 'qsp_canva_oauth_token';
  const STORAGE_KEY_PKCE = 'qsp_canva_pkce_state';
  const DEFAULT_REDIRECT_URI = 'quizstudiopro://canva/callback';
  const CANVA_API_BASE = 'https://api.canva.com/rest/v1';

  function parseCanvaDesignId(url) {
    if (!url || typeof url !== 'string') return null;
    const m = /canva\.com\/design\/([A-Za-z0-9_-]+)/i.exec(url.trim());
    return m ? m[1] : null;
  }

  function getConfiguredClientId() {
    try {
      if (typeof window !== 'undefined' && window.AndroidBridge && window.AndroidBridge.getCanvaConfig) {
        const cfg = JSON.parse(window.AndroidBridge.getCanvaConfig() || '{}');
        if (cfg.clientId && String(cfg.clientId).trim()) return String(cfg.clientId).trim();
      }
    } catch (_) {}
    try {
      if (typeof localStorage !== 'undefined') {
        return (localStorage.getItem(STORAGE_KEY_CLIENT_ID) || '').trim();
      }
    } catch (_) {}
    return '';
  }

  function setClientId(clientId) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_CLIENT_ID, String(clientId || '').trim());
    }
  }

  function getStoredToken() {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY_TOKEN) || 'null');
      if (!raw || !raw.accessToken) return null;
      if (raw.expiresAt && Date.now() > raw.expiresAt - 15000) return null;
      return raw;
    } catch (_) {
      return null;
    }
  }

  function saveToken(tokenObj) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_TOKEN, JSON.stringify(tokenObj));
    }
  }

  function clearToken() {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY_TOKEN);
    }
  }

  function base64UrlEncode(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function generatePkcePair() {
    const verifierBytes = new Uint8Array(32);
    crypto.getRandomValues(verifierBytes);
    const codeVerifier = base64UrlEncode(verifierBytes);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    const codeChallenge = base64UrlEncode(new Uint8Array(digest));
    const stateBytes = new Uint8Array(16);
    crypto.getRandomValues(stateBytes);
    const state = base64UrlEncode(stateBytes);
    return { codeVerifier, codeChallenge, state };
  }

  async function startOAuthFlow(clientIdOverride) {
    const clientId = (clientIdOverride || getConfiguredClientId()).trim();
    if (!clientId) {
      return {
        ok: false,
        code: 'MISSING_CLIENT_ID',
        message: 'Canva OAuth Client ID is not configured. Enter your Canva Connect Client ID or set CANVA_CLIENT_ID in Secrets.'
      };
    }

    const { codeVerifier, codeChallenge, state } = await generatePkcePair();
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_PKCE, JSON.stringify({
        clientId,
        codeVerifier,
        state,
        redirectUri: DEFAULT_REDIRECT_URI,
        createdAt: Date.now()
      }));
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: DEFAULT_REDIRECT_URI,
      scope: 'design:meta:read design:content:read asset:read',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state
    });

    const authUrl = `https://www.canva.com/api/oauth/authorize?${params.toString()}`;
    if (typeof window !== 'undefined' && window.AndroidBridge && window.AndroidBridge.launchCanvaAuth) {
      const launchRes = JSON.parse(window.AndroidBridge.launchCanvaAuth(authUrl) || '{}');
      return { ok: !!launchRes.ok, launched: true, authUrl, error: launchRes.error || null };
    }
    return { ok: true, launched: false, authUrl };
  }

  async function exchangeAuthCallback(callbackPayload, fetchImpl = fetch) {
    if (!callbackPayload || callbackPayload.error) {
      throw new Error(callbackPayload && (callbackPayload.errorDescription || callbackPayload.error) || 'Canva authorization was cancelled or denied.');
    }
    let pkce = null;
    try { pkce = JSON.parse(localStorage.getItem(STORAGE_KEY_PKCE) || 'null'); } catch (_) {}
    if (!pkce || !pkce.codeVerifier) {
      throw new Error('Missing PKCE session state. Restart Canva sign-in.');
    }
    if (callbackPayload.state && callbackPayload.state !== pkce.state) {
      throw new Error('OAuth state mismatch. Please restart Canva sign-in.');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: callbackPayload.code,
      code_verifier: pkce.codeVerifier,
      client_id: pkce.clientId,
      redirect_uri: pkce.redirectUri || DEFAULT_REDIRECT_URI
    });

    const res = await fetchImpl('https://api.canva.com/rest/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error_description || data.message || `Canva token exchange failed (HTTP ${res.status})`);
    }
    const tokenObj = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      expiresAt: Date.now() + ((Number(data.expires_in) || 3600) * 1000)
    };
    saveToken(tokenObj);
    return tokenObj;
  }

  function mapHttpError(status, body) {
    const detail = (body && (body.message || body.error_description || body.code)) || '';
    if (status === 401) return { code: 'UNAUTHORIZED', message: 'Canva access token expired or invalid. Please reconnect your Canva account.' };
    if (status === 403) return { code: 'FORBIDDEN_PRIVATE', message: 'This Canva design is private or your account lacks read permission. Share or grant access in Canva first.' };
    if (status === 404) return { code: 'NOT_FOUND', message: 'Canva design was not found. Verify the design ID and account workspace.' };
    if (status === 429) return { code: 'RATE_LIMITED', message: 'Canva API rate limit reached. Wait a moment before retrying.' };
    return { code: 'HTTP_ERROR', message: `Canva Connect API error (HTTP ${status})${detail ? ': ' + detail : ''}` };
  }

  /**
   * Imports a Canva design genuinely via `/rest/v1/designs/{id}` + `/rest/v1/exports`.
   * Explicitly marks flattened raster exports `editable: false` rather than pretending text layers were extracted.
   */
  async function importCanvaDesign(url, { fetchImpl = (typeof fetch === 'function' ? fetch : null), accessToken = null, ratio = '16/9' } = {}) {
    const designId = parseCanvaDesignId(url);
    if (!designId) {
      return { ok: false, code: 'INVALID_URL', message: 'Invalid Canva design URL. Expected https://www.canva.com/design/<id>/...' };
    }

    const token = accessToken || (getStoredToken() && getStoredToken().accessToken);
    if (!token) {
      return {
        ok: false,
        code: 'AUTH_REQUIRED',
        message: 'Canva OAuth sign-in required to inspect or export this design via Canva Connect API.'
      };
    }

    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let metaRes;
    try {
      metaRes = await fetchImpl(`${CANVA_API_BASE}/designs/${encodeURIComponent(designId)}`, { headers });
    } catch (netErr) {
      return { ok: false, code: 'NETWORK_ERROR', message: 'Network error contacting Canva Connect API: ' + netErr.message };
    }

    const metaJson = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok) {
      return { ok: false, ...mapHttpError(metaRes.status, metaJson) };
    }

    const designMeta = metaJson.design || metaJson;
    const title = designMeta.title || `Canva Design ${designId}`;

    // Request official PNG export job
    let exportUrl = null;
    try {
      const expRes = await fetchImpl(`${CANVA_API_BASE}/exports`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ design_id: designId, format: { type: 'png' } })
      });
      if (expRes.ok) {
        const expJson = await expRes.json().catch(() => ({}));
        const job = expJson.job || expJson;
        if (job.status === 'success' && job.urls && job.urls.length) {
          exportUrl = job.urls[0];
        } else if (job.id) {
          for (let attempt = 0; attempt < 6; attempt++) {
            await new Promise(r => setTimeout(r, 400));
            const poll = await fetchImpl(`${CANVA_API_BASE}/exports/${encodeURIComponent(job.id)}`, { headers });
            if (!poll.ok) break;
            const pJson = await poll.json().catch(() => ({}));
            const pJob = pJson.job || pJson;
            if (pJob.status === 'success' && pJob.urls && pJob.urls.length) {
              exportUrl = pJob.urls[0];
              break;
            }
            if (pJob.status === 'failed') break;
          }
        }
      }
    } catch (_) {
      // Export job failed cleanly — fall back to design thumbnail if present
    }

    const imageUrl = exportUrl || (designMeta.thumbnail && designMeta.thumbnail.url) || '';
    const assets = imageUrl ? { canva_flattened_art: imageUrl } : {};
    const elements = [
      {
        id: 'canva_flattened_bg',
        type: 'background',
        name: `${title} (Flattened Canva Export)`,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        backgroundColor: '#0f172a',
        assetRef: imageUrl ? 'canva_flattened_art' : '',
        editable: false, // Explicitly marked non-editable because Canva Connect returns flattened raster artwork
        locked: false,
        sourceImageRef: `canva:${designId}`,
        layerOrder: 0
      },
      {
        id: 'canva_q_slot',
        type: 'question_text',
        name: 'Quiz Question Overlay Slot',
        x: 0.08,
        y: 0.18,
        width: 0.84,
        height: 0.24,
        text: '{question}',
        fontSize: 0.052,
        fontWeight: 800,
        textColor: '#ffffff',
        editable: true,
        sourceImageRef: 'overlay_slot',
        layerOrder: 1
      }
    ];

    const scene = SceneModel
      ? SceneModel.fromDetectionToScene({
          ratio,
          assets,
          elements,
          report: {
            analysisMode: 'canva_connect_api',
            designId,
            title,
            flattenedArtwork: true,
            limitations: ['Canva Connect API returns flattened raster exports rather than decomposed editable vector text layers; overlay slots are provided above the flattened backdrop.']
          }
        })
      : { mode: 'IMPORTED_TEMPLATE_MODE', ratio, assets, elements };

    return {
      ok: true,
      designId,
      title,
      editableVectorsAvailable: false,
      imageUrl,
      scene
    };
  }

  return {
    parseCanvaDesignId,
    getConfiguredClientId,
    setClientId,
    getStoredToken,
    saveToken,
    clearToken,
    startOAuthFlow,
    exchangeAuthCallback,
    importCanvaDesign
  };
});

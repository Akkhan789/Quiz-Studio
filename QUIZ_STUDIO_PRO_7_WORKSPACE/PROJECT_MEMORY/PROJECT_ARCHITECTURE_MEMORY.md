# Quiz Studio Pro 7 — Project Architecture Memory

This document is the persistent engineering reference for **Quiz Studio Pro 7**, derived strictly from read-only inspection of `PRESERVED_PRIMARY_SOURCE/` (`quiz-studio-pro (7).zip`) and `PRESERVED_REFERENCE_SOURCE/` (`quiz-studio-pro (1) - compact-source-reference.zip`) during Phase 0.

---

## 1. Workspace Structure & Source Boundaries

- **Workspace root:** `QUIZ_STUDIO_PRO_7_WORKSPACE/`
  - `ORIGINAL_ARCHIVES/`
    - `quiz-studio-pro (7).zip` — **Primary Source of Truth** (`14,097,579` bytes, SHA-256 `fb825d50bfb6f54fea2f0787e3a42fd1694a9223ef67d85e4fb8d0188ccf4415`)
    - `quiz-studio-pro (1) - compact-source-reference.zip` — **Secondary Reference** (`869,469` bytes, SHA-256 `4a879cd1400125e1f7eec7247e3c966696e4d895f8c860f8a81460608a1bc91c`)
  - `PRESERVED_PRIMARY_SOURCE/` — Untouched extraction of `quiz-studio-pro (7).zip` (`83` files, `41` dirs). **Never modify.**
  - `PRESERVED_REFERENCE_SOURCE/` — Untouched extraction of Reference (`77` files, `31` dirs). **Never modify.**
  - `WORKING_SOURCE/` — Separate copy of `PRESERVED_PRIMARY_SOURCE/` used for baseline Gradle/JS tests and authorized future phase edits.
  - `PRESERVATION_REPORTS/` — `PHASE_0_PRESERVATION_REPORT.md`, `FILE_INVENTORY.md`, `CHECKSUM_MANIFEST.md`, `BASELINE_REGRESSION.md`.
  - `PROJECT_MEMORY/` — `PROJECT_ARCHITECTURE_MEMORY.md` (this file).

---

## 2. Native Android Architecture (`com.quizstudiopro.app`)

### 2.1 Build & Manifest Configuration
- **Build System:** Gradle `9.3.1`, AGP `9.1.1`, Kotlin `2.2.10`, Java `17`.
- **Android SDK:** `compileSdk = 36` (minor `1`), `targetSdk = 36`, `minSdk = 29` (Android 10+).
- **Package / App ID:** `namespace = "com.quizstudiopro.app"`, `applicationId = "com.quizstudiopro.app"`, `versionCode = 1`, `versionName = "1.0.0"`. (`settings.gradle.kts` still has `rootProject.name = "My Application"`; `strings.xml` has `app_name = "Quiz Studio Pro"`.)
- **Permissions (`AndroidManifest.xml`):**
  - `android.permission.INTERNET`
  - `android.permission.FOREGROUND_SERVICE`
  - `android.permission.FOREGROUND_SERVICE_DATA_SYNC`
  - `android.permission.POST_NOTIFICATIONS` (runtime-requested on API 33+ in `MainActivity.onCreate`)
- **Components:**
  - `MainActivity` (`android:exported="true"`, `configChanges="orientation|screenSize|screenLayout|keyboardHidden"`, `windowSoftInputMode="adjustResize"`, launcher intent filter)
  - `QuizEncodingService` (`android:foregroundServiceType="dataSync"`, `android:exported="false"`)

### 2.2 WebView Shell & Bridge (`MainActivity.kt`)
- Single non-Compose `Activity` hosting a full-screen `WebView`.
- Asset hosting via `WebViewAssetLoader` mapping `/assets/` -> `https://appassets.androidplatform.net/assets/www/login.html` (`allowFileAccess = false`, `allowContentAccess = true`, `mixedContentMode = NEVER_ALLOW`, `javaScriptEnabled = true`, `domStorageEnabled = true`, `databaseEnabled = true`, `mediaPlaybackRequiresUserGesture = true`).
- Native file chooser (`WebChromeClient.onShowFileChooser`) via `ACTION_OPEN_DOCUMENT` (`EXTRA_ALLOW_MULTIPLE`, `takePersistableUriPermission` attempted).
- Back button handling (`onBackPressed`): navigates `webView.goBack()` if possible, else delegates to super.
- **`AndroidBridge` (`@JavascriptInterface`) APIs:**
  - **Device / Screen / Notifications:** `deviceId()`, `deviceName()`, `setKeepScreenOn(Boolean)`, `toast(String)`, `notifyExportStarted(status)`, `notifyExportProgress(progress, status)`, `notifyExportCompleted(message)`, `notifyExportFailed(error)`, `logLiveEvent(event, type)`.
  - **Direct Edge TTS:** `fetchVoiceInventory()`, `fetchVoiceInventory(forceRefresh: Boolean)`, `synthesizeSpeech(text, voiceShortName, speedPercent)`, `playPreviewAudio(text, voiceShortName, speedPercent)`, `stopPlayback()`.
  - **Native Video Export:** `initNativeExport(width, height, fps, totalFrames, totalAudioSamples)`, `writePcmChunk(base64Pcm)`, `submitFrame(frameIndex, base64Image)`, `finalizeNativeExport(filename)`, `cancelNativeExport()`.
  - **WebCodecs Chunked Storage & Media Actions:** `saveBegin(name)`, `saveChunk(base64Chunk)`, `saveEnd()`, `saveFailed(reason)`, `hasSavedVideo()`, `openSavedVideo()`, `shareSavedVideo()`.

### 2.3 Native Audio / Direct Edge TTS Layer (`audio/`)
- **`EdgeTtsV2Drm.kt`:** Port of Edge TTS v2 `Sec-MS-GEC` token generation (`<16 hex CS64>-<64 hex SHA256>`), Chromium UA `143.0.3650.75`, `TRUSTED_CLIENT_TOKEN = 6A5AA1D4EAFF4E9FB37E23D68491D6F4`, MUID generation, and `adjustClockSkew(serverDateHeader)` from RFC 1123 `Date` headers.
- **`EdgeTtsClient.kt`:** OkHttp `fetchVoiceList()` (24h cache in `cacheDir/edge_voices_v2.json`, fallback to stale cache on network failure when not forcing refresh) and mutex-serialized `synthesizeToMp3()` over `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` (25s timeout, retry on 401/Handshake/WebSocket failure, `audio-24khz-48kbitrate-mono-mp3` SSML synthesis).
- **`AudioDecoder.kt`:** Decodes MP3 bytes via `MediaExtractor` + `MediaCodec`, downmixes multi-channel to mono, and linearly resamples to 48,000 Hz PCM16 (`DecodedAudio`).
- **`VoiceEngine.kt`:** Manages in-memory + disk MP3 cache (`cacheDir/edge_tts_audio_cache/<md5>.mp3`) and plays voice previews via `AudioTrack` (`MODE_STATIC`, `USAGE_MEDIA`, `CONTENT_TYPE_SPEECH`) with completion marker callback to `window.onPreviewFinished()`.

### 2.4 Native Hardware Video Encoder (`video/`, `service/`)
- **`StreamingVideoEncoderSession.kt`:** Producer-consumer pipeline (`ArrayBlockingQueue(8)`, background `MediaCodecEncoderWorker` thread):
  - Encodes H.264 video (`COLOR_FormatSurface`, `10M/6M/3M` bps by width, I-frame interval 1s) via **`EglTextureRenderer.kt`** (EGL14 + GLES2 texture quad with `EGLExt.eglPresentationTimeANDROID`).
  - Encodes optional 48kHz mono AAC-LC audio (`192kbps`) from a temp PCM file written by `writePcmChunk()`, buffering samples until both `MediaMuxer` tracks receive `INFO_OUTPUT_FORMAT_CHANGED`.
- **`VideoEncoder.kt`:** Older batch `encodeVideo()` + `verifyMp4AudioTrack()` + `PendingSample` data class (only `PendingSample` and `ProgressListener` are used by `StreamingVideoEncoderSession`; `encodeVideo()` itself is not called from `MainActivity`).
- **`QuizEncodingService.kt`:** Foreground service (`dataSync`) updating progress notifications (`NOTIFICATION_ID = 4101`) and completion/failure notifications (`RESULT_NOTIFICATION_ID = 4102`).

---

## 3. WebView Application Architecture (`app/src/main/assets/www/`)

- **`login.html`:** Local Mode (`#offline` clears `qsp_session` and navigates to `index.html`), optional remote account backend (`qsp_account_base_url` calling `/account/login`, `/account/register`, `/account/validate`), session auto-check on load.
- **`index.html` (2,457 lines):**
  - Workspace UI: Header + responsive Drawer Sidebar + Quiz Studio editor + Video Preview (`<canvas id="pvCanvas">` + DOM overlays) + Template Library (`#templateManager`) + Video & Timer Settings (`#videoSettings`) + Video Export Preview Panel (`#videoPreviewPanel`).
  - **Bundled Assets:** 21 local `.woff2` font files in `fonts/` (`fonts.css` — Poppins, Montserrat, Oswald, Bebas Neue, Anton, Lilita One, Playfair Display, Merriweather, Roboto, Open Sans), `mp4-muxer.mjs`, and two audio files in `sounds/` (`10-1_256k.mp3` and `countdown.mp3`, identical 202,906-byte MP3s).
  - **Export Pipeline:**
    1. Decodes question `audioData` and answer `answerAudioData` when `With Narration` is active (`AudioContext.decodeAudioData`), or uses visual timings (`3.2s` voice + countdown + `0.52s` reveal + `2.5s` answer) when `Without Narration` is selected.
    2. Renders mixed stereo 48kHz audio via `OfflineAudioContext` (`renderAudioTrack()`).
    3. **Path 1 (WebCodecs):** `VideoEncoder` (`avc1.640028` / `4d401f` / `42e01f`) + `AudioEncoder` (`mp4a.40.2` / `opus`, `f32-planar`) + `Mp4Muxer.Muxer` (`fastStart: 'in-memory'`). Populates `<video id="exportedVideoPlayer">` via `registerExportedMp4Blob(blob)` and streams to `Movies/QuizStudioPro/` via `__saveBlobToPhone()`.
    4. **Path 2 (Native MediaCodec Fallback):** `AndroidBridge.initNativeExport` -> `writePcmChunk` -> base64 JPEG `submitFrame` -> `finalizeNativeExport` (direct MediaStore write to `Movies/QuizStudioPro/`).
    5. **Path 3 (`MediaRecorder`):** Exists in `detectMp4Support` (`recorderMp4Mime()`), though `$('exportBtn').onclick` only branches on `mode === 'webcodecs'` and `AndroidBridge.initNativeExport`; `recorder` mode falls through to `MP4 direct export is not supported in this browser`.
- **`question-import.js` (`QuizStudioImport.parseText`):** Multi-format parser for quoted CSV, TSV, pipe-delimited (`|`), Markdown tables, and JSON with deduplication and per-row error reporting.
- **`timeline-engine.js` (`QuizTimeline.build`):** Deterministic timeline builder supporting both `withNarration = true` and `withNarration = false`.
- **`pro-enhancements.js`:** Adds header toolbar (`LOCAL MODE`/`ACCOUNT` badge, `Logout`/`Account`, `Projects`, `Save`, `Export Questions`, `Export CSV`, `Import CSV/JSON`), IndexedDB project store (`quiz-studio-pro-db`), autosave debounce (`scheduleSave`), project manager modal (`Open`, `Copy`, `Rename`, `Delete`), `#importBulk` override with Import Preview modal, and periodic `/account/validate`.
- **`quiz-studio-pro-bridge.js`:** Sets `__MOBILE_APP = true` and defines initial `__saveBlobToPhone`, `onFileSaved`, `onExportProgress` (note `index.html` later overrides `__saveBlobToPhone` and `onFileSaved` at lines 2342–2385).

---

## 4. Primary (`quiz-studio-pro (7).zip`) vs. Secondary Reference (`quiz-studio-pro (1)`) Comparison

| Area | Primary (`quiz-studio-pro (7).zip`) | Secondary Reference (`quiz-studio-pro (1)`) |
| :--- | :--- | :--- |
| **1. UI Screens & Structure** | Adds Narration On/Off toggle, Live Activity bar & expandable logs, Sample Questions generator (6 languages), Template Upload & CV Detector, Canva Connect import card, Dedicated Exported Video Preview panel (`<video>` + Play/Download/Share), element Y-offset & scale controls (`headerY/Scale`, `qY/Scale`, `optY/Scale`), `bgImage` upload. | Compact core editor + Template Studio + Timer Looks (`TIMER_LOOKS`) + Theme Editor; no sample generator, no template detector, no Canva card, no `<video>` preview panel, no activity log panel. |
| **2. Navigation & Flow** | `login.html` -> `index.html`; drawer sidebar + `#tplToggle` Studio toggle; `WebViewAssetLoader`. | Identical `login.html` -> `index.html` + `WebViewAssetLoader`; Reference includes `tts-backend/admin-ui/index.html` for server admin. |
| **3. TTS Architecture** | **Direct On-Device/Direct Edge TTS** in Kotlin (`VoiceEngine`, `EdgeTtsClient`, `EdgeTtsV2Drm`, `AudioDecoder`) + `AudioTrack` preview; **no backend server folder**; JS fallback hits Edge directly without DRM headers when `AndroidBridge` absent. | **External FastAPI Backend (`tts-backend/server.py`)** supporting Edge + Kokoro + Piper engines (`#ttsEngine`, `#ttsLock`); `bridge.js` intercepts `/api/*` and attaches `X-Device-ID` / Bearer token. |
| **4. Question Management** | `question-import.js` + `pro-enhancements.js` modal + 6-language `SAMPLE_QUESTIONS_DB` + main-panel Export JSON/CSV buttons + `With/Without Narration` support. | `question-import.js` + `pro-enhancements.js` modal; no sample generator, no main-panel export buttons, no `Without Narration` mode. |
| **5. Template System** | Dual storage (`localStorage` stripping large `bgImage` + IndexedDB `quiz-studio-pro-templates-db`), `bgImage` custom backdrop, element offsets/scales, pixel-sampling `analyzeTemplateImage()`, simulated Canva import. | `localStorage` only (`quizstudiopro_templates_v1`), same `TIMER_LOOKS` & `THEME_PRESETS` (`ocean`, `night`, `sunset`). |
| **6. Video Preview** | Live Canvas (`drawSpanish`) + DOM preview + `buildPreviewTimeline` + new `#videoPreviewPanel` (`<video id="exportedVideoPlayer">`) for post-export MP4 playback. | Live Canvas + DOM preview only (`playBtn`/`prevBtn`/`nextBtn`/`stopBtn`); no post-export `<video>` preview panel. |
| **7. Video Export** | WebCodecs (`fastStart: 'in-memory'`, `f32-planar` audio) **+ Native Android `MediaCodec` + EGL2 Hardware Fallback** (`StreamingVideoEncoderSession` + `EglTextureRenderer` + `QuizEncodingService`) + `saveBegin/Chunk/End` chunked gallery export. | WebCodecs (`fastStart: false`, OPFS `FileSystemWritableFileStream` support) + `MediaRecorder` MP4 fallback + `saveBegin/Chunk/End` chunked gallery export; no native `MediaCodec` encoder. |
| **8. File Storage & Save/Load** | IndexedDB (`quiz-studio-pro-db` projects, `quiz-studio-pro-templates-db` templates, `tinglu_sounds` countdown sounds), JSON Project Save/Load, MediaStore `Movies/QuizStudioPro/` via `MainActivity.kt`, FileProvider share (`shareSavedVideo`). | Same IndexedDB projects & countdown sounds + MediaStore `Movies/QuizStudioPro/` + `tts-backend` SQLite (`accounts`, `sessions`, `tts_cache`). |
| **9. Tests & Build Config** | `QuizStudioAppUnitTest.kt` (6 math/bounds unit tests) + unused `ExampleInstrumentedTest.kt` (`com.example`). `minSdk 29`, `compileSdk 36`. No Node tests or Python backend tests included. | `tests-import.cjs`, `tests-timeline.cjs`, `tests-backend.py`, `ExampleUnitTest.kt`, `ExampleRobolectricTest.kt`. Same `minSdk 29`, `compileSdk 36`, plus `public/QuizStudioPro.apk`. |

---

## 5. Known Defects & Technical Risks Identified in Audit (For Future Phases)

1. **CRITICAL — Broken `ttsSettings()` / `ttsApplyPending()` DOM References (`index.html:1896,1899`):**
   - When Reference's `#ttsEngine` and `#ttsLock` controls were removed from Primary's UI, `ttsSettings()` and `ttsApplyPending()` were not updated.
   - `ttsSettings()` reads `ttsEl('ttsEngine').value` and `ttsEl('ttsLock').checked`, throwing a `TypeError` whenever `currentTemplate()` runs — which directly breaks **`pro-enhancements.js` `snapshot()` / `save()` / autosave**, **`#saveProject`**, **`#saveTemplate`**, **`#updateTemplate`**, and **`#btnSaveDetectedTemplate`**.
   - `ttsApplyPending()` throws on `ttsEl('ttsEngine').value` / `ttsEl('ttsLock').checked` when loading templates or projects that carry `.tts` metadata.
2. **HIGH — Native MediaCodec Export Preview Gap (`index.html:1110–1194`):**
   - If WebCodecs is unavailable and the Native `AndroidBridge.initNativeExport` path executes, `finalizeNativeExport` writes directly to MediaStore (`lastSavedUri`) and shows an alert, but never loads `<video id="exportedVideoPlayer">` or reveals `#videoPreviewPanel`.
3. **HIGH — Android WebView Blob `<a download>` Dead End (`index.html:377, 1914, 2402, 2440` & `pro-enhancements.js:42–45`):**
   - `saveProject`, `exportTemplate`, `btnExportQuestionsMain`, `btnExportCsvMain`, and header `Export Questions`/`Export CSV` trigger `<a href="blob:..." download="...">`. Inside `MainActivity`'s `WebView` (which has no `DownloadListener` and cannot resolve `blob:` URLs via `DownloadManager`), blob anchor downloads silently fail on Android unless routed through `AndroidBridge`.
4. **MEDIUM — Simulated Canva Integration (`index.html:2278–2324`):**
   - "Canva Project Import (Official Connect API)" is a `setTimeout(..., 800)` stub checking regex `canva.com/design/...` and `url.includes('private')`, applying a static hardcoded `canvaTheme` without calling any Canva API.
5. **MEDIUM — Heuristic-Only "Computer Vision" Template Detector (`index.html:2077–2148`):**
   - `analyzeTemplateImage()` samples 4 hardcoded normalized `(x, y)` coordinates on the canvas and returns hardcoded confidence (`91` or `96`); it does not detect text bounds or layout boxes.
6. **MEDIUM — Question List Edit & Badge Mismatch (`index.html:306, 332`):**
   - `renderList()` checks `q.audioData` (ignoring whether `q.answerAudioData` exists) for the `Voice ✓` indicator, and saving an edited question only preserves `q.audioData` (`o.audioData`), dropping `q.answerAudioData`.
7. **MEDIUM — Web Browser Fallback Edge TTS Missing Sec-MS-GEC DRM (`index.html:1378–1395, 1501–1538`):**
   - Outside Android (when `AndroidBridge` is absent), JS `loadVoices` and `ttsSynth` call Microsoft Edge endpoints without `Sec-MS-GEC` / `Sec-MS-GEC-Version` headers, which Microsoft rejects with `403` unless proxied.
8. **LOW — Dual Overwritten Bridge Definitions & Dead Paths:**
   - `quiz-studio-pro-bridge.js` defines `__saveBlobToPhone` and `onFileSaved`, then `index.html:2342–2385` overwrites both.
   - `detectMp4Support` returns `{ok:true, mode:'recorder'}` when `MediaRecorder` supports MP4, yet `exportBtn.onclick` never implements `mode === 'recorder'`.
   - `ExampleInstrumentedTest.kt` remains under `com.example` (unused/stale package) instead of `com.quizstudiopro.app`.
   - `VideoEncoder.kt.encodeVideo()` and `MainActivity.AndroidBridge.hasSavedVideo()` exist in native code without active callers.

# Quiz Studio Pro 7 — Phase 0 Baseline Regression Report

## 1. Test Environment & Scope Constraints

- **Target Tested:** `QUIZ_STUDIO_PRO_7_WORKSPACE/WORKING_SOURCE/` (unmodified copy of `quiz-studio-pro (7).zip`)
- **Preservation Verification:** `PRESERVED_PRIMARY_SOURCE/` and `PRESERVED_REFERENCE_SOURCE/` remained strictly untouched throughout all checks.
- **Execution Environment Capabilities:**
  - `gradle 9.3.1` (JVM unit tests + compilation): **Available**
  - `node v22.23.4` (JavaScript syntax & engine unit tests): **Available**
  - `python 3.11.2` (static DOM/asset/archive audits): **Available**
  - Android Emulator / Physical Device / `adb` / Live WebView Runtime: **NOT AVAILABLE** in this container environment.

No runtime UI, WebView, network, or hardware `MediaCodec` behavior is claimed as device-verified. Every feature below is classified strictly by what was observed in code and executable offline tests.

---

## 2. Baseline Verification Commands & Observed Results

| Check | Exact Command / Scope | Exit Code | Outcome & Details |
| :--- | :--- | :---: | :--- |
| **Container Root Build** | `compile_applet` (at `/app/applet`) | `0` | `Build succeeded - the applet is compiled` |
| **Primary JVM Unit Tests** | `gradle -p QUIZ_STUDIO_PRO_7_WORKSPACE/WORKING_SOURCE :app:testDebugUnitTest --no-daemon` | `0` | `BUILD SUCCESSFUL in 1m 35s` (`33 actionable tasks: 33 executed`). `QuizStudioAppUnitTest`: **6 tests, 0 failures, 0 errors, 0 skipped** (`0.035s`). Note: tests cover pure math/bounds assertions only, not TTS/encoder classes. |
| **Primary Debug APK Assembly** | `gradle -p QUIZ_STUDIO_PRO_7_WORKSPACE/WORKING_SOURCE :app:assembleDebug --no-daemon` | Failed (`validateSigningDebug`) | `:app:compileDebugKotlin`, `:app:compileDebugJavaWithJavac`, `:app:processDebugResources`, `:app:mergeLibDexDebug`, `:app:mergeExtDexDebug` succeeded; `:app:validateSigningDebug FAILED` because `quiz-studio-pro (7).zip` does not include `debug.keystore` (preserved unmodified during Phase 0). |
| **JS/MJS Syntax Audit** | `node --check` on `mp4-muxer.mjs`, `pro-enhancements.js`, `question-import.js`, `quiz-studio-pro-bridge.js`, `timeline-engine.js`, plus inline `<script>` blocks from `index.html` (2 blocks: 1 + 2,160 lines) and `login.html` (1 block: 12 lines) | `0` | **8 / 8 scripts passed** syntax validation with zero errors. |
| **Question Import Behavioral Suite** | `PRESERVED_REFERENCE_SOURCE/tests-import.cjs` executed against `WORKING_SOURCE/app/src/main/assets/www/question-import.js` | `0` | `PASS: pipe, tab, CSV quoting, Markdown table, JSON, invalid row and duplicate detection` |
| **Timeline Behavioral Suite (Narration ON)** | `PRESERVED_REFERENCE_SOURCE/tests-timeline.cjs` executed against `WORKING_SOURCE/app/src/main/assets/www/timeline-engine.js` | `0` | `PASS: prompt → countdown → reveal → answer ordering, transitions, decoded durations and validation` |
| **Timeline Check (Narration OFF)** | Node harness calling `QuizTimeline.build(2 questions, [], 10, [], false)` | `0` | `withNarration=false total: 33.34 segments: 9 types: voice,count,reveal,answer,page,voice,count,reveal,answer` |
| **Static DOM ID Cross-Check** | Python check of `ttsEl('...')` calls vs static `id="..."` attributes in `index.html` | `0` | Detected **2 missing DOM IDs**: `ttsEngine` and `ttsLock` referenced by `ttsSettings()` (`index.html:1896`) and `ttsApplyPending()` (`index.html:1899`). |
| **On-Device WebView / Encoder / Network Tests** | Android Emulator / `adb` | N/A | **NOT TESTED** — No Android emulator or `adb` in execution environment. |

---

## 3. Feature-by-Feature Baseline Audit

Status classifications used:
- **VERIFIED**: Directly executed and passed in offline tests during Phase 0.
- **PARTIAL**: Implemented and wired, but either (a) cannot be runtime-executed without Android device/emulator/network, or (b) has a verified partial defect/gap in code.
- **PRESENT BUT NOT CONNECTED**: Code or UI exists but is broken, stubbed, overwritten, or unreachable in execution.
- **MISSING**: Not present in the Primary application.
- **NOT TESTED**: Implemented in code requiring device/network/UI runtime that is unavailable in this environment.

| Feature | Classification | Evidence & Findings |
| :--- | :--- | :--- |
| **Login** | **PARTIAL** (Offline syntax OK; network runtime **NOT TESTED**) | `login.html:19–22` posts to `${base}/account/login`, `${base}/account/register`, `${base}/account/validate` with `AndroidBridge.deviceId()`. `pro-enhancements.js:152–161` validates sessions every 5 min. Primary archive includes **no backend server** (`tts-backend/` absent), so login requires an externally hosted compatible server. |
| **Local mode** | **PARTIAL** (Code wired; WebView runtime **NOT TESTED**) | `login.html:21` clears `qsp_session` and navigates to `index.html`. `pro-enhancements.js:100` displays `LOCAL MODE` badge when no session exists. `MainActivity.kt:136` loads `login.html` over `WebViewAssetLoader` (`https://appassets.androidplatform.net/assets/www/login.html`). |
| **Question importing** | **VERIFIED** (Parser) / **NOT TESTED** (File picker & UI modal) | `question-import.js` (`QuizStudioImport.parseText`) passed all automated CSV/TSV/pipe/Markdown/JSON/dedupe tests (`tests-import.cjs` exit `0`). `pro-enhancements.js:134–143, 168–198` wires both `#bulkInput` (`#importBulk`) and header `Import CSV/JSON` via `MainActivity.kt` `ACTION_OPEN_DOCUMENT`. |
| **Sample questions** | **PARTIAL** (Code present; DOM click runtime **NOT TESTED**) | `index.html:54–68, 1925–2020` implements `SAMPLE_QUESTIONS_DB` across 6 languages (`en`, `es`, `it`, `fr`, `de`, `pt`) and 4 count buttons (`btnSample1/3/5/10`) that populate `#bulkInput` in pipe format for import. |
| **Edge TTS** | **PARTIAL** (Native Kotlin DRM present, **NOT TESTED** live; browser fallback broken) | Kotlin implements `EdgeTtsV2Drm.kt` (v2 `Sec-MS-GEC` + clock skew), `EdgeTtsClient.kt` (OkHttp voice fetch + WSS synthesis + 24h `edge_voices_v2.json` cache), and `VoiceEngine.kt` (`edge_tts_audio_cache/<md5>.mp3`). Cannot be live-tested without device/network. Non-Android browser fallback (`index.html:1378, 1501`) lacks `Sec-MS-GEC` headers. Also `ttsSettings()` (`index.html:1896`) throws `TypeError` on missing `#ttsEngine`/`#ttsLock` when saving templates/projects. |
| **Voice preview** | **NOT TESTED** (Code wired via `AndroidBridge.playPreviewAudio`) | `index.html:1692–1746` calls `AndroidBridge.playPreviewAudio(text, voiceId, speed)` -> `MainActivity.kt:220–248` -> `VoiceEngine.kt:119–175` (`AudioDecoder` + `AudioTrack` `MODE_STATIC`, callbacks `onPreviewFinished`/`onPreviewError`/`stopPlayback`). Requires Android device runtime. |
| **Speech generation** | **NOT TESTED** (Code wired; latent edit/badge discrepancy noted) | `index.html:1541–1666` iterates questions, calls `AndroidBridge.synthesizeSpeech` (`MainActivity.kt:201–218` -> `VoiceEngine.synthesizeToMp3Bytes`) for prompt and answer MP3 data URLs, and updates `#ttsProgressContainer`. Latent bug: editing a question (`index.html:332`) preserves `q.audioData` but drops `q.answerAudioData`; `renderList` checks only `q.audioData`. |
| **Templates** | **PARTIAL** (UI/Canvas present; save/load impacted by `ttsSettings()` bug & simulated/heuristic tools) | `index.html:89–158, 1201–1262, 1765–1919` supports starter presets, custom `THEME_DEFAULT` editor, `bgImage` upload, layout offsets/scales, `TIMER_LOOKS`, `THEME_PRESETS`, IndexedDB + `localStorage` storage. **Critical bug:** `currentTemplate()` calls `ttsSettings()` (`index.html:1896`) which reads null `#ttsEngine`/`#ttsLock` and throws `TypeError`, breaking template save/update. Template CV detector (`analyzeTemplateImage`, `index.html:2077`) is a 4-point pixel sampler; Canva Connect (`index.html:2278`) is a `setTimeout` stub. |
| **Preview** | **VERIFIED** (Timeline engine) / **NOT TESTED** (Canvas/DOM playback) | `timeline-engine.js` passed both Narration ON (`tests-timeline.cjs`) and Narration OFF (`QuizTimeline.build(..., false)`) checks. Live quiz preview (`renderPreview`, `drawSpanish`, `playBtn`, `prevBtn`, `nextBtn`, `stopBtn`) requires browser/WebView DOM runtime. |
| **Video export** | **PARTIAL** (WebCodecs & Native fallback wired; **NOT TESTED** on device; Recorder branch unfinished) | `index.html:835–1199` supports: (1) WebCodecs `VideoEncoder` + `AudioEncoder` (`f32-planar`) + `mp4-muxer.mjs` (`fastStart: 'in-memory'`); (2) Native `AndroidBridge.initNativeExport` -> `StreamingVideoEncoderSession.kt` (`MediaCodec` AVC + AAC-LC + `EglTextureRenderer.kt` + `QuizEncodingService.kt`). `detectMp4Support` can return `mode: 'recorder'`, which has no handler branch in `$('exportBtn').onclick` (`index.html:1195`). |
| **MP4 playback** | **PARTIAL** (Wired for WebCodecs; **PRESENT BUT NOT CONNECTED** for Native fallback) | `index.html:246–260, 2330–2340, 2387–2393` populates `<video id="exportedVideoPlayer">` and shows `#videoPreviewPanel` via `registerExportedMp4Blob(blob)` **only** in the WebCodecs branch (`index.html:1098`). The Native `finalizeNativeExport` branch (`index.html:1179–1194`) never sets the player source or displays `#videoPreviewPanel`. |
| **Download** | **PARTIAL** | WebCodecs path streams MP4 chunks via `__saveBlobToPhone` -> `AndroidBridge.saveBegin/saveChunk/saveEnd` (`MainActivity.kt:428–478`) to `Movies/QuizStudioPro/`. Native path saves directly to MediaStore in `finalizeNativeExport`. Clicking `#btnDownloadMp4` (`index.html:2395–2413`) works when `lastGeneratedMp4Blob` exists or falls back to `openSavedVideo()`; outside Android, uses `<a download>`. |
| **Share** | **NOT TESTED** (Code wired via `FileProvider` / MediaStore URI) | `index.html:2415–2427` calls `AndroidBridge.shareSavedVideo()` (`MainActivity.kt:485–499`), which shares `lastSavedUri` via `Intent.ACTION_SEND` (`video/mp4`). Depends on `lastSavedUri` populated by `saveEnd()` or `finalizeNativeExport()`. |
| **Project save** | **PARTIAL / BROKEN IN CODE** (`ttsSettings()` `TypeError` + WebView blob-download gap) | **1. IndexedDB Autosave/Save (`pro-enhancements.js:21–31`):** `snapshot()` calls `currentTemplate()` -> `ttsSettings()` (`index.html:1896`), which dereferences null `ttsEl('ttsEngine').value` and throws `TypeError`, causing `save()` to fail (`Save failed: ...`). **2. JSON File Save (`index.html:377`):** Also calls `currentTemplate()` (same `TypeError`) AND downloads via `URL.createObjectURL` + `<a download>`, which has no WebView `DownloadListener` in `MainActivity.kt`. |
| **Project reopen** | **PARTIAL** (`pro-enhancements.js` CRUD + `#loadProject` wired, blocked by `save()` / `applyTtsSettings()` bugs) | `pro-enhancements.js:32–67, 210–212` restores active project from IndexedDB on launch and provides `Projects` modal (`Open`/`Copy`/`Rename`/`Delete`). `#loadProject` (`index.html:378`) imports JSON via file chooser. Restoring templates/projects with a `.tts` object hits `ttsApplyPending()` (`index.html:1899`), which dereferences null `ttsEl('ttsEngine')` / `ttsEl('ttsLock')`. |

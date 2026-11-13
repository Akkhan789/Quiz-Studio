# Quiz Studio Pro — Known Limitations & Architectural Notes

In keeping with rigorous release engineering practices, this document outlines known operational boundaries, backend dependencies, and environment considerations.

---

## 1. External TTS Backend Requirement
- **Dependency:** Text-To-Speech audio synthesis requires an active companion server implementing Microsoft Edge TTS endpoints (`/api/health`, `/api/voices`, and `/api/tts`).
- **No Mock Fallback:** In accordance with prompt requirements, the application preserves the real server configuration UI and refuses to generate synthetic or mock silence narration when the server is unreachable.
- **Resolution:** To use live voice narration, deploy the provided `tts-backend/server.py` onto a hosting environment (e.g., Cloud Run, VPS, or local Docker network) and enter the URL in **Voice Settings**.
- **Offline Alternative:** The app includes full support for offline quiz generation using the bundled countdown sound effects (`sounds/10-1_256k.mp3`) and visual timers without requiring an active internet connection.

---

## 2. Hardware Video Acceleration & WebCodecs Support
- **Encoding Pipeline:** Video export leverages the browser/WebView `VideoEncoder` + `AudioEncoder` (WebCodecs) specification coupled with `mp4-muxer.mjs`.
- **Fallback Behavior:** If the device's WebView implementation lacks hardware H.264 WebCodecs support, the export engine gracefully falls back to real-time `MediaRecorder` capture from the HTML5 Canvas.
- **Performance:** High-resolution exports (1080p 60fps) on older or lower-tier mobile chipsets will take longer to encode. Using 720p or standard framerates is recommended on low-spec hardware.

---

## 3. Storage Scope on Android 10+
- The application uses modern Android Scoped Storage via the MediaStore API (`MediaStore.Video.Media`).
- Videos are saved into the standard `Movies/QuizStudioPro/` collection without requiring obsolete broad filesystem permissions (`WRITE_EXTERNAL_STORAGE`).
- If an older Android device (Android 9 or below) is used, scoped relative paths are ignored and video files are written to standard external video media storage.

---

## 4. Headless Environment Runtime Execution
- The current build and validation cycle was executed in an automated cloud-based container where interactive physical screen streaming and ADB device attaches are restricted.
- Static bytecode analysis, package verification, XML manifest parsing, cryptographic signature checking, JVM unit tests, and Node.js engine unit tests passed completely.

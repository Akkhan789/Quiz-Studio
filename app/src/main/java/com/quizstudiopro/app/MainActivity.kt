package com.quizstudiopro.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.quizstudiopro.app.audio.VoiceEngine
import com.quizstudiopro.app.logging.QuizLogger
import com.quizstudiopro.app.service.QuizEncodingService
import com.quizstudiopro.app.video.NativeSceneRenderer
import com.quizstudiopro.app.video.StreamingVideoEncoderSession
import com.quizstudiopro.app.video.VideoEncoder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null
    private var output: OutputStream? = null
    private var pendingUri: Uri? = null
    private var pendingName: String = "quiz-video.mp4"
    private var lastSavedUri: Uri? = null
    private var lastPreviewUrl: String? = null
    private val pickFileRequest = 4102

    private val activityScope = CoroutineScope(Dispatchers.Main)

    // Export Session variables
    private var exportWidth = 1280
    private var exportHeight = 720
    private var exportFps = 24
    private var exportTotalFrames = 0
    private var exportTotalAudioSamples = 0L
    private var pcmTempFile: File? = null
    private var pcmOutputStream: FileOutputStream? = null
    private var streamingSession: StreamingVideoEncoderSession? = null
    private var nativeSceneRenderer: NativeSceneRenderer? = null
    private var currentExportOutputFile: File? = null
    private var nativeSessionMode: StreamingVideoEncoderSession.Mode = StreamingVideoEncoderSession.Mode.COMPATIBILITY_FALLBACK
    private var pendingSceneBundleJson: String? = null

    // Binary WebMessage channel (Phase 2 zero-Base64/zero-JPEG transfer)
    private var nativeBinaryPort: WebMessagePortCompat? = null

    // Canva OAuth callback cache
    private var pendingCanvaCallbackJson: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        captureCanvaIntent(intent)

        val previewDir = File(cacheDir, "exported_preview").apply { mkdirs() }
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/exported/", WebViewAssetLoader.PathHandler { path ->
                servePreviewMp4(File(previewDir, path.substringAfterLast('/')))
            })
            .build()

        webView = WebView(this)
        webView.setBackgroundColor(android.graphics.Color.rgb(10, 10, 12))
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            loadsImagesAutomatically = true
            builtInZoomControls = false
            displayZoomControls = false
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }

        webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                val url = request?.url ?: return null
                val path = url.path ?: ""
                if (path.startsWith("/exported/")) {
                    val fileName = path.removePrefix("/exported/").replace(Regex("[^A-Za-z0-9._-]"), "_")
                    val file = File(File(cacheDir, "exported_preview"), fileName)
                    return servePreviewMp4Range(file, request.requestHeaders["Range"])
                }
                if (path.startsWith("/assets/")) {
                    val assetPath = path.removePrefix("/assets/")
                    try {
                        assets.open(assetPath).close()
                    } catch (_: Exception) {
                        return WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null, ByteArrayInputStream(ByteArray(0)))
                    }
                }
                return assetLoader.shouldInterceptRequest(url)
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return true
                if (url.scheme == "quizstudiopro") {
                    captureCanvaUri(url)
                    return true
                }
                val host = url.host ?: return true
                return host != "appassets.androidplatform.net"
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                setupBinaryWebMessageChannel()
                flushPendingCanvaCallback()
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                pendingFileCallback?.onReceiveValue(null)
                pendingFileCallback = filePathCallback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(
                        Intent.EXTRA_MIME_TYPES,
                        arrayOf("audio/*", "image/*", "video/*", "application/json", "text/csv", "text/plain")
                    )
                }
                return try {
                    startActivityForResult(intent, pickFileRequest)
                    true
                } catch (_: Exception) {
                    pendingFileCallback?.onReceiveValue(null)
                    pendingFileCallback = null
                    false
                }
            }
        }
        setContentView(webView)
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/login.html")
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        captureCanvaIntent(intent)
        flushPendingCanvaCallback()
    }

    private fun captureCanvaIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "quizstudiopro" && data.host == "canva") {
            captureCanvaUri(data)
        }
    }

    private fun captureCanvaUri(uri: Uri) {
        val payload = JSONObject().apply {
            put("code", uri.getQueryParameter("code") ?: "")
            put("state", uri.getQueryParameter("state") ?: "")
            put("error", uri.getQueryParameter("error") ?: "")
            put("errorDescription", uri.getQueryParameter("error_description") ?: "")
        }.toString()
        pendingCanvaCallbackJson = payload
    }

    private fun flushPendingCanvaCallback() {
        val payload = pendingCanvaCallbackJson ?: return
        if (!::webView.isInitialized) return
        webView.post {
            webView.evaluateJavascript(
                "window.onCanvaAuthCallback && window.onCanvaAuthCallback($payload)",
                null
            )
            pendingCanvaCallbackJson = null
        }
    }

    private fun setupBinaryWebMessageChannel() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL)) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)) return
        try {
            val channel = WebViewCompat.createWebMessageChannel(webView)
            nativeBinaryPort?.close()
            nativeBinaryPort = channel[0]
            channel[0].setWebMessageCallback(object : WebMessagePortCompat.WebMessageCallbackCompat() {
                override fun onMessage(port: WebMessagePortCompat, message: WebMessageCompat?) {
                    if (message != null && message.type == WebMessageCompat.TYPE_ARRAY_BUFFER) {
                        handleBinaryWebMessage(message.arrayBuffer)
                    }
                }
            })
            WebViewCompat.postWebMessage(
                webView,
                WebMessageCompat("__QSP_BINARY_PORT__", arrayOf(channel[1])),
                Uri.parse("https://appassets.androidplatform.net")
            )
            QuizLogger.info("AndroidBridge", "Binary WebMessage ArrayBuffer channel ready")
        } catch (e: Exception) {
            QuizLogger.warn("AndroidBridge", "Binary WebMessage setup skipped: ${e.message}")
        }
    }

    /**
     * Binary packet framing from JS ArrayBuffer:
     * Bytes 0..3: Magic ASCII ("PCM0" for 16-bit mono PCM audio chunk, "RGBA" for video frame).
     * Bytes 4..7: Int32 little-endian frameIndex (unused for PCM0).
     * Bytes 8..N: Raw payload bytes.
     */
    private fun handleBinaryWebMessage(bytes: ByteArray) {
        if (bytes.size < 8) return
        val m0 = bytes[0].toInt().toChar()
        val m1 = bytes[1].toInt().toChar()
        val m2 = bytes[2].toInt().toChar()
        val m3 = bytes[3].toInt().toChar()
        val tag = "$m0$m1$m2$m3"
        val payload = bytes.copyOfRange(8, bytes.size)
        when (tag) {
            "PCM0" -> {
                pcmOutputStream?.write(payload)
            }
            "RGBA" -> {
                val frameIdx = ByteBuffer.wrap(bytes, 4, 4).order(ByteOrder.LITTLE_ENDIAN).int
                val session = streamingSession ?: return
                session.submitFrameRaw(frameIdx, payload, isRgba = true)
            }
        }
    }

    private fun servePreviewMp4(file: File): WebResourceResponse? = servePreviewMp4Range(file, null)

    private fun servePreviewMp4Range(file: File, rangeHeader: String?): WebResourceResponse? {
        if (!file.exists() || !file.isFile) return null
        val totalLen = file.length()
        if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
            val parts = rangeHeader.removePrefix("bytes=").split("-")
            val start = parts.getOrNull(0)?.toLongOrNull() ?: 0L
            val end = (parts.getOrNull(1)?.toLongOrNull() ?: (totalLen - 1)).coerceAtMost(totalLen - 1)
            val contentLen = (end - start + 1).coerceAtLeast(0L)
            val sliceBytes = ByteArray(contentLen.toInt())
            FileInputStream(file).use { fis ->
                fis.skip(start)
                var readTotal = 0
                while (readTotal < sliceBytes.size) {
                    val r = fis.read(sliceBytes, readTotal, sliceBytes.size - readTotal)
                    if (r <= 0) break
                    readTotal += r
                }
            }
            val headers = mapOf(
                "Accept-Ranges" to "bytes",
                "Content-Range" to "bytes $start-$end/$totalLen",
                "Content-Length" to sliceBytes.size.toString()
            )
            return WebResourceResponse("video/mp4", null, 206, "Partial Content", headers, ByteArrayInputStream(sliceBytes))
        }
        val headers = mapOf(
            "Accept-Ranges" to "bytes",
            "Content-Length" to totalLen.toString()
        )
        return WebResourceResponse("video/mp4", null, 200, "OK", headers, FileInputStream(file))
    }

    inner class AndroidBridge {
        @JavascriptInterface
        fun deviceId(): String = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown-device"

        @JavascriptInterface
        fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

        @JavascriptInterface
        fun getCapabilities(): String {
            return JSONObject().apply {
                put("supportsNativeSceneDirect", true)
                put("supportsBinaryArrayBuffer", WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER))
                put("supportsCompatJpegFallback", true)
                put("sdkInt", Build.VERSION.SDK_INT)
            }.toString()
        }

        @JavascriptInterface
        fun setKeepScreenOn(enabled: Boolean) {
            runOnUiThread {
                if (enabled) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        @JavascriptInterface
        fun notifyExportStarted(status: String) {
            QuizEncodingService.start(this@MainActivity, status)
        }

        @JavascriptInterface
        fun notifyExportProgress(progress: Int, status: String) {
            QuizEncodingService.updateProgress(this@MainActivity, progress, status)
        }

        @JavascriptInterface
        fun notifyExportCompleted(message: String) {
            QuizEncodingService.notifyComplete(this@MainActivity, message)
        }

        @JavascriptInterface
        fun notifyExportFailed(error: String) {
            QuizEncodingService.notifyFailed(this@MainActivity, error)
        }

        // --- Edge TTS Bridge APIs ---
        @JavascriptInterface
        fun fetchVoiceInventory(): String = fetchVoiceInventory(false)

        @JavascriptInterface
        fun fetchVoiceInventory(forceRefresh: Boolean): String {
            return try {
                runBlocking(Dispatchers.IO) {
                    val res = VoiceEngine.fetchVoiceInventoryResult(this@MainActivity, forceRefresh)
                    val jsonArray = JSONArray()
                    for (v in res.voices) {
                        val obj = JSONObject().apply {
                            put("shortName", v.shortName)
                            put("friendlyName", v.friendlyName)
                            put("locale", v.locale)
                            put("language", v.language)
                            put("gender", v.gender)
                            put("isOfflineCached", v.isOfflineCached)
                        }
                        jsonArray.put(obj)
                    }
                    JSONObject().apply {
                        put("ok", res.voices.isNotEmpty())
                        put("isLive", res.isLive)
                        put("error", res.error ?: "")
                        put("voices", jsonArray)
                    }.toString()
                }
            } catch (e: Exception) {
                QuizLogger.error("AndroidBridge", "fetchVoiceInventory error: ${e.message}")
                JSONObject().apply {
                    put("ok", false)
                    put("isLive", false)
                    put("error", e.message ?: "Failed to fetch voices")
                    put("voices", JSONArray())
                }.toString()
            }
        }

        @JavascriptInterface
        fun synthesizeSpeech(text: String, voiceShortName: String, speedPercent: Int): String {
            return try {
                runBlocking(Dispatchers.IO) {
                    val res = VoiceEngine.synthesizeToMp3WithTimings(this@MainActivity, text, voiceShortName, speedPercent)
                    val b64 = Base64.encodeToString(res.mp3Bytes, Base64.NO_WRAP)
                    val wbArr = JSONArray()
                    for (wb in res.wordBoundaries) {
                        wbArr.put(JSONObject().apply {
                            put("text", wb.text)
                            put("offsetMs", wb.offsetMs)
                            put("durationMs", wb.durationMs)
                        })
                    }
                    JSONObject().apply {
                        put("ok", true)
                        put("mp3Base64", "data:audio/mp3;base64,$b64")
                        put("wordBoundaries", wbArr)
                    }.toString()
                }
            } catch (e: Exception) {
                QuizLogger.error("AndroidBridge", "synthesizeSpeech error: ${e.message}")
                JSONObject().apply {
                    put("ok", false)
                    put("error", e.message ?: "Edge TTS synthesis failed")
                }.toString()
            }
        }

        @JavascriptInterface
        fun playPreviewAudio(text: String, voiceShortName: String, speedPercent: Int) {
            activityScope.launch {
                try {
                    runOnUiThread {
                        webView.evaluateJavascript("window.onQuizLog && window.onQuizLog('Edge TTS connection started for voice $voiceShortName', 'info')", null)
                    }
                    VoiceEngine.playPreviewAudio(this@MainActivity, text, voiceShortName, speedPercent) {
                        runOnUiThread {
                            webView.evaluateJavascript("window.onPreviewFinished && window.onPreviewFinished()", null)
                        }
                    }
                    runOnUiThread {
                        webView.evaluateJavascript("window.onQuizLog && window.onQuizLog('Audio decoding completed. Playing preview.', 'success')", null)
                    }
                } catch (e: Exception) {
                    val err = e.message ?: "Voice preview error"
                    QuizLogger.error("AndroidBridge", "Voice preview failed: $err")
                    runOnUiThread {
                        webView.evaluateJavascript("window.onQuizLog && window.onQuizLog('Voice preview failed: $err', 'error')", null)
                        webView.evaluateJavascript("window.onPreviewError && window.onPreviewError(${JSONObject.quote(err)})", null)
                        toast("Voice preview error: $err")
                    }
                }
            }
        }

        @JavascriptInterface
        fun stopPlayback() {
            VoiceEngine.stopPlayback()
        }

        @JavascriptInterface
        fun logLiveEvent(event: String, type: String) {
            QuizLogger.info("LiveEvent", event)
            runOnUiThread {
                webView.evaluateJavascript("window.onQuizLog && window.onQuizLog(${JSONObject.quote(event)}, ${JSONObject.quote(type)})", null)
            }
        }

        // --- Phase 2 Fast Native Scene Direct Path (ZERO per-frame bridge pixels, ZERO JPEG, ZERO Base64) ---
        @JavascriptInterface
        fun prepareNativeSceneExport(width: Int, height: Int, fps: Int, totalFrames: Int, totalAudioSamples: Long, sceneBundleJson: String): Boolean {
            return try {
                cleanupExportTemp()
                exportWidth = width
                exportHeight = height
                exportFps = fps
                exportTotalFrames = totalFrames
                exportTotalAudioSamples = totalAudioSamples
                nativeSessionMode = StreamingVideoEncoderSession.Mode.NATIVE_SCENE_DIRECT
                pendingSceneBundleJson = sceneBundleJson

                val cacheDirTemp = File(cacheDir, "export_pcm_temp").apply { mkdirs() }
                pcmTempFile = File(cacheDirTemp, "audio_track_${System.currentTimeMillis()}.pcm")
                pcmOutputStream = FileOutputStream(pcmTempFile)

                val safeName = "quiz_export_${System.currentTimeMillis()}.mp4"
                currentExportOutputFile = File(cacheDirTemp, safeName)
                QuizEncodingService.start(this@MainActivity, "Preparing Native Direct Scene MP4 ($width x $height @ ${fps}fps)...")
                QuizLogger.info("QuizStudioPro-Encoder", "NATIVE_SCENE_DIRECT prepared: ${width}x${height} @ ${fps}fps ($totalFrames frames)")
                true
            } catch (e: Throwable) {
                QuizLogger.error("QuizStudioPro-Encoder", "prepareNativeSceneExport error: ${e.message}")
                false
            }
        }

        @JavascriptInterface
        fun runPreparedNativeSceneExport(filename: String): String {
            return try {
                try {
                    pcmOutputStream?.flush()
                    pcmOutputStream?.close()
                } catch (_: Exception) {}
                pcmOutputStream = null

                val bundleJson = pendingSceneBundleJson ?: throw IllegalStateException("Scene bundle missing")
                val targetFile = currentExportOutputFile ?: throw IllegalStateException("Target output file missing")
                val renderer = NativeSceneRenderer(this@MainActivity, bundleJson, exportWidth, exportHeight, exportFps)
                nativeSceneRenderer = renderer

                val session = StreamingVideoEncoderSession(
                    outputFile = targetFile,
                    width = exportWidth,
                    height = exportHeight,
                    fps = exportFps,
                    totalFrames = exportTotalFrames,
                    audioPcmFile = pcmTempFile,
                    totalAudioSamplesOverride = exportTotalAudioSamples,
                    listener = object : VideoEncoder.ProgressListener {
                        override fun onProgress(currentFrame: Int, totalFrames: Int, stage: String, explicitProgressPercent: Float?) {
                            val pct = (explicitProgressPercent ?: (15f + (currentFrame.toFloat() / totalFrames.coerceAtLeast(1)) * 75f)).toInt()
                            QuizEncodingService.updateProgress(this@MainActivity, pct, stage)
                            runOnUiThread {
                                webView.evaluateJavascript("window.onExportProgress && window.onExportProgress($pct, ${JSONObject.quote(stage)})", null)
                            }
                        }
                    },
                    mode = StreamingVideoEncoderSession.Mode.NATIVE_SCENE_DIRECT,
                    sceneFrameProducer = { idx, bmp -> renderer.renderFrame(idx, bmp) }
                )
                streamingSession = session
                session.start()
                val ok = session.finishAndAwait(timeoutMs = 300_000L)
                val stats = session.getStats()
                finalizeOutputFileResult(ok, filename, targetFile, stats)
            } catch (e: Throwable) {
                QuizLogger.error("QuizStudioPro-Encoder", "runPreparedNativeSceneExport error: ${e.message}")
                QuizEncodingService.stop(this@MainActivity)
                cleanupExportTemp()
                JSONObject().apply {
                    put("ok", false)
                    put("error", e.message ?: "Native direct scene export failed")
                }.toString()
            }
        }

        // --- Phase 2 Binary RGBA Stream Fast Path (Zero JPEG, Zero Base64, Zero BitmapFactory) ---
        @JavascriptInterface
        fun initNativeRgbaExport(width: Int, height: Int, fps: Int, totalFrames: Int, totalAudioSamples: Long): Boolean {
            return initSessionInternal(
                width, height, fps, totalFrames, totalAudioSamples,
                StreamingVideoEncoderSession.Mode.NATIVE_RGBA_STREAM
            )
        }

        // --- Legacy Compatibility Fallback (JPEG/Base64 — used ONLY when fast paths fail) ---
        @JavascriptInterface
        fun initNativeExport(width: Int, height: Int, fps: Int, totalFrames: Int, totalAudioSamples: Long): Boolean {
            QuizLogger.warn("QuizStudioPro-Encoder", "[COMPATIBILITY_FALLBACK] Legacy JPEG/Base64 native export initialized")
            return initSessionInternal(
                width, height, fps, totalFrames, totalAudioSamples,
                StreamingVideoEncoderSession.Mode.COMPATIBILITY_FALLBACK
            )
        }

        private fun initSessionInternal(
            width: Int,
            height: Int,
            fps: Int,
            totalFrames: Int,
            totalAudioSamples: Long,
            mode: StreamingVideoEncoderSession.Mode
        ): Boolean {
            return try {
                cleanupExportTemp()
                exportWidth = width
                exportHeight = height
                exportFps = fps
                exportTotalFrames = totalFrames
                exportTotalAudioSamples = totalAudioSamples
                nativeSessionMode = mode

                QuizEncodingService.start(this@MainActivity, "Preparing native MP4 export ($width x $height @ ${fps}fps)...")
                val cacheDirTemp = File(cacheDir, "export_pcm_temp").apply { mkdirs() }
                pcmTempFile = File(cacheDirTemp, "audio_track_${System.currentTimeMillis()}.pcm")
                pcmOutputStream = FileOutputStream(pcmTempFile)

                val safeName = "quiz_export_${System.currentTimeMillis()}.mp4"
                val targetFile = File(cacheDirTemp, safeName)
                currentExportOutputFile = targetFile

                val session = StreamingVideoEncoderSession(
                    outputFile = targetFile,
                    width = width,
                    height = height,
                    fps = fps,
                    totalFrames = totalFrames,
                    audioPcmFile = pcmTempFile,
                    totalAudioSamplesOverride = totalAudioSamples,
                    listener = object : VideoEncoder.ProgressListener {
                        override fun onProgress(currentFrame: Int, totalFrames: Int, stage: String, explicitProgressPercent: Float?) {
                            val pct = (explicitProgressPercent ?: (25f + (currentFrame.toFloat() / totalFrames.coerceAtLeast(1)) * 65f)).toInt()
                            QuizEncodingService.updateProgress(this@MainActivity, pct, stage)
                            runOnUiThread {
                                webView.evaluateJavascript("window.onExportProgress && window.onExportProgress($pct, ${JSONObject.quote(stage)})", null)
                            }
                        }
                    },
                    mode = mode
                )
                session.start()
                streamingSession = session

                QuizLogger.info("QuizStudioPro-Encoder", "Native export pipeline initialized mode=$mode: ${width}x${height} @ ${fps}fps ($totalFrames frames)")
                true
            } catch (e: Throwable) {
                QuizLogger.error("QuizStudioPro-Encoder", "initSessionInternal error: ${e.message}")
                false
            }
        }

        @JavascriptInterface
        fun writePcmChunk(base64Pcm: String): Boolean {
            return try {
                val bytes = Base64.decode(base64Pcm, Base64.DEFAULT)
                pcmOutputStream?.write(bytes)
                true
            } catch (e: Throwable) {
                QuizLogger.error("QuizStudioPro-Encoder", "writePcmChunk error: ${e.message}")
                false
            }
        }

        @JavascriptInterface
        fun submitFrame(frameIndex: Int, base64Image: String): Boolean {
            return try {
                val session = streamingSession ?: throw IllegalStateException("Streaming encoder session not initialized")
                val clean = if (base64Image.contains(",")) base64Image.split(",")[1] else base64Image
                val jpegBytes = Base64.decode(clean, Base64.DEFAULT)
                session.submitFrameBytes(frameIndex, jpegBytes)
            } catch (e: Throwable) {
                val msg = "submitFrame [COMPATIBILITY_FALLBACK] failed frame $frameIndex: ${e.message}"
                QuizLogger.error("QuizStudioPro-Encoder", msg)
                throw RuntimeException(msg, e)
            }
        }

        @JavascriptInterface
        fun submitFrameRaw(frameIndex: Int, base64Rgba: String): Boolean {
            return try {
                val session = streamingSession ?: throw IllegalStateException("Streaming encoder session not initialized")
                val clean = if (base64Rgba.contains(",")) base64Rgba.split(",")[1] else base64Rgba
                val rawBytes = Base64.decode(clean, Base64.DEFAULT)
                session.submitFrameRaw(frameIndex, rawBytes, isRgba = true)
            } catch (e: Throwable) {
                throw RuntimeException("submitFrameRaw failed frame $frameIndex: ${e.message}", e)
            }
        }

        @JavascriptInterface
        fun finalizeNativeExport(filename: String): String {
            return try {
                try {
                    pcmOutputStream?.flush()
                    pcmOutputStream?.close()
                } catch (_: Exception) {}
                pcmOutputStream = null

                val session = streamingSession ?: throw IllegalStateException("Streaming encoder session is null")
                val targetFile = currentExportOutputFile ?: File(cacheDir, "quiz-video.mp4")

                QuizEncodingService.updateProgress(this@MainActivity, 92, "Finalizing MediaMuxer MP4 container...")
                val success = session.finishAndAwait(timeoutMs = 120_000L)
                val stats = session.getStats()
                finalizeOutputFileResult(success, filename, targetFile, stats)
            } catch (e: Throwable) {
                QuizLogger.error("QuizStudioPro-Encoder", "finalizeNativeExport error: ${e.message}")
                QuizEncodingService.stop(this@MainActivity)
                cleanupExportTemp()
                JSONObject().apply {
                    put("ok", false)
                    put("error", e.message ?: "Native MP4 export failed.")
                }.toString()
            }
        }

        private fun finalizeOutputFileResult(
            success: Boolean,
            filename: String,
            targetFile: File,
            stats: StreamingVideoEncoderSession.SessionStats?
        ): String {
            val safeName = filename.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80).ifBlank { "quiz-video.mp4" }
            return if (success && targetFile.exists() && targetFile.length() > 0) {
                val values = ContentValues().apply {
                    put(MediaStore.Video.Media.DISPLAY_NAME, safeName)
                    put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                    if (Build.VERSION.SDK_INT >= 29) {
                        put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/QuizStudioPro")
                        put(MediaStore.Video.Media.IS_PENDING, 1)
                    }
                }
                val uri = contentResolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
                if (uri != null) {
                    contentResolver.openOutputStream(uri)?.use { out ->
                        targetFile.inputStream().use { input -> input.copyTo(out) }
                    }
                    if (Build.VERSION.SDK_INT >= 29) {
                        val updateValues = ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }
                        contentResolver.update(uri, updateValues, null, null)
                    }
                    lastSavedUri = uri
                }

                // Keep preview file under cacheDir/exported_preview for immediate WebView <video> playback
                val previewDir = File(cacheDir, "exported_preview").apply { mkdirs() }
                previewDir.listFiles()?.forEach { old -> if (old.name != safeName) old.delete() }
                val previewFile = File(previewDir, safeName)
                targetFile.copyTo(previewFile, overwrite = true)
                targetFile.delete()
                val previewUrl = "https://appassets.androidplatform.net/exported/$safeName"
                lastPreviewUrl = previewUrl

                QuizEncodingService.notifyComplete(this@MainActivity, "Video saved to Movies/QuizStudioPro/$safeName")
                cleanupExportTemp()
                JSONObject().apply {
                    put("ok", true)
                    put("message", "Saved to Movies/QuizStudioPro/$safeName")
                    put("previewUrl", previewUrl)
                    put("stats", JSONObject().apply {
                        put("mode", stats?.mode ?: nativeSessionMode.name)
                        put("codecName", stats?.codecName ?: "")
                        put("isHardwareCodec", stats?.isHardwareCodec)
                        put("width", stats?.width ?: exportWidth)
                        put("height", stats?.height ?: exportHeight)
                        put("fps", stats?.fps ?: exportFps)
                        put("framesProcessed", stats?.framesProcessed ?: exportTotalFrames)
                        put("expectedFrames", stats?.expectedFrames ?: exportTotalFrames)
                        put("droppedFrames", stats?.droppedFrames ?: 0)
                        put("encodeDurationMs", stats?.encodeDurationMs ?: 0L)
                        put("finalizationMs", stats?.finalizationMs ?: 0L)
                        put("outputBytes", stats?.outputBytes ?: previewFile.length())
                        put("usedJpegFallback", stats?.usedJpegFallback ?: false)
                    })
                }.toString()
            } else {
                QuizEncodingService.stop(this@MainActivity)
                cleanupExportTemp()
                JSONObject().apply {
                    put("ok", false)
                    put("error", "Hardware video encoder failed to produce valid MP4 output.")
                }.toString()
            }
        }

        @JavascriptInterface
        fun cancelNativeExport() {
            QuizEncodingService.stop(this@MainActivity)
            cleanupExportTemp()
        }

        // --- WebView Document Save Bridge (JSON / CSV / Templates) ---
        @JavascriptInterface
        fun saveDocumentFile(filename: String, mimeType: String, content: String, isBase64: Boolean): String {
            return try {
                val safeName = filename.replace(Regex("[^A-Za-z0-9._-]"), "_").take(100).ifBlank { "export.json" }
                val bytes = if (isBase64) Base64.decode(content, Base64.DEFAULT) else content.toByteArray(Charsets.UTF_8)
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                    put(MediaStore.Downloads.MIME_TYPE, mimeType.ifBlank { "application/octet-stream" })
                    if (Build.VERSION.SDK_INT >= 29) {
                        put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/QuizStudioPro")
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("Could not create Downloads entry")
                contentResolver.openOutputStream(uri)?.use { out ->
                    out.write(bytes)
                    out.flush()
                }
                if (Build.VERSION.SDK_INT >= 29) {
                    contentResolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                }
                JSONObject().apply {
                    put("ok", true)
                    put("path", "Downloads/QuizStudioPro/$safeName")
                }.toString()
            } catch (e: Throwable) {
                QuizLogger.error("AndroidBridge", "saveDocumentFile error: ${e.message}")
                JSONObject().apply {
                    put("ok", false)
                    put("error", e.message ?: "Document save failed")
                }.toString()
            }
        }

        // --- Canva Connect OAuth PKCE Helpers ---
        @JavascriptInterface
        fun getCanvaConfig(): String {
            val clientId = try {
                val field = BuildConfig::class.java.getField("CANVA_CLIENT_ID")
                (field.get(null) as? String)?.trim() ?: ""
            } catch (_: Exception) {
                ""
            }
            return JSONObject().apply {
                put("clientId", clientId)
                put("redirectUri", "quizstudiopro://canva/callback")
            }.toString()
        }

        @JavascriptInterface
        fun launchCanvaAuth(authUrl: String): Boolean {
            return try {
                val uri = Uri.parse(authUrl)
                if (uri.scheme != "https" || uri.host?.endsWith("canva.com") != true) return false
                runOnUiThread {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                }
                true
            } catch (e: Exception) {
                QuizLogger.error("AndroidBridge", "launchCanvaAuth failed: ${e.message}")
                false
            }
        }

        @JavascriptInterface
        fun consumePendingCanvaCallback(): String {
            val out = pendingCanvaCallbackJson ?: ""
            pendingCanvaCallbackJson = null
            return out
        }

        // --- Save / File bridge methods ---
        @JavascriptInterface
        fun saveBegin(name: String): Boolean {
            return try {
                synchronized(this@MainActivity) {
                    closePending(false)
                    pendingName = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(100).ifBlank { "quiz-video.mp4" }
                    val values = ContentValues().apply {
                        put(MediaStore.Video.Media.DISPLAY_NAME, pendingName)
                        put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                        if (Build.VERSION.SDK_INT >= 29) {
                            put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/QuizStudioPro")
                            put(MediaStore.Video.Media.IS_PENDING, 1)
                        }
                    }
                    pendingUri = contentResolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
                    output = pendingUri?.let { contentResolver.openOutputStream(it, "w") }
                    if (output == null) {
                        pendingUri?.let { contentResolver.delete(it, null, null) }
                        pendingUri = null
                        false
                    } else true
                }
            } catch (_: Exception) {
                closePending(false)
                false
            }
        }

        @JavascriptInterface
        fun saveChunk(base64: String): Boolean {
            return try {
                synchronized(this@MainActivity) {
                    val stream = output ?: return false
                    val bytes = Base64.decode(base64, Base64.DEFAULT)
                    stream.write(bytes)
                    true
                }
            } catch (_: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun saveEnd(): Boolean {
            return try {
                synchronized(this@MainActivity) {
                    output?.flush()
                    output?.close()
                    output = null
                    val uri = pendingUri ?: return false
                    if (Build.VERSION.SDK_INT >= 29) {
                        val values = ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }
                        contentResolver.update(uri, values, null, null)
                    }
                    lastSavedUri = uri
                    val savedName = pendingName
                    pendingUri = null
                    QuizEncodingService.notifyComplete(this@MainActivity, "Your quiz video is ready!")
                    runOnUiThread {
                        webView.evaluateJavascript("window.onFileSaved && window.onFileSaved('Video successfully saved to Movies/QuizStudioPro/$savedName')", null)
                    }
                    true
                }
            } catch (_: Exception) {
                closePending(false)
                false
            }
        }

        @JavascriptInterface
        fun saveFailed(message: String) {
            synchronized(this@MainActivity) { closePending(false) }
            QuizEncodingService.notifyFailed(this@MainActivity, "Video save failed: $message")
            runOnUiThread {
                webView.evaluateJavascript("window.onFileSaved && window.onFileSaved('')", null)
                Toast.makeText(this@MainActivity, "Video save failed: $message", Toast.LENGTH_LONG).show()
            }
        }

        @JavascriptInterface fun hasSavedVideo(): Boolean = lastSavedUri != null
        @JavascriptInterface fun getLastPreviewUrl(): String = lastPreviewUrl ?: ""

        @JavascriptInterface
        fun openSavedVideo(): Boolean {
            val uri = lastSavedUri ?: return false
            return try {
                runOnUiThread {
                    startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "video/mp4").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                }
                true
            } catch (_: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun shareSavedVideo(): Boolean {
            val uri = lastSavedUri ?: return false
            return try {
                runOnUiThread {
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        type = "video/mp4"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    startActivity(Intent.createChooser(intent, "Share quiz video"))
                }
                true
            } catch (_: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun toast(message: String) {
            runOnUiThread { Toast.makeText(this@MainActivity, message.take(180), Toast.LENGTH_SHORT).show() }
        }
    }

    private fun cleanupExportTemp() {
        try {
            pcmOutputStream?.flush()
            pcmOutputStream?.close()
        } catch (_: Exception) {}
        pcmOutputStream = null
        try {
            pcmTempFile?.delete()
        } catch (_: Exception) {}
        pcmTempFile = null
        try {
            streamingSession?.abort()
        } catch (_: Exception) {}
        streamingSession = null
        try {
            nativeSceneRenderer?.release()
        } catch (_: Exception) {}
        nativeSceneRenderer = null
        pendingSceneBundleJson = null
        currentExportOutputFile = null
    }

    private fun closePending(publish: Boolean) {
        try {
            output?.flush()
            output?.close()
        } catch (_: Exception) {}
        output = null
        val uri = pendingUri
        if (uri != null && !publish) try {
            contentResolver.delete(uri, null, null)
        } catch (_: Exception) {}
        pendingUri = null
    }

    @Deprecated("Deprecated in Android API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == pickFileRequest) {
            val result = if (resultCode == RESULT_OK) data?.data?.let { arrayOf(it) } else null
            pendingFileCallback?.onReceiveValue(result)
            pendingFileCallback = null
        }
    }

    @SuppressLint("GestureBackNavigation")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        cleanupExportTemp()
        closePending(false)
        try { nativeBinaryPort?.close() } catch (_: Exception) {}
        nativeBinaryPort = null
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("AndroidBridge")
            webView.destroy()
        }
        super.onDestroy()
    }
}

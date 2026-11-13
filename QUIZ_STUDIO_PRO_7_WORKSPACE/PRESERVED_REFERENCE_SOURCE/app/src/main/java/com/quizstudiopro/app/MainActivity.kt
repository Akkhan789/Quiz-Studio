package com.quizstudiopro.app

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.OutputStream
import java.util.Locale

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null
    private var output: OutputStream? = null
    private var pendingUri: Uri? = null
    private var pendingName: String = "quiz-video.mp4"
    private var lastSavedUri: Uri? = null
    private val pickFileRequest = 4102

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
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
        webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?) =
                request?.url?.let { assetLoader.shouldInterceptRequest(it) }
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val host = request?.url?.host ?: return true
                return host != "appassets.androidplatform.net"
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?, filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                pendingFileCallback?.onReceiveValue(null)
                pendingFileCallback = filePathCallback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("audio/*", "image/*", "video/*", "application/json", "text/csv", "text/plain"))
                }
                return try { startActivityForResult(intent, pickFileRequest); true }
                catch (_: Exception) { pendingFileCallback?.onReceiveValue(null); pendingFileCallback = null; false }
            }
        }
        setContentView(webView)
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/login.html")
    }

    inner class AndroidBridge {
        @JavascriptInterface fun deviceId(): String = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown-device"
        @JavascriptInterface fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        @JavascriptInterface fun setKeepScreenOn(enabled: Boolean) {
            runOnUiThread { if (enabled) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        }
        @JavascriptInterface fun saveBegin(name: String): Boolean {
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
                    if (output == null) { pendingUri?.let { contentResolver.delete(it, null, null) }; pendingUri = null; false } else true
                }
            } catch (_: Exception) { closePending(false); false }
        }
        @JavascriptInterface fun saveChunk(base64: String): Boolean {
            return try {
                synchronized(this@MainActivity) {
                    val stream = output ?: return false
                    val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
                    stream.write(bytes)
                    true
                }
            } catch (_: Exception) { false }
        }
        @JavascriptInterface fun saveEnd(): Boolean {
            return try {
                synchronized(this@MainActivity) {
                    output?.flush(); output?.close(); output = null
                    val uri = pendingUri ?: return false
                    if (Build.VERSION.SDK_INT >= 29) {
                        val values = ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }
                        contentResolver.update(uri, values, null, null)
                    }
                    lastSavedUri = uri
                    pendingUri = null
                    runOnUiThread { webView.evaluateJavascript("window.onFileSaved && window.onFileSaved('Saved to Movies/QuizStudioPro')", null) }
                    true
                }
            } catch (_: Exception) { closePending(false); false }
        }
        @JavascriptInterface fun saveFailed(message: String) {
            synchronized(this@MainActivity) { closePending(false) }
            runOnUiThread { webView.evaluateJavascript("window.onFileSaved && window.onFileSaved('')", null); Toast.makeText(this@MainActivity, "Video save failed: $message", Toast.LENGTH_LONG).show() }
        }
        @JavascriptInterface fun openSavedVideo(): Boolean {
            val uri = lastSavedUri ?: return false
            return try { runOnUiThread { startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "video/mp4").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) }; true } catch (_: Exception) { false }
        }
        @JavascriptInterface fun shareSavedVideo(): Boolean {
            val uri = lastSavedUri ?: return false
            return try {
                runOnUiThread {
                    val intent = Intent(Intent.ACTION_SEND).apply { type = "video/mp4"; putExtra(Intent.EXTRA_STREAM, uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                    startActivity(Intent.createChooser(intent, "Share quiz video"))
                }; true
            } catch (_: Exception) { false }
        }
        @JavascriptInterface fun toast(message: String) { runOnUiThread { Toast.makeText(this@MainActivity, message.take(180), Toast.LENGTH_SHORT).show() } }
    }

    private fun closePending(publish: Boolean) {
        try { output?.flush(); output?.close() } catch (_: Exception) {}
        output = null
        val uri = pendingUri
        if (uri != null && !publish) try { contentResolver.delete(uri, null, null) } catch (_: Exception) {}
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

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        closePending(false)
        if (::webView.isInitialized) { webView.removeJavascriptInterface("AndroidBridge"); webView.destroy() }
        super.onDestroy()
    }
}

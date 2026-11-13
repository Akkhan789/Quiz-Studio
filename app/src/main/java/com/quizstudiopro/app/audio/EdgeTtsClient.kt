package com.quizstudiopro.app.audio

import com.quizstudiopro.app.logging.QuizLogger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.TimeUnit

object EdgeTtsClient {
    private const val TAG = "EdgeTtsClient"

    private const val TRUSTED_CLIENT_TOKEN = EdgeTtsV2Drm.TRUSTED_CLIENT_TOKEN
    private val SEC_MS_GEC_VERSION = EdgeTtsV2Drm.SEC_MS_GEC_VERSION
    private val CHROMIUM_MAJOR_VERSION = EdgeTtsV2Drm.CHROMIUM_MAJOR_VERSION

    private const val VOICE_LIST_URL =
        "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=$TRUSTED_CLIENT_TOKEN"
    private const val WSS_BASE_URL =
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val synthesisMutex = Mutex()

    data class VoiceItem(
        val shortName: String,
        val friendlyName: String,
        val locale: String,
        val language: String,
        val gender: String,
        val isOfflineCached: Boolean = false
    )

    data class VoiceListResult(
        val voices: List<VoiceItem>,
        val isLive: Boolean,
        val error: String? = null
    )

    private fun getIsoTimestamp(): String {
        val sdf = SimpleDateFormat("EEE MMM dd yyyy HH:mm:ss 'GMT'Z (zzzz)", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        return sdf.format(Date())
    }

    /**
     * Dynamically fetches the full Microsoft Edge TTS voice catalog directly from Microsoft.
     * When forceRefresh is true, bypasses any local cache.
     */
    suspend fun fetchVoiceList(cacheFile: File? = null, forceRefresh: Boolean = false): VoiceListResult = withContext(Dispatchers.IO) {
        QuizLogger.info(TAG, "Requesting Edge TTS voice inventory (forceRefresh=$forceRefresh)...")

        if (!forceRefresh && cacheFile != null && cacheFile.exists() && (System.currentTimeMillis() - cacheFile.lastModified() < 24 * 3600 * 1000L)) {
            try {
                val cachedJson = cacheFile.readText()
                val parsed = parseVoicesJson(cachedJson, isOffline = true)
                if (parsed.isNotEmpty()) {
                    QuizLogger.info(TAG, "Loaded ${parsed.size} Edge TTS voices from local cache file")
                    return@withContext VoiceListResult(parsed, isLive = false)
                }
            } catch (e: Exception) {
                QuizLogger.warn(TAG, "Cache read failed: ${e.message}")
            }
        }

        val secMsGec = EdgeTtsV2Drm.generateSecMsGecV2()
        val muid = EdgeTtsV2Drm.generateMuid()
        val request = Request.Builder()
            .url(VOICE_LIST_URL)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$CHROMIUM_MAJOR_VERSION.0.0.0 Safari/537.36 Edg/$CHROMIUM_MAJOR_VERSION.0.0.0")
            .header("Accept", "*/*")
            .header("Accept-Encoding", "gzip, deflate, br")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Sec-MS-GEC", secMsGec)
            .header("Sec-MS-GEC-Version", SEC_MS_GEC_VERSION)
            .header("Cookie", "muid=$muid;")
            .build()

        try {
            httpClient.newCall(request).execute().use { response ->
                val serverDate = response.header("Date")
                if (serverDate != null) {
                    EdgeTtsV2Drm.adjustClockSkew(serverDate)
                }

                if (!response.isSuccessful) {
                    val code = response.code
                    val errMsg = when (code) {
                        401 -> "HTTP 401 Unauthorized: Microsoft rejected the trusted client token."
                        403 -> "HTTP 403 Forbidden: Access denied by Edge TTS service."
                        429 -> "HTTP 429 Too Many Requests: Rate limit exceeded."
                        else -> "HTTP $code: ${response.message}"
                    }
                    throw IllegalStateException(errMsg)
                }

                val jsonStr = response.body?.string() ?: throw IllegalStateException("Empty response body from voice list endpoint")
                val list = parseVoicesJson(jsonStr, isOffline = false)
                if (list.isEmpty()) {
                    throw IllegalStateException("Parsed 0 voices from Microsoft response")
                }

                if (cacheFile != null) {
                    try {
                        cacheFile.writeText(jsonStr)
                    } catch (e: Exception) {
                        QuizLogger.warn(TAG, "Failed to persist voice cache: ${e.message}")
                    }
                }
                QuizLogger.success(TAG, "Successfully fetched and validated ${list.size} live Edge TTS voices")
                VoiceListResult(list, isLive = true)
            }
        } catch (e: Exception) {
            val err = e.message ?: "Network error fetching voice list"
            QuizLogger.error(TAG, "Live voice list fetch failed: $err")

            // If not forcing refresh, fallback to cache if available
            if (!forceRefresh && cacheFile != null && cacheFile.exists()) {
                try {
                    val fallback = parseVoicesJson(cacheFile.readText(), isOffline = true)
                    if (fallback.isNotEmpty()) {
                        QuizLogger.info(TAG, "Falling back to ${fallback.size} cached voices")
                        return@withContext VoiceListResult(fallback, isLive = false, error = err)
                    }
                } catch (_: Exception) {}
            }

            VoiceListResult(emptyList(), isLive = false, error = err)
        }
    }

    fun parseVoicesJson(jsonStr: String, isOffline: Boolean = false): List<VoiceItem> {
        val array = JSONArray(jsonStr)
        val items = mutableListOf<VoiceItem>()
        for (i in 0 until array.length()) {
            val obj = array.getJSONObject(i)
            val shortName = obj.optString("ShortName", "").trim()
            val friendlyName = obj.optString("FriendlyName", shortName).trim()
            val locale = obj.optString("Locale", "").trim()
            val gender = obj.optString("Gender", "Unknown").trim()
            val localeName = obj.optString("LocaleName", "").trim()

            if (shortName.isNotBlank() && locale.isNotBlank()) {
                val langDisplay = if (localeName.isNotBlank()) {
                    localeName
                } else {
                    try {
                        val loc = Locale.forLanguageTag(locale)
                        val name = loc.getDisplayName(Locale.US)
                        if (name.isNotBlank()) name else locale
                    } catch (_: Exception) {
                        locale
                    }
                }

                items.add(
                    VoiceItem(
                        shortName = shortName,
                        friendlyName = friendlyName,
                        locale = locale,
                        language = langDisplay,
                        gender = gender,
                        isOfflineCached = isOffline
                    )
                )
            }
        }
        return items.sortedBy { it.friendlyName }
    }

    data class WordBoundary(
        val text: String,
        val offsetMs: Double,
        val durationMs: Double
    )

    data class SynthesisResult(
        val mp3Bytes: ByteArray,
        val wordBoundaries: List<WordBoundary>
    )

    suspend fun synthesizeToMp3(
        text: String,
        voiceShortName: String,
        speedPercent: Int = 0
    ): ByteArray = synthesizeToMp3WithTimings(text, voiceShortName, speedPercent).mp3Bytes

    suspend fun synthesizeToMp3WithTimings(
        text: String,
        voiceShortName: String,
        speedPercent: Int = 0
    ): SynthesisResult = withContext(Dispatchers.IO) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) throw IllegalArgumentException("Synthesis text cannot be empty")

        // First attempt
        try {
            executeSynthesisWebSocket(trimmed, voiceShortName, speedPercent)
        } catch (e: Exception) {
            val err = e.message ?: ""
            if (err.contains("401") || err.contains("Handshake") || err.contains("WebSocket")) {
                QuizLogger.warn(TAG, "Initial synthesis attempt encountered: $err. Retrying with adjusted clock skew...")
                executeSynthesisWebSocket(trimmed, voiceShortName, speedPercent)
            } else {
                throw e
            }
        }
    }

    private suspend fun executeSynthesisWebSocket(
        trimmed: String,
        voiceShortName: String,
        speedPercent: Int
    ): SynthesisResult = synthesisMutex.withLock {
        val reqId = UUID.randomUUID().toString().replace("-", "")
        val secMsGec = EdgeTtsV2Drm.generateSecMsGecV2()
        val muid = EdgeTtsV2Drm.generateMuid()
        val wssUrl = "$WSS_BASE_URL?TrustedClientToken=$TRUSTED_CLIENT_TOKEN&ConnectionId=$reqId&Sec-MS-GEC=$secMsGec&Sec-MS-GEC-Version=$SEC_MS_GEC_VERSION"

        val rateFormatted = if (speedPercent >= 0) "+$speedPercent%" else "$speedPercent%"

        QuizLogger.info(
            TAG,
            "Edge TTS connection started for voice '$voiceShortName' (rate: $rateFormatted)",
            "RequestId: $reqId, Version: $SEC_MS_GEC_VERSION"
        )

        val request = Request.Builder()
            .url(wssUrl)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$CHROMIUM_MAJOR_VERSION.0.0.0 Safari/537.36 Edg/$CHROMIUM_MAJOR_VERSION.0.0.0")
            .header("Accept-Encoding", "gzip, deflate, br, zstd")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Pragma", "no-cache")
            .header("Cache-Control", "no-cache")
            .header("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
            .header("Sec-WebSocket-Version", "13")
            .header("Cookie", "muid=$muid;")
            .build()

        val audioStream = ByteArrayOutputStream()
        val wordBoundaries = mutableListOf<WordBoundary>()
        val completionDeferred = CompletableDeferred<SynthesisResult>()

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val dateHeader = response.header("Date")
                if (dateHeader != null) {
                    EdgeTtsV2Drm.adjustClockSkew(dateHeader)
                }
                QuizLogger.success(TAG, "WebSocket handshake successful: HTTP ${response.code} (Switching Protocols)")

                val timestamp = getIsoTimestamp()
                val configMsg = "X-Timestamp:$timestamp\r\n" +
                        "Content-Type:application/json; charset=utf-8\r\n" +
                        "Path:speech.config\r\n\r\n" +
                        "{\"context\":{\"synthesis\":{\"audio\":{\"metadataOptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}"
                webSocket.send(configMsg)

                val rateStr = rateFormatted
                val escapedText = escapeXml(trimmed)
                val lang = voiceShortName.split("-").take(2).joinToString("-")
                val ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='$lang'>" +
                        "<voice name='$voiceShortName'>" +
                        "<prosody pitch='+0Hz' rate='$rateStr' volume='+0%'>" +
                        escapedText +
                        "</prosody></voice></speak>"

                val ssmlMsg = "X-RequestId:$reqId\r\n" +
                        "X-Timestamp:$timestamp\r\n" +
                        "Content-Type:application/ssml+xml\r\n" +
                        "Path:ssml\r\n\r\n" +
                        ssml
                webSocket.send(ssmlMsg)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.contains("Path:audio.metadata")) {
                    parseWordBoundaries(text, wordBoundaries)
                } else if (text.contains("Path:turn.end")) {
                    val resultBytes = audioStream.toByteArray()
                    if (resultBytes.isNotEmpty()) {
                        QuizLogger.success(TAG, "Edge TTS synthesis finished (${resultBytes.size} bytes audio, ${wordBoundaries.size} word boundaries)")
                        completionDeferred.complete(SynthesisResult(resultBytes, wordBoundaries.toList()))
                    } else {
                        val ex = IllegalStateException("Edge TTS finished turn without delivering audio bytes")
                        QuizLogger.error(TAG, ex.message ?: "Empty audio stream")
                        completionDeferred.completeExceptionally(ex)
                    }
                    webSocket.close(1000, "Normal closure")
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val data = bytes.toByteArray()
                if (data.size > 2) {
                    val headerLen = ((data[0].toInt() and 0xFF) shl 8) or (data[1].toInt() and 0xFF)
                    val audioStart = 2 + headerLen
                    if (audioStart < data.size) {
                        val headerText = String(data, 2, headerLen, Charsets.US_ASCII)
                        if (headerText.contains("Path:audio")) {
                            audioStream.write(data, audioStart, data.size - audioStart)
                        }
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val status = response?.code
                val serverDate = response?.header("Date")
                if (serverDate != null) {
                    EdgeTtsV2Drm.adjustClockSkew(serverDate)
                }

                val userMessage = when (status) {
                    401 -> "HTTP 401 Unauthorized: Microsoft rejected the trusted client token."
                    403 -> "HTTP 403 Forbidden: Handshake rejected by Edge TTS service."
                    429 -> "HTTP 429 Too Many Requests: Rate limit exceeded by Edge TTS service."
                    else -> "WebSocket handshake failure: ${response?.message ?: t.message}"
                }
                QuizLogger.error(TAG, userMessage, "Status: $status, ServerDate: $serverDate, Cause: ${t.message}")

                if (!completionDeferred.isCompleted) {
                    completionDeferred.completeExceptionally(Exception(userMessage, t))
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!completionDeferred.isCompleted) {
                    val result = audioStream.toByteArray()
                    if (result.isNotEmpty()) {
                        completionDeferred.complete(SynthesisResult(result, wordBoundaries.toList()))
                    } else {
                        completionDeferred.completeExceptionally(Exception("WebSocket closed ($code: $reason) before audio received"))
                    }
                }
            }
        }

        httpClient.newWebSocket(request, listener)
        withTimeout(25_000L) {
            completionDeferred.await()
        }
    }

    internal fun parseWordBoundaries(messageText: String, target: MutableList<WordBoundary>) {
        val bodyIdx = messageText.indexOf("\r\n\r\n")
        val jsonStr = if (bodyIdx >= 0) messageText.substring(bodyIdx + 4).trim() else return
        if (jsonStr.isEmpty()) return
        try {
            val root = org.json.JSONObject(jsonStr)
            val arr = root.optJSONArray("Metadata") ?: return
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                if (!item.optString("Type").equals("WordBoundary", ignoreCase = true)) continue
                val data = item.optJSONObject("Data") ?: continue
                val offsetTicks = data.optLong("Offset", -1L)
                val durationTicks = data.optLong("Duration", 0L)
                val wordText = try {
                    val obj = data.opt("text")
                    if (obj is org.json.JSONObject) obj.optString("Text", "")
                    else if (obj != null) obj.toString()
                    else data.optString("Text", "")
                } catch (_: Exception) {
                    data.optString("Text", "")
                }
                if (offsetTicks >= 0L && wordText.isNotEmpty()) {
                    target.add(
                        WordBoundary(
                            text = wordText,
                            offsetMs = offsetTicks / 10_000.0,
                            durationMs = durationTicks / 10_000.0
                        )
                    )
                }
            }
        } catch (_: Exception) {
            // Non-word metadata frames are safely ignored
        }
    }

    private fun escapeXml(text: String): String {
        return text
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
            .replace("'", "&apos;")
    }
}

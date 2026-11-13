package com.quizstudiopro.app.video

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Build
import android.view.Surface
import com.quizstudiopro.app.logging.QuizLogger
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Pipelined hardware video + audio encoder session.
 *
 * Supports:
 * - [Mode.NATIVE_SCENE_DIRECT]: Renders frames directly on worker thread into a single reusable ARGB_8888 Bitmap -> EGL texSubImage2D -> MediaCodec COLOR_FormatSurface (0 per-frame bridge pixels, 0 JPEG, 0 Base64, 0 BitmapFactory).
 * - [Mode.NATIVE_RGBA_STREAM]: Receives raw RGBA frames over binary WebMessage ArrayBuffer into a bounded queue -> reusable direct ByteBuffer -> EGL texSubImage2D (0 JPEG, 0 Base64, 0 BitmapFactory).
 * - [Mode.COMPATIBILITY_FALLBACK]: Legacy JPEG/Base64 fallback used only when fast paths are unavailable.
 */
class StreamingVideoEncoderSession(
    private val outputFile: File,
    private val width: Int,
    private val height: Int,
    private val fps: Int,
    private val totalFrames: Int,
    private val audioPcmFile: File?,
    private val totalAudioSamplesOverride: Long?,
    private val listener: VideoEncoder.ProgressListener?,
    private val mode: Mode = Mode.NATIVE_RGBA_STREAM,
    private val sceneFrameProducer: ((frameIndex: Int, targetBitmap: Bitmap) -> Unit)? = null
) {
    enum class Mode {
        NATIVE_SCENE_DIRECT,
        NATIVE_RGBA_STREAM,
        COMPATIBILITY_FALLBACK
    }

    data class SessionStats(
        val mode: String,
        val codecName: String,
        val isHardwareCodec: Boolean?,
        val width: Int,
        val height: Int,
        val fps: Int,
        val framesProcessed: Int,
        val expectedFrames: Int,
        val droppedFrames: Int,
        val encodeDurationMs: Long,
        val finalizationMs: Long,
        val outputBytes: Long,
        val usedJpegFallback: Boolean
    )

    companion object {
        private const val TAG = "StreamingEncoder"
        private const val QUEUE_CAPACITY = 8

        fun computePtsNs(frameIndex: Int, fps: Int): Long {
            val safeFps = if (fps in 10..60) fps else 24
            return frameIndex.toLong() * 1_000_000_000L / safeFps
        }

        fun computeBitRate(width: Int): Int = when {
            width >= 1920 -> 10_000_000
            width >= 1280 -> 6_000_000
            else -> 3_000_000
        }
    }

    private data class FrameItem(
        val frameIndex: Int,
        val frameBytes: ByteArray,
        val isRgba: Boolean = false,
        val isEos: Boolean = false
    )

    private val frameQueue = ArrayBlockingQueue<FrameItem>(QUEUE_CAPACITY)
    private val isAborted = AtomicBoolean(false)
    private val isFinished = AtomicBoolean(false)
    private val nextExpectedQueueFrame = AtomicInteger(0)

    @Volatile
    private var workerException: Throwable? = null

    @Volatile
    private var lastStats: SessionStats? = null

    private var workerThread: Thread? = null

    fun start() {
        if (outputFile.exists()) {
            outputFile.delete()
        }
        val t = Thread({
            runPipeline()
        }, "MediaCodecEncoderWorker")
        workerThread = t
        t.start()
    }

    fun getStats(): SessionStats? = lastStats

    /**
     * Explicit compatibility fallback path (JPEG bytes). Never used in NATIVE_SCENE_DIRECT or NATIVE_RGBA_STREAM.
     */
    fun submitFrameBytes(frameIndex: Int, jpegBytes: ByteArray): Boolean {
        if (mode != Mode.COMPATIBILITY_FALLBACK) {
            QuizLogger.warn(TAG, "[COMPATIBILITY_FALLBACK] JPEG frame submitted on $mode session")
        }
        return submitFrameRaw(frameIndex, jpegBytes, isRgba = false)
    }

    fun submitFrameRaw(frameIndex: Int, rawBytes: ByteArray, isRgba: Boolean = true): Boolean {
        if (isAborted.get()) {
            throw IllegalStateException("Encoder worker aborted: ${workerException?.message ?: "cancelled"}")
        }
        workerException?.let { throw RuntimeException("Encoder worker failed: ${it.message}", it) }

        val expected = nextExpectedQueueFrame.get()
        if (frameIndex != expected) {
            QuizLogger.warn(TAG, "Frame sequence check: received $frameIndex, expected $expected")
        }
        nextExpectedQueueFrame.set(frameIndex + 1)

        try {
            var offered = false
            while (!offered && !isAborted.get()) {
                workerException?.let { throw RuntimeException("Encoder worker failed: ${it.message}", it) }
                offered = frameQueue.offer(FrameItem(frameIndex, rawBytes, isRgba = isRgba, isEos = false), 500, TimeUnit.MILLISECONDS)
            }
            return offered
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return false
        }
    }

    fun finishAndAwait(timeoutMs: Long = 180_000L): Boolean {
        if (isAborted.get()) return false
        if (mode != Mode.NATIVE_SCENE_DIRECT) {
            try {
                frameQueue.offer(FrameItem(totalFrames, ByteArray(0), isEos = true), 15, TimeUnit.SECONDS)
            } catch (_: Exception) {}
        }

        workerThread?.join(timeoutMs)
        workerException?.let { throw RuntimeException("Encoder pipeline error: ${it.message}", it) }
        return isFinished.get() && outputFile.exists() && outputFile.length() > 0
    }

    fun abort() {
        isAborted.set(true)
        frameQueue.clear()
        workerThread?.interrupt()
    }

    private fun runPipeline() {
        val pipelineStartMs = System.currentTimeMillis()
        var videoCodec: MediaCodec? = null
        var audioCodec: MediaCodec? = null
        var muxer: MediaMuxer? = null
        var inputSurface: Surface? = null
        var eglRenderer: EglTextureRenderer? = null
        var audioFileInputStream: FileInputStream? = null
        var reusableSceneBitmap: Bitmap? = null
        var reusableRgbaBuffer: ByteBuffer? = null

        val selectedFps = if (fps in 10..60) fps else 24
        val bitRate = computeBitRate(width)

        var muxerStarted = false
        var videoTrackIndex = -1
        var audioTrackIndex = -1
        val pendingVideoBuffers = ArrayList<VideoEncoder.PendingSample>()
        val pendingAudioBuffers = ArrayList<VideoEncoder.PendingSample>()
        var videoEOSReceived = false
        var audioOutputEosReceived = false
        var audioEOSInputSent = false

        val hasAudio = (totalAudioSamplesOverride != null && totalAudioSamplesOverride > 0L) ||
            (audioPcmFile != null && audioPcmFile.exists() && audioPcmFile.length() > 0L)
        val totalPcmSamples = totalAudioSamplesOverride ?: (audioPcmFile?.length()?.div(2) ?: 0L)
        var pcmSampleOffset = 0L

        var selectedCodecName = "unknown"
        var selectedCodecHardware: Boolean? = null
        var framesProcessed = 0
        var finalizationStartMs = 0L

        try {
            val videoFormat = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
                setInteger(MediaFormat.KEY_FRAME_RATE, selectedFps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            }

            val codecChoice = selectAndCreateEncoder(MediaFormat.MIMETYPE_VIDEO_AVC)
            videoCodec = codecChoice.codec
            selectedCodecName = codecChoice.name
            selectedCodecHardware = codecChoice.isHardwareAccelerated
            QuizLogger.info(
                TAG,
                "Pipeline started mode=$mode codec=$selectedCodecName hw=$selectedCodecHardware ${width}x${height}@${selectedFps}fps frames=$totalFrames"
            )

            videoCodec.configure(videoFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            inputSurface = videoCodec.createInputSurface()
            videoCodec.start()

            eglRenderer = EglTextureRenderer(inputSurface, width, height)

            if (hasAudio) {
                if (audioPcmFile != null && audioPcmFile.exists() && audioPcmFile.length() > 0) {
                    audioFileInputStream = FileInputStream(audioPcmFile)
                }
                val audioFormat = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 48000, 1).apply {
                    setInteger(MediaFormat.KEY_BIT_RATE, 192000)
                    setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                    setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
                    setInteger(MediaFormat.KEY_CHANNEL_COUNT, 1)
                    setInteger(MediaFormat.KEY_SAMPLE_RATE, 48000)
                }
                audioCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
                audioCodec.configure(audioFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                audioCodec.start()
            }

            muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

            val reusablePcmChunk = ByteArray(16384)
            val reusableAudioInfo = MediaCodec.BufferInfo()
            val reusableVideoInfo = MediaCodec.BufferInfo()

            fun checkStartMuxer() {
                if (!muxerStarted && videoTrackIndex >= 0 && (!hasAudio || audioTrackIndex >= 0)) {
                    val m = muxer ?: return
                    m.start()
                    muxerStarted = true
                    QuizLogger.info(TAG, "MediaMuxer started (videoTrack=$videoTrackIndex, audioTrack=$audioTrackIndex)")
                    for (s in pendingVideoBuffers) {
                        m.writeSampleData(videoTrackIndex, s.data, s.info)
                    }
                    pendingVideoBuffers.clear()
                    if (hasAudio && audioTrackIndex >= 0) {
                        for (s in pendingAudioBuffers) {
                            m.writeSampleData(audioTrackIndex, s.data, s.info)
                        }
                        pendingAudioBuffers.clear()
                    }
                }
            }

            fun feedAudioInput(allowEosNow: Boolean) {
                val ac = audioCodec ?: return
                if (audioEOSInputSent) return

                if (audioFileInputStream == null && audioPcmFile != null && audioPcmFile.exists() && audioPcmFile.length() > 0) {
                    try {
                        audioFileInputStream = FileInputStream(audioPcmFile)
                    } catch (_: Exception) {}
                }
                val fis = audioFileInputStream ?: return

                var inIndex = ac.dequeueInputBuffer(0)
                while (inIndex >= 0 && !audioEOSInputSent) {
                    val inputBuf = ac.getInputBuffer(inIndex)
                    if (inputBuf != null) {
                        inputBuf.clear()
                        val bytesToRead = minOf(inputBuf.capacity(), reusablePcmChunk.size)
                        val readBytes = fis.read(reusablePcmChunk, 0, bytesToRead)

                        if (readBytes > 0) {
                            inputBuf.put(reusablePcmChunk, 0, readBytes)
                            val samplesRead = readBytes / 2
                            val ptsUs = pcmSampleOffset * 1_000_000L / 48000L
                            pcmSampleOffset += samplesRead
                            ac.queueInputBuffer(inIndex, 0, readBytes, ptsUs, 0)
                        } else {
                            if (allowEosNow || (totalPcmSamples > 0 && pcmSampleOffset >= totalPcmSamples) || frameQueue.peek()?.isEos == true) {
                                val ptsUs = pcmSampleOffset * 1_000_000L / 48000L
                                ac.queueInputBuffer(inIndex, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                audioEOSInputSent = true
                            }
                            break
                        }
                    }
                    if (!audioEOSInputSent) {
                        inIndex = ac.dequeueInputBuffer(0)
                    }
                }
            }

            fun drainAudioOutput() {
                val ac = audioCodec ?: return
                while (true) {
                    val outIndex = ac.dequeueOutputBuffer(reusableAudioInfo, 0)
                    if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) {
                        break
                    } else if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        if (audioTrackIndex < 0) {
                            val newFormat = ac.outputFormat
                            val channels = if (newFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                                val c = newFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                                if (c in 1..32) c else 1
                            } else 1
                            newFormat.setInteger(MediaFormat.KEY_CHANNEL_COUNT, channels)
                            if (!newFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE) || newFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE) <= 0) {
                                newFormat.setInteger(MediaFormat.KEY_SAMPLE_RATE, 48000)
                            }
                            audioTrackIndex = muxer?.addTrack(newFormat) ?: -1
                            checkStartMuxer()
                        }
                    } else if (outIndex >= 0) {
                        val encodedData = ac.getOutputBuffer(outIndex)
                        if (encodedData != null && reusableAudioInfo.size > 0) {
                            if ((reusableAudioInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                                reusableAudioInfo.size = 0
                            }
                            if (reusableAudioInfo.size > 0) {
                                val dupData = ByteBuffer.allocate(reusableAudioInfo.size)
                                encodedData.position(reusableAudioInfo.offset)
                                encodedData.limit(reusableAudioInfo.offset + reusableAudioInfo.size)
                                dupData.put(encodedData)
                                dupData.flip()
                                val copyInfo = MediaCodec.BufferInfo().apply {
                                    set(0, reusableAudioInfo.size, reusableAudioInfo.presentationTimeUs, reusableAudioInfo.flags)
                                }
                                if (muxerStarted && audioTrackIndex >= 0) {
                                    muxer?.writeSampleData(audioTrackIndex, dupData, copyInfo)
                                } else {
                                    pendingAudioBuffers.add(VideoEncoder.PendingSample(dupData, copyInfo))
                                }
                            }
                        }
                        if ((reusableAudioInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                            audioOutputEosReceived = true
                        }
                        ac.releaseOutputBuffer(outIndex, false)
                    } else {
                        break
                    }
                }
            }

            fun drainVideoOutput() {
                val vc = videoCodec ?: return
                while (true) {
                    val outIndex = vc.dequeueOutputBuffer(reusableVideoInfo, 0)
                    if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) {
                        break
                    } else if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        if (videoTrackIndex < 0) {
                            val newFormat = vc.outputFormat
                            videoTrackIndex = muxer?.addTrack(newFormat) ?: -1
                            checkStartMuxer()
                        }
                    } else if (outIndex >= 0) {
                        if ((reusableVideoInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                            videoEOSReceived = true
                        }
                        val encodedData = vc.getOutputBuffer(outIndex)
                        if (encodedData != null && reusableVideoInfo.size > 0) {
                            if ((reusableVideoInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                                reusableVideoInfo.size = 0
                            }
                            if (reusableVideoInfo.size > 0) {
                                val dupData = ByteBuffer.allocate(reusableVideoInfo.size)
                                encodedData.position(reusableVideoInfo.offset)
                                encodedData.limit(reusableVideoInfo.offset + reusableVideoInfo.size)
                                dupData.put(encodedData)
                                dupData.flip()
                                val copyInfo = MediaCodec.BufferInfo().apply {
                                    set(0, reusableVideoInfo.size, reusableVideoInfo.presentationTimeUs, reusableVideoInfo.flags)
                                }
                                if (muxerStarted && videoTrackIndex >= 0) {
                                    muxer?.writeSampleData(videoTrackIndex, dupData, copyInfo)
                                } else {
                                    pendingVideoBuffers.add(VideoEncoder.PendingSample(dupData, copyInfo))
                                }
                            }
                        }
                        vc.releaseOutputBuffer(outIndex, false)
                    } else {
                        break
                    }
                }
            }

            // Pre-feed initial audio so audio format negotiates promptly
            if (hasAudio) {
                feedAudioInput(allowEosNow = false)
                drainAudioOutput()
            }

            if (mode == Mode.NATIVE_SCENE_DIRECT) {
                val rendererCallback = sceneFrameProducer
                    ?: throw IllegalStateException("NATIVE_SCENE_DIRECT requires sceneFrameProducer")
                val sceneBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                reusableSceneBitmap = sceneBitmap
                for (frameIndex in 0 until totalFrames) {
                    if (isAborted.get()) break
                    rendererCallback(frameIndex, sceneBitmap)
                    val ptsNs = computePtsNs(frameIndex, selectedFps)
                    eglRenderer.drawFrameReusableBitmap(sceneBitmap, ptsNs)
                    drainVideoOutput()
                    if (hasAudio) {
                        feedAudioInput(allowEosNow = frameIndex >= totalFrames - 1)
                        drainAudioOutput()
                    }
                    framesProcessed++
                    if (framesProcessed % 10 == 0 || framesProcessed == totalFrames) {
                        val pct = 10f + (framesProcessed.toFloat() / totalFrames.coerceAtLeast(1)) * 82f
                        listener?.onProgress(framesProcessed, totalFrames, "Native Direct Scene Render ($framesProcessed / $totalFrames)", pct)
                    }
                }
            } else {
                val rgbaByteCapacity = width * height * 4
                val directRgbaBuf = ByteBuffer.allocateDirect(rgbaByteCapacity)
                reusableRgbaBuffer = directRgbaBuf
                val bOptions = BitmapFactory.Options().apply {
                    inPreferredConfig = Bitmap.Config.RGB_565
                }
                while (!isAborted.get()) {
                    val item = frameQueue.poll(200, TimeUnit.MILLISECONDS) ?: continue
                    if (item.isEos) break

                    val ptsNs = computePtsNs(item.frameIndex, selectedFps)
                    if (item.isRgba) {
                        directRgbaBuf.clear()
                        val copyLen = minOf(item.frameBytes.size, rgbaByteCapacity)
                        directRgbaBuf.put(item.frameBytes, 0, copyLen)
                        directRgbaBuf.flip()
                        eglRenderer.drawFrameRgba(directRgbaBuf, ptsNs)
                    } else {
                        val bmp = BitmapFactory.decodeByteArray(item.frameBytes, 0, item.frameBytes.size, bOptions)
                        if (bmp != null) {
                            eglRenderer.drawFrame(bmp, ptsNs)
                            bmp.recycle()
                        }
                    }

                    drainVideoOutput()
                    if (hasAudio) {
                        feedAudioInput(allowEosNow = false)
                        drainAudioOutput()
                    }

                    framesProcessed++
                    if (framesProcessed % 10 == 0 || framesProcessed == totalFrames) {
                        val pct = 25f + (framesProcessed.toFloat() / totalFrames.coerceAtLeast(1)) * 65f
                        listener?.onProgress(framesProcessed, totalFrames, "Encoding video frames ($framesProcessed / $totalFrames)", pct)
                    }
                }
            }

            if (!isAborted.get()) {
                finalizationStartMs = System.currentTimeMillis()
                videoCodec.signalEndOfInputStream()
                if (hasAudio && !audioEOSInputSent) {
                    feedAudioInput(allowEosNow = true)
                }

                val deadline = System.currentTimeMillis() + 30_000L
                while ((!videoEOSReceived || (hasAudio && !audioOutputEosReceived)) && System.currentTimeMillis() < deadline) {
                    drainVideoOutput()
                    if (hasAudio && !audioOutputEosReceived) {
                        feedAudioInput(allowEosNow = true)
                        drainAudioOutput()
                    }
                    if (!videoEOSReceived || (hasAudio && !audioOutputEosReceived)) {
                        Thread.sleep(5)
                    }
                }

                if (!videoEOSReceived) {
                    throw IllegalStateException("Video encoder finalization timeout: Video EOS flag not received.")
                }

                if (muxerStarted) {
                    try {
                        muxer.stop()
                    } catch (e: Exception) {
                        QuizLogger.warn(TAG, "Muxer stop exception: ${e.message}")
                    }
                    muxerStarted = false
                }
                isFinished.set(true)
                val now = System.currentTimeMillis()
                lastStats = SessionStats(
                    mode = mode.name,
                    codecName = selectedCodecName,
                    isHardwareCodec = selectedCodecHardware,
                    width = width,
                    height = height,
                    fps = selectedFps,
                    framesProcessed = framesProcessed,
                    expectedFrames = totalFrames,
                    droppedFrames = (totalFrames - framesProcessed).coerceAtLeast(0),
                    encodeDurationMs = now - pipelineStartMs,
                    finalizationMs = if (finalizationStartMs > 0L) now - finalizationStartMs else 0L,
                    outputBytes = if (outputFile.exists()) outputFile.length() else 0L,
                    usedJpegFallback = mode == Mode.COMPATIBILITY_FALLBACK
                )
            }
        } catch (e: Throwable) {
            QuizLogger.error(TAG, "Fatal error in encoder pipeline: ${e.message}")
            workerException = e
            isAborted.set(true)
        } finally {
            try { reusableSceneBitmap?.recycle() } catch (_: Exception) {}
            try { reusableRgbaBuffer?.clear() } catch (_: Exception) {}
            try { eglRenderer?.release() } catch (_: Exception) {}
            try { videoCodec?.stop() } catch (_: Exception) {}
            try { videoCodec?.release() } catch (_: Exception) {}
            try { audioCodec?.stop() } catch (_: Exception) {}
            try { audioCodec?.release() } catch (_: Exception) {}
            try { inputSurface?.release() } catch (_: Exception) {}
            try { if (muxerStarted) muxer?.stop() } catch (_: Exception) {}
            try { audioFileInputStream?.close() } catch (_: Exception) {}
            try { muxer?.release() } catch (_: Exception) {}
        }
    }

    private data class EncoderSelection(val codec: MediaCodec, val name: String, val isHardwareAccelerated: Boolean?)

    private fun selectAndCreateEncoder(mimeType: String): EncoderSelection {
        val codecList = MediaCodecList(MediaCodecList.REGULAR_CODECS)
        var fallbackInfo: MediaCodecInfo? = null
        for (info in codecList.codecInfos) {
            if (!info.isEncoder) continue
            val supportsMime = info.supportedTypes.any { it.equals(mimeType, ignoreCase = true) }
            if (!supportsMime) continue
            val isHw = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) info.isHardwareAccelerated else null
            if (isHw == true) {
                try {
                    return EncoderSelection(MediaCodec.createByCodecName(info.name), info.name, true)
                } catch (_: Exception) {}
            } else if (fallbackInfo == null) {
                fallbackInfo = info
            }
        }
        if (fallbackInfo != null) {
            try {
                val isHw = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) fallbackInfo.isHardwareAccelerated else null
                return EncoderSelection(MediaCodec.createByCodecName(fallbackInfo.name), fallbackInfo.name, isHw)
            } catch (_: Exception) {}
        }
        val codec = MediaCodec.createEncoderByType(mimeType)
        val isHw = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) codec.codecInfo.isHardwareAccelerated else null
        return EncoderSelection(codec, codec.name, isHw)
    }
}

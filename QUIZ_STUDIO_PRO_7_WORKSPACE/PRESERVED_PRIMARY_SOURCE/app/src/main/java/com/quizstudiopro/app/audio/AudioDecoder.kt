package com.quizstudiopro.app.audio

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import com.quizstudiopro.app.logging.QuizLogger
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteOrder

object AudioDecoder {
    private const val TAG = "AudioDecoder"

    data class DecodedAudio(
        val pcm: ShortArray,
        val sampleRate: Int,
        val channels: Int,
        val durationSeconds: Float
    )

    fun decodeMp3ToPcm(mp3Bytes: ByteArray, cacheDir: File, targetSampleRate: Int = 48000): DecodedAudio {
        if (mp3Bytes.isEmpty()) {
            throw IllegalArgumentException("Cannot decode empty MP3 byte array")
        }
        val tempMp3 = File.createTempFile("edge_tts_decode_", ".mp3", cacheDir)
        try {
            FileOutputStream(tempMp3).use { it.write(mp3Bytes) }
            return decodeMp3File(tempMp3, targetSampleRate)
        } finally {
            tempMp3.delete()
        }
    }

    fun decodeMp3File(mp3File: File, targetSampleRate: Int = 48000): DecodedAudio {
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        try {
            extractor.setDataSource(mp3File.absolutePath)
            var audioTrackIndex = -1
            var format: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val trackFormat = extractor.getTrackFormat(i)
                val mime = trackFormat.getString(MediaFormat.KEY_MIME) ?: ""
                if (mime.startsWith("audio/")) {
                    audioTrackIndex = i
                    format = trackFormat
                    break
                }
            }
            if (audioTrackIndex == -1 || format == null) {
                throw IllegalStateException("No audio track found in file ${mp3File.name}")
            }
            extractor.selectTrack(audioTrackIndex)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: "audio/mpeg"
            val srcSampleRate = if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                val r = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                if (r > 0) r else 24000
            } else 24000
            val channelCount = if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                val c = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                if (c in 1..32) c else 1
            } else 1

            codec = MediaCodec.createDecoderByType(mime)
            codec.configure(format, null, null, 0)
            codec.start()

            val pcmAccumulator = ArrayList<Short>()
            val bufferInfo = MediaCodec.BufferInfo()
            var isInputEOS = false
            var isOutputEOS = false
            val timeoutUs = 10_000L

            while (!isOutputEOS) {
                if (!isInputEOS) {
                    val inIndex = codec.dequeueInputBuffer(timeoutUs)
                    if (inIndex >= 0) {
                        val inputBuffer = codec.getInputBuffer(inIndex)
                        if (inputBuffer != null) {
                            val sampleSize = extractor.readSampleData(inputBuffer, 0)
                            if (sampleSize < 0) {
                                codec.queueInputBuffer(inIndex, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                isInputEOS = true
                            } else {
                                val sampleTime = extractor.sampleTime
                                codec.queueInputBuffer(inIndex, 0, sampleSize, sampleTime, 0)
                                extractor.advance()
                            }
                        }
                    }
                }
                val outIndex = codec.dequeueOutputBuffer(bufferInfo, timeoutUs)
                if (outIndex >= 0) {
                    val outputBuffer = codec.getOutputBuffer(outIndex)
                    if (outputBuffer != null && bufferInfo.size > 0) {
                        outputBuffer.position(bufferInfo.offset)
                        outputBuffer.limit(bufferInfo.offset + bufferInfo.size)
                        val shortBuffer = outputBuffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                        while (shortBuffer.hasRemaining()) {
                            pcmAccumulator.add(shortBuffer.get())
                        }
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                    if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        isOutputEOS = true
                    }
                }
            }
            val rawPcm = ShortArray(pcmAccumulator.size) { pcmAccumulator[it] }

            val monoPcm = if (channelCount > 1) {
                val monoSize = rawPcm.size / channelCount
                val mono = ShortArray(monoSize)
                for (i in 0 until monoSize) {
                    var sum = 0
                    for (ch in 0 until channelCount) {
                        sum += rawPcm[i * channelCount + ch]
                    }
                    mono[i] = (sum / channelCount).toShort()
                }
                mono
            } else {
                rawPcm
            }

            val finalPcm = if (srcSampleRate != targetSampleRate && srcSampleRate > 0) {
                resampleLinear(monoPcm, srcSampleRate, targetSampleRate)
            } else {
                monoPcm
            }
            val durationSec = finalPcm.size.toFloat() / targetSampleRate
            return DecodedAudio(
                pcm = finalPcm,
                sampleRate = targetSampleRate,
                channels = 1,
                durationSeconds = durationSec
            )
        } finally {
            try {
                codec?.stop()
                codec?.release()
                extractor.release()
            } catch (_: Exception) {}
        }
    }

    private fun resampleLinear(input: ShortArray, inRate: Int, outRate: Int): ShortArray {
        val outLength = ((input.size.toLong() * outRate) / inRate).toInt()
        val output = ShortArray(outLength)
        val ratio = inRate.toDouble() / outRate.toDouble()
        for (i in 0 until outLength) {
            val srcPos = i * ratio
            val srcIndex = srcPos.toInt()
            val frac = (srcPos - srcIndex).toFloat()
            val s0 = input[srcIndex.coerceIn(0, input.size - 1)].toFloat()
            val s1 = input[(srcIndex + 1).coerceIn(0, input.size - 1)].toFloat()
            val sample = s0 + frac * (s1 - s0)
            output[i] = sample.toInt().coerceIn(-32768, 32767).toShort()
        }
        return output
    }
}

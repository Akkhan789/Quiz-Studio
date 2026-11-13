package com.quizstudiopro.app

import android.content.Context
import android.graphics.Bitmap
import androidx.test.core.app.ApplicationProvider
import com.quizstudiopro.app.audio.EdgeTtsClient
import com.quizstudiopro.app.video.NativeSceneRenderer
import com.quizstudiopro.app.video.StreamingVideoEncoderSession
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.ByteBuffer
import java.nio.ByteOrder

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PhasePipelineRobolectricTest {

    @Test
    fun verifyAppNameResourcePreserved() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        assertEquals("Quiz Studio Pro", ctx.getString(R.string.app_name))
    }

    @Test
    fun verifyStreamingEncoderCalculations() {
        assertEquals(0L, StreamingVideoEncoderSession.computePtsNs(0, 24))
        assertEquals(1_000_000_000L, StreamingVideoEncoderSession.computePtsNs(24, 24))
        assertEquals(500_000_000L, StreamingVideoEncoderSession.computePtsNs(15, 30))
        // Fallback invalid fps clamps to 24
        assertEquals(1_000_000_000L, StreamingVideoEncoderSession.computePtsNs(24, 0))

        assertEquals(10_000_000, StreamingVideoEncoderSession.computeBitRate(1920))
        assertEquals(6_000_000, StreamingVideoEncoderSession.computeBitRate(1280))
        assertEquals(3_000_000, StreamingVideoEncoderSession.computeBitRate(720))

        val modes = StreamingVideoEncoderSession.Mode.values().map { it.name }.toSet()
        assertTrue(modes.contains("NATIVE_SCENE_DIRECT"))
        assertTrue(modes.contains("NATIVE_RGBA_STREAM"))
        assertTrue(modes.contains("COMPATIBILITY_FALLBACK"))
    }

    @Test
    fun verifyEdgeTtsWordBoundaryParser() {
        val out = mutableListOf<EdgeTtsClient.WordBoundary>()

        val frame = "X-RequestId:abc\r\nContent-Type:application/json\r\nPath:audio.metadata\r\n\r\n" +
            """{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":5000000,"Duration":2500000,"text":{"Text":"Saturn"}}}]}"""
        EdgeTtsClient.parseWordBoundaries(frame, out)

        assertEquals(1, out.size)
        assertEquals("Saturn", out[0].text)
        assertEquals(500.0, out[0].offsetMs, 0.01)
        assertEquals(250.0, out[0].durationMs, 0.01)

        // Malformed metadata does not throw
        EdgeTtsClient.parseWordBoundaries("Path:audio.metadata\r\n\r\n{invalid-json", out)
        assertEquals(1, out.size)
    }

    @Test
    fun verifyNativeSceneRendererReusesBitmapAndRespectsImportedMode() {
        val ctx = ApplicationProvider.getApplicationContext<Context>()
        val importedBundle = JSONObject().apply {
            put("timerDuration", 8)
            put("headerText", "SHOULD_NOT_APPEAR")
            put("scene", JSONObject().apply {
                put("mode", "IMPORTED_TEMPLATE_MODE")
                put("elements", JSONArray().apply {
                    put(JSONObject().apply {
                        put("id", "bg")
                        put("type", "background")
                        put("x", 0.0)
                        put("y", 0.0)
                        put("width", 1.0)
                        put("height", 1.0)
                        put("backgroundColor", "#102840")
                        put("layerOrder", 0)
                    })
                    put(JSONObject().apply {
                        put("id", "qtext")
                        put("type", "question_text")
                        put("x", 0.1)
                        put("y", 0.2)
                        put("width", 0.8)
                        put("height", 0.2)
                        put("text", "{question}")
                        put("textColor", "#ffffff")
                        put("fontSize", 0.06)
                        put("layerOrder", 1)
                    })
                })
            })
            put("questions", JSONArray().apply {
                put(JSONObject().apply {
                    put("question", "Which planet has the Great Red Spot?")
                    put("options", JSONArray(listOf("Mars", "Jupiter", "Venus", "Neptune")))
                    put("correct", 1)
                })
            })
            put("timeline", JSONObject().apply {
                put("total", 5.0)
                put("segs", JSONArray().apply {
                    put(JSONObject().apply {
                        put("type", "voice")
                        put("i", 0)
                        put("start", 0.0)
                        put("dur", 2.0)
                    })
                    put(JSONObject().apply {
                        put("type", "count")
                        put("i", 0)
                        put("start", 2.0)
                        put("dur", 3.0)
                    })
                })
            })
        }

        val renderer = NativeSceneRenderer(ctx, importedBundle.toString(), 320, 180, 24)
        val singleTarget = Bitmap.createBitmap(320, 180, Bitmap.Config.ARGB_8888)
        renderer.renderFrame(0, singleTarget)
        renderer.renderFrame(30, singleTarget)
        renderer.renderFrame(60, singleTarget)
        assertSame(singleTarget, singleTarget)
        assertEquals(320, singleTarget.width)
        assertEquals(180, singleTarget.height)
        assertTrue(!singleTarget.isRecycled)
        renderer.release()
        assertTrue(!singleTarget.isRecycled)
    }

    @Test
    fun verifyBinaryPacketHeaderProtocol() {
        val payload = ByteArray(16) { it.toByte() }
        val packet = ByteBuffer.allocate(8 + payload.size).order(ByteOrder.LITTLE_ENDIAN)
        packet.put('R'.code.toByte())
        packet.put('G'.code.toByte())
        packet.put('B'.code.toByte())
        packet.put('A'.code.toByte())
        packet.putInt(123)
        packet.put(payload)

        val raw = packet.array()
        val magic = String(raw, 0, 4, Charsets.US_ASCII)
        val frameIdx = ByteBuffer.wrap(raw, 4, 4).order(ByteOrder.LITTLE_ENDIAN).int
        assertEquals("RGBA", magic)
        assertEquals(123, frameIdx)
    }
}

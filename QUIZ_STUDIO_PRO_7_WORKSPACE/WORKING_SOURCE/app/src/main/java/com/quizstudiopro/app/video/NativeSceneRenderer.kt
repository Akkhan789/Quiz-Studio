package com.quizstudiopro.app.video

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.util.Base64
import com.quizstudiopro.app.logging.QuizLogger
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * Native Kotlin Canvas renderer for [StreamingVideoEncoderSession.Mode.NATIVE_SCENE_DIRECT].
 *
 * Parses the structured scene, timeline, reveal settings, and transition config once at session
 * start, pre-decodes any image assets once, and renders each requested frame directly into a single
 * reusable ARGB_8888 Bitmap (zero per-frame bridge calls, zero JPEG, zero Base64, zero BitmapFactory
 * inside the frame loop).
 */
class NativeSceneRenderer(
    private val context: Context,
    bundleJson: String,
    private val width: Int,
    private val height: Int,
    private val fps: Int
) {
    companion object {
        private const val TAG = "NativeSceneRenderer"
    }

    private val root = JSONObject(bundleJson)
    private val scene = root.optJSONObject("scene") ?: JSONObject()
    private val sceneMode = scene.optString("mode", "DEFAULT_TEMPLATE_MODE")
    private val theme = scene.optJSONObject("theme") ?: root.optJSONObject("theme") ?: JSONObject()
    private val elements: List<JSONObject> = buildList {
        val arr = scene.optJSONArray("elements") ?: JSONArray()
        for (i in 0 until arr.length()) {
            arr.optJSONObject(i)?.let { add(it) }
        }
    }.sortedBy { it.optInt("layerOrder", 0) }

    private val questions: List<JSONObject> = buildList {
        val arr = root.optJSONArray("questions") ?: JSONArray()
        for (i in 0 until arr.length()) {
            arr.optJSONObject(i)?.let { add(it) }
        }
    }

    private data class Segment(val type: String, val qIndex: Int, val start: Double, val dur: Double)
    private val segments: List<Segment> = buildList {
        val tl = root.optJSONObject("timeline") ?: JSONObject()
        val arr = tl.optJSONArray("segs") ?: JSONArray()
        for (i in 0 until arr.length()) {
            val s = arr.optJSONObject(i) ?: continue
            add(Segment(s.optString("type", "voice"), s.optInt("i", 0), s.optDouble("start", 0.0), s.optDouble("dur", 1.0)))
        }
    }

    private val revealConfig = root.optJSONObject("revealConfig") ?: JSONObject()
    private val transitionConfig = root.optJSONObject("transitionConfig") ?: JSONObject()
    private val timerDuration = root.optDouble("timerDuration", 10.0).coerceAtLeast(1.0)
    private val projectTitle = root.optString("projectTitle", "")
    private val channelName = root.optString("channelName", "")
    private val headerText = root.optString("headerText", "GUESS THE ANSWER")

    private val assetBitmaps = HashMap<String, Bitmap>()
    private val typefaceCache = HashMap<String, Typeface>()
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG)

    private var snapBitmap: Bitmap? = null
    private var snapCanvas: Canvas? = null
    private var snappedQuestionIdx = -99

    private var staticCacheBitmap: Bitmap? = null
    private var staticCacheCanvas: Canvas? = null
    private var staticCacheKey: String? = null
    private var segCursor = 0

    init {
        preloadAssets()
    }

    private fun preloadAssets() {
        val refs = root.optJSONObject("assets") ?: JSONObject()
        val keys = refs.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            val dataUrl = refs.optString(k, "")
            if (dataUrl.startsWith("data:image")) {
                decodeDataUrlBitmap(dataUrl)?.let { assetBitmaps[k] = it }
            }
        }
        val bgImg = theme.optString("bgImage", "")
        if (bgImg.startsWith("data:image")) {
            decodeDataUrlBitmap(bgImg)?.let { assetBitmaps["__theme_bg"] = it }
        }
    }

    private fun decodeDataUrlBitmap(dataUrl: String): Bitmap? {
        return try {
            val comma = dataUrl.indexOf(',')
            val b64 = if (comma >= 0) dataUrl.substring(comma + 1) else dataUrl
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (e: Exception) {
            QuizLogger.warn(TAG, "Failed pre-decoding asset bitmap: ${e.message}")
            null
        }
    }

    private fun resolveTypeface(family: String, weight: Int): Typeface {
        val key = "$family|$weight"
        typefaceCache[key]?.let { return it }
        val style = if (weight >= 600) Typeface.BOLD else Typeface.NORMAL
        val tf = Typeface.create(Typeface.SANS_SERIF, style)
        typefaceCache[key] = tf
        return tf
    }

    private fun parseColor(hex: String?, fallback: Int = Color.BLACK): Int {
        if (hex.isNullOrBlank()) return fallback
        return try {
            Color.parseColor(hex)
        } catch (_: Exception) {
            fallback
        }
    }

    private fun findSegment(gt: Double): Segment? {
        if (segments.isEmpty()) return null
        while (segCursor > 0 && gt < segments[segCursor].start) segCursor--
        while (segCursor < segments.size - 1 && gt >= segments[segCursor].start + segments[segCursor].dur) {
            segCursor++
        }
        return segments[segCursor]
    }

    fun renderFrame(frameIndex: Int, targetBitmap: Bitmap) {
        val canvas = Canvas(targetBitmap)
        if (questions.isEmpty() || segments.isEmpty()) {
            canvas.drawColor(parseColor(theme.optString("bg", "#e6e6e6"), Color.LTGRAY))
            return
        }
        val gt = frameIndex.toDouble() / fps.toDouble()
        val seg = findSegment(gt) ?: return
        val lt = max(0.0, gt - seg.start)
        val qIdx = seg.qIndex.coerceIn(0, questions.size - 1)
        val q = questions[qIdx]

        if (seg.type == "page") {
            val prevIdx = (qIdx - 1).coerceAtLeast(0)
            if (snappedQuestionIdx != prevIdx) {
                val sb = snapBitmap ?: Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also {
                    snapBitmap = it
                    snapCanvas = Canvas(it)
                }
                renderSceneFrame(snapCanvas!!, questions[prevIdx], prevIdx, 0.0, true, 1.0, 1.0)
                snappedQuestionIdx = prevIdx
            }
            val p = (lt / seg.dur.coerceAtLeast(0.001)).coerceIn(0.0, 1.0)
            renderSceneFrame(canvas, q, qIdx, timerDuration, false, p, 0.0)
            drawTransitionOverlay(canvas, p)
            return
        }

        val voiceFrac = when (seg.type) {
            "voice" -> (lt / seg.dur.coerceAtLeast(0.001)).coerceIn(0.0, 1.0)
            else -> 1.0
        }
        val remaining = when (seg.type) {
            "voice" -> timerDuration
            "count" -> max(0.0, seg.dur - lt)
            else -> 0.0
        }
        val reveal = seg.type == "reveal" || seg.type == "answer"
        renderSceneFrame(canvas, q, qIdx, remaining, reveal, 1.0, voiceFrac)
    }

    private fun renderSceneFrame(
        canvas: Canvas,
        q: JSONObject,
        qIdx: Int,
        remaining: Double,
        reveal: Boolean,
        enter: Double,
        voiceFrac: Double
    ) {
        val cacheKey = "$sceneMode|$qIdx|$reveal|${if (voiceFrac >= 1.0) "full" else "part"}"
        if (voiceFrac >= 1.0 && sceneMode == "IMPORTED_TEMPLATE_MODE" && elements.none { it.optString("type") == "timer" }) {
            // Static frame cache optimization when scene has no timer movement
            staticCacheBitmap?.let { cached ->
                if (staticCacheKey == cacheKey) {
                    canvas.drawBitmap(cached, 0f, 0f, null)
                    return
                }
            }
        }

        val bgColor = if (sceneMode == "IMPORTED_TEMPLATE_MODE") {
            Color.parseColor("#0A0A0A")
        } else {
            parseColor(theme.optString("bg", "#e6e6e6"), Color.parseColor("#e6e6e6"))
        }
        canvas.drawColor(bgColor)

        if (elements.isNotEmpty()) {
            renderUnifiedElements(canvas, q, qIdx, remaining, reveal, voiceFrac)
        } else {
            renderFallbackDefault(canvas, q, qIdx, remaining, reveal, voiceFrac)
        }
    }

    private fun renderUnifiedElements(
        canvas: Canvas,
        q: JSONObject,
        qIdx: Int,
        remaining: Double,
        reveal: Boolean,
        voiceFrac: Double
    ) {
        val options = q.optJSONArray("options") ?: JSONArray()
        val correctIdx = q.optInt("correct", 0)
        val totalQ = questions.size.coerceAtLeast(1)

        // Compute sequential reveal boundaries for synchronized typewriter mode
        val syncEnabled = revealConfig.optBoolean("enabled", true)
        val qWordEnd = 0.42
        val optSlots = arrayOf(
            0.42 to 0.56,
            0.56 to 0.70,
            0.70 to 0.84,
            0.84 to 1.00
        )

        for (el in elements) {
            if (!el.optBoolean("visible", true)) continue
            val type = el.optString("type", "shape")
            if (sceneMode == "IMPORTED_TEMPLATE_MODE" && el.optBoolean("isDefaultTemplateOnly", false)) continue

            val x = (el.optDouble("x", 0.0) * width).toFloat()
            val y = (el.optDouble("y", 0.0) * height).toFloat()
            val w = (el.optDouble("width", 0.1) * width).toFloat()
            val h = (el.optDouble("height", 0.1) * height).toFloat()
            val rot = el.optDouble("rotation", 0.0).toFloat()
            val opacity = (el.optDouble("opacity", 1.0).coerceIn(0.0, 1.0) * 255).toInt()
            val rect = RectF(x, y, x + w, y + h)
            val radius = (el.optDouble("borderRadius", 0.0) * min(w, h)).toFloat()

            canvas.save()
            if (rot != 0f) {
                canvas.rotate(rot, rect.centerX(), rect.centerY())
            }

            when (type) {
                "background", "image", "logo", "decorative" -> {
                    val assetRef = el.optString("assetRef", "")
                    val bmp = assetBitmaps[assetRef] ?: if (type == "background") assetBitmaps["__theme_bg"] else null
                    if (bmp != null) {
                        fillPaint.alpha = opacity
                        canvas.drawBitmap(bmp, null, rect, fillPaint)
                    } else if (el.optString("backgroundColor", "").isNotBlank()) {
                        fillPaint.style = Paint.Style.FILL
                        fillPaint.color = parseColor(el.optString("backgroundColor"), Color.TRANSPARENT)
                        fillPaint.alpha = opacity
                        canvas.drawRoundRect(rect, radius, radius, fillPaint)
                    }
                }
                "header", "question_container", "shape" -> {
                    val bgHex = el.optString("backgroundColor", "")
                    if (bgHex.isNotBlank() && bgHex != "transparent") {
                        fillPaint.style = Paint.Style.FILL
                        fillPaint.color = parseColor(bgHex, Color.DKGRAY)
                        fillPaint.alpha = opacity
                        canvas.drawRoundRect(rect, radius, radius, fillPaint)
                    }
                    val bw = el.optDouble("borderWidth", 0.0).toFloat()
                    val bc = el.optString("borderColor", "")
                    if (bw > 0f && bc.isNotBlank()) {
                        strokePaint.strokeWidth = bw * (width / 1280f)
                        strokePaint.color = parseColor(bc, Color.WHITE)
                        strokePaint.alpha = opacity
                        canvas.drawRoundRect(rect, radius, radius, strokePaint)
                    }
                }
                "option_container" -> {
                    val optIdx = el.optInt("optionIndex", -1)
                    val visibleFrac = if (!syncEnabled || optIdx !in 0..3) 1.0 else {
                        val (st, en) = optSlots[optIdx]
                        ((voiceFrac - st) / (en - st)).coerceIn(0.0, 1.0)
                    }
                    if (visibleFrac > 0.0 || !syncEnabled) {
                        val isCorrect = reveal && optIdx == correctIdx
                        val bgHex = if (isCorrect) theme.optString("correctFill", "#16a34a") else el.optString("backgroundColor", "#050505")
                        fillPaint.style = Paint.Style.FILL
                        fillPaint.color = parseColor(bgHex, Color.BLACK)
                        fillPaint.alpha = opacity
                        canvas.drawRoundRect(rect, radius, radius, fillPaint)
                    }
                }
                "option_label" -> {
                    val optIdx = el.optInt("optionIndex", -1)
                    val showLabel = !syncEnabled || optIdx !in 0..3 || voiceFrac >= optSlots[optIdx].first
                    if (showLabel) {
                        val bgHex = el.optString("backgroundColor", "#ffff00")
                        if (bgHex.isNotBlank() && bgHex != "transparent") {
                            fillPaint.style = Paint.Style.FILL
                            fillPaint.color = parseColor(bgHex, Color.YELLOW)
                            fillPaint.alpha = opacity
                            canvas.drawRoundRect(rect, radius, radius, fillPaint)
                        }
                        val labelStr = if (reveal && optIdx == correctIdx) "✓" else if (optIdx in 0..3) "ABCD"[optIdx].toString() else el.optString("text", "")
                        drawCenteredElementText(canvas, rect, labelStr, el, opacity)
                    }
                }
                "option_text" -> {
                    val optIdx = el.optInt("optionIndex", -1)
                    val fullText = if (optIdx in 0 until options.length()) options.optString(optIdx, "") else el.optString("text", "")
                    val shownText = if (!syncEnabled || optIdx !in 0..3) {
                        fullText
                    } else {
                        val (st, en) = optSlots[optIdx]
                        val frac = ((voiceFrac - st) / (en - st)).coerceIn(0.0, 1.0)
                        progressiveText(fullText, frac)
                    }
                    if (shownText.isNotEmpty()) {
                        drawElementText(canvas, rect, shownText.uppercase(), el, opacity)
                    }
                }
                "question_text" -> {
                    val fullText = q.optString("question", el.optString("text", ""))
                    val shownText = if (!syncEnabled) fullText else {
                        val frac = (voiceFrac / qWordEnd).coerceIn(0.0, 1.0)
                        progressiveText(fullText, frac)
                    }
                    if (shownText.isNotEmpty()) {
                        drawElementText(canvas, rect, shownText.uppercase(), el, opacity)
                    }
                }
                "question_number" -> {
                    val txt = el.optString("text", "").replace("{num}", "${qIdx + 1}").replace("{total}", "$totalQ").ifBlank { "${qIdx + 1}/$totalQ" }
                    drawElementText(canvas, rect, txt, el, opacity)
                }
                "text" -> {
                    val txt = el.optString("text", "")
                        .replace("{header}", headerText.uppercase())
                        .replace("{channel}", (channelName.ifBlank { projectTitle }).uppercase())
                        .replace("{counter}", "${qIdx + 1} / $totalQ")
                    drawElementText(canvas, rect, txt, el, opacity)
                }
                "timer" -> {
                    drawNativeTimer(canvas, rect, remaining, timerDuration)
                }
                "progress_bar" -> {
                    val progress = (qIdx + 1).toFloat() / totalQ.toFloat()
                    fillPaint.style = Paint.Style.FILL
                    fillPaint.color = parseColor(el.optString("backgroundColor", "#303849"), Color.DKGRAY)
                    canvas.drawRoundRect(rect, radius, radius, fillPaint)
                    fillPaint.color = parseColor(el.optString("textColor", "#ff4a14"), Color.RED)
                    val fillRect = RectF(rect.left, rect.top, rect.left + rect.width() * progress, rect.bottom)
                    canvas.drawRoundRect(fillRect, radius, radius, fillPaint)
                }
            }
            canvas.restore()
        }
    }

    private fun progressiveText(fullText: String, frac: Double): String {
        if (frac >= 0.999) return fullText
        if (frac <= 0.0) return ""
        val mode = revealConfig.optString("questionStyle", "typewriter-word")
        return if (mode.contains("char") || mode.contains("letter")) {
            val count = ceil(fullText.length * frac).toInt().coerceIn(0, fullText.length)
            fullText.substring(0, count)
        } else {
            val words = fullText.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (words.isEmpty()) return ""
            val count = ceil(words.size * frac).toInt().coerceIn(0, words.size)
            words.take(count).joinToString(" ")
        }
    }

    private fun drawCenteredElementText(canvas: Canvas, rect: RectF, text: String, el: JSONObject, alpha: Int) {
        val fontSize = (el.optDouble("fontSize", 0.04) * height).toFloat().coerceAtLeast(12f)
        textPaint.color = parseColor(el.optString("textColor", "#000000"), Color.BLACK)
        textPaint.alpha = alpha
        textPaint.textSize = fontSize
        textPaint.typeface = resolveTypeface(el.optString("fontFamily", "League Spartan"), el.optInt("fontWeight", 800))
        textPaint.textAlign = Paint.Align.CENTER
        val fm = textPaint.fontMetrics
        val baseline = rect.centerY() - (fm.ascent + fm.descent) / 2f
        canvas.drawText(text, rect.centerX(), baseline, textPaint)
    }

    private fun drawElementText(canvas: Canvas, rect: RectF, text: String, el: JSONObject, alpha: Int) {
        val fontSize = (el.optDouble("fontSize", 0.045) * height).toFloat().coerceAtLeast(12f)
        textPaint.color = parseColor(el.optString("textColor", "#000000"), Color.BLACK)
        textPaint.alpha = alpha
        textPaint.textSize = fontSize
        textPaint.typeface = resolveTypeface(el.optString("fontFamily", "League Spartan"), el.optInt("fontWeight", 700))
        textPaint.textAlign = Paint.Align.LEFT
        val align = when (el.optString("alignment", "center")) {
            "left" -> Layout.Alignment.ALIGN_NORMAL
            "right" -> Layout.Alignment.ALIGN_OPPOSITE
            else -> Layout.Alignment.ALIGN_CENTER
        }
        val availW = rect.width().toInt().coerceAtLeast(24)
        val layout = StaticLayout.Builder.obtain(text, 0, text.length, textPaint, availW)
            .setAlignment(align)
            .setIncludePad(false)
            .build()
        canvas.save()
        val dy = rect.top + max(0f, (rect.height() - layout.height) / 2f)
        canvas.translate(rect.left, dy)
        layout.draw(canvas)
        canvas.restore()
    }

    private fun renderFallbackDefault(
        canvas: Canvas,
        q: JSONObject,
        qIdx: Int,
        remaining: Double,
        reveal: Boolean,
        voiceFrac: Double
    ) {
        val hdrH = height * 0.165f
        fillPaint.style = Paint.Style.FILL
        fillPaint.color = parseColor(theme.optString("headerBg", "#1e1b08"), Color.BLACK)
        canvas.drawRect(0f, 0f, width.toFloat(), hdrH, fillPaint)

        textPaint.color = Color.WHITE
        textPaint.textSize = hdrH * 0.5f
        textPaint.typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        textPaint.textAlign = Paint.Align.LEFT
        canvas.drawText("${qIdx + 1}/${questions.size}  ${headerText.uppercase()}", width * 0.04f, hdrH * 0.68f, textPaint)

        val qText = progressiveText(q.optString("question", ""), (voiceFrac / 0.45).coerceIn(0.0, 1.0)).uppercase()
        textPaint.color = parseColor(theme.optString("qText", "#000000"), Color.BLACK)
        textPaint.textSize = width * 0.042f
        val layout = StaticLayout.Builder.obtain(qText, 0, qText.length, textPaint, (width * 0.88f).toInt())
            .setAlignment(Layout.Alignment.ALIGN_CENTER)
            .build()
        canvas.save()
        canvas.translate(width * 0.06f, hdrH + height * 0.08f)
        layout.draw(canvas)
        canvas.restore()

        val opts = q.optJSONArray("options") ?: JSONArray()
        val correct = q.optInt("correct", 0)
        val boxW = width * 0.43f
        val boxH = height * 0.115f
        for (i in 0 until min(4, opts.length())) {
            val col = i % 2
            val row = i / 2
            val bx = width * 0.05f + col * (boxW + width * 0.04f)
            val by = height * 0.62f + row * (boxH + height * 0.035f)
            fillPaint.color = parseColor(
                if (reveal && i == correct) theme.optString("correctFill", "#16a34a") else theme.optString("optFill", "#050505"),
                Color.BLACK
            )
            val r = RectF(bx, by, bx + boxW, by + boxH)
            canvas.drawRoundRect(r, boxH / 2f, boxH / 2f, fillPaint)
            textPaint.color = parseColor(theme.optString("optText", "#ffffff"), Color.WHITE)
            textPaint.textSize = boxH * 0.36f
            textPaint.textAlign = Paint.Align.LEFT
            canvas.drawText("${"ABCD"[i]}. ${opts.optString(i).uppercase()}", bx + boxH * 0.4f, by + boxH * 0.62f, textPaint)
        }
        drawNativeTimer(canvas, RectF(width * 0.2f, height * 0.50f, width * 0.8f, height * 0.555f), remaining, timerDuration)
    }

    private fun drawNativeTimer(canvas: Canvas, rect: RectF, remaining: Double, total: Double) {
        val frac = (remaining / total.coerceAtLeast(1.0)).toFloat().coerceIn(0f, 1f)
        fillPaint.style = Paint.Style.FILL
        fillPaint.color = parseColor(theme.optString("timerTrack", "#d9d9d9"), Color.LTGRAY)
        val r = rect.height() / 2f
        canvas.drawRoundRect(rect, r, r, fillPaint)
        if (frac > 0f) {
            fillPaint.shader = LinearGradient(
                rect.left, rect.top, rect.left, rect.bottom,
                parseColor(theme.optString("timerA", "#ff4a14"), Color.RED),
                parseColor(theme.optString("timerB", "#f02a00"), Color.RED),
                Shader.TileMode.CLAMP
            )
            canvas.drawRoundRect(RectF(rect.left, rect.top, rect.left + max(rect.height(), rect.width() * frac), rect.bottom), r, r, fillPaint)
            fillPaint.shader = null
        }
    }

    private fun drawTransitionOverlay(canvas: Canvas, progress: Double) {
        val snap = snapBitmap ?: return
        val style = transitionConfig.optString("style", "classic-page-turn")
        val p = progress.toFloat().coerceIn(0f, 1f)
        val eased = if (p < 0.5f) 2f * p * p else 1f - (-2f * p + 2f).pow(2) / 2f
        if (style == "none" || p >= 1f) return
        when (style) {
            "fade", "crossfade" -> {
                fillPaint.alpha = ((1f - eased) * 255).toInt()
                canvas.drawBitmap(snap, 0f, 0f, fillPaint)
                fillPaint.alpha = 255
            }
            "slide-left", "push" -> {
                canvas.save()
                canvas.translate(-width * eased, 0f)
                canvas.drawBitmap(snap, 0f, 0f, null)
                canvas.restore()
            }
            "slide-right" -> {
                canvas.save()
                canvas.translate(width * eased, 0f)
                canvas.drawBitmap(snap, 0f, 0f, null)
                canvas.restore()
            }
            "reverse-page-turn" -> {
                val left = width * eased
                canvas.save()
                canvas.clipRect(left, 0f, width.toFloat(), height.toFloat())
                canvas.drawBitmap(snap, 0f, 0f, null)
                canvas.restore()
            }
            else -> {
                val pw = width * (1f - eased)
                if (pw > 1f) {
                    canvas.save()
                    canvas.clipRect(0f, 0f, pw, height.toFloat())
                    canvas.scale(pw / width, 1f)
                    canvas.drawBitmap(snap, 0f, 0f, null)
                    canvas.restore()
                    if (p > 0.5f) {
                        fillPaint.color = Color.argb(((p - 0.5f) * 1.4f * 255).toInt().coerceIn(0, 215), 240, 235, 225)
                        canvas.drawRect(0f, 0f, pw, height.toFloat(), fillPaint)
                    }
                }
            }
        }
    }

    fun release() {
        assetBitmaps.values.forEach { try { it.recycle() } catch (_: Exception) {} }
        assetBitmaps.clear()
        try { snapBitmap?.recycle() } catch (_: Exception) {}
        snapBitmap = null
        try { staticCacheBitmap?.recycle() } catch (_: Exception) {}
        staticCacheBitmap = null
    }
}

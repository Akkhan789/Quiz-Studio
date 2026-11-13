package com.quizstudiopro.app.audio

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.floor

/**
 * Upstream Edge TTS v2 DRM implementation ported directly from rany2/edge-tts (PR #492).
 * Implements the v2 Sec-MS-GEC token algorithm (<16 hex>-<64 hex>) and clock skew correction.
 */
object EdgeTtsV2Drm {

    const val TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
    const val CHROMIUM_FULL_VERSION = "143.0.3650.75"
    val CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0]
    val SEC_MS_GEC_VERSION = "2-$CHROMIUM_FULL_VERSION"

    private const val WIN_EPOCH = 11644473600L
    private const val S_TO_NS = 1_000_000_000.0
    private const val U32_MASK = 0xFFFFFFFFL

    private val secureRandom = SecureRandom()

    // Clock skew tracking in seconds
    var clockSkewSeconds: Double = 0.0

    private val SHA256_INITIAL = longArrayOf(
        0x6A09E667L, 0xBB67AE85L, 0x3C6EF372L, 0xA54FF53AL,
        0x510E527FL, 0x9B05688CL, 0x1F83D9ABL, 0x5BE0CD19L
    )

    private val SHA256_STATE = longArrayOf(
        0xFD9FBEA2L, 0x91243CE7L, 0xBE499094L, 0xCD2E1E0AL,
        0x6C006F49L, 0x04BD35ABL, 0xFEB0A7E4L, 0x03EFFBD2L
    )

    private val SHA256_SCHEDULE = longArrayOf(
        0xEB24BF9EL, 0x1558691FL, 0xA0C09EE2L, 0x0CFA32BAL,
        0xA622EE8CL, 0xD1DD9491L, 0xC0DD25A0L, 0xF9E70AB6L,
        0xF0C31573L, 0x7058CE4EL, 0x7188E606L, 0x00E5AB33L,
        0xD258B060L, 0x72766564L
    )

    private val SHA256_ROUND_CONSTANTS = longArrayOf(
        0x428A2F98L, 0x71374491L, 0xB5C0FBCFL, 0xE9B5DBA5L,
        0x3956C25BL, 0x59F111F1L, 0x923F82A4L, 0xAB1C5ED5L,
        0xD807AA98L, 0x12835B01L, 0x243185BEL, 0x550C7DC3L,
        0x72BE5D74L, 0x80DEB1FEL, 0x9BDC06A7L, 0xC19BF174L,
        0xE49B69C1L, 0xEFBE4786L, 0x0FC19DC6L, 0x240CA1CCL,
        0x2DE92C6FL, 0x4A7484AAL, 0x5CB0A9DCL, 0x76F988DAL,
        0x983E5152L, 0xA831C66DL, 0xB00327C8L, 0xBF597FC7L,
        0xC6E00BF3L, 0xD5A79147L, 0x06CA6351L, 0x14292967L,
        0x27B70A85L, 0x2E1B2138L, 0x4D2C6DFCL, 0x53380D13L,
        0x650A7354L, 0x766A0ABBL, 0x81C2C92EL, 0x92722C85L,
        0xA2BFE8A1L, 0xA81A664BL, 0xC24B8B70L, 0xC76C51A3L,
        0xD192E819L, 0xD6990624L, 0xF40E3585L, 0x106AA070L,
        0x19A4C116L, 0x1E376C08L, 0x2748774CL, 0x34B0BCB5L,
        0x391C0CB3L, 0x4ED8AA4AL, 0x5B9CCA4FL, 0x682E6FF3L,
        0x748F82EEL, 0x78A5636FL, 0x84C87814L, 0x8CC70208L,
        0x90BEFFFAL, 0xA4506CEBL, 0xBEF9A3F7L, 0xC67178F2L
    )

    private const val SHA256_ADJUSTMENT = 0xC9DC06A7L

    private val SHA256_BLOCK_CONSTANTS: LongArray = LongArray(64).apply {
        System.arraycopy(SHA256_ROUND_CONSTANTS, 0, this, 0, 14)
        this[14] = SHA256_ADJUSTMENT
        System.arraycopy(SHA256_ROUND_CONSTANTS, 15, this, 15, 49)
    }

    private const val SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80L
    private const val SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0L

    private val CS64_COEFFICIENTS = arrayOf(
        longArrayOf(0xE82E91B1L, 0xB32700D0L),
        longArrayOf(0x44DE24C6L, 0x88DFF51DL),
        longArrayOf(0x3BEB65BCL, 0x29514038L),
        longArrayOf(0xC89C5933L, 0xB328CBDFL),
        longArrayOf(0x8D1EC211L, 0xD405B4D5L),
        longArrayOf(0x314EF5D5L, 0x26E55F3CL),
        longArrayOf(0xE92491B1L, 0x607801C6L),
        longArrayOf(0xF0A5B9D5L, 0x82B2C1FBL),
        longArrayOf(0x06064CF3L, 0xFA51A3DAL),
        longArrayOf(0xDA79FA60L, 0x207CC464L),
        longArrayOf(0xBED20560L, 0x3C3C74F3L),
        longArrayOf(0x89F9C9F8L, 0xD2D14B61L),
        longArrayOf(0x35FA38C6L, 0xBB04A2C1L),
        longArrayOf(0xCB49E3C6L, 0xC5626167L)
    )

    private const val CS64_FACTOR = 0x82893933L
    private const val CS64_ADJUSTMENT0 = 0xF2F90B1AL
    private const val CS64_ADJUSTMENT1 = 0x0B1A0000L

    private fun rol16(value: Long): Long {
        val v = value and U32_MASK
        return ((v shl 16) or (v ushr 16)) and U32_MASK
    }

    private fun wordsLe4Even(data: ByteArray): LongArray {
        val padLen = (4 - (data.size % 4)) % 4
        val padded = ByteArray(data.size + padLen)
        System.arraycopy(data, 0, padded, 0, data.size)
        if (padded.isEmpty()) return LongArray(0)

        val wordCount = padded.size / 4
        val words = LongArray(if (wordCount % 2 != 0) wordCount + 1 else wordCount)
        val buf = ByteBuffer.wrap(padded).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until wordCount) {
            words[i] = buf.getInt().toLong() and U32_MASK
        }
        return words
    }

    private fun sigma0(value: Long): Long {
        return ((value ushr 7) xor (value shl 25) xor (value ushr 18) xor (value shl 14) xor (value ushr 3)) and U32_MASK
    }

    private fun sigma1(value: Long): Long {
        return ((value ushr 17) xor (value shl 15) xor (value ushr 19) xor (value shl 13) xor (value ushr 10)) and U32_MASK
    }

    private fun sha256Rounds(
        state: LongArray,
        words: LongArray,
        firstRound: Int = 0
    ): LongArray {
        var a = state[0]
        var b = state[1]
        var c = state[2]
        var d = state[3]
        var e = state[4]
        var f = state[5]
        var g = state[6]
        var h = state[7]

        val constants = if (firstRound == 14) SHA256_BLOCK_CONSTANTS else SHA256_ROUND_CONSTANTS
        val aligned = Math.min(64, ((firstRound + 7) / 8) * 8)

        for (index in firstRound until aligned) {
            val rotE = e * 0x100000001L
            val rotA = a * 0x100000001L
            val t1 = (h + ((rotE ushr 6) xor (rotE ushr 11) xor (rotE ushr 25)) +
                    (g xor (e and (f xor g))) + constants[index] + words[index]) and U32_MASK
            val t2 = (((rotA ushr 2) xor (rotA ushr 13) xor (rotA ushr 22)) +
                    ((a and b) or (c and (a or b)))) and U32_MASK

            h = g
            g = f
            f = e
            e = (d + t1) and U32_MASK
            d = c
            c = b
            b = a
            a = (t1 + t2) and U32_MASK
        }

        var index = aligned
        while (index < 64) {
            var rotE = e * 0x100000001L
            var rotA = a * 0x100000001L
            var t1 = (h + ((rotE ushr 6) xor (rotE ushr 11) xor (rotE ushr 25)) +
                    (g xor (e and (f xor g))) + constants[index] + words[index]) and U32_MASK
            d = (d + t1) and U32_MASK
            h = (t1 + ((rotA ushr 2) xor (rotA ushr 13) xor (rotA ushr 22)) +
                    ((a and b) or (c and (a or b)))) and U32_MASK

            rotE = d * 0x100000001L
            rotA = h * 0x100000001L
            t1 = (g + ((rotE ushr 6) xor (rotE ushr 11) xor (rotE ushr 25)) +
                    (f xor (d and (e xor f))) + constants[index + 1] + words[index + 1]) and U32_MASK
            c = (c + t1) and U32_MASK
            g = (t1 + ((rotA ushr 2) xor (rotA ushr 13) xor (rotA ushr 22)) +
                    ((h and a) or (b and (h or a)))) and U32_MASK

            rotE = c * 0x100000001L
            rotA = g * 0x100000001L
            t1 = (f + ((rotE ushr 6) xor (rotE ushr 11) xor (rotE ushr 25)) +
                    (e xor (c and (d xor e))) + constants[index + 2] + words[index + 2]) and U32_MASK
            b = (b + t1) and U32_MASK
            f = (t1 + ((rotA ushr 2) xor (rotA ushr 13) xor (rotA ushr 22)) +
                    ((g and h) or (a and (g or h)))) and U32_MASK

            rotE = b * 0x100000001L
            rotA = f * 0x100000001L
            t1 = (e + ((rotE ushr 6) xor (rotE ushr 11) xor (rotE ushr 25)) +
                    (d xor (b and (c xor d))) + constants[index + 3] + words[index + 3]) and U32_MASK
            a = (a + t1) and U32_MASK
            e = (t1 + ((rotA ushr 2) xor (rotA ushr 13) xor (rotA ushr 22)) +
                    ((f and g) or (h and (f or g)))) and U32_MASK

            rotE = a * 0x100000001L
            rotA = e * 0x100000001L
            t1 = (d + ((rotE ushr 6) xor (rotE ushr 11) xor (rotE ushr 25)) +
                    (c xor (a and (b xor c))) + constants[index + 4] + words[index + 4]) and U32_MASK
            h = (h + t1) and U32_MASK
            d = (t1 + ((rotA ushr 2) xor (rotA ushr 13) xor (rotA ushr 22)) +
                    ((e and f) or (g and (e or f)))) and U32_MASK

            rotE = h * 0x100000001L
            rotA = d * 0x100000001L
            t1 = (c + ((rotE ushr 6) xor (rotE ushr 11) xor (rotE ushr 25)) +
                    (b xor (h and (a xor b))) + constants[index + 5] + words[index + 5]) and U32_MASK
            g = (g + t1) and U32_MASK
            c = (t1 + ((rotA ushr 2) xor (rotA ushr 13) xor (rotA ushr 22)) +
                    ((d and e) or (f and (d or e)))) and U32_MASK

            rotE = g * 0x100000001L
            rotA = c * 0x100000001L
            t1 = (b + ((rotE ushr 6) xor (rotE ushr 11) xor (rotE ushr 25)) +
                    (a xor (g and (h xor a))) + constants[index + 6] + words[index + 6]) and U32_MASK
            f = (f + t1) and U32_MASK
            b = (t1 + ((rotA ushr 2) xor (rotA ushr 13) xor (rotA ushr 22)) +
                    ((c and d) or (e and (c or d)))) and U32_MASK

            rotE = f * 0x100000001L
            rotA = b * 0x100000001L
            t1 = (a + ((rotE ushr 6) xor (rotE ushr 11) xor (rotE ushr 25)) +
                    (h xor (f and (g xor h))) + constants[index + 7] + words[index + 7]) and U32_MASK
            e = (e + t1) and U32_MASK
            a = (t1 + ((rotA ushr 2) xor (rotA ushr 13) xor (rotA ushr 22)) +
                    ((b and c) or (d and (b or c)))) and U32_MASK

            index += 8
        }

        return longArrayOf(a, b, c, d, e, f, g, h)
    }

    private fun expandSha256Schedule(words: LongArray, firstWord: Int = 16) {
        for (i in firstWord until 64) {
            val x = words[i - 2]
            val y = words[i - 15]
            val s1 = ((x ushr 17) xor (x shl 15) xor (x ushr 19) xor (x shl 13) xor (x ushr 10)) and U32_MASK
            val s0 = ((y ushr 7) xor (y shl 25) xor (y ushr 18) xor (y shl 14) xor (y ushr 3)) and U32_MASK
            words[i] = (s1 + words[i - 7] + s0 + words[i - 16]) and U32_MASK
        }
    }

    private fun sha256Init(data: ByteArray): LongArray {
        val words = LongArray(64)
        // words[0..13] = 0
        val b0 = data[0].toInt() and 0xFF
        val b1 = data[1].toInt() and 0xFF
        val b2 = data[2].toInt() and 0xFF
        words[14] = ((b0 shl 16) or (b1 shl 8) or b2).toLong() and U32_MASK

        val b3 = data[3].toInt() and 0xFF
        val b4 = data[4].toInt() and 0xFF
        val b5 = data[5].toInt() and 0xFF
        val b6 = data[6].toInt() and 0xFF
        words[15] = ((b3.toLong() shl 24) or (b4.toLong() shl 16) or (b5.toLong() shl 8) or b6.toLong()) and U32_MASK

        for (index in 16 until 30) {
            var value = SHA256_SCHEDULE[index - 16]
            if (index - 2 >= 14) {
                val s1 = if (index == 16) sigma1(words[index - 2]) xor SHA256_SIGMA1_ADJUSTMENT else sigma1(words[index - 2])
                value += s1
            }
            if (index - 7 >= 14) {
                value += words[index - 7]
            }
            if (index - 15 >= 14) {
                val s0 = if (index == 29) sigma0(words[index - 15]) xor SHA256_SIGMA0_ADJUSTMENT else sigma0(words[index - 15])
                value += s0
            }
            words[index] = value and U32_MASK
        }

        words[30] = (sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] +
                SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) and U32_MASK

        expandSha256Schedule(words, 31)
        val working = sha256Rounds(SHA256_STATE, words, 14)
        val res = LongArray(8)
        for (i in 0 until 8) {
            res[i] = (SHA256_INITIAL[i] + working[i]) and U32_MASK
        }
        return res
    }

    private fun sha256Digest(data: ByteArray): ByteArray {
        if (data.size < 7) throw IllegalArgumentException("Token salt must contain at least 7 bytes")

        val length = 57 + data.size
        val zeroPadLen = ((55 - length) % 64 + 64) % 64
        val paddedLen = (data.size - 7) + 1 + zeroPadLen + 8
        val padded = ByteArray(paddedLen)

        var pos = 0
        System.arraycopy(data, 7, padded, pos, data.size - 7)
        pos += data.size - 7
        padded[pos++] = 0x80.toByte()
        // zero bytes already 0
        pos += zeroPadLen

        val bitLen = length.toLong() * 8L
        ByteBuffer.wrap(padded, pos, 8).order(ByteOrder.BIG_ENDIAN).putLong(bitLen)

        var state = sha256Init(data)
        var offset = 0
        val blockWords = LongArray(64)
        while (offset < padded.size) {
            val bb = ByteBuffer.wrap(padded, offset, 64).order(ByteOrder.BIG_ENDIAN)
            for (i in 0 until 16) {
                blockWords[i] = bb.getInt().toLong() and U32_MASK
            }
            expandSha256Schedule(blockWords, 16)
            val working = sha256Rounds(state, blockWords, 0)
            val nextState = LongArray(8)
            for (i in 0 until 8) {
                nextState[i] = (state[i] + working[i]) and U32_MASK
            }
            state = nextState
            offset += 64
        }

        val outBuf = ByteBuffer.allocate(32).order(ByteOrder.BIG_ENDIAN)
        for (i in 0 until 8) {
            outBuf.putInt(state[i].toInt())
        }
        return outBuf.array()
    }

    private fun cs64Digest(data: ByteArray, digest: ByteArray): Pair<Long, Long> {
        val digestBuf = ByteBuffer.wrap(digest).order(ByteOrder.LITTLE_ENDIAN)
        var keyA = digestBuf.getInt().toLong() and U32_MASK
        var keyB = digestBuf.getInt().toLong() and U32_MASK
        keyA = keyA or 1L
        keyB = keyB or 1L

        val factors = longArrayOf(
            (keyA * CS64_FACTOR) and U32_MASK,
            (keyB * CS64_FACTOR) and U32_MASK
        )

        val terms = mutableListOf<Long>()
        val offsets = mutableListOf<Long>()

        for (i in CS64_COEFFICIENTS.indices) {
            val coeff = CS64_COEFFICIENTS[i][0]
            val offset = CS64_COEFFICIENTS[i][1]
            terms.add((coeff * factors[i % 2]) and U32_MASK)
            offsets.add(offset and U32_MASK)
        }

        val dataWithZero = ByteArray(data.size + 1)
        dataWithZero[0] = 0.toByte()
        System.arraycopy(data, 0, dataWithZero, 1, data.size)
        val dataWords = wordsLe4Even(dataWithZero)

        for (index in dataWords.indices) {
            val word = dataWords[index]
            var term = (word * (if (index % 2 == 0) keyA else keyB)) and U32_MASK
            var offset = (rol16(word) * (if (index % 2 == 0) 0xEF0569FBL else 0xC31713DBL)) and U32_MASK
            if (index == 0) {
                term = (term + (CS64_ADJUSTMENT0 * factors[0])) and U32_MASK
                offset = (offset + CS64_ADJUSTMENT1) and U32_MASK
            }
            terms.add(term)
            offsets.add(offset)
        }

        var swapAcc = 0L
        var swapLast = 0L
        var state = 0L
        var acc = 0L

        var index = 0
        while (index < terms.size) {
            val x = terms[index]
            val y = terms[index + 1]

            var t = rol16((offsets[index] + x) and U32_MASK)
            var q = (t * 0x76F50F34L) and U32_MASK
            swapAcc = (swapAcc + ((rol16(q) * 0xC3EFEA97L + q) and U32_MASK)) and U32_MASK

            t = rol16((offsets[index + 1] + y) and U32_MASK)
            q = (t * 0x1881CE3CL) and U32_MASK
            swapLast = ((rol16(q) * 0x35BD1EC9L + q) and U32_MASK)
            swapAcc = (swapAcc + swapLast) and U32_MASK

            state = (state * keyA + x) and U32_MASK
            state = (rol16(state) * 0xCF98B111L) and U32_MASK
            state = (rol16(state) * 0x87085B9FL) and U32_MASK
            state = (rol16(state) * 0x12CEB96DL) and U32_MASK
            state = (rol16(state) * 0x257E1D83L) and U32_MASK
            acc = (acc + state) and U32_MASK

            t = (state * keyB + y) and U32_MASK
            t = (rol16(t) * 0xA27416F5L) and U32_MASK
            t = (rol16(t) * 0xD38396FFL) and U32_MASK
            state = (rol16((rol16(t) * 0x7C932B89L) and U32_MASK) * 0xBFA49F69L) and U32_MASK
            acc = (acc + state) and U32_MASK

            index += 2
        }

        val word1 = (swapLast xor state) and U32_MASK
        val word2 = (swapAcc xor acc) and U32_MASK
        return Pair(word1, word2)
    }

    /**
     * Generates a v2 Sec-MS-GEC token value matching upstream edge-tts.
     * The token format is "<16 hex>-<64 hex>" (81 chars total).
     */
    fun generateSecMsGecV2(unixTimestamp: Double? = null): String {
        val ts = unixTimestamp ?: (getUnixTimestamp())
        var ticks = ts + WIN_EPOCH
        ticks -= (ticks % 300)
        ticks *= (S_TO_NS / 100.0)

        val strToHash = String.format(Locale.US, "%.0f%s", ticks, TRUSTED_CLIENT_TOKEN).toByteArray(Charsets.US_ASCII)

        val digest = sha256Digest(strToHash)
        val cs64Words = cs64Digest(strToHash, digest)

        val cs64Buf = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
        cs64Buf.putInt(cs64Words.first.toInt())
        cs64Buf.putInt(cs64Words.second.toInt())

        val cs64Hex = cs64Buf.array().joinToString("") { String.format(Locale.US, "%02X", it) }
        val sha256Hex = digest.joinToString("") { String.format(Locale.US, "%02X", it) }

        return "$cs64Hex-$sha256Hex"
    }

    fun getUnixTimestamp(): Double {
        return (System.currentTimeMillis() / 1000.0) + clockSkewSeconds
    }

    fun generateMuid(): String {
        val bytes = ByteArray(16)
        secureRandom.nextBytes(bytes)
        return bytes.joinToString("") { String.format(Locale.US, "%02X", it) }
    }

    /**
     * Adjust clock skew based on server Date header (RFC 1123 / RFC 2616 format).
     * e.g., "Thu, 05 Nov 2026 06:13:01 GMT"
     */
    fun adjustClockSkew(serverDateHeader: String?): Boolean {
        if (serverDateHeader.isNullOrBlank()) return false
        try {
            val sdf = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss z", Locale.US)
            sdf.timeZone = TimeZone.getTimeZone("GMT")
            val date = sdf.parse(serverDateHeader)
            if (date != null) {
                val serverTimestamp = date.time / 1000.0
                val clientTimestamp = getUnixTimestamp()
                val skew = serverTimestamp - clientTimestamp
                clockSkewSeconds += skew
                return true
            }
        } catch (ignored: Exception) {}
        return false
    }
}

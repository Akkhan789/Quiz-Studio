package com.quizstudiopro.app.logging

import android.util.Log

object QuizLogger {
    fun debug(tag: String, message: String) {
        Log.d("QuizStudioPro:$tag", message)
    }

    fun info(tag: String, message: String, detail: String? = null) {
        val full = if (detail != null) "$message\n$detail" else message
        Log.i("QuizStudioPro:$tag", full)
    }

    fun warn(tag: String, message: String) {
        Log.w("QuizStudioPro:$tag", message)
    }

    fun error(tag: String, message: String, detail: String? = null) {
        val full = if (detail != null) "$message\n$detail" else message
        Log.e("QuizStudioPro:$tag", full)
    }

    fun success(tag: String, message: String, detail: String? = null) {
        val full = if (detail != null) "$message\n$detail" else message
        Log.i("QuizStudioPro:$tag", "[SUCCESS] $full")
    }
}

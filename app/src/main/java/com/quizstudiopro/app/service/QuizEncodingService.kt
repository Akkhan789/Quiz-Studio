package com.quizstudiopro.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.quizstudiopro.app.MainActivity

class QuizEncodingService : Service() {

    companion object {
        private const val CHANNEL_ID = "quiz_encoding_channel"
        private const val NOTIFICATION_ID = 4101
        private const val RESULT_NOTIFICATION_ID = 4102
        private const val ACTION_START = "ACTION_START_ENCODING"
        private const val ACTION_UPDATE = "ACTION_UPDATE_PROGRESS"
        private const val ACTION_STOP = "ACTION_STOP_ENCODING"
        private const val ACTION_COMPLETE = "ACTION_COMPLETE"
        private const val ACTION_FAILED = "ACTION_FAILED"
        private const val EXTRA_PROGRESS = "EXTRA_PROGRESS"
        private const val EXTRA_STATUS = "EXTRA_STATUS"

        fun start(context: Context, status: String) {
            val intent = Intent(context, QuizEncodingService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_STATUS, status)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun updateProgress(context: Context, progress: Int, status: String) {
            val intent = Intent(context, QuizEncodingService::class.java).apply {
                action = ACTION_UPDATE
                putExtra(EXTRA_PROGRESS, progress)
                putExtra(EXTRA_STATUS, status)
            }
            context.startService(intent)
        }

        fun notifyComplete(context: Context, message: String = "Your quiz video is ready!") {
            val intent = Intent(context, QuizEncodingService::class.java).apply {
                action = ACTION_COMPLETE
                putExtra(EXTRA_STATUS, message)
            }
            context.startService(intent)
        }

        fun notifyFailed(context: Context, error: String = "Video export failed — Tap to view details.") {
            val intent = Intent(context, QuizEncodingService::class.java).apply {
                action = ACTION_FAILED
                putExtra(EXTRA_STATUS, error)
            }
            context.startService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, QuizEncodingService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        when (intent?.action) {
            ACTION_START -> {
                val status = intent.getStringExtra(EXTRA_STATUS) ?: "Video export in progress"
                val notification = buildOngoingNotification(0, status)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }
            }
            ACTION_UPDATE -> {
                val progress = intent.getIntExtra(EXTRA_PROGRESS, 0)
                val status = intent.getStringExtra(EXTRA_STATUS) ?: "Video export in progress"
                manager.notify(NOTIFICATION_ID, buildOngoingNotification(progress, status))
            }
            ACTION_COMPLETE -> {
                val msg = intent.getStringExtra(EXTRA_STATUS) ?: "Your quiz video is ready!"
                stopForeground(STOP_FOREGROUND_REMOVE)
                manager.notify(RESULT_NOTIFICATION_ID, buildResultNotification("Quiz Studio Pro", msg, false))
                stopSelf()
            }
            ACTION_FAILED -> {
                val msg = intent.getStringExtra(EXTRA_STATUS) ?: "Video export failed — Tap to view details."
                stopForeground(STOP_FOREGROUND_REMOVE)
                manager.notify(RESULT_NOTIFICATION_ID, buildResultNotification("Quiz Studio Pro", msg, true))
                stopSelf()
            }
            ACTION_STOP -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun getTapIntent(): PendingIntent {
        val appIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        return PendingIntent.getActivity(this, 0, appIntent, flags)
    }

    private fun buildOngoingNotification(progress: Int, status: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Quiz Studio Pro — Video export in progress")
            .setContentText(status)
            .setSmallIcon(android.R.drawable.ic_menu_save)
            .setContentIntent(getTapIntent())
            .setOngoing(true)
            .setProgress(100, progress, false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun buildResultNotification(title: String, message: String, isError: Boolean): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(message)
            .setSmallIcon(if (isError) android.R.drawable.stat_notify_error else android.R.drawable.stat_sys_download_done)
            .setContentIntent(getTapIntent())
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Quiz Video Export Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows progress and completion notifications for video exports"
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }
}

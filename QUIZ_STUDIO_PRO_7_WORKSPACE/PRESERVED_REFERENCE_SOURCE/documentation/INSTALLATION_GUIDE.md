# Quiz Studio Pro — Android APK Installation Guide

This guide details how to install and run the compiled `QuizStudioPro.apk` package on Android devices, emulators, or test environments.

---

## 1. System Requirements
- **Supported Operating Systems:** Android 10 (API Level 29) through Android 15+ (API Level 36).
- **Supported Architectures:** ARM64 (`arm64-v8a`), ARMv7 (`armeabi-v7a`), x86, and x86_64.
- **Minimum Available Storage:** 150 MB (for APK install, project assets, and generated video exports).

---

## 2. Installation Methods

### Method A: Direct Sideloading onto an Android Phone or Tablet
1. Transfer `public/QuizStudioPro.apk` to your Android device via USB cable, Google Drive, email attachment, or local network file sharing.
2. On your device, open your File Manager or Downloads app and tap `QuizStudioPro.apk`.
3. If prompted by Android security:
   - Tap **Settings** in the dialog.
   - Toggle **Allow from this source** (or **Install unknown apps** for your browser / file manager).
   - Return to the installer and tap **Install**.
4. Once installation completes, tap **Open** or locate **Quiz Studio Pro** in your app drawer.

### Method B: Installation via Android Debug Bridge (ADB)
If you have Android Studio or the Android SDK Platform-Tools installed on your computer:
1. Connect your Android device via USB and enable **USB Debugging** under Developer Options (or start an Android Virtual Device).
2. Open a terminal / command prompt.
3. Run the following command:
   ```bash
   adb install -r public/QuizStudioPro.apk
   ```
4. To launch the application directly from the command line:
   ```bash
   adb shell am start -n com.quizstudiopro.app/.MainActivity
   ```

---

## 3. First-Time Setup & Modes of Operation

### Mode 1: Local Offline Mode (Recommended for Instant Use)
1. On initial launch, the application displays the **Quiz Studio Pro Sign in** screen.
2. Tap the **Continue in Local Mode** button at the bottom of the card.
3. You will immediately enter the full Quiz Studio workspace.
4. All quiz projects, questions, custom styling, and audio settings will be persisted automatically on your device using IndexedDB.

### Mode 2: Remote Account & Edge TTS Backend (Optional)
If you have deployed the companion `tts-backend/` server:
1. Enter your server URL (e.g., `https://your-tts-api.example.com`) in the **Account backend URL** field.
2. Sign in with your account credentials or create a new account using an invite code.
3. In the Quiz Studio workspace, open **Voice Settings** to configure Edge TTS speech synthesis for questions and answers.

---

## 4. Exporting Quiz Videos to Device Gallery
1. After composing questions and selecting your starter template, tap **Export MP4 Video**.
2. Quiz Studio Pro encodes frames and audio using WebCodecs / MediaRecorder and streams the video chunks to Android Scoped Storage.
3. When export finishes, the video is saved directly to:
   ```
   Internal Storage > Movies > QuizStudioPro > <project-name>.mp4
   ```
4. The app provides **Open Saved Video** and **Share Video** actions to view the exported clip in your default video player or share to social media.

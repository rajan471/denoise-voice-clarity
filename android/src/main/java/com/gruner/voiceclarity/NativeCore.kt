package com.gruner.voiceclarity

/** JNI bridge to libdenoise_voice_core.so. Mirrors rust-core/src/jni.rs. */
internal object NativeCore {
    @Volatile var available: Boolean = false
        private set

    init {
        available = try {
            System.loadLibrary("denoise_voice_core")
            true
        } catch (t: Throwable) {
            // runCatching: android.util.Log is a throwing stub off-device.
            runCatching { android.util.Log.w("VoiceClarity", "native core unavailable: $t") }
            false
        }
    }

    external fun create(): Long
    external fun destroy(handle: Long)
    external fun init(handle: Long, sampleRateHz: Int, channels: Int): Int
    external fun reset(handle: Long, newRateHz: Int): Int
    external fun processBanded(handle: Long, bands: Int, framesPerBand: Int,
                               buffer: java.nio.ByteBuffer): Int
    external fun setEnabled(handle: Long, enabled: Boolean)
    external fun setAttenuationLimitDb(handle: Long, db: Float)
}

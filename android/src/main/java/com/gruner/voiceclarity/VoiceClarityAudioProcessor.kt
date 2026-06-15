package com.gruner.voiceclarity

import io.livekit.android.audio.AudioProcessorInterface
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger

/**
 * LiveKit capture post-processor running the denoise-voice-core chain
 * (HPF -> DeepFilterNet 3 -> clarity). Attach via
 * AudioProcessorOptions(capturePostProcessor = this).
 *
 * Degradation: if the native lib is missing or processing keeps failing,
 * the processor turns inert and audio passes through untouched.
 */
class VoiceClarityAudioProcessor internal constructor(
    private val bridge: Bridge,
) : AudioProcessorInterface {

    internal interface Bridge {
        val available: Boolean
        fun create(): Long
        fun destroy(handle: Long)
        fun init(handle: Long, sampleRateHz: Int, channels: Int): Int
        fun reset(handle: Long, newRateHz: Int): Int
        fun processBanded(handle: Long, bands: Int, framesPerBand: Int, buffer: ByteBuffer): Int
        fun setEnabled(handle: Long, enabled: Boolean)
        fun setAttenuationLimitDb(handle: Long, db: Float)
    }

    constructor() : this(RealBridge)

    private object RealBridge : Bridge {
        override val available get() = NativeCore.available
        override fun create() = NativeCore.create()
        override fun destroy(handle: Long) = NativeCore.destroy(handle)
        override fun init(handle: Long, sampleRateHz: Int, channels: Int) =
            NativeCore.init(handle, sampleRateHz, channels)
        override fun reset(handle: Long, newRateHz: Int) = NativeCore.reset(handle, newRateHz)
        override fun processBanded(handle: Long, bands: Int, framesPerBand: Int, buffer: ByteBuffer) =
            NativeCore.processBanded(handle, bands, framesPerBand, buffer)
        override fun setEnabled(handle: Long, enabled: Boolean) = NativeCore.setEnabled(handle, enabled)
        override fun setAttenuationLimitDb(handle: Long, db: Float) =
            NativeCore.setAttenuationLimitDb(handle, db)
    }

    private companion object { const val MAX_CONSECUTIVE_ERRORS = 50 }

    @Volatile private var handle: Long = 0
    @Volatile private var userEnabled = true
    @Volatile private var healthy = false
    private var attenuationLimitDb: Float? = null
    private val consecutiveErrors = AtomicInteger(0)

    // Guards every native call against destroy-while-processing (use-after-free).
    // Uncontended in steady state, so it is ~free on the audio path; contention
    // only happens during teardown, which is exactly when we need exclusion.
    private val lock = Any()

    fun setEnabled(enabled: Boolean) {
        synchronized(lock) {
            userEnabled = enabled
            if (handle != 0L) bridge.setEnabled(handle, enabled)
        }
    }

    fun setAttenuationLimitDb(db: Float) {
        synchronized(lock) {
            attenuationLimitDb = db
            if (handle != 0L) bridge.setAttenuationLimitDb(handle, db)
        }
    }

    /**
     * Destroys the native processor. Call only after the processor is detached
     * from AudioProcessorOptions / capture is stopped. Must not race
     * [processAudio]; the internal lock makes a late audio callback a safe
     * no-op, but detaching first is the contract.
     */
    fun release() {
        synchronized(lock) {
            if (handle != 0L) { bridge.destroy(handle); handle = 0; healthy = false }
        }
    }

    // -- AudioProcessorInterface ------------------------------------------

    override fun isEnabled(): Boolean = healthy && userEnabled

    override fun getName(): String = "denoise-voice-clarity"

    override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) {
        synchronized(lock) {
            if (!bridge.available) { healthy = false; return }
            if (handle == 0L) handle = bridge.create()
            healthy = handle != 0L && bridge.init(handle, sampleRateHz, numChannels) == 0
            consecutiveErrors.set(0)
            if (healthy) {
                // Re-apply settings made before (re-)init so they aren't dropped.
                bridge.setEnabled(handle, userEnabled)
                attenuationLimitDb?.let { bridge.setAttenuationLimitDb(handle, it) }
            }
        }
    }

    override fun resetAudioProcessing(newRate: Int) {
        synchronized(lock) {
            if (handle != 0L) { bridge.reset(handle, newRate); consecutiveErrors.set(0) }
        }
    }

    override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
        if (!isEnabled() || numFrames <= 0) return
        synchronized(lock) {
            // Re-check under the lock: release() may have destroyed the handle
            // between the isEnabled() fast-path check and here.
            if (handle == 0L || !isEnabled()) return
            processLocked(numFrames, buffer)
        }
    }

    private fun processLocked(numFrames: Int, buffer: ByteBuffer) {
        // Buffer convention (verified against webrtc-sdk/webrtc m125_release and
        // m144_release, sdk/android/src/jni/pc/external_audio_processor.cc —
        // m125 is what livekit-android 2.18.2 ships via
        // io.github.webrtc-sdk:android-prefixed:125.6422.07):
        //
        //   ExternalAudioProcessor::Process passes audio->channels()[0] — the
        //   FULL-BAND mono signal, not the APM's split-band view — with
        //   numFrames = audio->num_frames(), the TOTAL frames in the 10 ms
        //   buffer at the current rate (the glue derives the rate as
        //   numFrames * 100, e.g. 480 @ 48 kHz). numBands is informational.
        //
        // So we forward shape (bands=1, framesPerBand=numFrames): the core's
        // (1, 480) path runs the full chain directly on full-band data. Passing
        // (numBands, numFrames/numBands) instead would make the core "merge"
        // full-band samples as if they were split bands — garbage audio.
        //
        // The buffer comes from JNI NewDirectByteBuffer over webrtc's float*:
        // always direct, 4-byte aligned, un-sliced — satisfying jni.rs's -4
        // contract. Capacity is kNsFrameSize * numBands * 4 bytes, which is
        // >= numFrames * 4 at every rate webrtc produces (== at 16/32/48 kHz).
        val rc = bridge.processBanded(handle, 1, numFrames, buffer)
        if (rc == 0) {
            consecutiveErrors.set(0)
        } else if (consecutiveErrors.incrementAndGet() >= MAX_CONSECUTIVE_ERRORS) {
            healthy = false
            // runCatching: android.util.Log is a throwing stub in plain-JVM
            // unit tests; self-disable must never itself throw.
            runCatching {
                android.util.Log.w(
                    "VoiceClarity",
                    "self-disabled after $MAX_CONSECUTIVE_ERRORS errors (rc=$rc)",
                )
            }
        }
    }
}

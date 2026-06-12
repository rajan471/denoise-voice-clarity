package com.gruner.voiceclarity

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

private open class FakeBridge(var processResult: Int = 0) : VoiceClarityAudioProcessor.Bridge {
    var inited = 0
    var resets = 0
    var destroyed = 0
    var lastBands = -1
    var lastFramesPerBand = -1
    override val available get() = true
    override fun create() = 1L
    override fun destroy(handle: Long) { destroyed++ }
    override fun init(handle: Long, sampleRateHz: Int, channels: Int): Int { inited++; return 0 }
    override fun reset(handle: Long, newRateHz: Int): Int { resets++; return 0 }
    override fun processBanded(handle: Long, bands: Int, framesPerBand: Int, buffer: ByteBuffer): Int {
        lastBands = bands
        lastFramesPerBand = framesPerBand
        return processResult
    }
    override fun setEnabled(handle: Long, enabled: Boolean) {}
    override fun setAttenuationLimitDb(handle: Long, db: Float) {}
}

class VoiceClarityAudioProcessorTest {
    private fun directBuf(floats: Int): ByteBuffer =
        ByteBuffer.allocateDirect(floats * 4).order(ByteOrder.nativeOrder())

    @Test fun `lifecycle init and process`() {
        val p = VoiceClarityAudioProcessor(FakeBridge())
        p.initializeAudioProcessing(48_000, 1)
        assertTrue(p.isEnabled())
        p.processAudio(3, 480, directBuf(480))
        assertEquals("denoise-voice-clarity", p.getName())
    }

    @Test fun `buffer is full-band so shape forwards as one band of numFrames`() {
        // The webrtc-sdk glue passes audio->channels()[0] (full-band data) with
        // numFrames = total frames per 10 ms; numBands is informational only.
        // The adapter must forward (bands=1, framesPerBand=numFrames).
        val bridge = FakeBridge()
        val p = VoiceClarityAudioProcessor(bridge)
        p.initializeAudioProcessing(48_000, 1)
        p.processAudio(3, 480, directBuf(480))
        assertEquals(1, bridge.lastBands)
        assertEquals(480, bridge.lastFramesPerBand)
    }

    @Test fun `unavailable bridge means inert`() {
        val bridge = object : FakeBridge() { override val available get() = false }
        val p = VoiceClarityAudioProcessor(bridge)
        p.initializeAudioProcessing(48_000, 1)
        assertFalse(p.isEnabled())
        p.processAudio(3, 480, directBuf(480)) // must not throw
    }

    @Test fun `error budget self-disables after 50 consecutive failures`() {
        val bridge = FakeBridge(processResult = -2)
        val p = VoiceClarityAudioProcessor(bridge)
        p.initializeAudioProcessing(48_000, 1)
        repeat(50) { p.processAudio(3, 480, directBuf(480)) }
        assertFalse(p.isEnabled())
    }

    @Test fun `reset is forwarded`() {
        val bridge = FakeBridge()
        val p = VoiceClarityAudioProcessor(bridge)
        p.initializeAudioProcessing(48_000, 1)
        p.resetAudioProcessing(16_000)
        assertEquals(1, bridge.resets)
    }

    @Test fun `success resets error counter`() {
        val bridge = FakeBridge(processResult = -2)
        val p = VoiceClarityAudioProcessor(bridge)
        p.initializeAudioProcessing(48_000, 1)
        repeat(49) { p.processAudio(3, 480, directBuf(480)) }
        bridge.processResult = 0
        p.processAudio(3, 480, directBuf(480)) // success resets counter
        bridge.processResult = -2
        repeat(49) { p.processAudio(3, 480, directBuf(480)) }
        assertTrue(p.isEnabled()) // 49 < 50 again
    }
}

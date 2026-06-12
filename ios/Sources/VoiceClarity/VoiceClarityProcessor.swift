import Foundation
import os
import LiveKit
import DenoiseVoiceCoreFFI

/// Seam over the `dvc_*` C API so the processor logic is unit-testable
/// without the Rust binary. Mirrors the cbindgen header in
/// `Sources/DenoiseVoiceCoreFFI/include/denoise_voice_core.h`; the opaque
/// `DvcHandle *` imports into Swift as `OpaquePointer`.
protocol VoiceClarityCore: AnyObject {
    func create() -> OpaquePointer?
    func destroy(_ h: OpaquePointer?)
    func initialize(_ h: OpaquePointer?, sampleRate: Int32, channels: Int32) -> Int32
    func reset(_ h: OpaquePointer?, newRate: Int32) -> Int32
    func processBanded(_ h: OpaquePointer?, bands: Int32, framesPerBand: Int32,
                       buffer: UnsafeMutablePointer<Float>) -> Int32
    func setEnabled(_ h: OpaquePointer?, _ on: Bool)
    func setAttenuationLimitDb(_ h: OpaquePointer?, _ db: Float)
}

/// Production bridge to the Rust core shipped in DenoiseVoiceCoreFFI.xcframework.
final class RealCore: VoiceClarityCore {
    func create() -> OpaquePointer? { dvc_create() }
    func destroy(_ h: OpaquePointer?) { dvc_destroy(h) }
    func initialize(_ h: OpaquePointer?, sampleRate: Int32, channels: Int32) -> Int32 {
        dvc_init(h, sampleRate, channels)
    }
    func reset(_ h: OpaquePointer?, newRate: Int32) -> Int32 { dvc_reset(h, newRate) }
    func processBanded(_ h: OpaquePointer?, bands: Int32, framesPerBand: Int32,
                       buffer: UnsafeMutablePointer<Float>) -> Int32 {
        dvc_process_banded(h, bands, framesPerBand, buffer)
    }
    func setEnabled(_ h: OpaquePointer?, _ on: Bool) { dvc_set_enabled(h, on) }
    func setAttenuationLimitDb(_ h: OpaquePointer?, _ db: Float) {
        dvc_set_attenuation_limit_db(h, db)
    }
}

/// LiveKit capture post-processor running the denoise-voice-core chain
/// (HPF -> DeepFilterNet 3 -> clarity). Attach via
/// `AudioManager.shared.capturePostProcessingDelegate = processor`.
///
/// On iOS the capture-post hook delivers the APM's split-band view
/// (`bands` = 3 x `framesPerBand` = 160 at 48 kHz); the buffer is forwarded
/// band-major as-is and the core merges/splits internally.
///
/// Degradation: if the core keeps failing (`MAX_CONSECUTIVE_ERRORS`
/// consecutive non-zero returns), the processor turns inert and audio passes
/// through untouched.
///
/// Teardown contract: detach the delegate from `AudioManager` (or stop
/// capture) before calling `audioProcessingRelease()`. The internal lock
/// makes a late audio callback a safe no-op, but detaching first is the
/// contract.
public final class VoiceClarityProcessor: NSObject, AudioCustomProcessingDelegate, @unchecked Sendable {
    private static let MAX_CONSECUTIVE_ERRORS = 50
    private static let log = Logger(subsystem: "com.gruner.voiceclarity",
                                    category: "VoiceClarityProcessor")

    private let core: VoiceClarityCore

    // Guards every core call against destroy-while-processing
    // (use-after-free). Uncontended in steady state, so it is ~free on the
    // audio path (~100 Hz); contention only happens during teardown, which is
    // exactly when we need exclusion. Mirrors the Android adapter's decision.
    private let lock = NSLock()

    private var handle: OpaquePointer?
    private var healthy = false
    private var userEnabled = true
    private var attenuationLimitDb: Float?
    private var consecutiveErrors = 0

    public override convenience init() { self.init(core: RealCore()) }

    init(core: VoiceClarityCore) {
        self.core = core
        super.init()
    }

    deinit {
        // Last-resort cleanup; callers should release explicitly after detach.
        if let h = handle { core.destroy(h) }
    }

    /// False until initialized, and after release or self-disable.
    public var isHealthy: Bool {
        lock.lock(); defer { lock.unlock() }
        return healthy
    }

    /// Master user toggle. When off, processing is skipped entirely (in
    /// addition to the core-side passthrough). Survives re-initialization.
    public var isUserEnabled: Bool {
        get {
            lock.lock(); defer { lock.unlock() }
            return userEnabled
        }
        set {
            lock.lock(); defer { lock.unlock() }
            userEnabled = newValue
            if handle != nil { core.setEnabled(handle, newValue) }
        }
    }

    /// Maximum noise attenuation in dB. Settable before initialization; the
    /// value is stored and re-applied on every (re-)init.
    public func setAttenuationLimitDb(_ db: Float) {
        lock.lock(); defer { lock.unlock() }
        attenuationLimitDb = db
        if handle != nil { core.setAttenuationLimitDb(handle, db) }
    }

    // MARK: - AudioCustomProcessingDelegate

    public var audioProcessingName: String { "denoise-voice-clarity" }

    public func audioProcessingInitialize(sampleRate sampleRateHz: Int, channels: Int) {
        lock.lock(); defer { lock.unlock() }
        if handle == nil { handle = core.create() }
        healthy = handle != nil
            && core.initialize(handle, sampleRate: Int32(sampleRateHz),
                               channels: Int32(channels)) == 0
        consecutiveErrors = 0
        if healthy {
            // Re-apply settings made before (re-)init so they aren't dropped.
            core.setEnabled(handle, userEnabled)
            if let db = attenuationLimitDb { core.setAttenuationLimitDb(handle, db) }
        }
    }

    public func audioProcessingProcess(audioBuffer: LKAudioBuffer) {
        let bands = Int32(audioBuffer.bands)
        let framesPerBand = Int32(audioBuffer.framesPerBand)
        guard bands > 0, framesPerBand > 0 else { return }
        for ch in 0..<audioBuffer.channels {
            processChannel(bands: bands, framesPerBand: framesPerBand,
                           buffer: audioBuffer.rawBuffer(forChannel: ch))
        }
    }

    public func audioProcessingRelease() {
        lock.lock(); defer { lock.unlock() }
        if let h = handle {
            core.destroy(h)
            handle = nil
        }
        healthy = false
    }

    // MARK: - Internals

    /// Processes one channel's band-major buffer in place. Internal seam so
    /// the health/enable gating is testable without an `LKAudioBuffer`
    /// (concrete @objcMembers class that cannot be faked).
    func processChannel(bands: Int32, framesPerBand: Int32,
                        buffer: UnsafeMutablePointer<Float>) {
        lock.lock(); defer { lock.unlock() }
        guard healthy, userEnabled, let h = handle else { return }
        let rc = core.processBanded(h, bands: bands, framesPerBand: framesPerBand,
                                    buffer: buffer)
        if rc == 0 {
            consecutiveErrors = 0
        } else {
            consecutiveErrors += 1
            if consecutiveErrors >= Self.MAX_CONSECUTIVE_ERRORS {
                healthy = false
                Self.log.warning("self-disabled after \(Self.MAX_CONSECUTIVE_ERRORS) consecutive errors (rc=\(rc))")
            }
        }
    }
}

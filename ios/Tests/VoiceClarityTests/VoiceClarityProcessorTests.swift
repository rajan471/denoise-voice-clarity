import XCTest
@testable import VoiceClarity

final class FakeCore: VoiceClarityCore {
    var processResult: Int32 = 0
    var inits = 0, resets = 0, destroys = 0, processCalls = 0
    var lastShape: (bands: Int32, framesPerBand: Int32)?
    func create() -> OpaquePointer? { OpaquePointer(bitPattern: 1) }
    func destroy(_ h: OpaquePointer?) { destroys += 1 }
    func initialize(_ h: OpaquePointer?, sampleRate: Int32, channels: Int32) -> Int32 { inits += 1; return 0 }
    func reset(_ h: OpaquePointer?, newRate: Int32) -> Int32 { resets += 1; return 0 }
    func processBanded(_ h: OpaquePointer?, bands: Int32, framesPerBand: Int32,
                       buffer: UnsafeMutablePointer<Float>) -> Int32 {
        processCalls += 1; lastShape = (bands, framesPerBand); return processResult
    }
    func setEnabled(_ h: OpaquePointer?, _ on: Bool) {}
    func setAttenuationLimitDb(_ h: OpaquePointer?, _ db: Float) {}
}

final class VoiceClarityProcessorTests: XCTestCase {
    func testLifecycle() {
        let core = FakeCore()
        let p = VoiceClarityProcessor(core: core)
        p.audioProcessingInitialize(sampleRate: 48_000, channels: 1)
        XCTAssertTrue(p.isHealthy)
        XCTAssertEqual(core.inits, 1)
        p.audioProcessingRelease()
        XCTAssertEqual(core.destroys, 1)
        XCTAssertFalse(p.isHealthy)
    }

    func testProcessForwardsBandedShape() {
        let core = FakeCore()
        let p = VoiceClarityProcessor(core: core)
        p.audioProcessingInitialize(sampleRate: 48_000, channels: 1)
        var buf = [Float](repeating: 0.1, count: 480)
        buf.withUnsafeMutableBufferPointer { ptr in
            p.processChannel(bands: 3, framesPerBand: 160, buffer: ptr.baseAddress!)
        }
        XCTAssertEqual(core.processCalls, 1)
        XCTAssertEqual(core.lastShape?.bands, 3)
        XCTAssertEqual(core.lastShape?.framesPerBand, 160)
    }

    func testErrorBudgetSelfDisables() {
        let core = FakeCore(); core.processResult = -2
        let p = VoiceClarityProcessor(core: core)
        p.audioProcessingInitialize(sampleRate: 48_000, channels: 1)
        var buf = [Float](repeating: 0.1, count: 480)
        buf.withUnsafeMutableBufferPointer { ptr in
            for _ in 0..<50 {
                p.processChannel(bands: 3, framesPerBand: 160, buffer: ptr.baseAddress!)
            }
        }
        XCTAssertFalse(p.isHealthy)
    }

    func testSuccessResetsErrorBudget() {
        let core = FakeCore(); core.processResult = -2
        let p = VoiceClarityProcessor(core: core)
        p.audioProcessingInitialize(sampleRate: 48_000, channels: 1)
        var buf = [Float](repeating: 0.1, count: 480)
        buf.withUnsafeMutableBufferPointer { ptr in
            for _ in 0..<49 { p.processChannel(bands: 3, framesPerBand: 160, buffer: ptr.baseAddress!) }
            core.processResult = 0
            p.processChannel(bands: 3, framesPerBand: 160, buffer: ptr.baseAddress!)
            core.processResult = -2
            for _ in 0..<49 { p.processChannel(bands: 3, framesPerBand: 160, buffer: ptr.baseAddress!) }
        }
        XCTAssertTrue(p.isHealthy)
    }

    func testUserDisableSkipsProcessing() {
        // The user-enable gate lives in processChannel (not only in
        // audioProcessingProcess) precisely so it is testable without an
        // LKAudioBuffer, which cannot be faked (concrete @objcMembers class
        // wrapping an internal LKRTCAudioBuffer).
        let core = FakeCore()
        let p = VoiceClarityProcessor(core: core)
        p.audioProcessingInitialize(sampleRate: 48_000, channels: 1)
        p.isUserEnabled = false
        var buf = [Float](repeating: 0.1, count: 480)
        buf.withUnsafeMutableBufferPointer { ptr in
            p.processChannel(bands: 3, framesPerBand: 160, buffer: ptr.baseAddress!)
        }
        XCTAssertEqual(core.processCalls, 0)
    }

    func testReleaseIdempotentAndProcessAfterReleaseSafe() {
        let core = FakeCore()
        let p = VoiceClarityProcessor(core: core)
        p.audioProcessingInitialize(sampleRate: 48_000, channels: 1)
        p.audioProcessingRelease()
        p.audioProcessingRelease()
        XCTAssertEqual(core.destroys, 1)
        var buf = [Float](repeating: 0, count: 480)
        buf.withUnsafeMutableBufferPointer { ptr in
            p.processChannel(bands: 3, framesPerBand: 160, buffer: ptr.baseAddress!)
        }
        XCTAssertEqual(core.processCalls, 0)
    }
}

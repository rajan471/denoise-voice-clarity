//! C ABI for the mobile adapters (iOS direct; Android via jni.rs in the
//! Android adapter crate). All functions are unsafe-by-contract: the handle
//! must come from `dvc_create`, and the buffer must hold
//! `bands * frames_per_band` valid f32s. No allocation, locks, or logging on
//! the process path.
//!
//! Return-code contract (mirrored by the Kotlin/Swift adapters):
//! -  `0`: success.
//! - `-1`: invalid arguments — null handle, null buffer, `bands <= 0`,
//!   `frames_per_band <= 0`, non-positive sample rate / channel count.
//! - `-2`: the core returned an error. Today the only core error is an
//!   internal length mismatch, which is unreachable through this FFI because
//!   the slice is constructed from the declared `bands * frames_per_band`
//!   shape — the branch is kept for future core errors.

use crate::bands::BandedVoiceClarity;
use crate::Config;
use std::os::raw::{c_float, c_int};

/// Opaque handle around one `BandedVoiceClarity` instance (one per audio
/// stream, owned by a single audio thread).
pub struct DvcHandle(BandedVoiceClarity);

/// Create a new processor with default config.
///
/// # Safety
///
/// The returned pointer owns the instance and must be freed with exactly one
/// call to `dvc_destroy`. Never null.
#[no_mangle]
pub unsafe extern "C" fn dvc_create() -> *mut DvcHandle {
    Box::into_raw(Box::new(DvcHandle(BandedVoiceClarity::new(
        Config::default(),
    ))))
}

/// Destroy a processor created by `dvc_create`. Null is a safe no-op.
///
/// # Safety
///
/// `h` must be null or a pointer obtained from `dvc_create` that has not
/// already been destroyed. The handle must not be used after this call.
#[no_mangle]
pub unsafe extern "C" fn dvc_destroy(h: *mut DvcHandle) {
    if !h.is_null() {
        drop(Box::from_raw(h));
    }
}

/// Bind the processor to a sample rate and channel count.
/// Returns 0 / -1 / -2 per the module-level contract.
///
/// # Safety
///
/// `h` must be null or a live pointer from `dvc_create`, with no other
/// references active (single audio thread ownership).
#[no_mangle]
pub unsafe extern "C" fn dvc_init(h: *mut DvcHandle, sample_rate_hz: c_int, channels: c_int) -> c_int {
    let Some(h) = h.as_mut() else { return -1 };
    if sample_rate_hz <= 0 || channels <= 0 {
        return -1;
    }
    match h.0.init(sample_rate_hz as u32, channels as u32) {
        Ok(()) => 0,
        Err(_) => -2,
    }
}

/// Re-initialise for a new sample rate, dropping all DSP state.
/// Returns 0 / -1 / -2 per the module-level contract.
///
/// # Safety
///
/// `h` must be null or a live pointer from `dvc_create`, with no other
/// references active (single audio thread ownership).
#[no_mangle]
pub unsafe extern "C" fn dvc_reset(h: *mut DvcHandle, new_rate_hz: c_int) -> c_int {
    let Some(h) = h.as_mut() else { return -1 };
    if new_rate_hz <= 0 {
        return -1;
    }
    match h.0.reset(new_rate_hz as u32) {
        Ok(()) => 0,
        Err(_) => -2,
    }
}

/// Process one band-major banded buffer in place (one channel).
/// Returns 0 / -1 / -2 per the module-level contract.
///
/// # Safety
///
/// `h` must be null or a live pointer from `dvc_create`. `buf` must be null
/// or point to at least `bands * frames_per_band` valid, writable f32s that
/// stay valid for the duration of the call. No other references to either may
/// be active (single audio thread ownership).
#[no_mangle]
pub unsafe extern "C" fn dvc_process_banded(
    h: *mut DvcHandle,
    bands: c_int,
    frames_per_band: c_int,
    buf: *mut c_float,
) -> c_int {
    let Some(h) = h.as_mut() else { return -1 };
    if buf.is_null() || bands <= 0 || frames_per_band <= 0 {
        return -1;
    }
    let n = bands as usize * frames_per_band as usize;
    let slice = std::slice::from_raw_parts_mut(buf, n);
    match h.0.process_banded(bands as usize, frames_per_band as usize, slice) {
        Ok(()) => 0,
        Err(_) => -2,
    }
}

/// Master enable. When off, processing is a no-op passthrough.
/// Null handle is a safe no-op.
///
/// # Safety
///
/// `h` must be null or a live pointer from `dvc_create`, with no other
/// references active (single audio thread ownership).
#[no_mangle]
pub unsafe extern "C" fn dvc_set_enabled(h: *mut DvcHandle, enabled: bool) {
    if let Some(h) = h.as_mut() {
        h.0.set_enabled(enabled);
    }
}

/// Set the denoiser's maximum noise attenuation in dB.
/// Null handle is a safe no-op.
///
/// # Safety
///
/// `h` must be null or a live pointer from `dvc_create`, with no other
/// references active (single audio thread ownership).
#[no_mangle]
pub unsafe extern "C" fn dvc_set_attenuation_limit_db(h: *mut DvcHandle, db: c_float) {
    if let Some(h) = h.as_mut() {
        h.0.set_attenuation_limit_db(db);
    }
}

/// True when the full chain (DFN denoiser) is live, i.e. initialised at
/// 48 kHz. Null handle returns false.
///
/// # Safety
///
/// `h` must be null or a live pointer from `dvc_create`, with no mutable
/// reference active concurrently.
#[no_mangle]
pub unsafe extern "C" fn dvc_dfn_active(h: *const DvcHandle) -> bool {
    h.as_ref().map(|h| h.0.dfn_active()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffi_lifecycle_roundtrip() {
        unsafe {
            let h = dvc_create();
            assert!(!h.is_null());
            assert_eq!(dvc_init(h, 48_000, 1), 0);
            let mut buf = [0.1f32; 480];
            assert_eq!(dvc_process_banded(h, 3, 160, buf.as_mut_ptr()), 0);
            // frames_per_band == 0 violates the transport contract -> -1.
            // (A core-level -2 length mismatch is unreachable from C: the FFI
            // constructs the slice from the declared bands * frames_per_band
            // shape, so the lengths always agree.)
            assert_eq!(dvc_process_banded(h, 3, 0, buf.as_mut_ptr()), -1);
            dvc_set_enabled(h, false);
            dvc_set_attenuation_limit_db(h, 24.0);
            assert_eq!(dvc_reset(h, 16_000), 0);
            dvc_destroy(h);
        }
    }

    #[test]
    fn ffi_null_handle_is_safe() {
        unsafe {
            assert_eq!(dvc_init(std::ptr::null_mut(), 48_000, 1), -1);
            assert_eq!(
                dvc_process_banded(std::ptr::null_mut(), 3, 160, std::ptr::null_mut()),
                -1
            );
            dvc_destroy(std::ptr::null_mut()); // must not crash
        }
    }
}

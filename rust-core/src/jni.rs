//! JNI bridge for the Android adapter (com.gruner.voiceclarity.NativeCore).
//! Thin wrappers over ffi.rs; the hot path resolves the direct ByteBuffer
//! address once per call — zero copies.
//!
//! Return codes mirror the ffi.rs contract (0 ok, -1 invalid, -2 core error)
//! plus JNI-specific:
//! - `-4`: buffer is not a direct ByteBuffer, its address is unavailable, or
//!   the address is not 4-byte aligned for f32 access. Direct buffers from
//!   `ByteBuffer.allocateDirect` are at least 8-byte aligned in ART, but a
//!   sliced/offset view might not be — the Kotlin adapter must always pass an
//!   un-sliced direct buffer.
//! - `-5`: buffer capacity is too small for the declared
//!   `bands * framesPerBand` f32 shape.

use crate::ffi::*;
use ::jni::objects::{JByteBuffer, JClass};
use ::jni::sys::{jboolean, jfloat, jint, jlong};
use ::jni::JNIEnv;

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_create(
    _env: JNIEnv,
    _c: JClass,
) -> jlong {
    unsafe { dvc_create() as jlong }
}

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_destroy(
    _env: JNIEnv,
    _c: JClass,
    h: jlong,
) {
    unsafe { dvc_destroy(h as *mut DvcHandle) }
}

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_init(
    _env: JNIEnv,
    _c: JClass,
    h: jlong,
    rate: jint,
    channels: jint,
) -> jint {
    unsafe { dvc_init(h as *mut DvcHandle, rate, channels) }
}

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_reset(
    _env: JNIEnv,
    _c: JClass,
    h: jlong,
    rate: jint,
) -> jint {
    unsafe { dvc_reset(h as *mut DvcHandle, rate) }
}

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_processBanded(
    env: JNIEnv,
    _c: JClass,
    h: jlong,
    bands: jint,
    frames_per_band: jint,
    buf: JByteBuffer,
) -> jint {
    if bands <= 0 || frames_per_band <= 0 {
        return -1;
    }
    let Ok(addr) = env.get_direct_buffer_address(&buf) else {
        return -4;
    };
    if (addr as usize) % core::mem::align_of::<f32>() != 0 {
        return -4;
    }
    let Ok(cap) = env.get_direct_buffer_capacity(&buf) else {
        return -4;
    };
    let needed = (bands as usize) * (frames_per_band as usize) * core::mem::size_of::<f32>();
    if cap < needed {
        return -5;
    }
    unsafe { dvc_process_banded(h as *mut DvcHandle, bands, frames_per_band, addr as *mut f32) }
}

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_setEnabled(
    _env: JNIEnv,
    _c: JClass,
    h: jlong,
    on: jboolean,
) {
    unsafe { dvc_set_enabled(h as *mut DvcHandle, on != 0) }
}

#[no_mangle]
pub extern "system" fn Java_com_gruner_voiceclarity_NativeCore_setAttenuationLimitDb(
    _env: JNIEnv,
    _c: JClass,
    h: jlong,
    db: jfloat,
) {
    unsafe { dvc_set_attenuation_limit_db(h as *mut DvcHandle, db) }
}

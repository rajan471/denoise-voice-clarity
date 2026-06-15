# JNI entry point: native method registration is done by name at runtime, so
# R8 in the consuming app must not rename/strip NativeCore or its natives.
-keepclasseswithmembernames class com.gruner.voiceclarity.NativeCore { native <methods>; }

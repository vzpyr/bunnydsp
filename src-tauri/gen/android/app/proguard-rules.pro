# ProGuard rules to preserve JNI boundaries called from Rust

-keep class com.bunnydsp.eq.MainActivity {
    public *;
    native <methods>;
}

-keep class com.bunnydsp.eq.MainActivity$Companion {
    public *;
}
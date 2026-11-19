-keep class com.cadmaster.offline.cad.** { *; }
-keep class com.cadmaster.offline.data.** { *; }
-keepclasseswithmembers class * {
    native <methods>;
}
-keepclassmembers class * extends androidx.room.RoomDatabase {
    void <init>();
}

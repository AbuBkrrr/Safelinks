# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# LAN router pairing plugin (see MainActivity.registerPlugin call).
# Capacitor's own AAR generally keeps @CapacitorPlugin-annotated
# classes via its bundled consumer rules, but this is registered
# manually via registerPlugin() rather than capacitor.config.json's
# plugin list, so keeping it explicitly removes any doubt.
-keep class com.aibrainsventures.safelinks.RouterLanPairingPlugin { *; }
-keepclassmembers class com.aibrainsventures.safelinks.RouterLanPairingPlugin {
    @com.getcapacitor.PluginMethod <methods>;
}

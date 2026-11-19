# CAD MASTER — Offline Android CAD Viewer & Architecture Guide

CAD Master provides **two standalone offline Android deployment targets** built from this workspace with **zero runtime internet dependencies**, zero external CDNs, zero cloud APIs, and zero online licensing:

1. **Native Android App (`/android/`)**: Kotlin + Jetpack Compose + Room + Android Storage Access Framework (SAF) + native `PdfDocument` / `Bitmap` exporters + optional LibreDWG JNI bridge (`INTERNET` permission is **not** declared in `AndroidManifest.xml`).
2. **Standalone Offline Web/PWA Bundle (`dist/`)**: Fully self-contained React + TypeScript + Vite + Workbox Service Worker (`sw.js`) precaching 100% of JS, CSS, local `@fontsource/*` fonts, SVG/PNG icons, and the `7.5 MB` `@mlightcad/libredwg-web` WebAssembly binary (`wasm/libredwg-web.wasm`) for offline Android installation via **Android WebView / Capacitor** or **Chrome Android "Add to Home Screen" / Trusted Web Activity (TWA)**.

---

## 1. DWG / DXF Library Audit & Offline Limitations

| Engine | Target | License | Network / Cloud Dependency | Supported Formats & Honest Limitations |
| :--- | :--- | :--- | :--- | :--- |
| `dxf-parser` (v1.1.2) | Web / PWA (`dist/`) | MIT | **None** (100% local JS) | Reads ASCII DXF (`R10`–`R2025`). Binary DXF is handled by LibreDWG or requires ASCII DXF export. Custom/proprietary 3D ACIS (`3DSOLID`) or Civil/MEP proxy entities are skipped cleanly without crashing. |
| `@mlightcad/libredwg-web` (v0.9.0) + `/public/wasm/libredwg-web.wasm` | Web / PWA (`dist/`) | GPLv3 | **None** (100% local WASM, 7.5 MB precached by `sw.js`) | Reads binary DWG from AutoCAD **R13 (`AC1012`) through AutoCAD 2018–2025 (`AC1032`)** completely offline. Pre-R13 binary DWGs (`AC1006` R10, `AC1009` R11/R12), password-encrypted DWGs, and proprietary 3D ACIS/AEC objects are rejected or skipped with a clear user message. |
| Custom Streaming `DxfParser.kt` | Native Android (`/android/`) | Project | **None** (streaming `InputStream`) | Reads ASCII DXF (`R10`–`R2025`) directly from Android SAF `Uri` in background I/O without loading cloud services. |
| `DwgParser.kt` + `cadmaster_dwg_jni.cpp` | Native Android (`/android/`) | GPLv3 (LibreDWG) | **None** (requires NDK cross-compiled `libredwg.so`) | Inspects binary DWG version headers (`AC1006`–`AC1032`) natively. Full native DWG entity decoding activates automatically when `libredwg.so` is compiled for Android ABIs and placed in `jniLibs/`; otherwise displays a clear message prompting the user to convert to DXF or use the bundled WASM PWA build. |
| `jspdf` (v4.2.1) & `CadOfflineExporter.kt` | Web / Native Android | MIT / Android SDK | **None** (`Helvetica` PDF / `android.graphics.pdf.PdfDocument`) | Generates vector Drawing PDFs, Measurement Report PDFs, DXF files, CSV sheets, and high-res PNG snapshots locally on device storage. |

---

## 2. Native Android App Features (`/android/`)
- **100% Offline File Access**: Open `.dxf` and `.dwg` files from internal storage or SD card via SAF (`ActivityResultContracts.OpenDocument`) or Android Files (`ACTION_VIEW`).
- **Automatic Line Length Measurement**: Dedicated **Line Length** mode in the bottom bar; tap any line or polyline to inspect total length (`Selected Line Length` / `Polyline Total Length`), individual segments, angle, `ΔX`/`ΔY`, coordinates, and instant unit conversion (`mm`, `cm`, `m`, `in`, `ft`) in a docked bottom measurement bar.
- **Undo & Redo Stack**: Visible Undo/Redo controls in the top header; tracks drawing/dimension edits while excluding zoom and pan viewport changes.
- **Offline PDF & PNG Export**: `CadOfflineExporter.kt` writes A3 landscape engineering PDF sheets and `2400×1600` PNG exports directly to user-selected locations via `ActivityResultContracts.CreateDocument`.
- **Local Room Persistence**: `cad_master_offline.db` saves recent opened files, preferred units, decimal precision, grid/background state, and OSNAP settings locally.

---

## 3. Building the Native Android APK
### Optional Full Binary DWG Support (`libredwg.so`)
1. Cross-compile GNU LibreDWG for Android ABIs (`arm64-v8a`, `armeabi-v7a`, `x86_64`) using the Android NDK.
2. Copy `dwg.h` and headers into `app/src/main/cpp/third_party/libredwg/include/` and each ABI's `libredwg.so` into `app/src/main/jniLibs/<abi>/libredwg.so`.
3. Build the APK — `CMakeLists.txt` automatically links `libredwg.so` when present.

### Compile & Install APK
```bash
cd android
./gradlew testDebugUnitTest
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

---

## 4. Packaging `dist/` as a Standalone Offline Android App (Capacitor / WebView)
Because `vite build` bundles all fonts, icons, parsers, and the `7.5 MB` LibreDWG WASM locally into `dist/` (with Workbox precaching enabled in `dist/sw.js`), you can wrap `dist/` in a standalone Android WebView APK (zero internet needed) using Capacitor:

```bash
# From workspace root after running `npm run build`
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "CAD Master" "com.cadmaster.offline" --web-dir=dist
npx cap add android
npx cap sync android
npx cap open android
```
When bundled inside Capacitor's local `assets/public` WebView (or installed as an Android PWA from Chrome after first load), all DWG/DXF parsing, rendering, Undo/Redo, Line Length inspection, and PDF/PNG exports execute 100% offline on the Android device.

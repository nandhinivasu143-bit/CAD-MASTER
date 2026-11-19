#include <jni.h>
#include <string>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <cstring>

#ifdef HAVE_LIBREDWG
#include <dwg.h>
#endif

namespace {

std::string readMagicHeader(const std::string& filePath) {
    std::ifstream in(filePath, std::ios::binary);
    if (!in.is_open()) {
        return "";
    }
    char buf[7] = {0};
    in.read(buf, 6);
    if (in.gcount() < 6) {
        return "";
    }
    return std::string(buf, 6);
}

#ifdef HAVE_LIBREDWG
std::string convertDwgToDxfString(const std::string& filePath, std::string& outError) {
    Dwg_Data dwg;
    std::memset(&dwg, 0, sizeof(dwg));

    const int status = dwg_read_file(const_cast<char*>(filePath.c_str()), &dwg);
    if (status >= DWG_ERR_CRITICAL) {
        dwg_free(&dwg);
        outError = "LibreDWG failed to decode binary DWG (error code " + std::to_string(status) + ").";
        return "";
    }

    std::ostringstream dxf;
    dxf << std::fixed << std::setprecision(6);
    dxf << "0\nSECTION\n2\nHEADER\n";
    dxf << "9\n$INSUNITS\n70\n" << dwg.header_vars.INSUNITS << "\n";
    dxf << "0\nENDSEC\n";
    dxf << "0\nSECTION\n2\nENTITIES\n";

    for (BITCODE_BL i = 0; i < dwg.num_objects; ++i) {
        Dwg_Object* obj = &dwg.object[i];
        if (!obj || obj->supertype != DWG_SUPERTYPE_ENTITY || !obj->tio.entity) continue;
        Dwg_Object_Entity* ent = obj->tio.entity;

        if (obj->type == DWG_TYPE_LINE && ent->tio.LINE) {
            auto* l = ent->tio.LINE;
            dxf << "0\nLINE\n8\n0\n";
            dxf << "10\n" << l->start.x << "\n20\n" << l->start.y << "\n30\n" << l->start.z << "\n";
            dxf << "11\n" << l->end.x << "\n21\n" << l->end.y << "\n31\n" << l->end.z << "\n";
        } else if (obj->type == DWG_TYPE_CIRCLE && ent->tio.CIRCLE) {
            auto* c = ent->tio.CIRCLE;
            dxf << "0\nCIRCLE\n8\n0\n";
            dxf << "10\n" << c->center.x << "\n20\n" << c->center.y << "\n30\n" << c->center.z << "\n";
            dxf << "40\n" << c->radius << "\n";
        } else if (obj->type == DWG_TYPE_ARC && ent->tio.ARC) {
            auto* a = ent->tio.ARC;
            constexpr double RAD_TO_DEG = 57.29577951308232;
            dxf << "0\nARC\n8\n0\n";
            dxf << "10\n" << a->center.x << "\n20\n" << a->center.y << "\n30\n" << a->center.z << "\n";
            dxf << "40\n" << a->radius << "\n";
            dxf << "50\n" << (a->start_angle * RAD_TO_DEG) << "\n";
            dxf << "51\n" << (a->end_angle * RAD_TO_DEG) << "\n";
        } else if (obj->type == DWG_TYPE_LWPOLYLINE && ent->tio.LWPOLYLINE) {
            auto* p = ent->tio.LWPOLYLINE;
            dxf << "0\nLWPOLYLINE\n8\n0\n";
            dxf << "90\n" << p->num_points << "\n";
            dxf << "70\n" << ((p->flag & 512) ? 1 : 0) << "\n";
            for (BITCODE_BL k = 0; k < p->num_points; ++k) {
                dxf << "10\n" << p->points[k].x << "\n20\n" << p->points[k].y << "\n";
                if (p->bulges && k < p->num_bulges && p->bulges[k] != 0.0) {
                    dxf << "42\n" << p->bulges[k] << "\n";
                }
            }
        }
    }

    dxf << "0\nENDSEC\n0\nEOF\n";
    dwg_free(&dwg);
    return dxf.str();
}
#endif

} // namespace

extern "C" {

JNIEXPORT jboolean JNICALL
Java_com_cadmaster_offline_cad_DwgNativeBridge_nativeIsLibredwgLinked(JNIEnv*, jclass) {
#ifdef HAVE_LIBREDWG
    return JNI_TRUE;
#else
    return JNI_FALSE;
#endif
}

JNIEXPORT jstring JNICALL
Java_com_cadmaster_offline_cad_DwgNativeBridge_nativeInspectDwgHeader(
    JNIEnv* env,
    jclass,
    jstring jPath
) {
    const char* cPath = env->GetStringUTFChars(jPath, nullptr);
    const std::string header = cPath ? readMagicHeader(cPath) : "";
    if (cPath) env->ReleaseStringUTFChars(jPath, cPath);
    return env->NewStringUTF(header.c_str());
}

JNIEXPORT jstring JNICALL
Java_com_cadmaster_offline_cad_DwgNativeBridge_nativeReadDwgToDxf(
    JNIEnv* env,
    jclass,
    jstring jPath
) {
    const char* cPath = env->GetStringUTFChars(jPath, nullptr);
    std::string filePath = cPath ? cPath : "";
    if (cPath) env->ReleaseStringUTFChars(jPath, cPath);

#ifdef HAVE_LIBREDWG
    std::string error;
    std::string result = convertDwgToDxfString(filePath, error);
    if (!error.empty()) {
        std::string tagged = "ERROR:" + error;
        return env->NewStringUTF(tagged.c_str());
    }
    return env->NewStringUTF(result.c_str());
#else
    (void)filePath;
    return env->NewStringUTF("ERROR:Native LibreDWG binary library (libredwg.so) is not bundled yet. See android/README_BUILD_APK.md.");
#endif
}

} // extern "C"

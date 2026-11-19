cmake_minimum_required(VERSION 3.22.1)
project(cadmaster_dwg LANGUAGES CXX)

set(LIBREDWG_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/libredwg/include")
set(LIBREDWG_PREBUILT_SO "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libredwg.so")

add_library(
    cadmaster_dwg
    SHARED
    dwg_jni_bridge.cpp
)

if(EXISTS "${LIBREDWG_INCLUDE_DIR}/dwg.h" AND EXISTS "${LIBREDWG_PREBUILT_SO}")
    message(STATUS "CAD Master: Linking prebuilt LibreDWG for ${ANDROID_ABI}")
    add_library(redwg SHARED IMPORTED)
    set_target_properties(redwg PROPERTIES IMPORTED_LOCATION "${LIBREDWG_PREBUILT_SO}")
    target_include_directories(cadmaster_dwg PRIVATE "${LIBREDWG_INCLUDE_DIR}")
    target_compile_definitions(cadmaster_dwg PRIVATE HAVE_LIBREDWG=1)
    target_link_libraries(cadmaster_dwg redwg log)
else()
    message(STATUS "CAD Master: Building DWG JNI header inspector (place libredwg.so + dwg.h to enable full binary DWG decode)")
    target_link_libraries(cadmaster_dwg log)
endif()

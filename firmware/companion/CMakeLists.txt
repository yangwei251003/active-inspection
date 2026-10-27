cmake_minimum_required(VERSION 3.22)
set(EXTRA_COMPONENT_DIRS
    "vendor/esp-webrtc-solution/components"
    "vendor/esp-webrtc-solution/components/esp_webrtc/impl/whip_signal")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(active_inspection_companion)

cmake_minimum_required(VERSION 3.20)
project(kerchunk_dsp CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
# Always built on the machine that runs it (the appliance, or the CI runner that tests it).
# No -ffast-math: it silently breaks NaN/inf checks the engine relies on.
# Appended (not `set`) so CMake's default Release flags survive -- notably -DNDEBUG, which a
# bare `set(CMAKE_CXX_FLAGS_RELEASE ...)` would drop -- and so a user/cache override of
# CMAKE_CXX_FLAGS_RELEASE isn't clobbered.
string(APPEND CMAKE_CXX_FLAGS_RELEASE " -O3 -march=native")
add_compile_options(-Wall -Wextra -Wpedantic)
# Complex multiply without the C99 inf/NaN recovery path (__mulsc3): only changes results for
# inf/NaN operands, which the DSP never produces, and lets the lane loops vectorize.
add_compile_options(-fcx-limited-range)
find_package(Threads REQUIRED)

find_package(PkgConfig REQUIRED)
pkg_check_modules(FFTW3F REQUIRED IMPORTED_TARGET fftw3f)
find_package(nlohmann_json 3.2 REQUIRED)

file(GLOB KC_SRC CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp)
add_library(kcdsp STATIC ${KC_SRC})
target_include_directories(kcdsp PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(kcdsp PUBLIC PkgConfig::FFTW3F nlohmann_json::nlohmann_json m)

file(GLOB KC_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/test/*.cpp)
add_executable(kerchunk-dsp-tests ${KC_TESTS})
target_link_libraries(kerchunk-dsp-tests PRIVATE kcdsp Threads::Threads)

add_executable(kerchunk-dsp ${CMAKE_CURRENT_SOURCE_DIR}/app/main.cpp)
target_link_libraries(kerchunk-dsp PRIVATE kcdsp Threads::Threads)

if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/tools/cost_bench.cpp)
  add_executable(kc-cost-bench ${CMAKE_CURRENT_SOURCE_DIR}/tools/cost_bench.cpp)
  target_link_libraries(kc-cost-bench PRIVATE kcdsp)
endif()

if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/tools/quiet_survey.cpp)
  add_executable(kc-quiet-survey ${CMAKE_CURRENT_SOURCE_DIR}/tools/quiet_survey.cpp)
  target_link_libraries(kc-quiet-survey PRIVATE kcdsp)
endif()

cmake_minimum_required(VERSION 3.20)
project(kerchunk_dsp CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
# Always built on the machine that runs it (the appliance, or the CI runner that tests it).
# No -ffast-math: it silently breaks NaN/inf checks the engine relies on.
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -march=native")
add_compile_options(-Wall -Wextra -Wpedantic)

find_package(PkgConfig REQUIRED)
pkg_check_modules(FFTW3F REQUIRED IMPORTED_TARGET fftw3f)

file(GLOB KC_SRC CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp)
add_library(kcdsp STATIC ${KC_SRC})
target_include_directories(kcdsp PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(kcdsp PUBLIC PkgConfig::FFTW3F m)

file(GLOB KC_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/test/*.cpp)
add_executable(kerchunk-dsp-tests ${KC_TESTS})
target_link_libraries(kerchunk-dsp-tests PRIVATE kcdsp)

if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/tools/cost_bench.cpp)
  add_executable(kc-cost-bench ${CMAKE_CURRENT_SOURCE_DIR}/tools/cost_bench.cpp)
  target_link_libraries(kc-cost-bench PRIVATE kcdsp)
endif()

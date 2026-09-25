#!/bin/sh
# Throwaway P0 bench build. -march=native: this binary only ever runs on the appliance.
set -e
cd "$(dirname "$0")"
g++ -O3 -march=native -ffast-math -std=c++17 -Wall -Wextra -o p0 p0.cpp -lfftw3f -lm

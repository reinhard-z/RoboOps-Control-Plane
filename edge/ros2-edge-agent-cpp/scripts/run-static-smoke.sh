#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
build_dir="${TMPDIR:-/tmp}/roboops-ros2-edge-agent-smoke"
cxx="${CXX:-c++}"

mkdir -p "$build_dir"

"$cxx" \
  -std=c++17 \
  -Wall \
  -Wextra \
  -Wpedantic \
  -I"$package_dir/include" \
  "$package_dir/src/config.cpp" \
  "$package_dir/src/protocol.cpp" \
  "$package_dir/test/config_protocol_smoke.cpp" \
  -o "$build_dir/config_protocol_smoke"

"$build_dir/config_protocol_smoke"

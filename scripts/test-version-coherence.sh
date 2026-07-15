#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

REPO="$TEMP_ROOT/repo"
mkdir -p "$REPO/scripts" "$REPO/src-tauri" "$REPO/ros"
cp "$SCRIPT_DIR/check-version-coherence.sh" "$REPO/scripts/"

cat >"$REPO/package.json" <<'EOF'
{"version":"0.9.0"}
EOF
cat >"$REPO/src-tauri/Cargo.toml" <<'EOF'
[package]
name = "crebain"
version = "0.9.0"
EOF
cat >"$REPO/src-tauri/tauri.conf.json" <<'EOF'
{"version":"0.9.0"}
EOF
cat >"$REPO/CITATION.cff" <<'EOF'
cff-version: 1.2.0
version: 0.9.0
EOF
cat >"$REPO/ros/package.xml" <<'EOF'
<package><version>0.9.0</version></package>
EOF
cat >"$REPO/flake.nix" <<'EOF'
{ packages.default = { pname = "crebain"; }; }
          pname = "crebain";
          version = "0.9.0";
EOF

git -C "$REPO" init -q
git -C "$REPO" config user.name 'Release Test'
git -C "$REPO" config user.email 'release-test@example.invalid'
git -C "$REPO" add .
git -C "$REPO" commit -qm baseline
baseline="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" tag -a v0.9.0 -m 'CREBAIN 0.9.0'

"$REPO/scripts/check-version-coherence.sh"
"$REPO/scripts/check-version-coherence.sh" --expected-commit "$baseline" v0.9.0

expect_failure() {
  local description="$1"
  shift
  if "$@" >"$TEMP_ROOT/stdout" 2>"$TEMP_ROOT/stderr"; then
    echo "ERROR: mutation unexpectedly passed: $description" >&2
    exit 1
  fi
}

git -C "$REPO" tag lightweight
expect_failure 'lightweight tag' "$REPO/scripts/check-version-coherence.sh" lightweight
expect_failure 'malformed release tag' "$REPO/scripts/check-version-coherence.sh" v0.9.0-extra

printf '\n' >>"$REPO/package.json"
git -C "$REPO" add package.json
git -C "$REPO" commit -qm newer
expect_failure 'annotated tag targeting an older commit' \
  "$REPO/scripts/check-version-coherence.sh" --expected-commit HEAD v0.9.0

sed 's/<version>0.9.0<\//<version>0.8.0<\//' "$REPO/ros/package.xml" >"$TEMP_ROOT/package.xml"
mv "$TEMP_ROOT/package.xml" "$REPO/ros/package.xml"
expect_failure 'metadata version drift' "$REPO/scripts/check-version-coherence.sh"

echo 'OK: version-coherence self-test rejected tag and metadata mutations'

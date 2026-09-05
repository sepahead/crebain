#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECKER="$SCRIPT_DIR/check-ncp-coherence.sh"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/crebain-ncp-coherence.XXXXXX")"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

copy_file() {
  local relative="$1"
  mkdir -p "$FIXTURE_ROOT/$(dirname "$relative")"
  cp "$REPO_ROOT/$relative" "$FIXTURE_ROOT/$relative"
}

for relative in \
  .ncp-consumer \
  scripts/ncp-release-identities.tsv \
  src-tauri/Cargo.toml \
  src-tauri/crates/ncp-headless/Cargo.toml \
  src-tauri/crates/ncp-simulation/Cargo.toml \
  src-tauri/crates/ncp-simulation/Cargo.lock \
  src-tauri/Cargo.lock \
  package.json \
  bun.lock \
  docs/NCP_BRIDGE_HANDOFF.md \
  docs/NATIVE_NCP_SIMULATION.md \
  src/neuro/README.md \
  src-tauri/src/ncp/README.md \
  src-tauri/crates/ncp-headless/README.md \
  SECURITY.md; do
  copy_file "$relative"
done

CREBAIN_NCP_COHERENCE_ROOT="$FIXTURE_ROOT" "$CHECKER" >/dev/null

sed -i.bak 's/54008b16ea0c195a4ccc9691cb533dd1153bf7f0/64008b16ea0c195a4ccc9691cb533dd1153bf7f0/' \
  "$FIXTURE_ROOT/scripts/ncp-release-identities.tsv"
rm "$FIXTURE_ROOT/scripts/ncp-release-identities.tsv.bak"
if CREBAIN_NCP_COHERENCE_ROOT="$FIXTURE_ROOT" "$CHECKER" \
  >"$FIXTURE_ROOT/tag-object-drift.out" 2>&1; then
  echo "ERROR: annotated tag-object drift was accepted" >&2
  exit 1
fi
grep -q "is not an abbreviation of the mapped" "$FIXTURE_ROOT/tag-object-drift.out" \
  || { cat "$FIXTURE_ROOT/tag-object-drift.out" >&2; exit 1; }

copy_file "scripts/ncp-release-identities.tsv"
sed -i.bak 's/2f5bd586d4bb20c90362bb6f5698b7f64057ba4e/3f5bd586d4bb20c90362bb6f5698b7f64057ba4e/' \
  "$FIXTURE_ROOT/scripts/ncp-release-identities.tsv"
rm "$FIXTURE_ROOT/scripts/ncp-release-identities.tsv.bak"
if CREBAIN_NCP_COHERENCE_ROOT="$FIXTURE_ROOT" "$CHECKER" \
  >"$FIXTURE_ROOT/peeled-commit-drift.out" 2>&1; then
  echo "ERROR: peeled-commit drift was accepted" >&2
  exit 1
fi
grep -q "does not equal the mapped" "$FIXTURE_ROOT/peeled-commit-drift.out" \
  || { cat "$FIXTURE_ROOT/peeled-commit-drift.out" >&2; exit 1; }

copy_file "scripts/ncp-release-identities.tsv"

rm "$FIXTURE_ROOT/package.json"
ln -s "$REPO_ROOT/package.json" "$FIXTURE_ROOT/package.json"
if CREBAIN_NCP_COHERENCE_ROOT="$FIXTURE_ROOT" "$CHECKER" \
  >"$FIXTURE_ROOT/symlink-escape.out" 2>&1; then
  echo "ERROR: a symbolic-link pin escape was accepted" >&2
  exit 1
fi
grep -q "must not be a symbolic link" "$FIXTURE_ROOT/symlink-escape.out" \
  || { cat "$FIXTURE_ROOT/symlink-escape.out" >&2; exit 1; }

rm "$FIXTURE_ROOT/package.json"
copy_file "package.json"

printf '\n\nThis runtime uses wire 1.0.\n' >> "$FIXTURE_ROOT/src-tauri/crates/ncp-headless/README.md"
if CREBAIN_NCP_COHERENCE_ROOT="$FIXTURE_ROOT" "$CHECKER" \
  >"$FIXTURE_ROOT/unqualified.out" 2>&1; then
  echo "ERROR: unqualified incompatible wire mutation was accepted" >&2
  exit 1
fi
grep -q "contains unqualified NCP wire reference '1.0'" "$FIXTURE_ROOT/unqualified.out" \
  || { cat "$FIXTURE_ROOT/unqualified.out" >&2; exit 1; }

copy_file "src-tauri/crates/ncp-headless/README.md"
sed -i.bak 's/tag = "v0.8.0"/tag = "v0.7.0"/g' \
  "$FIXTURE_ROOT/src-tauri/crates/ncp-headless/Cargo.toml"
rm "$FIXTURE_ROOT/src-tauri/crates/ncp-headless/Cargo.toml.bak"
if CREBAIN_NCP_COHERENCE_ROOT="$FIXTURE_ROOT" "$CHECKER" \
  >"$FIXTURE_ROOT/tag-drift.out" 2>&1; then
  echo "ERROR: isolated manifest tag drift was accepted" >&2
  exit 1
fi
grep -q "NCP Cargo manifests pin different tags" "$FIXTURE_ROOT/tag-drift.out" \
  || { cat "$FIXTURE_ROOT/tag-drift.out" >&2; exit 1; }

copy_file "src-tauri/crates/ncp-headless/Cargo.toml"

native_manifest="src-tauri/crates/ncp-simulation/Cargo.toml"
native_lock="src-tauri/crates/ncp-simulation/Cargo.lock"
native_doc="docs/NATIVE_NCP_SIMULATION.md"

expect_native_rejection() {
  local label="$1"
  local diagnostic="$2"
  if CREBAIN_NCP_COHERENCE_ROOT="$FIXTURE_ROOT" "$CHECKER" \
    >"$FIXTURE_ROOT/$label.out" 2>&1; then
    echo "ERROR: $label was accepted" >&2
    exit 1
  fi
  grep -Fq "$diagnostic" "$FIXTURE_ROOT/$label.out" \
    || { cat "$FIXTURE_ROOT/$label.out" >&2; exit 1; }
  copy_file "$native_manifest"
  copy_file "$native_lock"
  copy_file "$native_doc"
  CREBAIN_NCP_COHERENCE_ROOT="$FIXTURE_ROOT" "$CHECKER" >/dev/null
}

sed -i.bak '/^ncp-local =/s@https://github.com/sepahead/NCP@https://github.com/example/NCP@' \
  "$FIXTURE_ROOT/$native_manifest"
expect_native_rejection native-repository-drift 'native ncp-local must use the canonical public Git repository'

sed -i.bak '/^ncp-local =/s/rev = "[0-9a-f]*"/rev = "0000000000000000000000000000000000000000"/' \
  "$FIXTURE_ROOT/$native_manifest"
expect_native_rejection native-revision-drift 'native ncp-local lock source does not equal its exact public revision'

sed -i.bak '/^ncp-local =/s/rev = "[0-9a-f]*"/rev = "de751d4"/' \
  "$FIXTURE_ROOT/$native_manifest"
expect_native_rejection native-short-revision 'native ncp-local revision must contain 40 lowercase hex characters'

sed -i.bak '/^ncp-local =/s/version = "=/version = "/' "$FIXTURE_ROOT/$native_manifest"
expect_native_rejection native-version-range 'native ncp-local version must be an exact stable =MAJOR.MINOR.PATCH'

sed -i.bak '/^ncp-local =/s/version = "=[^"]*"/version = "=99.0.0"/' "$FIXTURE_ROOT/$native_manifest"
expect_native_rejection native-version-drift 'native ncp-local lock version differs from its exact manifest version'

sed -i.bak '/^ncp-local =/s/ }/, path = "..\/sibling" }/' "$FIXTURE_ROOT/$native_manifest"
expect_native_rejection native-path-override 'native ncp-local may not declare a path, branch, or tag override'

printf '\n[patch."https://github.com/sepahead/NCP"]\n' >> "$FIXTURE_ROOT/$native_manifest"
expect_native_rejection native-patch-override 'native ncp-local workspace may not declare patch or replace overrides'

awk '
  /^\[\[package\]\]$/ { in_package = 0 }
  $0 == "name = \"ncp-local\"" { in_package = 1 }
  in_package && /^source = / { next }
  { print }
' "$FIXTURE_ROOT/$native_lock" > "$FIXTURE_ROOT/native-lock-mutated"
mv "$FIXTURE_ROOT/native-lock-mutated" "$FIXTURE_ROOT/$native_lock"
expect_native_rejection native-path-lock 'native ncp-local lock source does not equal its exact public revision'

awk '
  /^\[\[package\]\]$/ { in_package = 0 }
  $0 == "name = \"ncp-local\"" { in_package = 1 }
  in_package && /^source = / { sub(/#[0-9a-f]+/, "#0000000000000000000000000000000000000000") }
  { print }
' "$FIXTURE_ROOT/$native_lock" > "$FIXTURE_ROOT/native-lock-mutated"
mv "$FIXTURE_ROOT/native-lock-mutated" "$FIXTURE_ROOT/$native_lock"
expect_native_rejection native-lock-commit-drift 'native ncp-local lock source does not equal its exact public revision'

awk '
  /^\[\[package\]\]$/ { in_package = 0 }
  $0 == "name = \"ncp-local\"" { in_package = 1 }
  in_package && /^version = / { $0 = "version = \"99.0.0\"" }
  { print }
' "$FIXTURE_ROOT/$native_lock" > "$FIXTURE_ROOT/native-lock-mutated"
mv "$FIXTURE_ROOT/native-lock-mutated" "$FIXTURE_ROOT/$native_lock"
expect_native_rejection native-lock-version-drift 'native ncp-local lock version differs from its exact manifest version'

sed -i.bak '/^<!-- ncp-local-pin:/s/[0-9a-f]\{40\}/0000000000000000000000000000000000000000/' \
  "$FIXTURE_ROOT/$native_doc"
expect_native_rejection native-doc-drift 'native ncp-local documentation marker differs from its exact manifest pin'

rm "$FIXTURE_ROOT/$native_lock"
ln -s "$REPO_ROOT/$native_lock" "$FIXTURE_ROOT/$native_lock"
if CREBAIN_NCP_COHERENCE_ROOT="$FIXTURE_ROOT" "$CHECKER" \
  >"$FIXTURE_ROOT/native-symlink.out" 2>&1; then
  echo "ERROR: native symbolic-link lock was accepted" >&2
  exit 1
fi
grep -Fq 'must not be a symbolic link' "$FIXTURE_ROOT/native-symlink.out" \
  || { cat "$FIXTURE_ROOT/native-symlink.out" >&2; exit 1; }
rm "$FIXTURE_ROOT/$native_lock"
copy_file "$native_lock"
CREBAIN_NCP_COHERENCE_ROOT="$FIXTURE_ROOT" "$CHECKER" >/dev/null

echo "OK: NCP coherence self-test passed (5 historical and 12 native negatives; restored positive after each native mutation)"

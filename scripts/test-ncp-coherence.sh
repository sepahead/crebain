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
  src-tauri/Cargo.lock \
  package.json \
  bun.lock \
  docs/NCP_BRIDGE_HANDOFF.md \
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

echo "OK: NCP coherence self-test passed (identity, symlink, wire, and isolated-tag drift rejected)"

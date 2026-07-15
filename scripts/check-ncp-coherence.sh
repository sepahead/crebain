#!/usr/bin/env bash
# Read-only, offline guard for CREBAIN's NCP consumer contract.
#
# `.ncp-consumer` declares the pin-bearing files. This guard derives the release
# tag from the Cargo manifest, then requires the Rust and npm manifests,
# lockfiles, and curated current-state documentation to agree. It intentionally
# performs no install, build, git, or network operation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESCRIPTOR="$REPO_ROOT/.ncp-consumer"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

single_value() {
  local label="$1"
  local values="$2"
  local count
  count="$(printf '%s\n' "$values" | sed '/^[[:space:]]*$/d' | wc -l | tr -d '[:space:]')"
  [[ "$count" == "1" ]] || die "$label: expected exactly one match, found $count"
  printf '%s' "$values"
}

safe_declared_file() {
  local relative="$1"
  case "$relative" in
    ""|/*|..|../*|*/..|*/../*) die "unsafe path in .ncp-consumer: '$relative'" ;;
  esac
  [[ -f "$REPO_ROOT/$relative" ]] || die "declared pin file is missing: $relative"
}

[[ -f "$DESCRIPTOR" ]] || die ".ncp-consumer is missing"

cargo_manifest=""
cargo_lock=""
npm_manifest=""
npm_lock=""

while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line="${raw_line%%#*}"
  kind=""
  relative=""
  extra=""
  read -r kind relative extra <<< "$line"
  [[ -n "$kind" ]] || continue
  [[ -n "$relative" && -z "$extra" ]] || die "malformed .ncp-consumer row: $raw_line"
  safe_declared_file "$relative"
  case "$kind" in
    cargo_tag)
      [[ -z "$cargo_manifest" ]] || die "duplicate cargo_tag declaration"
      cargo_manifest="$REPO_ROOT/$relative"
      ;;
    cargo_lock)
      [[ -z "$cargo_lock" ]] || die "duplicate cargo_lock declaration"
      cargo_lock="$REPO_ROOT/$relative"
      ;;
    npm_tag)
      [[ -z "$npm_manifest" ]] || die "duplicate npm_tag declaration"
      npm_manifest="$REPO_ROOT/$relative"
      ;;
    npm_lock)
      [[ -z "$npm_lock" ]] || die "duplicate npm_lock declaration"
      npm_lock="$REPO_ROOT/$relative"
      ;;
    *) die "unsupported .ncp-consumer pin type for CREBAIN: $kind" ;;
  esac
done < "$DESCRIPTOR"

[[ -n "$cargo_manifest" ]] || die ".ncp-consumer has no cargo_tag declaration"
[[ -n "$cargo_lock" ]] || die ".ncp-consumer has no cargo_lock declaration"
[[ -n "$npm_manifest" ]] || die ".ncp-consumer has no npm_tag declaration"
[[ -n "$npm_lock" ]] || die ".ncp-consumer has no npm_lock declaration"

cargo_line() {
  local crate="$1"
  local matches
  matches="$(sed -nE "/^[[:space:]]*${crate}[[:space:]]*=/p" "$cargo_manifest")"
  single_value "$crate declaration in ${cargo_manifest#"$REPO_ROOT/"}" "$matches"
}

cargo_field() {
  local declaration="$1"
  local field="$2"
  local values
  values="$(printf '%s\n' "$declaration" | sed -nE "s/.*${field}[[:space:]]*=[[:space:]]*\"([^\"]+)\".*/\\1/p")"
  single_value "$field field in NCP Cargo dependency" "$values"
}

core_line="$(cargo_line ncp-core)"
zenoh_line="$(cargo_line ncp-zenoh)"
for declaration in "$core_line" "$zenoh_line"; do
  [[ "$(cargo_field "$declaration" git)" == "https://github.com/sepahead/NCP" ]] \
    || die "NCP Cargo dependency does not use the canonical repository"
  if printf '%s\n' "$declaration" | grep -Eq '(branch|rev)[[:space:]]*='; then
    die "tag-based .ncp-consumer entry may not also declare branch/rev"
  fi
done

tag="$(cargo_field "$core_line" tag)"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "NCP Cargo tag is not a stable vMAJOR.MINOR.PATCH release: $tag"
[[ "$(cargo_field "$zenoh_line" tag)" == "$tag" ]] \
  || die "ncp-core and ncp-zenoh manifest tags differ"

lock_source() {
  local crate="$1"
  awk -v crate="$crate" '
    /^\[\[package\]\]$/ {
      if (in_package && !printed_source) print "<missing source>"
      in_package = 0
      printed_source = 0
      next
    }
    $0 == "name = \"" crate "\"" { in_package = 1; next }
    in_package && /^source = "/ {
      line = $0
      sub(/^source = "/, "", line)
      sub(/"$/, "", line)
      print line
      printed_source = 1
    }
    END { if (in_package && !printed_source) print "<missing source>" }
  ' "$cargo_lock"
}

lock_commit=""
for crate in ncp-core ncp-zenoh; do
  source="$(single_value "$crate source in ${cargo_lock#"$REPO_ROOT/"}" "$(lock_source "$crate")")"
  prefix="git+https://github.com/sepahead/NCP?tag=$tag#"
  [[ "$source" == "$prefix"* ]] || die "$crate lock source does not pin $tag: $source"
  commit="${source#"$prefix"}"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "$crate lock source lacks a 40-hex commit"
  if [[ -z "$lock_commit" ]]; then
    lock_commit="$commit"
  else
    [[ "$commit" == "$lock_commit" ]] || die "ncp-core and ncp-zenoh resolve different commits"
  fi
done

npm_spec="$(single_value \
  "@sepahead/ncp declaration in ${npm_manifest#"$REPO_ROOT/"}" \
  "$(sed -nE 's/^[[:space:]]*"@sepahead\/ncp"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$npm_manifest")")"
expected_npm_spec="github:sepahead/NCP#$tag"
[[ "$npm_spec" == "$expected_npm_spec" ]] \
  || die "npm manifest pins '$npm_spec', expected '$expected_npm_spec'"

npm_lock_spec="$(single_value \
  "@sepahead/ncp root spec in ${npm_lock#"$REPO_ROOT/"}" \
  "$(sed -nE 's/^[[:space:]]*"@sepahead\/ncp"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$npm_lock")")"
[[ "$npm_lock_spec" == "$expected_npm_spec" ]] \
  || die "npm lock root spec pins '$npm_lock_spec', expected '$expected_npm_spec'"

npm_resolution="$(single_value \
  "@sepahead/ncp resolved package in ${npm_lock#"$REPO_ROOT/"}" \
  "$(sed -nE 's/^[[:space:]]*"@sepahead\/ncp"[[:space:]]*:[[:space:]]*\["@sepahead\/ncp@github:sepahead\/NCP#([0-9a-f]+)".*"sepahead-NCP-([0-9a-f]+)".*/\1 \2/p' "$npm_lock")")"
read -r npm_commit npm_cache_key <<< "$npm_resolution"
[[ "$npm_commit" == "$npm_cache_key" ]] \
  || die "npm lock resolved commit and cache key differ"
[[ "${#npm_commit}" -ge 7 && "${#npm_commit}" -le 40 ]] \
  || die "npm lock resolved ref must contain 7 to 40 hex characters"

wire="${tag#v}"
wire="${wire%.*}"
normative_docs=(
  "docs/NCP_BRIDGE_HANDOFF.md"
  "src/neuro/README.md"
  "src-tauri/src/ncp/README.md"
  "SECURITY.md"
)

for relative in "${normative_docs[@]}"; do
  file="$REPO_ROOT/$relative"
  [[ -f "$file" ]] || die "normative NCP document is missing: $relative"
  marker="$(single_value \
    "ncp-pin marker in $relative" \
    "$(sed -nE 's/^[[:space:]]*<!--[[:space:]]*ncp-pin:[[:space:]]*([^[:space:]]+)[[:space:]]*-->[[:space:]]*$/\1/p' "$file")")"
  [[ "$marker" == "$tag" ]] || die "$relative marker pins '$marker', expected '$tag'"

  # The explicit marker is the authoritative NCP release pin. These documents
  # also describe CREBAIN releases and may legitimately contain other semantic
  # versions, so a document-wide version scan would conflate independent pins.

  wire_references="$(grep -Eio 'wire[-[:space:]]+`?[0-9]+\.[0-9]+' "$file" \
    | grep -Eo '[0-9]+\.[0-9]+' | sort -u || true)"
  while IFS= read -r reference; do
    [[ -n "$reference" ]] || continue
    [[ "$reference" == "$wire" ]] \
      || die "$relative contains stale NCP wire reference '$reference' (expected '$wire')"
  done <<< "$wire_references"
done

echo "OK: NCP $tag (wire $wire) is coherent"
echo "  Cargo lock commit: $lock_commit"
echo "  Bun lock ref:      $npm_commit"
echo "  Normative docs:    ${normative_docs[*]}"

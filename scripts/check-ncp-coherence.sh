#!/usr/bin/env bash
# Read-only, offline guard for CREBAIN's NCP consumer contract.
#
# `.ncp-consumer` declares the revision-pinned Cargo files. This guard requires
# the Rust and npm manifests, lockfiles, the identity map, and curated
# current-state documentation to agree on that exact NCP revision. It
# intentionally performs no install, build, git, or network operation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_ROOT="${CREBAIN_NCP_COHERENCE_ROOT:-$DEFAULT_REPO_ROOT}"
[[ -d "$REPO_ROOT" && "$REPO_ROOT" != "/" ]] \
  || { echo "ERROR: invalid CREBAIN_NCP_COHERENCE_ROOT" >&2; exit 1; }
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"
DESCRIPTOR="$REPO_ROOT/.ncp-consumer"
RELEASE_IDENTITIES="$REPO_ROOT/scripts/ncp-release-identities.tsv"

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

safe_repo_file() {
  local relative="$1"
  local label="$2"
  local file
  local parent
  case "$relative" in
    ""|/*|..|../*|*/..|*/../*) die "unsafe repository path: '$relative'" ;;
  esac
  file="$REPO_ROOT/$relative"
  [[ -f "$file" ]] || die "$label is missing: $relative"
  [[ ! -L "$file" ]] || die "$label must not be a symbolic link: $relative"
  parent="$(cd "$(dirname "$file")" && pwd -P)" \
    || die "cannot resolve parent directory for $relative"
  case "$parent" in
    "$REPO_ROOT"|"$REPO_ROOT"/*) ;;
    *) die "$label resolves outside the repository: $relative" ;;
  esac
}

safe_declared_file() {
  safe_repo_file "$1" "declared pin file"
}

safe_repo_file ".ncp-consumer" ".ncp-consumer"
safe_repo_file "scripts/ncp-release-identities.tsv" "NCP release identity map"

cargo_manifests=()
cargo_lock=""
label=""
revision=""
while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line="${raw_line%%#*}"
  kind=""
  relative=""
  row_label=""
  row_revision=""
  extra=""
  read -r kind relative row_label row_revision extra <<< "$line"
  [[ -n "$kind" ]] || continue
  case "$kind" in
    cargo_rev|cargo_lock_rev) ;;
    *) die "unsupported .ncp-consumer pin type for CREBAIN: $kind" ;;
  esac
  [[ -n "$relative" && -n "$row_label" && -n "$row_revision" && -z "$extra" ]] \
    || die "malformed .ncp-consumer row: $raw_line"
  safe_declared_file "$relative"
  [[ "$row_label" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] \
    || die "NCP pin label is not vMAJOR.MINOR.PATCH or a release candidate: $row_label"
  [[ "$row_revision" =~ ^[0-9a-f]{40}$ ]] \
    || die "NCP pin revision must contain 40 lowercase hex characters: $row_revision"
  if [[ -z "$label" ]]; then
    label="$row_label"
    revision="$row_revision"
  else
    [[ "$row_label" == "$label" && "$row_revision" == "$revision" ]] \
      || die "NCP pin rows disagree: $label $revision and $row_label $row_revision"
  fi
  case "$kind" in
    cargo_rev)
      cargo_manifests+=("$REPO_ROOT/$relative")
      ;;
    cargo_lock_rev)
      [[ -z "$cargo_lock" ]] || die "duplicate cargo_lock_rev declaration"
      cargo_lock="$REPO_ROOT/$relative"
      ;;
  esac
done < "$DESCRIPTOR"

[[ "${#cargo_manifests[@]}" -gt 0 ]] || die ".ncp-consumer has no cargo_rev declaration"
[[ -n "$cargo_lock" ]] || die ".ncp-consumer has no cargo_lock_rev declaration"

cargo_line() {
  local manifest="$1"
  local crate="$2"
  local matches
  matches="$(sed -nE "/^[[:space:]]*${crate}[[:space:]]*=/p" "$manifest")"
  single_value "$crate declaration in ${manifest#"$REPO_ROOT/"}" "$matches"
}

cargo_field() {
  local declaration="$1"
  local field="$2"
  local values
  values="$(printf '%s\n' "$declaration" | sed -nE "s/.*${field}[[:space:]]*=[[:space:]]*\"([^\"]+)\".*/\\1/p")"
  single_value "$field field in NCP Cargo dependency" "$values"
}

for cargo_manifest in "${cargo_manifests[@]}"; do
  core_line="$(cargo_line "$cargo_manifest" ncp-core)"
  zenoh_line="$(cargo_line "$cargo_manifest" ncp-zenoh)"
  for declaration in "$core_line" "$zenoh_line"; do
    [[ "$(cargo_field "$declaration" git)" == "https://github.com/sepahead/NCP" ]] \
      || die "NCP Cargo dependency does not use the canonical repository"
    if printf '%s\n' "$declaration" | grep -Eq '(branch|tag)[[:space:]]*='; then
      die "revision-pinned NCP Cargo dependency may not also declare a branch or tag"
    fi
    [[ "$(cargo_field "$declaration" rev)" == "$revision" ]] \
      || die "NCP Cargo manifest does not pin the declared revision in ${cargo_manifest#"$REPO_ROOT/"}"
  done
done

lock_source() {
  local crate="$1"
  local lock_file="${2:-$cargo_lock}"
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
  ' "$lock_file"
}

for crate in ncp-core ncp-zenoh; do
  source="$(single_value "$crate source in ${cargo_lock#"$REPO_ROOT/"}" "$(lock_source "$crate")")"
  [[ "$source" == "git+https://github.com/sepahead/NCP?rev=$revision#$revision" ]] \
    || die "$crate lock source does not pin $revision: $source"
done

# NCP's consumer grammar has no npm revision row, so the npm pin files are fixed
# here instead of being declared in `.ncp-consumer`.
safe_repo_file "package.json" "NCP npm manifest"
safe_repo_file "bun.lock" "NCP npm lockfile"
npm_manifest="$REPO_ROOT/package.json"
npm_lock="$REPO_ROOT/bun.lock"
expected_npm_spec="github:sepahead/NCP#$revision"
npm_spec="$(single_value \
  "@sepahead/ncp declaration in package.json" \
  "$(sed -nE 's/^[[:space:]]*"@sepahead\/ncp"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$npm_manifest")")"
[[ "$npm_spec" == "$expected_npm_spec" ]] \
  || die "npm manifest pins '$npm_spec', expected '$expected_npm_spec'"
npm_lock_spec="$(single_value \
  "@sepahead/ncp root spec in bun.lock" \
  "$(sed -nE 's/^[[:space:]]*"@sepahead\/ncp"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$npm_lock")")"
[[ "$npm_lock_spec" == "$expected_npm_spec" ]] \
  || die "npm lock root spec pins '$npm_lock_spec', expected '$expected_npm_spec'"
npm_resolution="$(single_value \
  "@sepahead/ncp resolved package in bun.lock" \
  "$(sed -nE 's/^[[:space:]]*"@sepahead\/ncp"[[:space:]]*:[[:space:]]*\["@sepahead\/ncp@github:sepahead\/NCP#([0-9a-f]+)".*"sepahead-NCP-([0-9a-f]+)".*/\1 \2/p' "$npm_lock")")"
read -r npm_commit npm_cache_key <<< "$npm_resolution"
[[ "$npm_commit" == "$npm_cache_key" ]] \
  || die "npm lock resolved commit and cache key differ"
[[ "${#npm_commit}" -ge 7 && "${#npm_commit}" -le 40 ]] \
  || die "npm lock resolved ref must contain 7 to 40 hex characters"
[[ "$revision" == "$npm_commit"* ]] \
  || die "Bun lock ref $npm_commit is not an abbreviation of the declared revision $revision"

identity_rows="$(awk -v release="$label" '
  /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
  $1 == release { print }
' "$RELEASE_IDENTITIES")"
identity_row="$(single_value "release identity for $label" "$identity_rows")"
read -r identity_label tag_object identity_commit identity_extra <<< "$identity_row"
[[ "$identity_label" == "$label" && -z "$identity_extra" ]] \
  || die "malformed release identity for $label"
[[ "$tag_object" == "-" || "$tag_object" =~ ^[0-9a-f]{40}$ ]] \
  || die "$label tag object must be '-' (untagged) or 40 lowercase hex characters"
[[ "$identity_commit" =~ ^[0-9a-f]{40}$ ]] \
  || die "$label commit must contain 40 lowercase hex characters"
[[ "$revision" == "$identity_commit" ]] \
  || die "declared revision $revision does not equal the mapped $label commit $identity_commit"

wire="${label#v}"
wire="${wire%%-*}"
wire="${wire%.*}"

normative_docs=(
  "docs/NCP_BRIDGE_HANDOFF.md"
  "src/neuro/README.md"
  "src-tauri/src/ncp/README.md"
  "src-tauri/crates/ncp-headless/README.md"
  "SECURITY.md"
)
for relative in "${normative_docs[@]}"; do
  file="$REPO_ROOT/$relative"
  [[ -f "$file" ]] || die "normative NCP document is missing: $relative"
  marker="$(single_value \
    "ncp-pin marker in $relative" \
    "$(sed -nE 's/^[[:space:]]*<!--[[:space:]]*ncp-pin:[[:space:]]*([^[:space:]]+)[[:space:]]*-->[[:space:]]*$/\1/p' "$file")")"
  [[ "$marker" == "$label" ]] || die "$relative marker pins '$marker', expected '$label'"
  while IFS=: read -r line_number matched; do
    [[ -n "$line_number" && -n "$matched" ]] || continue
    reference="$(printf '%s\n' "$matched" | grep -Eo '[0-9]+\.[0-9]+' | head -1)"
    [[ -n "$reference" ]] || continue
    if [[ "$reference" == "$wire" ]]; then
      continue
    fi
    context_start=$((line_number > 1 ? line_number - 1 : 1))
    context_end=$((line_number + 1))
    context="$(sed -n "${context_start},${context_end}p" "$file")"
    if printf '%s\n' "$context" | grep -Eiq \
      '(retired|historical|previous|formerly|incompatib|no[[:space:]]+([^[:space:]]+[[:space:]]+){0,3}translat)'; then
      continue
    fi
    die "$relative:$line_number contains unqualified NCP wire reference '$reference' (CREBAIN pins '$wire'; another wire must be explicitly retired or incompatible)"
  done < <(grep -Enio 'wire[-[:space:]]+`?[0-9]+\.[0-9]+' "$file" || true)
done

# The separate scalar adapter consumes the local SDK, not the historical wire
# packages above. This remains an offline consistency check, not proof of public
# resolution, loaded executable identity, or installed interoperability.
native_manifest="src-tauri/crates/ncp-simulation/Cargo.toml"
native_lock="src-tauri/crates/ncp-simulation/Cargo.lock"
native_doc="docs/NATIVE_NCP_SIMULATION.md"
for relative in "$native_manifest" "$native_lock" "$native_doc"; do
  safe_repo_file "$relative" "native NCP pin file"
done
native_line="$(cargo_line "$REPO_ROOT/$native_manifest" ncp-local)"
[[ "$(cargo_field "$native_line" git)" == "https://github.com/sepahead/NCP" ]] \
  || die "native ncp-local must use the canonical public Git repository"
if printf '%s\n' "$native_line" | grep -Eq '(path|branch|tag)[[:space:]]*='; then
  die "native ncp-local may not declare a path, branch, or tag override"
fi
if grep -Eq '^\[(patch([.]|\])|replace\])' "$REPO_ROOT/$native_manifest"; then
  die "native ncp-local workspace may not declare patch or replace overrides"
fi
native_rev="$(cargo_field "$native_line" rev)"
native_version="$(cargo_field "$native_line" version)"
[[ "$native_rev" =~ ^[0-9a-f]{40}$ ]] \
  || die "native ncp-local revision must contain 40 lowercase hex characters"
[[ "$native_version" =~ ^=([0-9]+\.[0-9]+\.[0-9]+)$ ]] \
  || die "native ncp-local version must be an exact stable =MAJOR.MINOR.PATCH"
native_version="${native_version#=}"
native_source="$(single_value 'native ncp-local lock source' "$(lock_source ncp-local "$REPO_ROOT/$native_lock")")"
[[ "$native_source" == "git+https://github.com/sepahead/NCP?rev=$native_rev#$native_rev" ]] \
  || die "native ncp-local lock source does not equal its exact public revision"
native_locked_version="$(single_value 'native ncp-local lock version' "$(awk '
  /^\[\[package\]\]$/ { in_package = 0; next }
  $0 == "name = \"ncp-local\"" { in_package = 1; next }
  in_package && /^version = "/ {
    sub(/^version = "/, ""); sub(/"$/, ""); print
  }
' "$REPO_ROOT/$native_lock")")"
[[ "$native_locked_version" == "$native_version" ]] \
  || die "native ncp-local lock version differs from its exact manifest version"
native_marker="$(single_value 'native ncp-local documentation marker' "$(sed -nE \
  's/^<!-- ncp-local-pin: ([0-9]+\.[0-9]+\.[0-9]+ [0-9a-f]{40}) -->$/\1/p' \
  "$REPO_ROOT/$native_doc")")"
[[ "$native_marker" == "$native_version $native_rev" ]] \
  || die "native ncp-local documentation marker differs from its exact manifest pin"

echo "OK: NCP $label ($revision, wire $wire) is coherent"
echo "  Release identity:  tag object $tag_object, commit $identity_commit"
echo "  Cargo revision:    $revision"
echo "  Bun ref:           $npm_commit"
echo "  Normative docs:    ${normative_docs[*]}"
echo "OK: native ncp-local $native_version at $native_rev is coherent (offline source join only)"

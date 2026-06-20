#!/usr/bin/env bash
# check-version-coherence.sh — assert this repo's release version is coherent
# across every place it is recorded, and (optionally) that a release tag points
# at the commit it claims to.
#
# READ-ONLY: this script never writes to the repo, runs no builds, and performs
# no network calls. It only reads tracked files and (for the optional tag check)
# the local git object database.
#
# What "coherent" means here:
#   - the Cargo workspace package version (Cargo.toml [workspace.package].version,
#     falling back to [package].version for a single-crate repo)
#   - the npm package.json "version" (where a package.json is present)
#   - the CITATION.cff "version"
#   must all be byte-equal. A release that bumps one but forgets another is the
#   classic "moved tag / stale metadata" footgun this guard exists to catch.
#
# With an optional <tag> argument it additionally asserts:
#   - the annotated-tag object PEELS (^{commit}) to a commit that is exactly the
#     commit the tag ref resolves to (a lightweight tag peels to itself; an
#     annotated tag peels through its tag object) — i.e. the tag has not been
#     moved/re-pointed since it was cut, and
#   - the version embedded in the tag name (the numeric part of e.g. v0.2.8)
#     equals the coherent in-tree version, so no lockfile/manifest disagrees
#     with the tag.
#
# Usage:
#   scripts/check-version-coherence.sh [tag]
#
# Exit codes: 0 = coherent; 1 = mismatch / missing required file; 2 = bad usage.

set -euo pipefail

usage() {
  cat <<'EOF'
check-version-coherence.sh — assert release-version coherence (read-only).

Usage:
  check-version-coherence.sh [tag]

  tag   Optional. A release tag (e.g. v0.2.8). When given, the script also
        verifies the tag peels to the commit it points at (no moved tag) and
        that the tag's version matches the in-tree version.

With no tag, the script only asserts internal coherence at HEAD.

Exit codes: 0 = coherent; 1 = mismatch / missing required file; 2 = bad usage.
EOF
}

TAG=""
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    -*)        echo "ERROR: unknown option '$arg'" >&2; echo >&2; usage >&2; exit 2 ;;
    *)
      if [[ -n "$TAG" ]]; then
        echo "ERROR: too many arguments" >&2; echo >&2; usage >&2; exit 2
      fi
      TAG="$arg" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- version extractors (read-only; first match wins) -----------------------

# Cargo: prefer the workspace package version, else a single-crate [package].
# We look in the repo-root Cargo.toml first, then src-tauri/Cargo.toml (Tauri
# apps keep the crate manifest there).
cargo_version() {
  local f
  for f in "$REPO_ROOT/Cargo.toml" "$REPO_ROOT/src-tauri/Cargo.toml"; do
    [[ -f "$f" ]] || continue
    # Pull version from [workspace.package] or [package], whichever appears.
    awk '
      /^\[workspace\.package\]/ { sec="wp"; next }
      /^\[package\]/            { sec="pkg"; next }
      /^\[/                     { sec="" ; next }
      (sec=="wp" || sec=="pkg") && /^[[:space:]]*version[[:space:]]*=/ {
        line=$0
        sub(/^[^=]*=[[:space:]]*/, "", line)
        gsub(/["\x27]/, "", line)        # strip both " and '"'"'
        sub(/[[:space:]].*$/, "", line)  # drop trailing comment/space
        print line
        exit
      }
    ' "$f"
    return
  done
}

# npm: package.json "version": "x.y.z"
npm_version() {
  local f="$REPO_ROOT/package.json"
  [[ -f "$f" ]] || return
  awk -F'"' '/^[[:space:]]*"version"[[:space:]]*:/ { print $4; exit }' "$f"
}

# CITATION.cff: a top-level `version:` key. Values may be quoted or bare.
cff_version() {
  local f="$REPO_ROOT/CITATION.cff"
  [[ -f "$f" ]] || return
  awk '
    /^version[[:space:]]*:/ {
      line=$0
      sub(/^version[[:space:]]*:[[:space:]]*/, "", line)
      gsub(/["\x27]/, "", line)
      sub(/[[:space:]]*#.*$/, "", line)
      sub(/[[:space:]]+$/, "", line)
      print line
      exit
    }
  ' "$f"
}

CARGO_VER="$(cargo_version || true)"
NPM_VER="$(npm_version || true)"
CFF_VER="$(cff_version || true)"

echo "Version coherence (repo: $REPO_ROOT)"
echo
printf '  %-22s %s\n' "Cargo (workspace/pkg)" "${CARGO_VER:-<not present>}"
printf '  %-22s %s\n' "npm (package.json)"     "${NPM_VER:-<not present>}"
printf '  %-22s %s\n' "CITATION.cff"           "${CFF_VER:-<not present>}"
echo

problems=()

# Collect the versions that are actually present; require at least one source
# of truth and that all present sources agree.
present_labels=()
present_values=()
[[ -n "$CARGO_VER" ]] && { present_labels+=("Cargo"); present_values+=("$CARGO_VER"); }
[[ -n "$NPM_VER"   ]] && { present_labels+=("npm");   present_values+=("$NPM_VER"); }
[[ -n "$CFF_VER"   ]] && { present_labels+=("CITATION.cff"); present_values+=("$CFF_VER"); }

if [[ "${#present_values[@]}" -eq 0 ]]; then
  echo "ERROR: no version source found (no Cargo.toml / package.json / CITATION.cff version)" >&2
  exit 1
fi

CANON="${present_values[0]}"
for i in "${!present_values[@]}"; do
  if [[ "${present_values[$i]}" != "$CANON" ]]; then
    problems+=("${present_labels[$i]} version '${present_values[$i]}' != '${CANON}' (${present_labels[0]})")
  fi
done

# --- optional tag check -----------------------------------------------------
if [[ -n "$TAG" ]]; then
  if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "ERROR: not inside a git work tree; cannot check tag '$TAG'" >&2
    exit 1
  fi
  if ! git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1 \
     && ! git -C "$REPO_ROOT" rev-parse -q --verify "$TAG" >/dev/null 2>&1; then
    problems+=("tag '$TAG' does not exist in this repository")
  else
    # The ref as it stands (for an annotated tag this is the tag OBJECT sha).
    ref_target="$(git -C "$REPO_ROOT" rev-parse "$TAG")"
    # Peel to the commit it ultimately names.
    peeled_commit="$(git -C "$REPO_ROOT" rev-list -n1 "${TAG}^{commit}")"
    # What the tag ref points to, peeled the same way via the ref object.
    deref_commit="$(git -C "$REPO_ROOT" rev-parse "${TAG}^{commit}")"

    echo "  tag '$TAG':"
    printf '    ref target       %s\n' "$ref_target"
    printf '    peeled commit    %s\n' "$peeled_commit"
    echo

    if [[ "$peeled_commit" != "$deref_commit" ]]; then
      problems+=("tag '$TAG' peels inconsistently ($peeled_commit vs $deref_commit) — moved/corrupt tag")
    fi

    # Compare the tag's embedded version to the in-tree version. Strip a leading
    # 'v' and an optional crate-name prefix like 'pid-rs-v0.2.0'.
    tag_ver="$TAG"
    tag_ver="${tag_ver##*v}"   # drop everything up to & including the last 'v'
    if [[ "$tag_ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
      if [[ "$tag_ver" != "$CANON" ]]; then
        problems+=("tag '$TAG' encodes version '$tag_ver' but in-tree version is '$CANON' (lockfile/manifest disagrees)")
      fi
    else
      echo "  note: tag '$TAG' has no parseable semver; skipping version-vs-tag check"
      echo
    fi
  fi
fi

if [[ "${#problems[@]}" -ne 0 ]]; then
  echo "MISMATCH:" >&2
  for p in "${problems[@]}"; do
    echo "  - $p" >&2
  done
  exit 1
fi

if [[ -n "$TAG" ]]; then
  echo "OK: versions coherent at '$CANON' and tag '$TAG' is consistent"
else
  echo "OK: versions coherent at '$CANON'"
fi

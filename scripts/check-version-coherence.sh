#!/usr/bin/env bash
# Assert that every public CREBAIN version agrees and, for a release tag, that
# an annotated tag directly names the expected commit. This script is read-only.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/check-version-coherence.sh [--expected-commit REV] [TAG]

Without TAG, validates in-tree version coherence. With TAG, additionally
requires an exact vMAJOR.MINOR.PATCH annotated tag which directly targets REV.
REV defaults to HEAD and is useful in CI as --expected-commit "$GITHUB_SHA".
EOF
}

TAG=''
EXPECTED_COMMIT=''
while (($#)); do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --expected-commit)
      if (($# < 2)) || [[ -z "$2" ]]; then
        echo 'ERROR: --expected-commit requires a revision' >&2
        exit 2
      fi
      EXPECTED_COMMIT="$2"
      shift 2
      ;;
    -*)
      echo "ERROR: unknown option '$1'" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$TAG" ]]; then
        echo 'ERROR: at most one tag may be supplied' >&2
        exit 2
      fi
      TAG="$1"
      shift
      ;;
  esac
done

if [[ -n "$EXPECTED_COMMIT" && -z "$TAG" ]]; then
  echo 'ERROR: --expected-commit is only valid with TAG' >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

require_file() {
  if [[ ! -f "$REPO_ROOT/$1" ]]; then
    echo "ERROR: required version source is missing: $1" >&2
    exit 1
  fi
}

for source in \
  package.json \
  src-tauri/Cargo.toml \
  src-tauri/tauri.conf.json \
  CITATION.cff \
  ros/package.xml \
  flake.nix; do
  require_file "$source"
done

cargo_version() {
  awk '
    /^\[package\]/ { package=1; next }
    /^\[/ { package=0 }
    package && /^[[:space:]]*version[[:space:]]*=/ {
      line=$0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      gsub(/["\x27]/, "", line)
      sub(/[[:space:]]*(#.*)?$/, "", line)
      print line
      exit
    }
  ' "$REPO_ROOT/src-tauri/Cargo.toml"
}

json_version() {
  node -e '
    const fs = require("node:fs");
    const document = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof document.version !== "string") process.exit(1);
    process.stdout.write(document.version);
  ' "$1"
}

cff_version() {
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
  ' "$REPO_ROOT/CITATION.cff"
}

ros_version() {
  awk '
    match($0, /<version>[[:space:]]*[^<]+[[:space:]]*<\/version>/) {
      line=substr($0, RSTART, RLENGTH)
      sub(/^<version>[[:space:]]*/, "", line)
      sub(/[[:space:]]*<\/version>$/, "", line)
      print line
      exit
    }
  ' "$REPO_ROOT/ros/package.xml"
}

flake_version() {
  awk '
    /^[[:space:]]*pname[[:space:]]*=[[:space:]]*"crebain";/ { crebain=1; next }
    crebain && /^[[:space:]]*version[[:space:]]*=/ {
      line=$0
      sub(/^[^=]*=[[:space:]]*"/, "", line)
      sub(/";[[:space:]]*$/, "", line)
      print line
      exit
    }
  ' "$REPO_ROOT/flake.nix"
}

labels=(
  'package.json'
  'src-tauri/Cargo.toml'
  'src-tauri/tauri.conf.json'
  'CITATION.cff'
  'ros/package.xml'
  'flake.nix'
)
values=(
  "$(json_version "$REPO_ROOT/package.json")"
  "$(cargo_version)"
  "$(json_version "$REPO_ROOT/src-tauri/tauri.conf.json")"
  "$(cff_version)"
  "$(ros_version)"
  "$(flake_version)"
)

canonical="${values[0]}"
semver_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
problems=()

if [[ ! "$canonical" =~ $semver_pattern ]]; then
  problems+=("package.json version '$canonical' is not canonical MAJOR.MINOR.PATCH")
fi

echo "Version coherence (repo: $REPO_ROOT)"
for index in "${!labels[@]}"; do
  printf '  %-28s %s\n' "${labels[$index]}" "${values[$index]:-<missing>}"
  if [[ -z "${values[$index]}" ]]; then
    problems+=("${labels[$index]} has no readable version")
  elif [[ "${values[$index]}" != "$canonical" ]]; then
    problems+=("${labels[$index]} version '${values[$index]}' != '$canonical'")
  fi
done

if [[ -n "$TAG" ]]; then
  if [[ ! "$TAG" =~ ^v${semver_pattern#\^} ]]; then
    problems+=("tag '$TAG' must exactly match vMAJOR.MINOR.PATCH")
  elif [[ "${TAG#v}" != "$canonical" ]]; then
    problems+=("tag '$TAG' does not match in-tree version '$canonical'")
  fi

  tag_ref="refs/tags/$TAG"
  if ! git -C "$REPO_ROOT" rev-parse -q --verify "$tag_ref" >/dev/null; then
    problems+=("exact tag ref '$tag_ref' does not exist")
  else
    tag_object="$(git -C "$REPO_ROOT" rev-parse "$tag_ref")"
    object_type="$(git -C "$REPO_ROOT" cat-file -t "$tag_object")"
    if [[ "$object_type" != 'tag' ]]; then
      problems+=("tag '$TAG' is lightweight; an annotated tag object is required")
    else
      target_object="$(git -C "$REPO_ROOT" cat-file -p "$tag_object" | awk '$1 == "object" { print $2; exit }')"
      target_type="$(git -C "$REPO_ROOT" cat-file -p "$tag_object" | awk '$1 == "type" { print $2; exit }')"
      expected_revision="${EXPECTED_COMMIT:-HEAD}"
      if ! expected="$(git -C "$REPO_ROOT" rev-parse --verify "${expected_revision}^{commit}" 2>/dev/null)"; then
        problems+=("expected revision '$expected_revision' is not a commit")
      elif [[ "$target_type" != 'commit' ]]; then
        problems+=("annotated tag '$TAG' targets '$target_type', not a commit")
      elif [[ "$target_object" != "$expected" ]]; then
        problems+=("tag '$TAG' targets '$target_object', expected '$expected'")
      fi

      peeled="$(git -C "$REPO_ROOT" rev-parse --verify "${tag_ref}^{commit}")"
      if [[ -n "${expected:-}" && "$peeled" != "$expected" ]]; then
        problems+=("tag '$TAG' peels to '$peeled', expected '$expected'")
      fi
    fi
  fi
fi

if ((${#problems[@]})); then
  echo 'MISMATCH:' >&2
  printf '  - %s\n' "${problems[@]}" >&2
  exit 1
fi

if [[ -n "$TAG" ]]; then
  echo "OK: version $canonical and annotated tag $TAG target the expected commit"
else
  echo "OK: all required version sources agree at $canonical"
fi

#!/usr/bin/env python3
"""Verify the narrow crates.io compatibility overlay byte for byte."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tarfile
import tomllib
from pathlib import Path, PurePosixPath
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
VENDOR_ROOT = ROOT / "src-tauri" / "vendor-compat"
MANIFEST_PATH = VENDOR_ROOT / "PROVENANCE.json"
LOCK_PATH = ROOT / "src-tauri" / "Cargo.lock"
CARGO_MANIFEST_PATH = ROOT / "src-tauri" / "Cargo.toml"
ARCHIVE_ROOT = VENDOR_ROOT / "upstream-archives"
GENERATED_FROM = (
    "bundled hash-verified crates.io archives; no network access during verification"
)
SHA256 = re.compile(r"^[0-9a-f]{64}$")

PACKAGES = {
    "flume-0.11.1": {
        "archive_sha256": "da0e4dd2a88388a1f4ccc7c9ce104604dab68d9f408dc34cd45823d5a9069095",
        "archive_url": "https://static.crates.io/crates/flume/flume-0.11.1.crate",
        "license": "Apache-2.0 OR MIT",
        "crate_name": "flume",
        "version": "0.11.1",
        "replacements": (
            (
                '[dependencies.spin1]\nversion = "0.9.8"',
                '[dependencies.spin1]\nversion = "0.12.2"',
            ),
        ),
        "required_lock_dependencies": ("spin",),
        "forbidden_lock_dependencies": (),
    },
    "uhlc-0.8.2": {
        "archive_sha256": "b62a645e3e4e6c85b7abe49b086aa3204119431f42b6123b0070419fb6e9d24e",
        "archive_url": "https://static.crates.io/crates/uhlc/uhlc-0.8.2.crate",
        "license": "Apache-2.0 OR EPL-2.0",
        "crate_name": "uhlc",
        "version": "0.8.2",
        "replacements": (
            (
                '[dependencies.spin]\nversion = "0.10"',
                '[dependencies.spin]\nversion = "0.12.2"',
            ),
        ),
        "required_lock_dependencies": ("spin",),
        "forbidden_lock_dependencies": (),
    },
    "buddy_system_allocator-0.10.0": {
        "archive_sha256": "a7913f22349ffcfc6ca0ca9a656ec26cfbba538ed49c31a273dff2c5d1ea83d9",
        "archive_url": "https://static.crates.io/crates/buddy_system_allocator/buddy_system_allocator-0.10.0.crate",
        "license": "MIT",
        "crate_name": "buddy_system_allocator",
        "version": "0.10.0",
        "replacements": (
            (
                '[dependencies.spin]\nversion = "0.9.8"',
                '[dependencies.spin]\nversion = "0.12.2"',
            ),
        ),
        "required_lock_dependencies": ("spin",),
        "forbidden_lock_dependencies": (),
    },
    "zenoh-transport-1.9.0": {
        "archive_sha256": "80800c4adc26dbe81418735068541cf39820a95ec988114f04dd014775ba7c97",
        "archive_url": "https://static.crates.io/crates/zenoh-transport/zenoh-transport-1.9.0.crate",
        "license": "Apache-2.0 OR EPL-2.0",
        "crate_name": "zenoh-transport",
        "version": "1.9.0",
        "replacements": (
            (
                "transport_compression = []",
                'transport_compression = ["dep:lz4_flex"]',
            ),
            (
                '[dependencies.lz4_flex]\nversion = "0.10.0"',
                '[dependencies.lz4_flex]\nversion = "0.10.0"\noptional = true',
            ),
        ),
        "required_lock_dependencies": (),
        "forbidden_lock_dependencies": ("lz4_flex",),
    },
}

SPIN_VERSION = "0.12.2"
SPIN_CHECKSUM = "8abadc99fd9c7bbb7d0ca2b31d72a067d0c0dcd7aad25ab8cac71ba91417694b"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fail(message: str) -> None:
    raise ValueError(message)


def load_json_strict(path: Path) -> Any:
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                fail(f"duplicate JSON key {key!r} in {path}")
            result[key] = value
        return result

    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicates)


def archive_files(archive: Path, package: str) -> dict[str, bytes]:
    expected_prefix = PurePosixPath(package)
    files: dict[str, bytes] = {}
    with tarfile.open(archive, mode="r:gz") as bundle:
        for member in bundle.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not path.parts:
                fail(f"{archive}: unsafe archive member {member.name!r}")
            if path.parts[0] != str(expected_prefix):
                fail(f"{archive}: member is outside {package}: {member.name!r}")
            if member.isdir():
                continue
            if not member.isfile():
                fail(f"{archive}: links and special members are forbidden: {member.name!r}")
            relative = PurePosixPath(*path.parts[1:]).as_posix()
            if not relative or relative in files:
                fail(f"{archive}: invalid or duplicate member {member.name!r}")
            extracted = bundle.extractfile(member)
            if extracted is None:
                fail(f"{archive}: cannot read {member.name!r}")
            files[relative] = extracted.read()
    return files


def patched_files(archive: Path, package: str, specification: dict[str, Any]) -> dict[str, bytes]:
    files = archive_files(archive, package)
    if "Cargo.toml" not in files:
        fail(f"{archive}: Cargo.toml is missing")
    cargo = files["Cargo.toml"]
    for before, after in specification["replacements"]:
        if cargo.count(before.encode()) != 1 or after.encode() in cargo:
            fail(f"{archive}: expected manifest replacement is not unique")
        cargo = cargo.replace(before.encode(), after.encode())
    files["Cargo.toml"] = cargo
    return files


def build_manifest(archive_dir: Path) -> dict[str, Any]:
    document: dict[str, Any] = {
        "schema_version": 2,
        "generated_from": GENERATED_FROM,
        "packages": {},
    }
    for package, specification in PACKAGES.items():
        archive = archive_dir / f"{package}.crate"
        if not archive.is_file():
            fail(f"missing source archive: {archive}")
        archive_bytes = archive.read_bytes()
        if sha256(archive_bytes) != specification["archive_sha256"]:
            fail(f"{archive}: archive SHA-256 mismatch")
        upstream = archive_files(archive, package)
        patched = patched_files(archive, package, specification)
        document["packages"][package] = {
            "archive_url": specification["archive_url"],
            "archive_sha256": specification["archive_sha256"],
            "license": specification["license"],
            "manifest_changes": [
                {"path": "Cargo.toml", "from": before, "to": after}
                for before, after in specification["replacements"]
            ],
            "patched_manifest_sha256": sha256(patched["Cargo.toml"]),
            "upstream_files": {
                path: sha256(data) for path, data in sorted(upstream.items())
            },
        }
    return document


def regular_files(directory: Path) -> set[str]:
    result: set[str] = set()
    for path in directory.rglob("*"):
        if path.is_symlink():
            fail(f"symlink is forbidden in compatibility overlay: {path}")
        if path.is_file():
            result.add(path.relative_to(directory).as_posix())
        elif not path.is_dir():
            fail(f"special file is forbidden in compatibility overlay: {path}")
    return result


def assert_exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        actual = set(value) if isinstance(value, dict) else set()
        fail(
            f"{label} fields differ: missing={sorted(expected - actual)}, "
            f"unknown={sorted(actual - expected)}"
        )
    return value


def verify_cargo_resolution(lock_path: Path, cargo_manifest_path: Path) -> None:
    lock = tomllib.loads(lock_path.read_text(encoding="utf-8"))
    if lock.get("version") != 4 or not isinstance(lock.get("package"), list):
        fail("Cargo.lock must be a version-4 lock with a package array")
    packages = lock["package"]

    spin = [package for package in packages if package.get("name") == "spin"]
    if len(spin) != 1 or spin[0].get("version") != SPIN_VERSION:
        fail(f"Cargo.lock must resolve exactly spin {SPIN_VERSION}")
    if spin[0].get("checksum") != SPIN_CHECKSUM or not str(spin[0].get("source", "")).startswith(
        "registry+"
    ):
        fail("Cargo.lock spin source/checksum identity drift")

    expected_patches: dict[str, dict[str, str]] = {}
    for package, specification in PACKAGES.items():
        crate_name = specification["crate_name"]
        version = specification["version"]
        matching = [entry for entry in packages if entry.get("name") == crate_name]
        if len(matching) != 1 or matching[0].get("version") != version:
            fail(f"Cargo.lock must resolve exactly patched {package}")
        if "source" in matching[0] or "checksum" in matching[0]:
            fail(f"Cargo.lock does not resolve {package} as a path package")
        resolved_dependencies = set(matching[0].get("dependencies", []))
        required_dependencies = set(specification["required_lock_dependencies"])
        forbidden_dependencies = set(specification["forbidden_lock_dependencies"])
        if not required_dependencies <= resolved_dependencies:
            fail(f"Cargo.lock {package} is missing required compatibility dependencies")
        if forbidden_dependencies & resolved_dependencies:
            fail(f"Cargo.lock {package} retains a forbidden dormant dependency")
        expected_patches[crate_name] = {"path": f"vendor-compat/{package}"}

    if any(package.get("name") == "lz4_flex" for package in packages):
        fail("Cargo.lock retains lz4_flex while Zenoh transport compression is disabled")

    cargo_manifest = tomllib.loads(cargo_manifest_path.read_text(encoding="utf-8"))
    actual_patches = cargo_manifest.get("patch", {}).get("crates-io")
    if actual_patches != expected_patches:
        fail("Cargo.toml [patch.crates-io] does not exactly name the verified overlay")


def verify_manifest(
    document: Any,
    vendor_root: Path = VENDOR_ROOT,
    lock_path: Path = LOCK_PATH,
    cargo_manifest_path: Path = CARGO_MANIFEST_PATH,
) -> None:
    root = assert_exact_keys(
        document, {"schema_version", "generated_from", "packages"}, "PROVENANCE root"
    )
    if root["schema_version"] != 2 or root["generated_from"] != GENERATED_FROM:
        fail("PROVENANCE root identity drift")
    if not isinstance(root["packages"], dict) or set(root["packages"]) != set(PACKAGES):
        fail("PROVENANCE package set drift")

    expected_vendor_files = {"PROVENANCE.json", "README.md"}
    for package, specification in PACKAGES.items():
        entry = assert_exact_keys(
            root["packages"][package],
            {
                "archive_url",
                "archive_sha256",
                "license",
                "manifest_changes",
                "patched_manifest_sha256",
                "upstream_files",
            },
            package,
        )
        archive = vendor_root / "upstream-archives" / f"{package}.crate"
        expected_vendor_files.add(f"upstream-archives/{package}.crate")
        if sha256(archive.read_bytes()) != specification["archive_sha256"]:
            fail(f"{package}: bundled archive SHA-256 mismatch")
        if (
            entry["archive_url"] != specification["archive_url"]
            or entry["archive_sha256"] != specification["archive_sha256"]
            or entry["license"] != specification["license"]
        ):
            fail(f"{package}: archive identity or license drift")

        upstream = archive_files(archive, package)
        patched = patched_files(archive, package, specification)
        expected_upstream_hashes = {
            path: sha256(data) for path, data in sorted(upstream.items())
        }
        if entry["upstream_files"] != expected_upstream_hashes:
            fail(f"{package}: archive-derived upstream provenance drift")
        if any(not SHA256.fullmatch(value) for value in expected_upstream_hashes.values()):
            fail(f"{package}: malformed upstream file hash")

        expected_changes = [
            {"path": "Cargo.toml", "from": before, "to": after}
            for before, after in specification["replacements"]
        ]
        if entry["manifest_changes"] != expected_changes:
            fail(f"{package}: declared patch drift")
        if entry["patched_manifest_sha256"] != sha256(patched["Cargo.toml"]):
            fail(f"{package}: patched manifest hash drift")

        package_root = vendor_root / package
        if regular_files(package_root) != set(patched):
            fail(f"{package}: added, missing, linked, or special files")
        for relative, expected_data in patched.items():
            expected_vendor_files.add(f"{package}/{relative}")
            if (package_root / relative).read_bytes() != expected_data:
                fail(f"{package}: file differs from the one allowed archive patch: {relative}")

    if regular_files(vendor_root) != expected_vendor_files:
        fail("compatibility overlay has unaccounted top-level or package files")
    verify_cargo_resolution(lock_path, cargo_manifest_path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--refresh-from",
        type=Path,
        metavar="ARCHIVE_DIR",
        help="regenerate PROVENANCE.json from pre-downloaded, hash-verified .crate archives",
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.refresh_from is not None:
            document = build_manifest(arguments.refresh_from)
            MANIFEST_PATH.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        document = load_json_strict(MANIFEST_PATH)
        verify_manifest(document)
    except (OSError, ValueError, json.JSONDecodeError, tarfile.TarError, tomllib.TOMLDecodeError) as error:
        print(f"vendor compatibility verification failed: {error}", file=sys.stderr)
        return 1
    print(
        "OK: bundled crates.io archives prove four source trees differ only by "
        "the declared compatibility manifest changes"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

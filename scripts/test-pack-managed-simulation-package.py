#!/usr/bin/env python3
"""Fail-closed tests for the owner-private Engram pack wrapper."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

from managed_simulation_build_provenance import (
    NO_AUTHORITY,
    TARGET,
    canonical,
    sha256,
    validate_pack_receipt,
)
from managed_simulation_test_fixtures import build_receipt, macho_arm64, stage_receipt


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "pack-managed-simulation-package.py"


FAKE_ENGRAM = r"""#!/usr/bin/env python3
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

operation = sys.argv[1]
tool = Path(__file__)
if os.environ.get("CREBAIN_PACK_TEST_MUTATE_TOOL") == operation:
    tool.write_text(tool.read_text() + "\n# changed during operation\n")
if os.environ.get("CREBAIN_PACK_TEST_MOVE_ORIGIN") == operation:
    subprocess.run(
        ["git", "update-ref", "refs/remotes/origin/main", "HEAD^"],
        check=True,
    )
if operation == "check":
    output = Path(sys.argv[2])
    assert output.name == "bundle"
    assert (output / "marker.json").is_file()
    assert (output / "bundle-receipt.json").is_file()
    if os.environ.get("CREBAIN_PACK_TEST_CHECK_FAIL") == "1":
        raise SystemExit(9)
    raise SystemExit(0)
assert operation == "pack"
source = Path(sys.argv[2])
output = Path(sys.argv[3])
workspace = source.parent
for path in (source, workspace / "configuration.json"):
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
for path in (workspace, workspace / "package", workspace / "sealed" / "test-target"):
    assert stat.S_IMODE(path.stat().st_mode) == 0o700
for path in (workspace / "package").rglob("*"):
    assert not path.is_symlink()
    assert stat.S_IMODE(path.stat().st_mode) & 0o077 == 0
capture = os.environ.get("CREBAIN_PACK_TEST_CAPTURE")
if capture:
    Path(capture).write_text(str(workspace))
if os.environ.get("CREBAIN_PACK_TEST_FAIL") == "1":
    raise SystemExit(7)
output.mkdir(mode=0o700)
(output / "marker.json").write_text(json.dumps({"workspace": str(workspace)}))
if os.environ.get("CREBAIN_PACK_TEST_MISSING_RECEIPT") != "1":
    receipt = {
        "schema_version": "engram.extension-package-bundle-receipt.v1",
        "generation_id": "pkggen_" + "a" * 64,
    }
    payload = json.dumps(receipt, sort_keys=True, separators=(",", ":"))
    if os.environ.get("CREBAIN_PACK_TEST_NONCANONICAL_RECEIPT") == "1":
        payload += "\n"
    (output / "bundle-receipt.json").write_text(payload)
"""


def git(root: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", *arguments],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def make_fixture(root: Path) -> tuple[Path, Path, str]:
    integration = root / "integration"
    package = integration / "package"
    sealed = integration / "sealed" / "test-target"
    (package / "bin").mkdir(parents=True)
    (package / "contracts").mkdir()
    binary = package / "bin" / "crebain-managed-simulation"
    binary.write_bytes(macho_arm64())
    contract = package / "contracts" / "example.schema.json"
    contract.write_bytes(b"{}\n")
    os.chmod(package, 0o700)
    os.chmod(package / "bin", 0o700)
    os.chmod(package / "contracts", 0o700)
    os.chmod(binary, 0o700)
    os.chmod(contract, 0o600)
    sealed.mkdir(parents=True)
    os.chmod(integration / "sealed", 0o700)
    os.chmod(sealed, 0o700)
    (sealed / "manifest.json").write_text("{}")
    recipe = integration / "authoring.macos-aarch64-darwin.json"
    recipe.write_text(
        json.dumps(
            {
                "configuration_path": "configuration.json",
                "output_directory": "sealed/test-target",
                "package_root": "package",
            }
        )
    )
    configuration = integration / "configuration.json"
    configuration.write_text("{}")
    os.chmod(recipe, 0o644)
    os.chmod(configuration, 0o640)

    build = build_receipt(binary.read_bytes())
    build_root = integration / "build"
    build_root.mkdir(mode=0o700)
    build_path = build_root / "observed-build-receipt.json"
    build_path.write_bytes(canonical(build) + b"\n")
    inventory = [
        {
            "relative_path": "bin/crebain-managed-simulation",
            "byte_length": len(binary.read_bytes()),
            "sha256": sha256(binary.read_bytes()),
            "mode": 0o700,
            "role": "executable",
        },
        {
            "relative_path": "contracts/example.schema.json",
            "byte_length": len(contract.read_bytes()),
            "sha256": sha256(contract.read_bytes()),
            "mode": 0o600,
            "role": "contract",
        },
    ]
    stage = stage_receipt(
        build,
        inventory,
        recipe_bytes=recipe.read_bytes(),
        configuration_bytes=configuration.read_bytes(),
    )
    (integration / "package-stage-receipt.json").write_bytes(canonical(stage) + b"\n")
    package_lock = {
        "schema_version": "1.0",
        "inventory": [
            {
                **row,
                "mode": stat.S_IFREG | row["mode"],
            }
            for row in inventory
        ],
    }
    lock_bytes = canonical(package_lock) + b"\n"
    (sealed / "package-lock.json").write_bytes(lock_bytes)
    seal = {
        "schema_version": "engram.managed-extension-seal-receipt.v1",
        "target": {
            key: value for key, value in TARGET.items() if key != "rust_target_triple"
        },
        "package": {"executable_sha256": build["output"]["sha256"]},
        "package_lock": {
            "exact_sha256": sha256(lock_bytes),
            "canonical_sha256": sha256(canonical(package_lock)),
        },
        "configuration": {"exact_sha256": sha256(configuration.read_bytes())},
    }
    (sealed / "seal-receipt.json").write_bytes(canonical(seal) + b"\n")
    for path in sealed.iterdir():
        os.chmod(path, 0o600)

    engram = root / "engram"
    (engram / "scripts").mkdir(parents=True)
    git(engram, "init", "-b", "main")
    git(engram, "config", "user.name", "CREBAIN test")
    git(engram, "config", "user.email", "crebain-test@example.invalid")
    (engram / ".baseline").write_text("baseline\n")
    git(engram, "add", ".baseline")
    git(engram, "commit", "-m", "baseline")
    fake = engram / "scripts" / "engram_extension.py"
    fake.write_text(FAKE_ENGRAM)
    os.chmod(fake, 0o644)
    git(engram, "add", "scripts/engram_extension.py")
    git(engram, "commit", "-m", "add extension tool")
    origin = root / "engram-origin.git"
    subprocess.run(
        ["git", "init", "--bare", str(origin)],
        check=True,
        capture_output=True,
        text=True,
    )
    git(engram, "remote", "add", "origin", str(origin))
    git(engram, "push", "--set-upstream", "origin", "main")
    return integration, engram, git(engram, "rev-parse", "HEAD")


def invoke(
    integration: Path,
    engram: Path,
    commit: str,
    output: Path,
    *,
    environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--engram-root",
            str(engram),
            "--engram-commit",
            commit,
            "--integration-root",
            str(integration),
            "--output",
            str(output),
        ],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, **(environment or {})},
    )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="crebain-pack-test-") as raw:
        root = Path(raw).resolve()
        integration, engram, commit = make_fixture(root)
        recipe = integration / "authoring.macos-aarch64-darwin.json"
        configuration = integration / "configuration.json"
        source_modes = {
            path: stat.S_IMODE(path.stat().st_mode) for path in (recipe, configuration)
        }

        output = root / "package"
        accepted = invoke(integration, engram, commit, output)
        assert accepted.returncode == 0, accepted.stderr
        assert {path.name for path in output.iterdir()} == {
            "bundle",
            "engram-pack-receipt.json",
        }
        workspace = Path(
            json.loads((output / "bundle/marker.json").read_text())["workspace"]
        )
        assert not workspace.exists()
        receipt_bytes = (output / "engram-pack-receipt.json").read_bytes()
        receipt = json.loads(receipt_bytes)
        validate_pack_receipt(receipt)
        assert receipt_bytes == canonical(receipt) + b"\n"
        assert receipt["engram_repository"]["commit"] == commit
        assert receipt["engram_repository"]["origin_main"] == commit
        assert receipt["engram_tool"] == {
            "relative_path": "scripts/engram_extension.py",
            "size_bytes": len(FAKE_ENGRAM.encode()),
            "sha256": sha256(FAKE_ENGRAM.encode()),
            "git_mode": "100644",
            "git_blob": git(
                engram,
                "hash-object",
                "--no-filters",
                "--",
                "scripts/engram_extension.py",
            ),
        }
        bundle_receipt_bytes = (output / "bundle/bundle-receipt.json").read_bytes()
        assert receipt["bundle_receipt_exact_sha256"] == sha256(bundle_receipt_bytes)
        assert receipt["package_generation_id"] == "pkggen_" + "a" * 64
        assert receipt["authority"] == NO_AUTHORITY
        assert {
            path: stat.S_IMODE(path.stat().st_mode) for path in source_modes
        } == source_modes

        replay = invoke(integration, engram, commit, output)
        assert replay.returncode != 0 and "already exists" in replay.stderr

        capture = root / "failed-workspace.txt"
        failed = invoke(
            integration,
            engram,
            commit,
            root / "failed-bundle",
            environment={
                "CREBAIN_PACK_TEST_CAPTURE": str(capture),
                "CREBAIN_PACK_TEST_FAIL": "1",
            },
        )
        assert failed.returncode == 7
        assert not Path(capture.read_text()).exists()

        check_failed_output = root / "check-failed-bundle"
        check_failed = invoke(
            integration,
            engram,
            commit,
            check_failed_output,
            environment={"CREBAIN_PACK_TEST_CHECK_FAIL": "1"},
        )
        assert check_failed.returncode == 9
        assert not check_failed_output.exists()

        package = integration / "package"
        package.rename(integration / "real-package")
        package.symlink_to(integration / "real-package", target_is_directory=True)
        linked = invoke(integration, engram, commit, root / "linked-bundle")
        assert linked.returncode != 0 and "private directory" in linked.stderr

    with tempfile.TemporaryDirectory(prefix="crebain-pack-receipt-test-") as raw:
        root = Path(raw).resolve()
        integration, engram, commit = make_fixture(root)
        stage_path = integration / "package-stage-receipt.json"
        stage = json.loads(stage_path.read_bytes())
        stage["observed_build_receipt_exact_sha256"] = "f" * 64
        stage_material = {
            key: value for key, value in stage.items() if key != "receipt_sha256"
        }
        stage["receipt_sha256"] = sha256(canonical(stage_material))
        stage_path.write_bytes(canonical(stage) + b"\n")
        swapped = invoke(integration, engram, commit, root / "swapped-bundle")
        assert (
            swapped.returncode != 0
            and "build, Git, or target lineage" in swapped.stderr
        )
        assert not (root / "swapped-bundle").exists()

    with tempfile.TemporaryDirectory(prefix="crebain-pack-package-test-") as raw:
        root = Path(raw).resolve()
        integration, engram, commit = make_fixture(root)
        contract = integration / "package/contracts/example.schema.json"
        contract.write_bytes(b'{"changed":true}\n')
        mutated = invoke(integration, engram, commit, root / "mutated-bundle")
        assert (
            mutated.returncode != 0
            and "current authoring inputs or package" in mutated.stderr
        )
        assert not (root / "mutated-bundle").exists()

    for mutation_operation in ("pack", "check"):
        with tempfile.TemporaryDirectory(
            prefix=f"crebain-pack-tool-{mutation_operation}-"
        ) as raw:
            root = Path(raw).resolve()
            integration, engram, commit = make_fixture(root)
            output = root / "mutated-source-package"
            changed = invoke(
                integration,
                engram,
                commit,
                output,
                environment={"CREBAIN_PACK_TEST_MUTATE_TOOL": mutation_operation},
            )
            assert changed.returncode != 0
            assert "checkout is not clean" in changed.stderr
            assert not output.exists()

    for movement_operation in ("pack", "check"):
        with tempfile.TemporaryDirectory(
            prefix=f"crebain-pack-origin-{movement_operation}-"
        ) as raw:
            root = Path(raw).resolve()
            integration, engram, commit = make_fixture(root)
            output = root / "moved-origin-package"
            moved = invoke(
                integration,
                engram,
                commit,
                output,
                environment={"CREBAIN_PACK_TEST_MOVE_ORIGIN": movement_operation},
            )
            assert moved.returncode != 0
            assert "origin/main" in moved.stderr
            assert not output.exists()

    with tempfile.TemporaryDirectory(prefix="crebain-pack-git-negative-") as raw:
        root = Path(raw).resolve()
        integration, engram, commit = make_fixture(root)
        malformed_output = root / "malformed-commit-package"
        malformed = invoke(integration, engram, "NOT-A-COMMIT", malformed_output)
        assert malformed.returncode != 0 and "Git object ID" in malformed.stderr
        assert not malformed_output.exists()

        untracked = engram / "untracked.py"
        untracked.write_text("pass\n")
        dirty_output = root / "dirty-package"
        dirty = invoke(integration, engram, commit, dirty_output)
        assert dirty.returncode != 0 and "not clean" in dirty.stderr
        assert not dirty_output.exists()
        untracked.unlink()

        tool = engram / "scripts/engram_extension.py"
        git(engram, "update-index", "--skip-worktree", "scripts/engram_extension.py")
        tool.write_text(FAKE_ENGRAM + "\n# hidden mutation\n")
        hidden_output = root / "hidden-mutation-package"
        hidden = invoke(integration, engram, commit, hidden_output)
        assert hidden.returncode != 0 and "committed Git blob" in hidden.stderr
        assert not hidden_output.exists()

    for receipt_environment in (
        {"CREBAIN_PACK_TEST_MISSING_RECEIPT": "1"},
        {"CREBAIN_PACK_TEST_NONCANONICAL_RECEIPT": "1"},
    ):
        with tempfile.TemporaryDirectory(prefix="crebain-pack-bundle-receipt-") as raw:
            root = Path(raw).resolve()
            integration, engram, commit = make_fixture(root)
            output = root / "invalid-receipt-package"
            invalid = invoke(
                integration,
                engram,
                commit,
                output,
                environment=receipt_environment,
            )
            assert invalid.returncode != 0
            assert not output.exists()

    with tempfile.TemporaryDirectory(prefix="crebain-pack-linked-parent-") as raw:
        root = Path(raw).resolve()
        integration, engram, commit = make_fixture(root)
        real_parent = root / "real-output"
        real_parent.mkdir()
        linked_parent = root / "linked-output"
        linked_parent.symlink_to(real_parent, target_is_directory=True)
        output = linked_parent / "package"
        linked = invoke(integration, engram, commit, output)
        assert linked.returncode != 0 and "must not use a symlink" in linked.stderr
        assert not output.exists()

    with tempfile.TemporaryDirectory(prefix="crebain-pack-symlink-tool-") as raw:
        root = Path(raw).resolve()
        integration, engram, _commit = make_fixture(root)
        tool = engram / "scripts/engram_extension.py"
        tool.unlink()
        tool.symlink_to(engram / ".baseline")
        git(engram, "add", "scripts/engram_extension.py")
        git(engram, "commit", "-m", "replace tool with symlink")
        git(engram, "push", "origin", "main")
        commit = git(engram, "rev-parse", "HEAD")
        output = root / "symlink-tool-package"
        linked_tool = invoke(integration, engram, commit, output)
        assert linked_tool.returncode != 0 and "source blob" in linked_tool.stderr
        assert not output.exists()

    print(
        "OK: managed simulation pack wrapper joins immutable Engram source, "
        "build, stage, seal, bundle, and atomic receipt"
    )


if __name__ == "__main__":
    main()

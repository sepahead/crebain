#!/usr/bin/env python3
"""Validate CREBAIN synthetic captures with one immutable Engram checkout."""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


COMMIT = re.compile(r"[0-9a-f]{40}\Z")


def fail(message: str) -> None:
    raise SystemExit(f"Engram model oracle failed: {message}")


def git(root: Path, *arguments: str) -> bytes:
    environment = {
        **os.environ,
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_TERMINAL_PROMPT": "0",
        "LC_ALL": "C",
    }
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        environment.pop(name, None)
    result = subprocess.run(
        ["git", *arguments],
        cwd=root,
        env=environment,
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        fail(f"Git inspection failed for {' '.join(arguments)}")
    return result.stdout


def verify_checkout(root: Path, expected_commit: str) -> tuple[str, str]:
    if not COMMIT.fullmatch(expected_commit):
        fail("the expected Engram commit is invalid")
    canonical_root = root.resolve(strict=True)
    if canonical_root != root or not root.is_dir():
        fail("the Engram root is not one canonical directory")
    top = git(root, "rev-parse", "--show-toplevel").decode().strip()
    head = git(root, "rev-parse", "--verify", "HEAD^{commit}").decode().strip()
    origin_main = (
        git(root, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}")
        .decode()
        .strip()
    )
    status = git(root, "status", "--porcelain=v2", "-z", "--untracked-files=all")
    if (
        top != str(root)
        or head != expected_commit
        or origin_main != expected_commit
        or status
    ):
        fail("the Engram checkout is not clean immutable origin/main")
    if git(root, "rev-parse", "--is-bare-repository") != b"false\n":
        fail("the Engram checkout is bare")
    return head, origin_main


def object_member(value: Any, member: str, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get(member), dict):
        fail(f"{label} lacks {member}")
    return value[member]


def expect_rejected(
    model: Any, document: dict[str, Any], member: str, value: Any
) -> None:
    hostile = copy.deepcopy(document)
    hostile[member] = value
    try:
        model.model_validate(hostile)
    except ValueError:
        return
    fail(f"Engram accepted the hostile {model.__name__}.{member} control")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engram-root", type=Path, required=True)
    parser.add_argument("--engram-commit", required=True)
    parser.add_argument("--capture", type=Path, action="append", required=True)
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    root = arguments.engram_root.absolute()
    before = verify_checkout(root, arguments.engram_commit)
    sys.path.insert(0, str(root))

    from backend.integrations.reviewed_native_development_session import (
        ReviewedNativeDevelopmentHandshakeReceiptV1,
        ReviewedNativeDevelopmentTerminationReceiptV1,
        ReviewedNativeExecGateCommandBindingV1,
    )
    from backend.optimization.extension_closed_loop import (
        ClosedLoopRunPlanV1,
        ClosedLoopRunReceiptV2,
        RuntimeLifecycleReceiptBindingV1,
    )
    from backend.optimization.extension_closed_loop_nest_evidence import (
        NestClosedLoopEvidenceBundleV2,
        validate_nest_evidence_against_run,
    )

    observed: list[dict[str, Any]] = []
    seen_counts: set[int] = set()
    negative_controls = 0
    for capture_path in arguments.capture:
        path = capture_path.resolve(strict=True)
        try:
            capture = json.loads(path.read_bytes())
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            fail(f"capture JSON is invalid: {error}")
        if not isinstance(capture, dict):
            fail("capture root is not an object")
        plan = ClosedLoopRunPlanV1.model_validate(
            object_member(capture, "run_plan", "capture")
        )
        reviewed = object_member(capture, "reviewed_native_runtime", "capture")
        command = ReviewedNativeExecGateCommandBindingV1.model_validate(
            object_member(reviewed, "exec_gate_command_binding", "reviewed runtime")
        )
        handshake = ReviewedNativeDevelopmentHandshakeReceiptV1.model_validate(
            object_member(reviewed, "handshake_receipt", "reviewed runtime")
        )
        termination = ReviewedNativeDevelopmentTerminationReceiptV1.model_validate(
            object_member(reviewed, "termination_receipt", "reviewed runtime")
        )
        run = ClosedLoopRunReceiptV2.model_validate(
            object_member(capture, "terminal_receipt", "capture")
        )
        lifecycle = RuntimeLifecycleReceiptBindingV1.model_validate(
            object_member(
                object_member(capture, "terminal_receipt", "capture"),
                "runtime_lifecycle",
                "terminal receipt",
            )
        )
        evidence = NestClosedLoopEvidenceBundleV2.model_validate(
            object_member(capture, "nest_evidence_bundle", "capture")
        )
        validate_nest_evidence_against_run(evidence, run)
        if not observed:
            expect_rejected(
                ClosedLoopRunPlanV1, capture["run_plan"], "physical_actuation", True
            )
            expect_rejected(
                ReviewedNativeExecGateCommandBindingV1,
                reviewed["exec_gate_command_binding"],
                "target_command_sha256",
                "e" * 64,
            )
            expect_rejected(
                ReviewedNativeDevelopmentHandshakeReceiptV1,
                reviewed["handshake_receipt"],
                "host_local_admission",
                False,
            )
            expect_rejected(
                ReviewedNativeDevelopmentTerminationReceiptV1,
                reviewed["termination_receipt"],
                "physical_authority",
                True,
            )
            expect_rejected(
                RuntimeLifecycleReceiptBindingV1,
                capture["terminal_receipt"]["runtime_lifecycle"],
                "physical_authority",
                True,
            )
            expect_rejected(
                ClosedLoopRunReceiptV2,
                capture["terminal_receipt"],
                "scientific_authority",
                True,
            )
            expect_rejected(
                NestClosedLoopEvidenceBundleV2,
                capture["nest_evidence_bundle"],
                "ncp_control",
                True,
            )
            try:
                validate_nest_evidence_against_run(
                    evidence.model_copy(update={"run_receipt_sha256": "e" * 64}),
                    run,
                )
            except ValueError:
                pass
            else:
                fail("Engram accepted a hostile run-to-evidence join")
            negative_controls = 8
        count = len(plan.channels)
        if count not in {1, 2, 3} or count in seen_counts:
            fail("capture drone counts are not the exact 1, 2, and 3 roster")
        seen_counts.add(count)
        observed.append(
            {
                "drone_count": count,
                "run_plan_sha256": plan.digest,
                "command_binding_sha256": command.exec_gate_command_sha256,
                "handshake_receipt_sha256": handshake.receipt_sha256,
                "termination_receipt_sha256": termination.receipt_sha256,
                "lifecycle_binding_sha256": lifecycle.binding_sha256,
                "run_receipt_sha256": run.receipt_sha256,
                "evidence_bundle_sha256": evidence.bundle_sha256,
            }
        )
    if seen_counts != {1, 2, 3}:
        fail("capture drone counts are not the exact 1, 2, and 3 roster")
    after = verify_checkout(root, arguments.engram_commit)
    if after != before:
        fail("the Engram checkout changed during model validation")
    print(
        json.dumps(
            {
                "schema_version": "crebain.engram-model-oracle.v1",
                "engram_commit": before[0],
                "engram_origin_main": before[1],
                "captures": sorted(observed, key=lambda row: row["drone_count"]),
                "negative_controls": negative_controls,
                "provider_execution": False,
                "scientific_authority": False,
            },
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()

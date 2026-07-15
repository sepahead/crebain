#!/usr/bin/env python3
"""Generate the 159-row CREBAIN handoff task disposition without YAML dependencies."""

from __future__ import annotations

import argparse
import csv
import io
import re
import sys
from pathlib import Path

TASK = re.compile(r"^- id: (T\d{3})$")


def normalize_yaml_scalar(value: str) -> str:
    """Decode the quoted scalar forms used by the frozen handoff ledger."""
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    if len(value) >= 2 and value[0] == value[-1] == '"':
        # The ledger currently uses only single quotes here. Reject unsupported
        # escape ambiguity instead of silently presenting quoted YAML as prose.
        raise ValueError("double-quoted task scalars are unsupported")
    return value


def parse_tasks(path: Path) -> list[dict[str, str]]:
    tasks: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    collecting_title = False
    for line in path.read_text(encoding="utf-8").splitlines():
        match = TASK.match(line)
        if match:
            if current is not None:
                tasks.append(current)
            current = {"id": match.group(1)}
            collecting_title = False
            continue
        if current is None:
            continue
        if collecting_title and line.startswith("    "):
            current["title"] += f" {line.strip()}"
            continue
        collecting_title = False
        for field in ("phase", "title"):
            prefix = f"  {field}: "
            if line.startswith(prefix):
                current[field] = line[len(prefix) :]
                collecting_title = field == "title"
    if current is not None:
        tasks.append(current)
    if len(tasks) != 159 or [task["id"] for task in tasks] != [f"T{i:03d}" for i in range(159)]:
        raise ValueError("expected the exact sequential T000..T158 ledger")
    if any(set(task) != {"id", "phase", "title"} for task in tasks):
        raise ValueError("a task phase or title was not parsed")
    for task in tasks:
        task["phase"] = normalize_yaml_scalar(task["phase"])
        task["title"] = normalize_yaml_scalar(task["title"])
    return tasks


def disposition(number: int) -> tuple[str, str]:
    if number == 0:
        return "PARTIAL_UNSIGNED", "audit/frozen/INPUT_MANIFEST.json; no signature was supplied"
    if number == 1:
        return "COMPLETED_0_9", "audit/frozen/TRACKED_FILE_MANIFEST.json"
    if number == 2:
        return "COMPLETED_SAME_TEAM", "audit/frozen/FILE_REVIEW_LEDGER.csv; not independent review"
    if 3 <= number <= 9:
        return "COMPLETED_OR_NARROWED_0_9", "audit/frozen/REVIEW_REPORT.md; product profiles and inventories"
    if 10 <= number <= 134:
        return "REVIEWED_REPAIRED_OR_NOT_CLAIMED_0_9", "audit/frozen/FILE_REVIEW_LEDGER.csv; REVIEW_REPORT F/S registers"
    if 135 <= number <= 137:
        return "COMPLETED_0_9", "product profiles; IPC registry; Phase-0 production graph evidence"
    if number == 138:
        return "COMPLETED_0_9", "docs/SENSOR_FUSION.md normative-engine and migration disposition"
    if number == 139:
        return "PREREGISTERED_NOT_RUN", "docs/FUSION_VALIDATION_PROTOCOL.md"
    if 140 <= number <= 142:
        return "PARTIAL_NO_NUMERIC_CLAIM", "component fixtures/corpora exist; independent truth campaign absent"
    if number == 143:
        return "COMPLETED_0_9", "NoAuthority profiles, IPC registry, plant/production boundary gates"
    if 144 <= number <= 147:
        return "BLOCKED_EXTERNAL_NOT_IMPLEMENTED", "final Haldir/NCP/Galadriel/Prisoma artifacts unavailable"
    if number == 148:
        return "NOT_RUN", "target clean-room, GPU/device, and duration campaign unavailable"
    if number == 149:
        return "PARTIAL_CLAIMS_NARROWED", "0.9 status/decision text; target screenshot review remains"
    if number == 150:
        return "PARTIAL_AUTOMATED_MATRIX", "default/NCP/no-default/CUDA/TensorRT and hosted platform gates"
    if number == 151:
        return "PARTIAL_COMPONENT_ONLY", "bounded lifecycle/fault tests; deployed long-duration run absent"
    if number == 152:
        return "AUTOMATED_RELEASE_GATE_PENDING_TAG", "release workflow: packages, SBOM, scan, provenance, checksums"
    if number == 153:
        return "BLOCKED_INDEPENDENT_REVIEW", "same-team agent lanes are explicitly non-independent"
    if number == 154:
        return "COMPLETED_LOCAL_0_9", "0.9 metadata/authorship/docs; hosted state finalized at release"
    if number == 155:
        return "PARTIAL", "retired-v0.4 record and release workflow; publication rehearsal not independent"
    if number == 156:
        return "BLOCKED_CROSS_REPOSITORY", "five final local manifests do not exist"
    if number == 157:
        return "COMPLETED_0_9_NOT_INDEPENDENT", "audit/candidate/TWENTY_LENS_REVIEW.md"
    if number == 158:
        return "NARROWED_GO_0_9_NO_GO_1_0", "docs/NARROWED_GO_0.9.0.md"
    raise AssertionError(number)


def render(tasks: list[dict[str, str]]) -> str:
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=["id", "phase", "title", "ledger_1_0_status", "release_0_9_disposition", "evidence_or_blocker"],
        lineterminator="\n",
    )
    writer.writeheader()
    for task in tasks:
        number = int(task["id"][1:])
        status, evidence = disposition(number)
        writer.writerow(
            {
                **task,
                # The supplied completion rule requires all evidence and the
                # strict chain crosses unavailable external/independent gates.
                "ledger_1_0_status": "OPEN",
                "release_0_9_disposition": status,
                "evidence_or_blocker": evidence,
            }
        )
    return output.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ledger", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--write", action="store_true")
    arguments = parser.parse_args()
    try:
        content = render(parse_tasks(arguments.ledger))
        if arguments.write:
            arguments.output.parent.mkdir(parents=True, exist_ok=True)
            arguments.output.write_text(content, encoding="utf-8")
        elif arguments.output.read_text(encoding="utf-8") != content:
            raise ValueError("task disposition drift")
    except (OSError, ValueError) as error:
        print(f"TASK DISPOSITION FAILED: {error}", file=sys.stderr)
        return 1
    print("OK: all T000..T158 have explicit 1.0 and 0.9 dispositions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

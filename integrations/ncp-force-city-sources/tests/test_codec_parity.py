"""One frozen corpus through independent public Rust/Python verification, without engines."""

from copy import deepcopy
from builtins import BaseExceptionGroup
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from ncp_local import modular_buffer as b, modular_owner as o, modular_wire as w
from crebain_ncp_sensors.city.contract import CityContract
from codec_vectors import ROSTER, binding, vectors

FRAME_SENTINEL = 65_537
REPORT_BYTES = 262_144
CASE_CAP = 128


def bounded_read(path, limit):
    if path.is_symlink() or not path.is_file():
        raise AssertionError("missing regular fixture")
    with path.open("rb") as source:
        payload = source.read(limit + 1)
    if not payload or len(payload) > limit:
        raise AssertionError("fixture capacity")
    return payload


def inventory(root):
    return tuple(
        (p.name, len(raw), hashlib.sha256(raw).hexdigest())
        for p in sorted(root.iterdir())
        if p.is_file()
        for raw in (
            bounded_read(p, 65_536 if p.name == "manifest.json" else FRAME_SENTINEL),
        )
    )


def require_originals(root, expected):
    if inventory(root) != expected:
        raise AssertionError("original fixture changed")


def freeze(root, selected):
    if not 1 <= len(selected) <= CASE_CAP or len({v.identity for v in selected}) != len(
        selected
    ):
        raise AssertionError("case roster")
    root.mkdir(mode=0o700)
    manifest = {"schema": "crebain.city-codec-corpus.v1", "cases": []}
    for i, vector in enumerate(selected):
        if vector.layer not in ("request", "response") or (vector.response is None) != (
            vector.layer == "request"
        ):
            raise AssertionError("case mode")
        manifest["cases"].append({"id": vector.identity, "layer": vector.layer})
        for role, payload in (
            ("request", vector.request),
            ("response", vector.response),
        ):
            if payload is None:
                continue
            if type(payload) is not bytes or not 1 <= len(payload) <= FRAME_SENTINEL:
                raise AssertionError("frame extent")
            (root / f"{i:03}.{role}.bin").write_bytes(payload)
    raw = json.dumps(manifest, separators=(",", ":")).encode()
    if len(raw) > 65_536:
        raise AssertionError("manifest extent")
    (root / "manifest.json").write_bytes(raw)
    original = inventory(root)
    if sum(size for _, size, _ in original) >= 17 * 1024 * 1024:
        raise AssertionError("corpus extent")
    return original


def python_report(root, selected):
    rows = []
    selected_binding = binding()
    for i, vector in enumerate(selected):
        row = dict(
            id=vector.identity,
            layer=vector.layer,
            request_accepted=False,
            accepted=False,
            stage="request",
            error=None,
            request_digest=None,
            result_digest=None,
            typed_value_digest=None,
        )
        raw = bounded_read(root / f"{i:03}.request.bin", FRAME_SENTINEL)
        response = (
            None
            if vector.layer == "request"
            else bounded_read(root / f"{i:03}.response.bin", FRAME_SENTINEL)
        )
        try:
            request = w.Request.decode(raw, selected_binding, CityContract)
            request.verify(selected_binding)
            row.update(
                request_accepted=True,
                request_digest=request.request_digest,
                stage="input",
            )
            if type(request.command) is not w.Execute:
                raise AssertionError("corpus requires execute")
            operation = request.command.operation
            CityContract.check_input(operation)
            if not CityContract.allows(w.operation_name(operation)):
                raise w.ModularError("role")
            if response is None:
                value = w.operation_value(operation)
            else:
                row["stage"] = "response"
                result = o.verify_response(
                    selected_binding, request, response, CityContract
                )
                row["result_digest"] = result.result_digest
                value = result.body.value()
            row.update(
                typed_value_digest=w.typed_digest(w.PROFILE_DOMAIN, value),
                accepted=True,
                stage="accepted",
            )
        except (w.ModularError, b.BufferError) as error:
            row["error"] = error.code
        except ValueError as error:
            # Closed Enum conversion raises ValueError for an unknown protocol variant.
            if "is not a valid" not in str(error):
                raise
            row["error"] = "unknown_variant"
        rows.append(row)
    return {"schema": "crebain.city-codec-report.v1", "rows": rows}


def run_probe(argv, output, *, deadline_seconds=30):
    """Drain one directly owned child; timeout/overflow/nonzero never means rejection."""
    started = time.monotonic()
    streams = [bytearray(), bytearray()]
    child = subprocess.Popen(
        argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    selector = None
    failures = []
    try:
        selector = selectors.DefaultSelector()
        for i, pipe in enumerate((child.stdout, child.stderr)):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, i)
        while selector.get_map() or child.poll() is None:
            remaining = started + deadline_seconds - time.monotonic()
            if remaining <= 0:
                raise AssertionError("probe timeout")
            for key, _ in selector.select(min(remaining, 0.1)):
                block = os.read(key.fileobj.fileno(), 8192)
                if not block:
                    selector.unregister(key.fileobj)
                    continue
                if len(block) > REPORT_BYTES - sum(map(len, streams)):
                    raise AssertionError("probe output capacity")
                streams[key.data].extend(block)
        if (
            child.wait(
                timeout=max(0.001, started + deadline_seconds - time.monotonic())
            )
            != 0
        ):
            raise AssertionError("probe nonzero exit")
    except BaseException as error:
        failures.append(error)
    finally:

        def retain(action):
            try:
                action()
            except BaseException as error:
                failures.append(error)

        def retire():
            # Sole waiter owns this unreaped child; no process-group or host-wide signal.
            if child.poll() is None:
                child.kill()

        retain(retire)
        retain(lambda: child.wait(timeout=5))
        if selector is not None:
            retain(selector.close)
        retain(child.stdout.close)
        retain(child.stderr.close)
        retain(lambda: (output / "rust.stdout.bin").write_bytes(streams[0]))
        retain(lambda: (output / "rust.stderr.bin").write_bytes(streams[1]))
        retain(
            lambda: (output / "probe-command.json").write_text(
                json.dumps(
                    {
                        "argv": list(map(str, argv)),
                        "returncode": child.returncode,
                        "elapsed_seconds": time.monotonic() - started,
                        "deadline_seconds": deadline_seconds,
                        "cleanup_limit_seconds": 5,
                        "combined_stream_limit_bytes": REPORT_BYTES,
                        "failures": [type(error).__name__ for error in failures],
                    },
                    indent=2,
                )
                + "\n"
            )
        )
    if len(failures) == 1:
        raise failures[0]
    if failures:
        raise BaseExceptionGroup("probe operation and cleanup failures", failures)
    if streams[1]:
        raise AssertionError("unexpected probe diagnostics")
    return json.loads(streams[0])


def validate_report(report, selected):
    if (
        type(report) is not dict
        or set(report) != {"schema", "rows"}
        or report["schema"] != "crebain.city-codec-report.v1"
    ):
        raise AssertionError("report schema")
    rows = report["rows"]
    if type(rows) is not list or len(rows) != len(selected) or not rows:
        raise AssertionError("report roster")
    keys = {
        "id",
        "layer",
        "request_accepted",
        "accepted",
        "stage",
        "error",
        "request_digest",
        "result_digest",
        "typed_value_digest",
    }
    for row, vector in zip(rows, selected, strict=True):
        if (
            type(row) is not dict
            or set(row) != keys
            or (row["id"], row["layer"]) != (vector.identity, vector.layer)
        ):
            raise AssertionError("report row")
        if (
            type(row["accepted"]) is not bool
            or type(row["request_accepted"]) is not bool
        ):
            raise AssertionError("report flags")
        if row["stage"] not in ("request", "input", "response", "accepted"):
            raise AssertionError("report stage")
        if row["accepted"]:
            if (
                not row["request_accepted"]
                or row["stage"] != "accepted"
                or row["error"] is not None
            ):
                raise AssertionError("accepted report")
            if not w.digest_valid(row["request_digest"]) or not w.digest_valid(
                row["typed_value_digest"]
            ):
                raise AssertionError("accepted digest")
            if (
                vector.layer == "response" and not w.digest_valid(row["result_digest"])
            ) or (vector.layer == "request" and row["result_digest"] is not None):
                raise AssertionError("result digest")
        elif (
            type(row["error"]) is not str
            or not 1 <= len(row["error"]) <= 128
            or row["typed_value_digest"] is not None
        ):
            raise AssertionError("rejected report")
    return rows


def compare(python, rust, selected):
    p_rows, r_rows = validate_report(python, selected), validate_report(rust, selected)
    failures = []
    for vector, p, r in zip(selected, p_rows, r_rows, strict=True):
        expected = vector.expected == "accept"
        if p["accepted"] != expected or r["accepted"] != expected:
            failures.append(
                {
                    "id": vector.identity,
                    "expected": vector.expected,
                    "python": p["accepted"],
                    "rust": r["accepted"],
                    "classification": "mismatch"
                    if p["accepted"] != r["accepted"]
                    else "shared_unexpected",
                }
            )
        elif expected and any(
            p[key] != r[key]
            for key in ("request_digest", "result_digest", "typed_value_digest")
        ):
            failures.append(
                {"id": vector.identity, "classification": "digest_mismatch"}
            )
    return failures


def execute(probe, output):
    selected = vectors()
    output.mkdir(mode=0o700)
    fixtures = output / "originals"
    original = freeze(fixtures, selected)
    (output / "originals-before.json").write_text(json.dumps(original, indent=2) + "\n")
    (output / "expected.json").write_text(json.dumps(ROSTER, indent=2) + "\n")
    require_originals(fixtures, original)
    python = python_report(fixtures, selected)
    (output / "python.json").write_text(json.dumps(python, indent=2) + "\n")
    require_originals(fixtures, original)
    rust = run_probe([str(probe), str(fixtures)], output)
    (output / "rust.json").write_text(json.dumps(rust, indent=2) + "\n")
    failures = compare(python, rust, selected)
    require_originals(fixtures, original)
    result = {
        "schema": "crebain.city-codec-parity.v1",
        "cases": len(selected),
        "passed": not failures,
        "failures": failures,
        "originals_unchanged": True,
        "native_execution": False,
    }
    (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


class PublicCodecParity(unittest.TestCase):
    def test_complete_public_corpus(self):
        probe = Path(os.environ["CREBAIN_CITY_CODEC_PROBE"]).resolve(strict=True)
        selected = os.environ.get("CREBAIN_CITY_CODEC_OUTPUT")
        output = (
            Path(selected)
            if selected
            else Path(tempfile.mkdtemp(prefix="city-codec-")) / "corpus"
        )
        result = execute(probe, output)
        self.assertTrue(result["passed"], f"{result['failures']}; retained at {output}")


class HarnessControls(unittest.TestCase):
    def setUp(self):
        self.selected = vectors()[:1]
        self.directory = tempfile.TemporaryDirectory(prefix="city-codec-harness-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.original = freeze(self.root / "originals", self.selected)
        self.report = python_report(self.root / "originals", self.selected)

    def test_matching_complete_reports_are_accepted(self):
        self.assertEqual(compare(self.report, deepcopy(self.report), self.selected), [])

    def test_missing_duplicate_and_extra_rows_reject(self):
        for rows in ([], self.report["rows"] * 2):
            report = deepcopy(self.report)
            report["rows"] = rows
            with self.assertRaises(AssertionError):
                compare(self.report, report, self.selected)

    def test_changed_original_frame_rejects(self):
        path = self.root / "originals/000.request.bin"
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(AssertionError, "original fixture changed"):
            require_originals(self.root / "originals", self.original)

    def test_decision_and_digest_mismatches_are_not_hidden(self):
        report = deepcopy(self.report)
        report["rows"][0].update(
            accepted=False, stage="input", error="binding", typed_value_digest=None
        )
        self.assertEqual(
            compare(self.report, report, self.selected)[0]["classification"], "mismatch"
        )
        report = deepcopy(self.report)
        report["rows"][0]["typed_value_digest"] = "0" * 64
        self.assertEqual(
            compare(self.report, report, self.selected)[0]["classification"],
            "digest_mismatch",
        )

    def test_nonzero_probe_is_harness_failure(self):
        with self.assertRaisesRegex(AssertionError, "probe nonzero exit"):
            run_probe(
                [sys.executable, "-I", "-B", "-c", "raise SystemExit(7)"], self.root
            )
        self.assertEqual(
            json.loads((self.root / "probe-command.json").read_bytes())["returncode"], 7
        )

    def test_nonreturning_and_overflowing_probe_are_harness_failures(self):
        for index, (program, reason, deadline) in enumerate(
            (
                ("import time; time.sleep(5)", "probe timeout", 0.05),
                (
                    "import sys; sys.stdout.write('x' * 262145)",
                    "probe output capacity",
                    5,
                ),
            )
        ):
            output = self.root / str(index)
            output.mkdir()
            with self.assertRaisesRegex(AssertionError, reason):
                run_probe(
                    [sys.executable, "-I", "-B", "-c", program],
                    output,
                    deadline_seconds=deadline,
                )
            self.assertIsNotNone(
                json.loads((output / "probe-command.json").read_bytes())["returncode"]
            )

    def test_cleanup_failure_keeps_original_failure(self):
        cleanup = RuntimeError("synthetic selector cleanup failure")
        original = selectors.DefaultSelector.close

        def close(selector):
            original(selector)
            raise cleanup

        with patch.object(selectors.DefaultSelector, "close", close):
            with self.assertRaises(BaseExceptionGroup) as caught:
                run_probe(
                    [sys.executable, "-I", "-B", "-c", "raise SystemExit(7)"], self.root
                )
        self.assertEqual(str(caught.exception.exceptions[0]), "probe nonzero exit")
        self.assertIs(caught.exception.exceptions[1], cleanup)

    def test_zero_cases_and_boolean_flags_reject(self):
        with self.assertRaises(AssertionError):
            freeze(self.root / "empty", ())
        report = deepcopy(self.report)
        report["rows"][0]["accepted"] = 1
        with self.assertRaises(AssertionError):
            validate_report(report, self.selected)

    def test_signed_zero_adjacent_values_and_lexical_alias(self):
        selected = {v.identity: v for v in vectors()}

        def digest(name):
            return w.parse(selected[name].request)["request_digest"]

        self.assertNotEqual(
            digest("continuous_positive_zero"), digest("continuous_negative_zero")
        )
        self.assertNotEqual(
            digest("continuous_adjacent_low"), digest("continuous_adjacent_high")
        )
        self.assertEqual(
            digest("continuous_adjacent_low"), digest("alternate_float_spelling")
        )
        self.assertNotEqual(
            selected["continuous_adjacent_low"].request,
            selected["alternate_float_spelling"].request,
        )


if __name__ == "__main__":
    unittest.main()

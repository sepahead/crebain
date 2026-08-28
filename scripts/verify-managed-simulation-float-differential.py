#!/usr/bin/env python3
"""Compare CREBAIN finite-f64 cases with exact Engram Python symbols."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import struct
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CORPUS = (
    ROOT
    / "integrations"
    / "engram"
    / "managed-simulation"
    / "contracts"
    / "engram.managed-runtime-finite-float.v1.json"
)
DEFAULT_PROVENANCE = (
    ROOT
    / "integrations"
    / "engram"
    / "managed-simulation"
    / "contracts"
    / "finite-float-differential.provenance.json"
)
MAX_SOURCE_BYTES = 2_000_000
MAX_CORPUS_BYTES = 100_000


class DifferentialError(RuntimeError):
    """The reviewed Rust and Engram finite-number policies differ."""


def _strict_json(path: Path, max_bytes: int) -> Any:
    payload = path.read_bytes()
    if not 0 < len(payload) <= max_bytes:
        raise DifferentialError(f"{path}: file size is outside the verification bound")

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise DifferentialError(f"{path}: duplicate JSON member {key!r}")
            result[key] = value
        return result

    try:
        return json.loads(payload, object_pairs_hook=reject_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DifferentialError(f"{path}: malformed UTF-8 JSON") from exc


def _resolve_beneath(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise DifferentialError(f"Engram source escapes its root: {relative}") from exc
    return candidate


def _load_reviewed_symbol(engram_root: Path, source: dict[str, Any]) -> Any:
    relative = source.get("path")
    symbol = source.get("symbol")
    expected_digest = source.get("symbol_source_sha256")
    if not all(isinstance(value, str) and value for value in (relative, symbol)):
        raise DifferentialError("corpus has an invalid Engram symbol reference")
    if not isinstance(expected_digest, str) or len(expected_digest) != 64:
        raise DifferentialError("corpus has an invalid Engram symbol digest")

    path = _resolve_beneath(engram_root, relative)
    payload = path.read_bytes()
    if not 0 < len(payload) <= MAX_SOURCE_BYTES:
        raise DifferentialError(
            f"{relative}: source size is outside the verification bound"
        )
    try:
        text = payload.decode("utf-8")
        tree = ast.parse(text, filename=str(path))
    except (UnicodeDecodeError, SyntaxError) as exc:
        raise DifferentialError(
            f"{relative}: source is not parseable UTF-8 Python"
        ) from exc
    matches = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == symbol
    ]
    if len(matches) != 1 or isinstance(matches[0], ast.AsyncFunctionDef):
        raise DifferentialError(f"{relative}: expected one synchronous {symbol} symbol")
    function = matches[0]
    lines = text.splitlines(keepends=True)
    segment = "".join(lines[function.lineno - 1 : function.end_lineno]).encode("utf-8")
    actual_digest = hashlib.sha256(segment).hexdigest()
    if actual_digest != expected_digest:
        raise DifferentialError(
            f"{relative}:{symbol} changed ({actual_digest}); review and refresh the corpus"
        )

    module = ast.Module(body=[function], type_ignores=[])
    ast.fix_missing_locations(module)

    class LoadedManagedRuntimeJsonError(ValueError):
        pass

    def reject(_reason: str, detail: str) -> None:
        raise ValueError(detail)

    namespace: dict[str, Any] = {
        "Any": Any,
        "MAX_PORTABLE_JSON_FLOAT_ABS": 1.0e300,
        "MAX_SAFE_JSON_INTEGER": 9_007_199_254_740_991,
        "ManagedRuntimeJsonError": LoadedManagedRuntimeJsonError,
        "_valid_json": lambda _value: False,
        "_reject": reject,
        "math": math,
    }
    exec(compile(module, str(path), "exec"), namespace)  # noqa: S102
    loaded = namespace.get(symbol)
    if not callable(loaded):
        raise DifferentialError(f"{relative}: failed to load {symbol}")
    return loaded


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _randomized_transcript(
    renderer: Any, randomized: dict[str, Any]
) -> tuple[int, str]:
    seed_hex = randomized.get("seed_hex")
    sample_count = randomized.get("sample_count")
    if (
        randomized.get("algorithm") != "splitmix64-v1"
        or not isinstance(seed_hex, str)
        or len(seed_hex) != 16
        or any(character not in "0123456789abcdef" for character in seed_hex)
        or not isinstance(sample_count, int)
        or isinstance(sample_count, bool)
        or not 1 <= sample_count <= 100_000
        or randomized.get("transcript")
        != r"lowercase-binary64-hex:canonical-json-or-rejected\n"
    ):
        raise DifferentialError("finite-float corpus has invalid randomized metadata")
    state = int(seed_hex, 16)
    mask = (1 << 64) - 1
    transcript = bytearray()
    accepted = 0
    for _ in range(sample_count):
        state = (state + 0x9E3779B97F4A7C15) & mask
        value_bits = state
        value_bits = ((value_bits ^ (value_bits >> 30)) * 0xBF58476D1CE4E5B9) & mask
        value_bits = ((value_bits ^ (value_bits >> 27)) * 0x94D049BB133111EB) & mask
        value_bits = (value_bits ^ (value_bits >> 31)) & mask
        value = struct.unpack(">d", value_bits.to_bytes(8, "big"))[0]
        try:
            rendered = renderer(value)
            if not isinstance(rendered, str):
                raise DifferentialError(
                    "Engram randomized renderer returned a non-string"
                )
            accepted += 1
        except ValueError:
            rendered = "rejected"
        transcript.extend(f"{value_bits:016x}:{rendered}\n".encode("ascii"))
    return accepted, hashlib.sha256(transcript).hexdigest()


def _verify(
    corpus_path: Path, provenance_path: Path, engram_root: Path
) -> tuple[int, int]:
    provenance = _strict_json(provenance_path, MAX_CORPUS_BYTES)
    if not isinstance(provenance, dict) or provenance.get("schema_version") != (
        "crebain.finite-float-differential-provenance.v1"
    ):
        raise DifferentialError("finite-float provenance has the wrong schema version")
    copied = provenance.get("copied_corpus")
    sources = provenance.get("engram_python_sources")
    if (
        not isinstance(copied, dict)
        or not isinstance(sources, list)
        or len(sources) != 2
    ):
        raise DifferentialError("finite-float provenance has an invalid source roster")
    expected_corpus_digest = copied.get("sha256")
    source_corpus_path = copied.get("source_path")
    if (
        not isinstance(expected_corpus_digest, str)
        or len(expected_corpus_digest) != 64
        or not isinstance(source_corpus_path, str)
    ):
        raise DifferentialError("finite-float provenance has an invalid corpus binding")
    engram_corpus_path = _resolve_beneath(engram_root, source_corpus_path)
    if _sha256(corpus_path) != expected_corpus_digest:
        raise DifferentialError("local finite-float corpus differs from its provenance")
    if _sha256(engram_corpus_path) != expected_corpus_digest:
        raise DifferentialError(
            "Engram finite-float corpus differs from its provenance"
        )

    corpus = _strict_json(corpus_path, MAX_CORPUS_BYTES)
    if not isinstance(corpus, dict) or corpus.get("schema_version") != (
        "engram.managed-runtime-finite-float.v1"
    ):
        raise DifferentialError("finite-float corpus has the wrong schema version")
    cases = corpus.get("cases")
    randomized = corpus.get("randomized")
    if (
        corpus.get("canonicalizer") != "engram.managed-runtime-json.v1"
        or not isinstance(cases, list)
        or not isinstance(randomized, dict)
    ):
        raise DifferentialError(
            "finite-float corpus has an invalid canonicalizer or cases"
        )
    by_role = {
        source.get("role"): _load_reviewed_symbol(engram_root, source)
        for source in sources
        if isinstance(source, dict)
    }
    renderers = (
        ("host", by_role.get("host-canonical-f64-rendering")),
        ("child", by_role.get("child-canonical-f64-rendering")),
    )
    if any(not callable(renderer) for _, renderer in renderers):
        raise DifferentialError("finite-float corpus is missing a reviewed Engram role")

    seen: set[str] = set()
    for case in cases:
        if not isinstance(case, dict):
            raise DifferentialError("finite-float corpus contains a non-object case")
        case_id = case.get("id")
        bits_hex = case.get("binary64_be_hex")
        portable = case.get("portable")
        canonical = case.get("canonical_json")
        if (
            not isinstance(case_id, str)
            or not case_id
            or case_id in seen
            or not isinstance(bits_hex, str)
            or len(bits_hex) != 16
            or any(character not in "0123456789abcdef" for character in bits_hex)
            or not isinstance(portable, bool)
            or (canonical is not None and not isinstance(canonical, str))
        ):
            raise DifferentialError(
                f"finite-float corpus has an invalid case: {case_id!r}"
            )
        seen.add(case_id)
        value = struct.unpack(">d", bytes.fromhex(bits_hex))[0]
        if not math.isfinite(value):
            raise DifferentialError(f"{case_id}: corpus value is not finite")
        if portable != (canonical is not None):
            raise DifferentialError(
                f"{case_id}: canonical bytes disagree with portability"
            )
        for renderer_name, renderer in renderers:
            try:
                rendered = renderer(value)
                accepted = isinstance(rendered, str)
            except ValueError:
                rendered = None
                accepted = False
            if accepted != portable:
                raise DifferentialError(
                    f"{case_id}: Engram {renderer_name} portable={accepted}, "
                    f"corpus portable={portable}"
                )
            if portable and rendered != canonical:
                raise DifferentialError(
                    f"{case_id}: Engram {renderer_name} rendered {rendered!r}, "
                    f"corpus expected {canonical!r}"
                )
    if len(seen) < 20:
        raise DifferentialError(
            "finite-float corpus does not cover enough generic cases"
        )
    expected_accepted = randomized.get("accepted_count")
    expected_transcript = randomized.get("transcript_sha256")
    if (
        not isinstance(expected_accepted, int)
        or isinstance(expected_accepted, bool)
        or not isinstance(expected_transcript, str)
        or len(expected_transcript) != 64
    ):
        raise DifferentialError("finite-float corpus has invalid randomized receipts")
    for renderer_name, renderer in renderers:
        accepted, transcript_sha256 = _randomized_transcript(renderer, randomized)
        if accepted != expected_accepted or transcript_sha256 != expected_transcript:
            raise DifferentialError(
                f"Engram {renderer_name} randomized finite-float transcript drifted: "
                f"accepted={accepted}, sha256={transcript_sha256}"
            )
    return len(seen), int(randomized["sample_count"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engram-root", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--provenance", type=Path, default=DEFAULT_PROVENANCE)
    arguments = parser.parse_args()
    try:
        engram_root = arguments.engram_root.resolve(strict=True)
        fixed_count, randomized_count = _verify(
            arguments.corpus.resolve(strict=True),
            arguments.provenance.resolve(strict=True),
            engram_root,
        )
    except (DifferentialError, FileNotFoundError, OSError) as exc:
        parser.error(str(exc))
    print(
        f"verified {fixed_count} fixed and {randomized_count} deterministic binary64 "
        "cases against reviewed Engram Python symbols"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

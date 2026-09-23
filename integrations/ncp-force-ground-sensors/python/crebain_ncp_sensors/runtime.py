"""Content-checked local runtime selection; external roots remain caller-trusted.

This manifest records installed bytes, not an attestation or a hostile-code sandbox.
Keep every selected root immutable between admission and confirmed process retirement.
"""

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import stat
from typing import ClassVar


SCHEMA = "crebain.installed-sensor-runtime.v1"
MANIFEST = "runtime.json"
BRIDGE = "integrations/ncp-force-ground-sensors/bridge/main.ts"
DEPENDENCY = "integrations/ncp-force-ground-sensors/contracts/dependency-source.v1.json"
PRODUCER = "crebain-ncp-force-ground-sensors"
FAMILY_SCHEMA = "crebain.installed-checkpoint-family-runtime.v1"
FAMILY_BRIDGE = "integrations/ncp-force-ground-sensors/bridge/family-main.ts"
FAMILY_PRODUCER = "crebain-ncp-checkpoint-family"
BUN_CONFIG = b'[install]\nauto = "disable"\n'
MAX_MANIFEST_BYTES = 32 * 1024**2
MAX_ENTRIES = 200_000
MAX_TREE_BYTES = 64 * 1024**3
BUN_PACKAGES = ("typescript", "@dimforge/rapier3d-compat", "three", "@sparkjsdev/spark")
NODE_PACKAGES = ("playwright", "vite")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate manifest key")
        result[key] = value
    return result


def _object(value, names):
    require(type(value) is dict and set(value) == set(names), "closed runtime object required")


def _relative(value):
    require(type(value) is str and 0 < len(value) <= 4096, "bounded relative path required")
    path = PurePosixPath(value)
    require(bool(path.parts) and not path.is_absolute() and path.as_posix() == value
            and all(part not in (".", "..") for part in path.parts)
            and "\\" not in value and "\x00" not in value, "direct relative path required")
    return value


def _absolute(value):
    require(type(value) is str and 0 < len(value) <= 4096, "absolute runtime path required")
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=True) == path,
            "canonical runtime path required")
    return path


def file_record(path, relative=None):
    """Hash a direct regular file without following a replacement leaf symlink."""
    path = Path(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    stream = None
    failures = []
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= MAX_TREE_BYTES,
                "bounded regular runtime file required")
        # The outer scope owns this descriptor even if stream construction fails.
        stream = os.fdopen(descriptor, "rb", closefd=False)
        digest = hashlib.sha256()
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
        after = os.fstat(descriptor)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                "runtime file changed while hashing")
    except BaseException as primary:
        failures.append(primary)
    finally:
        if stream is not None:
            try:
                stream.close()
            except BaseException as cleanup:
                failures.append(cleanup)
        try:
            os.close(descriptor)
        except BaseException as cleanup:
            failures.append(cleanup)
    if len(failures) == 1:
        raise failures[0]
    if failures:
        raise BaseExceptionGroup("Runtime file read and cleanup failed", failures)
    return {"path": relative if relative is not None else str(path), "kind": "file",
            "mode": stat.S_IMODE(before.st_mode), "bytes": before.st_size,
            "sha256": digest.hexdigest()}


def inventory_tree(root, *, external_links=None):
    """Inventory directories, bytes, and link targets without traversing links."""
    root = _absolute(str(root))
    require(root.is_dir(), "runtime tree required")
    permitted = external_links or {}
    result = []
    total = 0
    pending = [root]
    while pending:
        current = pending.pop()
        for path in sorted(current.iterdir()):
            relative = path.relative_to(root).as_posix()
            _relative(relative)
            status = path.lstat()
            mode = stat.S_IMODE(status.st_mode)
            if stat.S_ISLNK(status.st_mode):
                target = os.readlink(path)
                resolved = path.resolve(strict=True)
                if relative in permitted:
                    require(target == str(permitted[relative]) and resolved == permitted[relative],
                            "external runtime link changed")
                else:
                    require(not Path(target).is_absolute() and resolved.is_relative_to(root),
                            "runtime link escapes its selected root")
                result.append({"path": relative, "kind": "symlink", "mode": mode,
                               "target": target})
            elif stat.S_ISDIR(status.st_mode):
                result.append({"path": relative, "kind": "directory", "mode": mode})
                pending.append(path)
            elif stat.S_ISREG(status.st_mode):
                row = file_record(path, relative)
                total += row["bytes"]
                require(total <= MAX_TREE_BYTES, "runtime tree byte limit")
                result.append(row)
            else:
                raise ValueError("special file in runtime tree")
            require(len(result) <= MAX_ENTRIES, "runtime tree entry limit")
    return sorted(result, key=lambda row: row["path"])


def _records(value, *, absolute=False):
    require(type(value) is list and 0 < len(value) <= MAX_ENTRIES, "bounded runtime roster required")
    names = []
    for row in value:
        require(type(row) is dict, "runtime entry required")
        kind = row.get("kind")
        extra = {"file": {"bytes", "sha256"}, "directory": set(), "symlink": {"target"}}
        require(type(kind) is str and kind in extra, "runtime entry kind")
        _object(row, {"path", "kind", "mode"} | extra[kind])
        if absolute:
            _absolute(row["path"])
        else:
            _relative(row["path"])
        require(type(row["mode"]) is int and 0 <= row["mode"] <= 0o7777, "runtime mode")
        if kind == "file":
            require(type(row["bytes"]) is int and 0 <= row["bytes"] <= MAX_TREE_BYTES,
                    "runtime byte count")
            require(type(row["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", row["sha256"]),
                    "runtime file digest")
        elif kind == "symlink":
            require(type(row["target"]) is str and 0 < len(row["target"]) <= 4096,
                    "runtime link target")
        names.append(row["path"])
    require(names == sorted(set(names)), "ordered unique runtime roster required")


def _tree(value):
    _object(value, {"path", "entries"})
    path = _absolute(value["path"])
    _records(value["entries"])
    require(inventory_tree(path) == value["entries"], "selected runtime tree changed")
    return path


def _executable(value):
    _records([value], absolute=True)
    require(value["kind"] == "file" and value["mode"] & 0o111, "runtime executable required")
    path = _absolute(value["path"])
    require(file_record(path) == value and os.access(path, os.X_OK), "runtime executable changed")
    return path


def source_identity(source):
    return hashlib.sha256(canonical(source)).hexdigest()


def check_package_roots(project, modules, *, graphics):
    """Reject package fallbacks outside the explicitly selected dependency tree."""
    roots = set()
    for start in (project, modules.parent):
        roots.update(parent / "node_modules" for parent in (start, *start.parents))
    for candidate in roots:
        if candidate.exists() or candidate.is_symlink():
            require(candidate.resolve(strict=True) == modules,
                    "alternate ancestor node_modules is not selected")
    packages = {}
    for name in BUN_PACKAGES + (NODE_PACKAGES if graphics else ()):
        directory = modules / name
        require(directory.is_dir() and directory.resolve(strict=True).is_relative_to(modules),
                "operational package is missing from selected tree: " + name)
        manifest = directory / "package.json"
        require(manifest.is_file() and manifest.resolve(strict=True).is_relative_to(modules)
                and manifest.stat().st_size <= 1024**2, "selected package metadata required: " + name)
        metadata = json.loads(manifest.read_bytes(), object_pairs_hook=_pairs)
        require(type(metadata) is dict and metadata.get("name") == name, "selected package name differs")
        packages[name] = directory.resolve(strict=True)
    return packages


@dataclass(frozen=True, slots=True)
class InstalledRuntime:
    """Immutable selection. Reopen once before launch, never once per body tick."""

    prefix: Path
    producer: Path
    bun: Path
    node: Path | None
    bridge: Path
    project: Path
    source_identity: str
    manifest_sha256: str
    _environment: tuple[tuple[str, str], ...]
    _schema: ClassVar[str] = SCHEMA
    _producer: ClassVar[str] = PRODUCER
    _bridge: ClassVar[str] = BRIDGE
    _dependency: ClassVar[str] = DEPENDENCY
    _requires_graphics: ClassVar[bool] = False

    @property
    def environment(self) -> dict[str, str]:
        return dict(self._environment)

    @classmethod
    def open(cls, prefix):
        prefix = Path(prefix).resolve(strict=True)
        status = prefix.stat()
        require(stat.S_ISDIR(status.st_mode) and status.st_uid == os.getuid()
                and stat.S_IMODE(status.st_mode) == 0o700, "owner-private runtime prefix required")
        manifest = prefix / MANIFEST
        require(not manifest.is_symlink() and manifest.is_file()
                and manifest.stat().st_size <= MAX_MANIFEST_BYTES, "bounded direct runtime manifest required")
        raw = manifest.read_bytes()
        value = json.loads(raw, object_pairs_hook=_pairs,
                           parse_constant=lambda token: (_ for _ in ()).throw(ValueError(token)))
        _object(value, {"schema", "source", "ncp", "platform", "producer", "project",
                        "node_modules", "bun", "node", "browser", "source_identity"})
        require(value["schema"] == cls._schema, "runtime schema")
        require(value["platform"] == {"system": platform.system(), "machine": platform.machine()},
                "runtime platform differs")
        source = value["source"]
        _object(source, {"commit", "tree", "files"})
        _object(value["ncp"], {"commit", "tree"})
        for identity in (source, value["ncp"]):
            for name in ("commit", "tree"):
                require(type(identity[name]) is str and re.fullmatch(r"[0-9a-f]{40}", identity[name]),
                        "source Git identity")
        _records(source["files"])
        require(all(row["kind"] != "directory" for row in source["files"]), "Git source leaves required")
        require(value["source_identity"] == source_identity(source), "runtime source identity changed")
        modules = _tree(value["node_modules"])
        browser = None if value["browser"] is None else _tree(value["browser"])
        bun = _executable(value["bun"])
        node = None if value["node"] is None else _executable(value["node"])
        require((node is None) == (browser is None), "Node and browser root must be selected together")
        require(not cls._requires_graphics or node is not None, "family runtime requires selected graphics")
        project = prefix / "project"
        _records(value["project"])
        actual = inventory_tree(project, external_links={"node_modules": modules})
        require(actual == value["project"], "installed project changed")
        selected = {row["path"]: row for row in actual}
        for row in source["files"]:
            require(selected.get(row["path"]) == row, "installed Git source changed")
        source_names = {row["path"] for row in source["files"]}
        require({cls._bridge, cls._dependency, "package.json", "bun.lock", "LICENSE-MIT", "LICENSE-APACHE"}
                <= source_names, "complete source entrypoints required")
        leaves = {row["path"] for row in actual if row["kind"] != "directory"}
        require(leaves == source_names | {"bunfig.toml", "node_modules"}, "unselected project file")
        require((project / "bunfig.toml").read_bytes() == BUN_CONFIG, "offline Bun configuration required")
        require(selected["node_modules"]["kind"] == "symlink"
                and os.readlink(project / "node_modules") == str(modules), "selected dependencies required")
        require(not any("node_modules" in Path(name).parts for name in source_names),
                "Git source contains an unselected dependency tree")
        check_package_roots(project, modules, graphics=node is not None)
        require(not any(Path(name).name.startswith(".env") and Path(name).name != ".env.example"
                        for name in source_names), "dotenv runtime configuration is not selected")
        dependency = json.loads((project / cls._dependency).read_bytes(), object_pairs_hook=_pairs)
        require({name: dependency.get(name) for name in ("commit", "tree")} == value["ncp"],
                "staged NCP contract differs")
        producer = prefix / "bin" / cls._producer
        require(producer.parent.resolve(strict=True) == producer.parent,
                "direct installed executable directory required")
        _records([value["producer"]])
        require(value["producer"]["path"] == cls._producer and value["producer"]["kind"] == "file"
                and value["producer"]["mode"] & 0o111 and os.access(producer, os.X_OK)
                and file_record(producer, cls._producer) == value["producer"], "installed producer changed")
        require({p.name for p in (prefix / "bin").iterdir()} == {cls._producer}, "unselected executable")
        require({p.name for p in prefix.iterdir()} <= {MANIFEST, "project", "bin", "build"},
                "unselected runtime root")
        environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "DO_NOT_TRACK": "1",
                       "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
                       "NODE_OPTIONS": "--no-global-search-paths"}
        if browser is not None:
            environment.update(PLAYWRIGHT_BROWSERS_PATH=str(browser), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1")
        return cls(prefix, producer, bun, node, project / cls._bridge, project,
                   value["source_identity"], hashlib.sha256(raw).hexdigest(),
                   tuple(sorted(environment.items())))


class InstalledFamilyRuntime(InstalledRuntime):
    """Explicit optional family executable selection; admission is not native readiness."""

    _schema = FAMILY_SCHEMA
    _producer = FAMILY_PRODUCER
    _bridge = FAMILY_BRIDGE
    _requires_graphics = True


class InstalledCityRuntime(InstalledRuntime):
    """Explicit shared-world city selection; source admission is not native qualification."""

    _schema = "crebain.installed-force-city-runtime.v1"
    _producer = "crebain-ncp-force-city-sources"
    _bridge = "integrations/ncp-force-city-sources/bridge/main.ts"
    _dependency = "integrations/ncp-force-city-sources/contracts/dependency-source.v1.json"
    _requires_graphics = False

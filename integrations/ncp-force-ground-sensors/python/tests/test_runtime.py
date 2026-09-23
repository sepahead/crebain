"""Temporary-file controls only: no producer, Bun, Node, or browser execution."""

from copy import deepcopy
from dataclasses import FrozenInstanceError
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from crebain_ncp_sensors import runtime as r


class RuntimeFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.path = self.base / "selected"
        self.path.write_bytes(b"selected regular bytes\n")
        self.opened = []
        self.actual_open = os.open
        self.actual_close = os.close

    def tracked_open(self, path, flags):
        descriptor = self.actual_open(path, flags)
        self.opened.append((descriptor, flags))
        return descriptor

    def assert_closed(self):
        self.assertEqual(len(self.opened), 1)
        descriptor, flags = self.opened[0]
        self.assertTrue(flags & os.O_NONBLOCK)
        self.assertTrue(flags & os.O_NOFOLLOW)
        with self.assertRaises(OSError) as caught:
            os.fstat(descriptor)
        self.assertEqual(caught.exception.errno, errno.EBADF)

    def test_regular_file_hashes_identically_and_directory_rejection_closes_its_fd(self):
        with patch.object(r.os, "open", self.tracked_open):
            row = r.file_record(self.path, "selected")
        self.assertEqual(row, {"path": "selected", "kind": "file", "mode": self.path.stat().st_mode & 0o7777,
                              "bytes": self.path.stat().st_size,
                              "sha256": hashlib.sha256(self.path.read_bytes()).hexdigest()})
        self.assert_closed()
        self.opened.clear()
        with patch.object(r.os, "open", self.tracked_open), patch.object(r.os, "fdopen") as wrap:
            with self.assertRaisesRegex(ValueError, "bounded regular"):
                r.file_record(self.base)
            wrap.assert_not_called()
        self.assert_closed()

    def test_fifo_without_writer_rejects_and_closes_before_a_bounded_child_deadline(self):
        fifo = self.base / "fifo"
        os.mkfifo(fifo)
        code = '''
import errno,json,os,runpy,sys
reader=runpy.run_path(sys.argv[1])["file_record"]
original=os.open
opened=[]
def record(path,flags):
    descriptor=original(path,flags)
    opened.append((descriptor,flags))
    return descriptor
os.open=record
try:
    reader(sys.argv[2])
except ValueError:
    rejected=True
else:
    rejected=False
assert len(opened)==1
descriptor,flags=opened[0]
try:
    os.fstat(descriptor)
except OSError as error:
    closed=error.errno==errno.EBADF
else:
    closed=False
    os.close(descriptor)
print(json.dumps({"rejected":rejected,"closed":closed,"nonblock":bool(flags & os.O_NONBLOCK)}))
'''
        result = subprocess.run([sys.executable, "-I", "-B", "-c", code, r.__file__, str(fifo)],
                                capture_output=True, timeout=5, check=True)
        self.assertEqual(json.loads(result.stdout), {"rejected": True, "closed": True, "nonblock": True})

    def test_wrapper_construction_failure_preserves_its_original_object_and_closes_fd(self):
        original = RuntimeError("wrapper construction failed")
        with patch.object(r.os, "open", self.tracked_open), patch.object(r.os, "fdopen", side_effect=original) as wrap:
            try:
                r.file_record(self.path)
            except BaseException as error:
                self.assertIs(error, original)
            else:
                self.fail("wrapper failure was accepted")
            wrap.assert_called_once_with(self.opened[0][0], "rb", closefd=False)
        self.assert_closed()

    def test_primary_stream_and_descriptor_failures_remain_original_and_ordered(self):
        events = []

        class HostilePrimary(RuntimeError):
            @property
            def __class__(self):
                raise AssertionError("exception classification invoked user code")

            def __str__(self):
                raise AssertionError("exception formatting invoked user code")

        primary = HostilePrimary()
        stream_error = RuntimeError("stream cleanup")
        descriptor_error = RuntimeError("descriptor cleanup")

        class Stream:
            def read(self, count):
                events.append("read")
                raise primary

            def close(self):
                events.append("stream-close")
                raise stream_error

        def close(descriptor):
            events.append("descriptor-close")
            self.actual_close(descriptor)
            raise descriptor_error

        with patch.object(r.os, "open", self.tracked_open), patch.object(r.os, "fdopen", return_value=Stream()), \
                patch.object(r.os, "close", close):
            try:
                r.file_record(self.path)
            except BaseExceptionGroup as failure:
                self.assertEqual(len(failure.exceptions), 3)
                for observed, original in zip(failure.exceptions, (primary, stream_error, descriptor_error)):
                    self.assertIs(observed, original)
            else:
                self.fail("operation and cleanup failures were accepted")
        self.assertEqual(events, ["read", "stream-close", "descriptor-close"])
        self.assert_closed()

    def test_stream_cleanup_failure_alone_still_closes_the_owned_descriptor(self):
        original = RuntimeError("stream close failed")

        class Stream:
            def read(self, count):
                return b""

            def close(self):
                raise original

        with patch.object(r.os, "open", self.tracked_open), patch.object(r.os, "fdopen", return_value=Stream()):
            try:
                r.file_record(self.path)
            except BaseException as error:
                self.assertIs(error, original)
            else:
                self.fail("stream cleanup failure was accepted")
        self.assert_closed()


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.prefix = self.base / "installed"
        self.prefix.mkdir(mode=0o700)
        self.project = self.prefix / "project"
        self.project.mkdir()
        self.ncp = {"commit": "a" * 40, "tree": "b" * 40}
        for name in (r.BRIDGE, "package.json", "bun.lock", "LICENSE-MIT", "LICENSE-APACHE"):
            path = self.project / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("selected fixture source\n")
        (self.project / r.DEPENDENCY).parent.mkdir(parents=True, exist_ok=True)
        (self.project / r.DEPENDENCY).write_text(json.dumps(self.ncp))
        source = {"commit": "c" * 40, "tree": "d" * 40,
                  "files": [row for row in r.inventory_tree(self.project) if row["kind"] == "file"]}
        modules = self.base / "node_modules"
        (modules / "package").mkdir(parents=True)
        (modules / "package/main.js").write_text("selected dependency")
        (modules / "package/LICENSE").write_text("retained license")
        for name in r.BUN_PACKAGES + r.NODE_PACKAGES:
            package = modules / name
            package.mkdir(parents=True)
            (package / "package.json").write_text(json.dumps({"name": name}))
        (modules / ".bin").mkdir()
        (modules / ".bin/tool").symlink_to("../package/main.js")
        (self.project / "node_modules").symlink_to(modules, target_is_directory=True)
        (self.project / "bunfig.toml").write_bytes(r.BUN_CONFIG)
        (self.prefix / "bin").mkdir()
        self.producer = self.prefix / "bin" / r.PRODUCER
        self.producer.write_text("synthetic producer: never executed\n")
        self.producer.chmod(0o755)
        self.bun = self.base / "bun"
        self.bun.write_text("synthetic bun: never executed\n")
        self.bun.chmod(0o755)
        self.value = {"schema": r.SCHEMA, "source": source, "ncp": self.ncp,
                      "platform": {"system": platform.system(), "machine": platform.machine()},
                      "producer": r.file_record(self.producer, r.PRODUCER),
                      "project": r.inventory_tree(self.project, external_links={"node_modules": modules}),
                      "node_modules": {"path": str(modules), "entries": r.inventory_tree(modules)},
                      "bun": r.file_record(self.bun), "node": None, "browser": None,
                      "source_identity": r.source_identity(source)}
        self.save()

    def save(self, value=None):
        (self.prefix / r.MANIFEST).write_text(json.dumps(self.value if value is None else value))

    def positive(self):
        with patch("subprocess.Popen", side_effect=AssertionError("runtime validation launched a process")):
            result = r.InstalledRuntime.open(self.prefix)
        self.assertEqual(result.source_identity, self.value["source_identity"])
        return result

    def test_camera_free_open_preserves_links_and_copies_environment(self):
        result = self.positive()
        self.assertIsNone(result.node)
        self.assertEqual(result.bridge, self.project / r.BRIDGE)
        self.assertEqual(result.producer, self.producer)
        self.assertEqual(result.environment["DO_NOT_TRACK"], "1")
        self.assertEqual(result.environment["BUN_RUNTIME_TRANSPILER_CACHE_PATH"], "0")
        changed = result.environment
        changed["NODE_OPTIONS"] = "--require=unselected.js"
        self.assertEqual(result.environment["NODE_OPTIONS"], "--no-global-search-paths")
        with self.assertRaises(FrozenInstanceError):
            result.bun = self.producer

    def test_family_requires_its_own_schema_executable_bridge_and_graphics_selection(self):
        self.positive()
        with self.assertRaises(ValueError):
            r.InstalledFamilyRuntime.open(self.prefix)
        family_bridge = self.project / r.FAMILY_BRIDGE
        family_bridge.write_text("selected synthetic family source; never executed")
        source = self.value["source"]
        source["files"] = sorted([*source["files"], r.file_record(family_bridge, r.FAMILY_BRIDGE)], key=lambda row: row["path"])
        self.value["source_identity"] = r.source_identity(source)
        modules = Path(self.value["node_modules"]["path"])
        self.value["project"] = r.inventory_tree(self.project, external_links={"node_modules": modules})
        self.producer.rename(self.prefix / "bin" / r.FAMILY_PRODUCER)
        self.producer = self.prefix / "bin" / r.FAMILY_PRODUCER
        self.value["producer"] = r.file_record(self.producer, r.FAMILY_PRODUCER)
        self.value["schema"] = r.FAMILY_SCHEMA
        self.save()
        with self.assertRaisesRegex(ValueError, "requires selected graphics"):
            r.InstalledFamilyRuntime.open(self.prefix)
        browser = self.base / "browsers"
        browser.mkdir()
        (browser / "browser").write_text("synthetic browser; never executed")
        self.value["node"] = r.file_record(self.bun)
        self.value["browser"] = {"path": str(browser), "entries": r.inventory_tree(browser)}
        self.save()
        with patch("subprocess.Popen", side_effect=AssertionError("profile discovery executed a child")):
            selected = r.InstalledFamilyRuntime.open(self.prefix)
            self.assertEqual(selected.bridge, family_bridge)
            self.assertEqual(selected.producer, self.producer)
            with self.assertRaises(ValueError):
                r.InstalledRuntime.open(self.prefix)
        original = self.producer.read_bytes()
        self.producer.write_bytes(original + b"drift")
        with self.assertRaisesRegex(ValueError, "producer changed"):
            r.InstalledFamilyRuntime.open(self.prefix)
        self.producer.write_bytes(original)
        self.assertEqual(r.InstalledFamilyRuntime.open(self.prefix), selected)

    def test_graphics_requires_both_selected_resources(self):
        browser = self.base / "browsers"
        browser.mkdir()
        (browser / "browser").write_text("synthetic browser")
        self.value["browser"] = {"path": str(browser), "entries": r.inventory_tree(browser)}
        self.save()
        with self.assertRaises(ValueError):
            r.InstalledRuntime.open(self.prefix)
        self.value["node"] = r.file_record(self.bun)
        self.save()
        result = self.positive()
        self.assertEqual(result.environment["PLAYWRIGHT_BROWSERS_PATH"], str(browser))
        self.value["browser"] = None
        self.save()
        with self.assertRaises(ValueError):
            r.InstalledRuntime.open(self.prefix)
        self.value["node"] = None
        self.save()
        self.positive()

    def test_byte_mode_and_roster_changes_reject_then_restore(self):
        dependency = Path(self.value["node_modules"]["path"]) / "package/main.js"
        for path in (self.producer, self.bun, self.project / r.BRIDGE, dependency):
            with self.subTest(path=path):
                original = path.read_bytes()
                path.write_bytes(original + b"changed")
                with self.assertRaises(ValueError):
                    r.InstalledRuntime.open(self.prefix)
                path.write_bytes(original)
                self.positive()
        self.producer.chmod(0o644)
        with self.assertRaises(ValueError):
            r.InstalledRuntime.open(self.prefix)
        self.producer.chmod(0o755)
        self.positive()
        for folder in (self.project, Path(self.value["node_modules"]["path"]), self.prefix):
            extra = folder / "unselected.py"
            extra.write_text("unselected")
            with self.assertRaises(ValueError):
                r.InstalledRuntime.open(self.prefix)
            extra.unlink()
            self.positive()

    def test_symlink_escape_and_replacement_reject_then_restore(self):
        modules = Path(self.value["node_modules"]["path"])
        link = modules / ".bin/tool"
        link.unlink()
        link.symlink_to(self.bun)
        with self.assertRaises(ValueError):
            r.InstalledRuntime.open(self.prefix)
        link.unlink()
        link.symlink_to("../package/main.js")
        self.positive()
        original = self.producer.read_bytes()
        self.producer.unlink()
        self.producer.symlink_to(self.bun)
        with self.assertRaises(OSError):
            r.InstalledRuntime.open(self.prefix)
        self.producer.unlink()
        self.producer.write_bytes(original)
        self.producer.chmod(0o755)
        self.positive()
        binary = self.prefix / "bin"
        moved = self.base / "moved-bin"
        binary.rename(moved)
        binary.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(ValueError):
            r.InstalledRuntime.open(self.prefix)
        binary.unlink()
        moved.rename(binary)
        self.positive()

    def test_closed_manifest_and_exact_scalar_types(self):
        mutations = [lambda v: v.update(extra=True),
                     lambda v: v.update(schema="different"),
                     lambda v: v["producer"].update(bytes=True),
                     lambda v: v["producer"].update(mode=True),
                     lambda v: v["producer"].update(kind=[]),
                     lambda v: v["source"]["files"][0].update(path="../escape"),
                     lambda v: v["source"]["files"][0].update(path="."),
                     lambda v: v["source"]["files"].append(v["source"]["files"][0]),
                     lambda v: v["ncp"].update(commit="e" * 40),
                     lambda v: v.update(source_identity="0" * 64),
                     lambda v: v["platform"].update(extra=True)]
        for mutate in mutations:
            changed = deepcopy(self.value)
            mutate(changed)
            self.save(changed)
            with self.subTest(change=changed), self.assertRaises(ValueError):
                r.InstalledRuntime.open(self.prefix)
            self.save()
            self.positive()
        manifest = self.prefix / r.MANIFEST
        manifest.write_text('{"schema":"one","schema":"two"}')
        with self.assertRaises(ValueError):
            r.InstalledRuntime.open(self.prefix)
        self.save()
        self.positive()

    def test_private_prefix_and_offline_configuration(self):
        self.prefix.chmod(0o755)
        with self.assertRaises(ValueError):
            r.InstalledRuntime.open(self.prefix)
        self.prefix.chmod(0o700)
        self.positive()
        (self.project / "bunfig.toml").write_text('[install]\nauto="force"\n')
        with self.assertRaises(ValueError):
            r.InstalledRuntime.open(self.prefix)
        (self.project / "bunfig.toml").write_bytes(r.BUN_CONFIG)
        self.positive()

    def test_later_ancestor_dependency_and_missing_selected_package_reject(self):
        alternate = self.prefix / "node_modules"
        alternate.mkdir()
        (alternate / "typescript").mkdir()
        (alternate / "typescript/package.json").write_text(json.dumps({"name": "typescript"}))
        with self.assertRaisesRegex(ValueError, "alternate ancestor"):
            r.InstalledRuntime.open(self.prefix)
        (alternate / "typescript/package.json").unlink()
        (alternate / "typescript").rmdir()
        alternate.rmdir()
        self.positive()
        modules = Path(self.value["node_modules"]["path"])
        metadata = modules / "typescript/package.json"
        original = metadata.read_bytes()
        metadata.unlink()
        self.value["node_modules"]["entries"] = r.inventory_tree(modules)
        self.save()
        with self.assertRaisesRegex(ValueError, "selected package metadata"):
            r.InstalledRuntime.open(self.prefix)
        metadata.write_bytes(original)
        self.value["node_modules"]["entries"] = r.inventory_tree(modules)
        self.save()
        self.positive()


if __name__ == "__main__":
    unittest.main()

"""Temporary-file controls only: no producer, Bun, Node, or browser execution."""

from copy import deepcopy
from dataclasses import FrozenInstanceError
import json
from pathlib import Path
import platform
import tempfile
import unittest
from unittest.mock import patch

from crebain_ncp_sensors import runtime as r


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

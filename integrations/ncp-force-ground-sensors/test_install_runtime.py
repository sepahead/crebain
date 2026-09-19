"""Builder controls use temporary files and mocked build tools, never native workloads."""

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import shutil
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("crebain_install_runtime_tests", Path(__file__).with_name("install_runtime.py"))
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
r = builder.runtime


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.source = self.base / "source"
        self.source.mkdir()
        self.output = self.base / "installed"
        self.sdk = self.base / "sdk"
        self.sdk.mkdir()
        ncp = {"commit": "a" * 40, "tree": "b" * 40}
        compose = (
            "def compose(source, destination):\n"
            "    destination.mkdir()\n"
            "    return {'dependency_commit': '" + ncp["commit"] + "', 'dependency_tree': '" + ncp["tree"] + "'}\n"
            "def checked_dependency(source):\n"
            "    return None\n"
        )
        files = {r.BRIDGE: b"selected bridge", r.DEPENDENCY: json.dumps(ncp).encode(),
                 "package.json": b"{}", "bun.lock": b"selected lock", "LICENSE-MIT": b"MIT license",
                 "LICENSE-APACHE": b"Apache license",
                 "integrations/ncp-force-ground-sensors/compose.py": compose.encode()}
        leaves = []
        for name, blob in sorted(files.items()):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(blob)
            path.chmod(0o644)
            leaves.append((name, "100644", blob))
        self.snapshot = ("c" * 40, "d" * 40, leaves)
        modules = self.source / "node_modules"
        modules.mkdir()
        (modules / "LICENSE").write_text("dependency license")
        for name in r.BUN_PACKAGES + r.NODE_PACKAGES:
            package = modules / name
            package.mkdir(parents=True)
            (package / "package.json").write_text(json.dumps({"name": name}))
            (package / "index.js").write_text("selected synthetic package entry")
        self.bun = self.base / "bun"
        self.bun.write_text("synthetic executable: never run")
        self.bun.chmod(0o755)
        vendor_patch = patch.object(builder, "check_vendors")
        self.vendor = vendor_patch.start()
        self.addCleanup(vendor_patch.stop)
        self.resolve_packages = builder.check_package_resolution
        resolution_patch = patch.object(builder, "check_package_resolution",
            side_effect=lambda project, executable, packages, **kw:
            {name: str(path / "index.js") for name, path in packages.items()})
        self.resolution = resolution_patch.start()
        self.addCleanup(resolution_patch.stop)

    def build(self, composition, output):
        producer = output / "synthetic-producer"
        producer.write_text("synthetic build result")
        return producer

    def test_camera_free_install_uses_existing_composition_and_keeps_licenses(self):
        with patch.object(builder, "source_snapshot", return_value=self.snapshot), \
                patch.object(builder, "build_producer", side_effect=self.build) as build, \
                patch.object(builder, "check_browser", side_effect=AssertionError("graphics was selected")), \
                patch("subprocess.Popen", side_effect=AssertionError("test launched a process")):
            selected = builder.install(self.sdk, self.output, self.bun, root=self.source)
        self.assertIsNone(selected.node)
        build.assert_called_once()
        self.assertEqual((selected.project / "LICENSE-MIT").read_bytes(), b"MIT license")
        self.assertTrue((selected.project / "node_modules").is_symlink())
        self.assertEqual((selected.project / "node_modules/LICENSE").read_text(), "dependency license")
        self.assertEqual(r.InstalledRuntime.open(self.output), selected)

    def test_graphics_install_selects_public_playwright_probe(self):
        browser = self.base / "browser"
        browser.mkdir()
        (browser / "LICENSE").write_text("browser license")
        with patch.object(builder, "source_snapshot", return_value=self.snapshot), \
                patch.object(builder, "build_producer", side_effect=self.build), \
                patch.object(builder, "check_browser") as probe, \
                patch("subprocess.Popen", side_effect=AssertionError("test launched a process")):
            selected = builder.install(self.sdk, self.output, self.bun, node=self.bun,
                                       browser_root=browser, root=self.source)
        probe.assert_called_once_with(selected.project, self.bun, browser)
        self.assertEqual(selected.environment["PLAYWRIGHT_BROWSERS_PATH"], str(browser))

    def test_vendor_preflight_precedes_build_and_failure_blocks_publication(self):
        order = []
        def accepted(project, bun, log):
            self.assertEqual(bun, self.bun)
            self.assertEqual((project / "bunfig.toml").read_bytes(), r.BUN_CONFIG)
            self.assertTrue((project / "node_modules").is_symlink())
            self.assertEqual(log.parent, self.output / "build")
            order.append("vendors")
        def built(composition, output):
            self.assertEqual(order, ["vendors"])
            order.append("build")
            return self.build(composition, output)
        self.vendor.side_effect = ValueError("synthetic vendor pin mismatch")
        with patch.object(builder, "source_snapshot", return_value=self.snapshot), \
                patch.object(builder, "build_producer", side_effect=built) as build:
            with self.assertRaisesRegex(ValueError, "vendor pin mismatch"):
                builder.install(self.sdk, self.output, self.bun, root=self.source)
            build.assert_not_called()
            self.assertFalse((self.output / r.MANIFEST).exists())
            self.output = self.base / "accepted"
            self.vendor.side_effect = accepted
            selected = builder.install(self.sdk, self.output, self.bun, root=self.source)
            self.assertEqual(order, ["vendors", "build"])
            self.assertEqual(r.InstalledRuntime.open(self.output), selected)

    def test_missing_local_with_present_ancestor_stops_before_any_preflight(self):
        local = self.source / "node_modules/typescript"
        shutil.rmtree(local)
        alternate = self.base / "node_modules/typescript"
        alternate.mkdir(parents=True)
        (alternate / "package.json").write_text(json.dumps({"name": "typescript"}))
        with patch.object(builder, "source_snapshot", return_value=self.snapshot), \
                patch.object(builder, "build_producer", side_effect=self.build) as build, \
                patch("subprocess.Popen", side_effect=AssertionError("test launched a process")):
            with self.assertRaisesRegex(ValueError, "alternate ancestor"):
                builder.install(self.sdk, self.output, self.bun, root=self.source)
            self.resolution.assert_not_called()
            self.vendor.assert_not_called()
            build.assert_not_called()
            self.assertFalse((self.output / r.MANIFEST).exists())
            shutil.rmtree(alternate.parent)
            local.mkdir()
            (local / "package.json").write_text(json.dumps({"name": "typescript"}))
            (local / "index.js").write_text("selected synthetic package entry")
            self.output = self.base / "selected-local"
            selected = builder.install(self.sdk, self.output, self.bun, root=self.source)
            self.assertEqual(r.InstalledRuntime.open(self.output), selected)

    def test_engine_resolution_rejects_foreign_entry_and_accepts_selected_entry(self):
        for engine, names in (("bun", r.BUN_PACKAGES), ("node", r.NODE_PACKAGES)):
            packages = {name: (self.source / "node_modules" / name) for name in names}
            selected = {name: str(path / "index.js") for name, path in packages.items()}
            wrong = dict(selected)
            wrong[names[0]] = str(self.bun)
            with patch("subprocess.check_output", return_value=json.dumps(wrong).encode()):
                with self.assertRaisesRegex(ValueError, "outside its selected package"):
                    self.resolve_packages(self.source, self.bun, packages, engine=engine)
            with patch("subprocess.check_output", return_value=json.dumps(selected).encode()) as invoked:
                self.assertEqual(self.resolve_packages(self.source, self.bun, packages, engine=engine), selected)
                environment = invoked.call_args.kwargs["env"]
                self.assertEqual(environment["DO_NOT_TRACK"], "1")
                self.assertEqual(environment["BUN_RUNTIME_TRANSPILER_CACHE_PATH"], "0")
                self.assertEqual(environment["NODE_OPTIONS"], "--no-global-search-paths")
                self.assertNotIn("NODE_PATH", environment)
                self.assertNotIn("HOME", environment)

    def test_failed_build_has_no_usable_manifest_and_keeps_diagnostics(self):
        with patch.object(builder, "source_snapshot", return_value=self.snapshot), \
                patch.object(builder, "build_producer", side_effect=RuntimeError("synthetic build failure")):
            with self.assertRaisesRegex(RuntimeError, "synthetic build failure"):
                builder.install(self.sdk, self.output, self.bun, root=self.source)
        self.assertTrue((self.output / "build/composition").is_dir())
        self.assertFalse((self.output / r.MANIFEST).exists())
        with self.assertRaises(ValueError):
            r.InstalledRuntime.open(self.output)

    def test_source_drift_prevents_manifest_publication(self):
        changed = ("e" * 40, self.snapshot[1], self.snapshot[2])
        with patch.object(builder, "source_snapshot", side_effect=[self.snapshot, changed]), \
                patch.object(builder, "build_producer", side_effect=self.build):
            with self.assertRaisesRegex(ValueError, "source changed"):
                builder.install(self.sdk, self.output, self.bun, root=self.source)
        self.assertFalse((self.output / r.MANIFEST).exists())

    def test_invalid_selection_rejects_before_build_and_a_fresh_selection_works(self):
        with patch.object(builder, "build_producer", side_effect=AssertionError("build admitted")):
            with self.assertRaises(ValueError):
                builder.install(self.sdk, self.output, self.bun, node=self.bun, root=self.source)
            self.output.mkdir()
            with self.assertRaises(ValueError):
                builder.install(self.sdk, self.output, self.bun, root=self.source)
        self.output.rmdir()
        self.test_camera_free_install_uses_existing_composition_and_keeps_licenses()

    def test_source_snapshot_rejoins_git_blobs_and_rejects_dirty_or_changed_bytes(self):
        tree = b""
        for name, mode, blob in self.snapshot[2]:
            digest = hashlib.sha1(b"blob " + str(len(blob)).encode() + b"\0" + blob).hexdigest()
            tree += f"{mode} blob {digest}\t{name}".encode() + b"\0"
        def git(root, *args):
            if args[0] == "status":
                return b""
            if args[0] == "ls-tree":
                return tree
            return (self.snapshot[0] if args[1] == "HEAD" else self.snapshot[1]).encode()
        with patch.object(builder, "_git", side_effect=git):
            self.assertEqual(builder.source_snapshot(self.source), self.snapshot)
            path = self.source / "LICENSE-MIT"
            original = path.read_bytes()
            path.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "Git object"):
                builder.source_snapshot(self.source)
            path.write_bytes(original)
            self.assertEqual(builder.source_snapshot(self.source), self.snapshot)
        with patch.object(builder, "_git", return_value=b" M selected.py"):
            with self.assertRaisesRegex(ValueError, "clean"):
                builder.source_snapshot(self.source)


if __name__ == "__main__":
    unittest.main()

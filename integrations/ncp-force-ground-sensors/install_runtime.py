#!/usr/bin/env python3
"""Stage a clean CREBAIN source tree and build its local sensor producer offline.

Install the locked Bun dependencies and Rust toolchain before calling this command.
The selected node_modules, Bun, optional Node, and browser roots stay external and
must remain immutable while the installed runtime is used. No browser is launched.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys


APP = Path(__file__).resolve().parent
ROOT = APP.parents[1]
TOOLCHAIN = "1.91.1"


def _module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    # No bytecode or source import-path override enters the installed package.
    exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)
    return module


runtime = _module("crebain_runtime_install_contract", APP / "python/crebain_ncp_sensors/runtime.py")


def _git(root, *arguments):
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update(GIT_OPTIONAL_LOCKS="0", GIT_NO_REPLACE_OBJECTS="1", GIT_NO_LAZY_FETCH="1",
                       GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull, GIT_TERMINAL_PROMPT="0")
    return subprocess.check_output(["git", "-C", str(root), *arguments], env=environment, timeout=30)


def source_snapshot(root):
    """Rejoin every clean worktree leaf to its immutable Git blob before staging."""
    runtime.require(not _git(root, "status", "--porcelain=v1", "--untracked-files=normal").strip(),
                    "runtime installation requires a clean committed source checkout")
    commit = _git(root, "rev-parse", "HEAD").decode().strip()
    tree = _git(root, "rev-parse", "HEAD^{tree}").decode().strip()
    leaves = []
    for record in _git(root, "ls-tree", "-r", "-z", "--full-tree", "HEAD").split(b"\0"):
        if not record:
            continue
        attributes, encoded = record.split(b"\t", 1)
        mode, kind, object_id = attributes.decode().split()
        name = encoded.decode("utf-8")
        runtime._relative(name)
        runtime.require(kind == "blob" and mode in {"100644", "100755", "120000"},
                        "submodules and special source entries are not supported")
        runtime.require(name != "bunfig.toml" and "node_modules" not in Path(name).parts
                        and not any(part == ".git" for part in Path(name).parts),
                        "source conflicts with installed runtime layout")
        path = root / name
        if mode == "120000":
            runtime.require(path.is_symlink(), "source link changed")
            blob = os.readlink(path).encode()
            runtime.require(not Path(blob.decode()).is_absolute()
                            and path.resolve(strict=True).is_relative_to(root), "source link escapes tree")
        else:
            runtime.require(path.is_file() and not path.is_symlink()
                            and path.resolve(strict=True) == path, "source file path changed")
            blob = path.read_bytes()
            runtime.require(bool(path.stat().st_mode & stat.S_IXUSR) == (mode == "100755"),
                            "source executable mode changed")
        actual = hashlib.sha1(b"blob " + str(len(blob)).encode() + b"\0" + blob).hexdigest()
        runtime.require(actual == object_id, "source bytes differ from the Git object: " + name)
        leaves.append((name, mode, blob))
    runtime.require(leaves and len(leaves) <= runtime.MAX_ENTRIES, "bounded source tree required")
    runtime.require(sum(len(blob) for _, _, blob in leaves) <= runtime.MAX_TREE_BYTES, "source byte limit")
    return commit, tree, leaves


def stage_source(snapshot, project):
    project.mkdir(mode=0o700)
    for name, mode, blob in snapshot[2]:
        path = project / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if mode == "120000":
            path.symlink_to(blob.decode())
        else:
            path.write_bytes(blob)
            path.chmod(0o755 if mode == "100755" else 0o644)
    files = [row for row in runtime.inventory_tree(project) if row["kind"] != "directory"]
    return {"commit": snapshot[0], "tree": snapshot[1], "files": files}


def _selected_executable(path):
    runtime.require(path.is_absolute(), "select an absolute executable path")
    result = path.resolve(strict=True)
    runtime.require(result.is_file() and os.access(result, os.X_OK), "selected executable is unavailable")
    return runtime.file_record(result)


def build_producer(composition, build, *, family=False, _city=False):
    """Use an already-installed toolchain; Cargo cannot fetch dependencies."""
    rustup = shutil.which("rustup")
    runtime.require(rustup is not None, "Rustup and the declared installed toolchain are required")
    cargo = subprocess.check_output([rustup, "which", "--toolchain", TOOLCHAIN, "cargo"],
                                    text=True, timeout=30).strip()
    rustc = subprocess.check_output([rustup, "which", "--toolchain", TOOLCHAIN, "rustc"],
                                    text=True, timeout=30).strip()
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("CARGO_", "RUST", "CC", "CXX", "DYLD_", "LD_"))}
    environment.update(RUSTC=rustc, RUSTUP_TOOLCHAIN=TOOLCHAIN, CARGO_NET_OFFLINE="true")
    runtime.require(type(_city) is bool and not (family and _city), "one producer selector required")
    producer = runtime.InstalledCityRuntime._producer if _city else runtime.FAMILY_PRODUCER if family else runtime.PRODUCER
    command = [cargo, "build", "--locked", "--offline", "--release", "--bin", producer, "--manifest-path",
               str(composition / "application/Cargo.toml"), "--target-dir", str(build / "target")]
    (build / "command.json").write_text(json.dumps({"argv": command, "toolchain": TOOLCHAIN}, indent=2) + "\n")
    with (build / "cargo.log").open("xb") as log:
        subprocess.run(command, cwd=composition / "application", env=environment,
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=1800)
    return build / "target/release" / producer


def check_browser(project, node, browser):
    """Ask the installed Playwright API for its executable without launching it."""
    environment = {"PATH": "/usr/bin:/bin", "PLAYWRIGHT_BROWSERS_PATH": str(browser),
                   "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1", "DO_NOT_TRACK": "1",
                   "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
                   "NODE_OPTIONS": "--no-global-search-paths"}
    selected = subprocess.check_output(
        [str(node), "--input-type=module", "--eval",
         "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath());"],
        cwd=project, env=environment, timeout=30, text=True)
    executable = Path(selected).resolve(strict=True)
    runtime.require(executable.is_relative_to(browser) and executable.is_file()
                    and os.access(executable, os.X_OK), "selected Playwright browser is not installed")


def check_vendors(project, bun, log_path):
    """Join installed Rapier, Three, and Spark bytes to the existing source pins."""
    runtime.require((project / "bunfig.toml").read_bytes() == runtime.BUN_CONFIG,
                    "offline Bun configuration required before vendor preflight")
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "DO_NOT_TRACK": "1",
                   "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
                   "NODE_OPTIONS": "--no-global-search-paths"}
    command = [str(bun), "--no-install", "--eval",
               "import {verifyPinnedProductionVendorInstallation} from "
               "'./scripts/lib/production-vendor-boundary.mjs'; "
               "verifyPinnedProductionVendorInstallation(process.cwd());"]
    with log_path.open("xb") as log:
        subprocess.run(command, cwd=project, env=environment, stdout=log,
                       stderr=subprocess.STDOUT, check=True, timeout=60)


def check_package_resolution(project, executable, packages, *, engine):
    """Resolve package entries with the selected engine before importing the checker."""
    names = json.dumps(list(packages))
    common = "import {realpathSync} from 'node:fs'; "
    if engine == "bun":
        arguments = ["--no-install", "--eval"]
        expression = "realpathSync(Bun.resolveSync(name, process.cwd()))"
    else:
        runtime.require(engine == "node", "explicit package resolution engine required")
        arguments = ["--input-type=module", "--eval"]
        common += "import {fileURLToPath} from 'node:url'; "
        expression = "realpathSync(fileURLToPath(import.meta.resolve(name)))"
    script = (common + f"const names={names}; process.stdout.write(JSON.stringify("
              + "Object.fromEntries(names.map(name => [name, " + expression + "]))));")
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "DO_NOT_TRACK": "1",
                   "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
                   "NODE_OPTIONS": "--no-global-search-paths"}
    raw = subprocess.check_output([str(executable), *arguments, script], cwd=project,
                                  env=environment, timeout=30)
    result = json.loads(raw, object_pairs_hook=runtime._pairs)
    runtime._object(result, packages)
    for name, selected in packages.items():
        path = runtime._absolute(result[name])
        runtime.require(path.is_file() and path.is_relative_to(selected),
                        "package entry resolved outside its selected package: " + name)
    return result


def install(ncp_source, output, bun, *, node=None, browser_root=None, root=ROOT, family=False):
    runtime.require((node is None) == (browser_root is None), "select Node and browser root together")
    runtime.require(type(family) is bool and (not family or node is not None), "family installation requires selected Node and browser")
    selected_class = runtime.InstalledFamilyRuntime if family else runtime.InstalledRuntime
    return _install(ncp_source, output, bun, node=node, browser_root=browser_root, root=root,
                    selected_class=selected_class)


def _install(ncp_source, output, bun, *, node, browser_root, root, selected_class):
    """Shared byte-custody mechanism; only fixed source-owned selectors are accepted."""
    runtime.require(selected_class in (runtime.InstalledRuntime, runtime.InstalledFamilyRuntime,
                                      runtime.InstalledCityRuntime), "fixed runtime selector required")
    runtime.require((node is None) == (browser_root is None), "select Node and browser root together")
    runtime.require(not selected_class._requires_graphics or node is not None,
                    "this selector requires selected graphics")
    root = root.resolve(strict=True)
    ncp_source = ncp_source.resolve(strict=True)
    runtime.require(output.is_absolute() and not output.exists() and not output.is_symlink(),
                    "runtime output must be a new absolute path")
    output = output.parent.resolve(strict=True) / output.name
    runtime.require(not output.is_relative_to(root) and not output.is_relative_to(ncp_source),
                    "runtime output must be outside the source checkouts")
    snapshot = source_snapshot(root)
    modules = (root / "node_modules").resolve(strict=True)
    runtime.require(not output.is_relative_to(modules), "runtime output must be outside dependency root")
    selected_modules = {"path": str(modules), "entries": runtime.inventory_tree(modules)}
    selected_bun = _selected_executable(bun)
    selected_node = None if node is None else _selected_executable(node)
    selected_browser = None
    if browser_root is not None:
        runtime.require(browser_root.is_absolute(), "select an absolute browser root")
        browser_root = browser_root.resolve(strict=True)
        runtime.require(not output.is_relative_to(browser_root), "runtime output must be outside browser root")
        selected_browser = {"path": str(browser_root), "entries": runtime.inventory_tree(browser_root)}
    output.mkdir(mode=0o700)
    project = output / "project"
    source = stage_source(snapshot, project)
    (project / "bunfig.toml").write_bytes(runtime.BUN_CONFIG)
    (project / "node_modules").symlink_to(modules, target_is_directory=True)
    project_before = runtime.inventory_tree(project, external_links={"node_modules": modules})
    build = output / "build"
    build.mkdir(mode=0o700)
    packages = runtime.check_package_roots(project, modules, graphics=selected_node is not None)
    origins = check_package_resolution(project, Path(selected_bun["path"]),
                                       {name: packages[name] for name in runtime.BUN_PACKAGES}, engine="bun")
    if selected_node is not None:
        origins.update(check_package_resolution(project, Path(selected_node["path"]),
                       {name: packages[name] for name in runtime.NODE_PACKAGES}, engine="node"))
    (build / "package-origins.json").write_text(json.dumps(origins, indent=2, sort_keys=True) + "\n")
    check_vendors(project, Path(selected_bun["path"]), build / "vendor-preflight.log")
    if selected_node is not None:
        check_browser(project, Path(selected_node["path"]), browser_root)
    compose_path = Path(selected_class._dependency).parents[1] / "compose.py"
    compose = _module("crebain_selected_runtime_compose", project / compose_path)
    composition = build / "composition"
    receipt = compose.compose(ncp_source, composition)
    if selected_class is runtime.InstalledFamilyRuntime:
        built = build_producer(composition, build, family=True)
    elif selected_class is runtime.InstalledCityRuntime:
        built = build_producer(composition, build, _city=True)
    else:
        built = build_producer(composition, build)
    binary = output / "bin"
    binary.mkdir(mode=0o700)
    producer = binary / selected_class._producer
    shutil.copyfile(built, producer)
    producer.chmod(0o755)
    runtime.require(source_snapshot(root) == snapshot, "source changed during installation")
    compose.checked_dependency(ncp_source)
    runtime.require(runtime.inventory_tree(modules) == selected_modules["entries"],
                    "installed dependencies changed during installation")
    runtime.require(runtime.file_record(Path(selected_bun["path"])) == selected_bun,
                    "Bun changed during installation")
    if selected_node is not None:
        runtime.require(runtime.file_record(Path(selected_node["path"])) == selected_node,
                        "Node changed during installation")
        runtime.require(runtime.inventory_tree(browser_root) == selected_browser["entries"],
                        "browser root changed during installation")
    runtime.require(runtime.inventory_tree(project, external_links={"node_modules": modules}) == project_before,
                    "staged source changed during installation")
    value = {"schema": selected_class._schema, "source": source,
             "ncp": {"commit": receipt["dependency_commit"], "tree": receipt["dependency_tree"]},
             "platform": {"system": platform.system(), "machine": platform.machine()},
             "producer": runtime.file_record(producer, selected_class._producer), "project": project_before,
             "node_modules": selected_modules, "bun": selected_bun, "node": selected_node,
             "browser": selected_browser, "source_identity": runtime.source_identity(source)}
    with (output / runtime.MANIFEST).open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
    return selected_class.open(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ncp-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bun", type=Path, required=True)
    parser.add_argument("--node", type=Path)
    parser.add_argument("--browser-root", type=Path)
    parser.add_argument("--family", action="store_true", help="install the separate live checkpoint family runtime")
    args = parser.parse_args()
    if (args.node is None) != (args.browser_root is None):
        parser.error("--node and --browser-root must be supplied together")
    if args.family and args.node is None:
        parser.error("--family requires --node and --browser-root")
    selected = install(args.ncp_source, args.output, args.bun,
                       node=args.node, browser_root=args.browser_root, family=args.family)
    print(json.dumps({"prefix": str(selected.prefix), "manifest_sha256": selected.manifest_sha256,
                      "source_identity": selected.source_identity, "native_session_executed": False,
                      "installed_qualified": False}))


if __name__ == "__main__":
    main()

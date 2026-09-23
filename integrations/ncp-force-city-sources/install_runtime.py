#!/usr/bin/env python3
"""Install the separately selected city producer from clean committed source, without execution."""

import argparse
import importlib.util
import json
from pathlib import Path
import sys

APP = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "crebain_city_shared_installer",
    APP.parent / "ncp-force-ground-sensors/install_runtime.py",
)
shared = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = shared
exec(compile(SPEC.loader.get_data(SPEC.origin), SPEC.origin, "exec"), shared.__dict__)


def install(ncp_source, output, bun, *, node=None, browser_root=None, root=shared.ROOT):
    return shared._install(
        ncp_source,
        output,
        bun,
        node=node,
        browser_root=browser_root,
        root=root,
        selected_class=shared.runtime.InstalledCityRuntime,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ncp-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bun", type=Path, required=True)
    parser.add_argument("--node", type=Path)
    parser.add_argument("--browser-root", type=Path)
    args = parser.parse_args()
    selected = install(
        args.ncp_source,
        args.output,
        args.bun,
        node=args.node,
        browser_root=args.browser_root,
    )
    print(
        json.dumps(
            {
                "prefix": str(selected.prefix),
                "manifest_sha256": selected.manifest_sha256,
                "source_identity": selected.source_identity,
                "native_session_executed": False,
                "installed_qualified": False,
            }
        )
    )


if __name__ == "__main__":
    main()

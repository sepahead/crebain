"""Project exact owned contract bytes and licenses into the Python package."""

import argparse
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
ROOT = APP.parents[1]
CONTRACTS = (
    "application.descriptor.v1.json",
    "application.schema.v1.json",
    "standalone.composition.v1.json",
    "rgba8.semantic.v1.json",
    "radiance.semantic.v1.json",
    "pressure.semantic.v1.json",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args()
    package = APP / "python/crebain_ncp_sensors/contracts"
    sources = {package / name: APP / "contracts" / name for name in CONTRACTS}
    sources.update({APP / "python" / name: ROOT / name for name in ("LICENSE-MIT", "LICENSE-APACHE")})
    snapshots = {target: source.read_bytes() for target, source in sources.items()}
    for target, raw in snapshots.items():
        if not 0 < len(raw) <= 65_536:
            raise ValueError("packaged resource exceeds its declared bound")
        if args.write:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        elif not target.is_file() or target.is_symlink() or target.read_bytes() != raw:
            raise ValueError(f"packaged resource differs: {target.relative_to(APP)}")
    if set(path.name for path in package.iterdir()) != set(CONTRACTS):
        raise ValueError("packaged contract roster differs")
    print("Python package resources: six exact contracts and two exact licenses")


if __name__ == "__main__":
    main()

"""Project exact city resources into the existing optional Python distribution."""

import hashlib
from pathlib import Path
import sys

from ncp_local import modular_wire as w

APP = Path(__file__).resolve().parent.parent
CLIENT = APP.parent / "ncp-force-ground-sensors/python/crebain_ncp_sensors/city"
NAMES = (
    "application.schema.v1.json",
    "application.descriptor.v1.json",
    "standalone.composition.v1.json",
    "rgba8.semantic.v1.json",
    "radiance.semantic.v1.json",
    "pressure.semantic.v1.json",
)
if sys.argv[1:] not in ([], ["--check"]):
    raise SystemExit("only --check is supported")
resources = {name: (APP / "contracts" / name).read_bytes() for name in NAMES}
descriptor = w.parse(resources["application.descriptor.v1.json"])
if (
    descriptor["types_schema_sha256"]
    != hashlib.sha256(resources["application.schema.v1.json"]).hexdigest()
):
    raise SystemExit("application descriptor no longer binds the city schema")
application = w.typed_digest(w.PROFILE_DOMAIN, descriptor)
composition = w.parse(resources["standalone.composition.v1.json"])
if composition["producer_application_digest"] != application:
    raise SystemExit("composition no longer binds the city application")
identities = {
    "APPLICATION_DIGEST": application,
    "COMPOSITION_DIGEST": w.typed_digest(w.PROFILE_DOMAIN, composition),
    "SENSOR_DIGESTS": {
        kind: w.typed_digest(
            w.PROFILE_DOMAIN, w.parse(resources[kind + ".semantic.v1.json"])
        )
        for kind in ("rgba8", "radiance", "pressure")
    },
}
outputs = {CLIENT / "contracts" / name: payload for name, payload in resources.items()}
outputs[CLIENT / "identities.py"] = (
    '"""Generated installed resource identities; no runtime selection authority."""\n'
    + "\n".join(name + " = " + repr(value) for name, value in identities.items())
    + "\n"
).encode()
for path, payload in outputs.items():
    if sys.argv[1:]:
        if path.read_bytes() != payload:
            raise SystemExit("city installed projection changed: " + str(path))
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)

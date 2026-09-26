"""Optional typed shared-world city application; importing launches no runtime."""

from .client import (
    CitySession,
    Observation,
    PendingBatch,
    Reading,
    SessionResult,
    SourceFailure,
)
from .codec import decode, resource_digest
from .contract import CityContract
from .owned import (
    OwnedCitySession,
    RetirementReceipt,
    city_session,
    failure_retirement,
    new_binding,
)
from .runtime import InstalledCityRuntime
from .composition import budgeted_city_session
from .resources import (
    CompositionResources,
    ResourceAdmission,
    ResourceBudget,
    admit_composition,
    composition_resources,
)

__all__ = [
    "CityContract",
    "CitySession",
    "CompositionResources",
    "InstalledCityRuntime",
    "Observation",
    "OwnedCitySession",
    "PendingBatch",
    "Reading",
    "RetirementReceipt",
    "ResourceAdmission",
    "ResourceBudget",
    "SessionResult",
    "SourceFailure",
    "city_session",
    "budgeted_city_session",
    "admit_composition",
    "composition_resources",
    "decode",
    "failure_retirement",
    "new_binding",
    "resource_digest",
]

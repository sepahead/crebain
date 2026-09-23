//! Fixed schema validation and type-separated application commitments.

use std::sync::OnceLock;

use ncp_local::modular_wire::{self as wire, ModularError};
use serde::Serialize;
use serde_json::{json, Value};

/// Exact installed application descriptor.
pub const DESCRIPTOR: &[u8] = include_bytes!("../../contracts/application.descriptor.v1.json");
/// Exact closed application schema.
pub const SCHEMA: &[u8] = include_bytes!("../../contracts/application.schema.v1.json");
/// Exact standalone composition descriptor.
pub const COMPOSITION: &[u8] = include_bytes!("../../contracts/standalone.composition.v1.json");
const SEMANTICS: [&[u8]; 3] = [
    include_bytes!("../../contracts/rgba8.semantic.v1.json"),
    include_bytes!("../../contracts/radiance.semantic.v1.json"),
    include_bytes!("../../contracts/pressure.semantic.v1.json"),
];
static DEFINITIONS: OnceLock<Result<Value, ModularError>> = OnceLock::new();

/// Application commitment kind; these are not new generic digest domains.
#[derive(Clone, Copy)]
pub enum Commitment {
    /// Resolved preparation, including host run and source mapping.
    Plan,
    /// Complete prepared sensor catalog.
    Catalog,
    /// Ordered shared-world entity roster.
    Roster,
    /// Derived application/native reservation plan.
    Resources,
    /// Complete typed sensor manifest.
    Manifest,
    /// Complete sensor batch.
    Batch,
}

/// Commit a closed application value using a fixed discriminator in the existing domain.
pub fn commit<T: Serialize>(kind: Commitment, input: &T) -> Result<String, ModularError> {
    let (schema, omitted) = match kind {
        Commitment::Roster => ("crebain.force-city-roster-commitment.v1", None),
        Commitment::Resources => ("crebain.force-city-resources-commitment.v1", None),
        Commitment::Plan => ("crebain.force-city-plan-commitment.v1", None),
        Commitment::Catalog => (
            "crebain.force-city-catalog-commitment.v1",
            Some("catalog_digest"),
        ),
        Commitment::Manifest => (
            "crebain.force-city-manifest-commitment.v1",
            Some("manifest_digest"),
        ),
        Commitment::Batch => (
            "crebain.force-city-batch-commitment.v1",
            Some("batch_digest"),
        ),
    };
    let mut value = serde_json::to_value(input).map_err(|_| ModularError::Wire)?;
    if let Some(field) = omitted {
        value
            .as_object_mut()
            .ok_or(ModularError::Wire)?
            .remove(field);
    }
    wire::typed_digest(
        wire::PROFILE_DOMAIN,
        &json!({"schema":schema,"value":value}),
        None,
    )
}

/// Digest one of the three installed modality descriptors.
pub fn semantic(kind: &str) -> Result<String, ModularError> {
    let index = match kind {
        "rgba8" => 0,
        "radiance" => 1,
        "pressure" => 2,
        _ => return Err(ModularError::Wire),
    };
    wire::typed_digest(
        wire::PROFILE_DOMAIN,
        &wire::parse_value(SEMANTICS[index])?,
        None,
    )
}

/// Return the exact standalone composition identity.
pub fn composition_digest() -> Result<String, ModularError> {
    wire::typed_digest(wire::PROFILE_DOMAIN, &wire::parse_value(COMPOSITION)?, None)
}

/// Validate one fixed named DTO against its installed closed schema.
pub fn validate<T: Serialize>(name: &str, value: &T) -> Result<(), ModularError> {
    let definitions =
        DEFINITIONS.get_or_init(|| serde_json::from_slice(SCHEMA).map_err(|_| ModularError::Wire));
    let definitions = definitions.as_ref().map_err(|error| *error)?;
    validate_definitions(name, value, definitions)
}

pub(crate) fn validate_definitions<T: Serialize>(
    name: &str,
    value: &T,
    definitions: &Value,
) -> Result<(), ModularError> {
    let schema = definitions
        .get("$defs")
        .and_then(|defs| defs.get(name))
        .ok_or(ModularError::Wire)?;
    let value = serde_json::to_value(value).map_err(|_| ModularError::Wire)?;
    if matches(schema, &value, &definitions["$defs"], 0) {
        Ok(())
    } else {
        Err(ModularError::Wire)
    }
}

fn matches(schema: &Value, value: &Value, definitions: &Value, depth: usize) -> bool {
    if depth > 24 || schema == &Value::Bool(false) {
        return false;
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        return reference
            .strip_prefix("#/$defs/")
            .and_then(|name| definitions.get(name))
            .is_some_and(|schema| matches(schema, value, definitions, depth + 1));
    }
    if let Some(expected) = schema.get("const") {
        return value == expected;
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return values.contains(value);
    }
    if let Some(arms) = schema.get("oneOf").and_then(Value::as_array) {
        return arms
            .iter()
            .filter(|arm| matches(arm, value, definitions, depth + 1))
            .count()
            == 1;
    }
    if let Some(arms) = schema.get("anyOf").and_then(Value::as_array) {
        return arms
            .iter()
            .any(|arm| matches(arm, value, definitions, depth + 1));
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("null") => value.is_null(),
        Some("boolean") => value.is_boolean(),
        Some("integer") => value.as_u64().is_some_and(|n| {
            n >= schema["minimum"].as_u64().unwrap_or(0)
                && n <= schema["maximum"].as_u64().unwrap_or(u64::MAX)
        }),
        Some("number") => value.as_f64().is_some_and(|n| {
            n.is_finite()
                && n >= schema["minimum"].as_f64().unwrap_or(f64::NEG_INFINITY)
                && n <= schema["maximum"].as_f64().unwrap_or(f64::INFINITY)
        }),
        Some("string") => value.as_str().is_some_and(|s| {
            if !s.is_ascii()
                || schema
                    .get("maxLength")
                    .and_then(Value::as_u64)
                    .is_some_and(|n| s.len() as u64 > n)
            {
                return false;
            }
            match schema.get("pattern").and_then(Value::as_str) {
                None => true,
                Some("^[0-9a-f]{64}$") => wire::valid_digest(s),
                Some("^[a-z][a-z0-9_-]{0,63}$") => valid_id(s),
                Some("^(rgb|thermal|pressure):[a-z][a-z0-9_-]{0,63}$") => {
                    s.split_once(':').is_some_and(|(prefix, id)| {
                        matches!(prefix, "rgb" | "thermal" | "pressure") && valid_id(id)
                    })
                }
                Some("^(rgb|thermal):[a-z][a-z0-9_-]{0,63}$") => {
                    s.split_once(':').is_some_and(|(prefix, id)| {
                        matches!(prefix, "rgb" | "thermal") && valid_id(id)
                    })
                }
                Some("^pressure:[a-z][a-z0-9_-]{0,63}$") => {
                    s.strip_prefix("pressure:").is_some_and(valid_id)
                }
                Some(
                    "^ncp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                ) => s.strip_prefix("ncp-").is_some_and(valid_uuid),
                Some("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$") => {
                    valid_uuid(s)
                }
                Some(_) => false,
            }
        }),
        Some("array") => value.as_array().is_some_and(|items| {
            if (items.len() as u64) < schema["minItems"].as_u64().unwrap_or(0)
                || items.len() as u64 > schema["maxItems"].as_u64().unwrap_or(0)
            {
                return false;
            }
            if let Some(prefix) = schema.get("prefixItems").and_then(Value::as_array) {
                return items.len() == prefix.len()
                    && items
                        .iter()
                        .zip(prefix)
                        .all(|(item, schema)| matches(schema, item, definitions, depth + 1));
            }
            items
                .iter()
                .all(|item| matches(&schema["items"], item, definitions, depth + 1))
        }),
        Some("object") => value.as_object().is_some_and(|items| {
            schema
                .get("properties")
                .and_then(Value::as_object)
                .is_some_and(|fields| {
                    items.keys().all(|name| fields.contains_key(name))
                        && schema
                            .get("required")
                            .and_then(Value::as_array)
                            .is_some_and(|required| {
                                required.iter().all(|name| {
                                    name.as_str().is_some_and(|name| items.contains_key(name))
                                })
                            })
                        && items.iter().all(|(name, value)| {
                            fields
                                .get(name)
                                .is_some_and(|field| matches(field, value, definitions, depth + 1))
                        })
                })
        }),
        _ => false,
    }
}

/// Match the bounded source identifier vocabulary.
pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// Match a canonical fresh version-four UUID.
pub fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes()[14] == b'4'
        && matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
        && value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

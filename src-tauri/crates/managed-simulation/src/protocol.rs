use std::collections::HashSet;
use std::io::{Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

use rand::RngExt;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::canonical::{
    canonical_json, sha256_bytes, strict_json, to_value, validate_number, MAX_SAFE_JSON_INTEGER,
};
use crate::contract::{
    finite_bounded, finite_positive_bounded, FinishRequest, FinishResponse, Outcome,
    PrepareRequest, RuntimeConfiguration, SimulationFrameResponse, StepRequest, AUTHORITY,
    CONFIGURATION_SCHEMA_BYTES, CONFIGURATION_SCHEMA_ID, FINISH_OPERATION_ID,
    FINISH_REQUEST_SCHEMA_BYTES, FINISH_REQUEST_SCHEMA_ID, FINISH_RESPONSE_SCHEMA_BYTES,
    FINISH_RESPONSE_SCHEMA_ID, IPC_PROTOCOL, IPC_SCHEMA_BYTES, LAUNCH_ABI, MAX_ACCELERATION_MPS2,
    MAX_DRONES, MAX_FRAME_BYTES, MAX_GENERATION_CPU_TIME_MS, MAX_OPERATIONS_PER_GENERATION,
    MAX_POSITION_ABS_M, MAX_SENSOR_OFFSET_ABS_M, MAX_SENSOR_VARIANCE_M2, MAX_SPEED_MPS, MAX_TICKS,
    MAX_TICK_MS, PREPARE_OPERATION_ID, PREPARE_REQUEST_SCHEMA_BYTES, PREPARE_REQUEST_SCHEMA_ID,
    PREPARE_RESPONSE_SCHEMA_BYTES, PREPARE_RESPONSE_SCHEMA_ID, PROFILE,
    STANDARD_FINISH_OPERATION_ID, STANDARD_FINISH_REQUEST_SCHEMA_BYTES,
    STANDARD_FINISH_REQUEST_SCHEMA_ID, STANDARD_FINISH_RESPONSE_SCHEMA_BYTES,
    STANDARD_FINISH_RESPONSE_SCHEMA_ID, STANDARD_PREPARE_OPERATION_ID,
    STANDARD_PREPARE_REQUEST_SCHEMA_BYTES, STANDARD_PREPARE_REQUEST_SCHEMA_ID,
    STANDARD_PREPARE_RESPONSE_SCHEMA_BYTES, STANDARD_PREPARE_RESPONSE_SCHEMA_ID,
    STANDARD_STEP_OPERATION_ID, STANDARD_STEP_REQUEST_SCHEMA_BYTES,
    STANDARD_STEP_REQUEST_SCHEMA_ID, STANDARD_STEP_RESPONSE_SCHEMA_BYTES,
    STANDARD_STEP_RESPONSE_SCHEMA_ID, STEP_OPERATION_ID, STEP_REQUEST_SCHEMA_BYTES,
    STEP_REQUEST_SCHEMA_ID, STEP_RESPONSE_SCHEMA_BYTES, STEP_RESPONSE_SCHEMA_ID,
};
use crate::simulation::{request_digest, SimulationRuntime};
use crate::standard::{
    standard_step_id, StandardFaultDisposition, StandardFinishRequest, StandardFinishResponse,
    StandardPrepareRequest, StandardPrepareResponse, StandardSimulationRuntime,
    StandardStepRequest, StandardStepResponse,
};

const ABSOLUTE_MAX_FRAME_BYTES: usize = 1_048_576;
const HANDSHAKE_MIN_FRAME_BYTES: u64 = 1_024;
const OPERATION_TIMEOUT_MS: u64 = 5_000;
const FINISH_CPU_TIME_MS: u64 = 100;
const PREPARE_CPU_TIME_MS: u64 = 5_000;
const STEP_CPU_TIME_MS: u64 = 500;
const FINISH_REQUEST_BYTES: usize = 4_096;
const FINISH_RESPONSE_BYTES: usize = 8_192;
const PREPARE_REQUEST_BYTES: usize = 16_384;
const PREPARE_RESPONSE_BYTES: usize = 32_768;
const STEP_REQUEST_BYTES: usize = 16_384;
const STEP_RESPONSE_BYTES: usize = 32_768;
const STANDARD_FAULT_CODE_MAX_UTF8_BYTES: usize = 128;

const ENVELOPE_FIELDS: &[&str] = &[
    "body",
    "generation",
    "kind",
    "message_id",
    "protocol",
    "schema_version",
    "sender",
    "sequence",
];
const GENERATION_FIELDS: &[&str] = &["generation_id", "installation_id", "ordinal"];
const HANDSHAKE_BODY_FIELDS: &[&str] =
    &["challenge", "configuration", "identity", "max_frame_bytes"];
const IDENTITY_FIELDS: &[&str] = &[
    "configuration_canonical_sha256",
    "configuration_exact_sha256",
    "executable_sha256",
    "installation_id",
    "launch_abi",
    "manifest_canonical_sha256",
    "manifest_exact_sha256",
    "operation_roster_sha256",
    "package_lock_canonical_sha256",
    "package_lock_exact_sha256",
    "package_sha256",
    "profile",
    "schema_registry_sha256",
    "target_id",
];
const IDENTITY_DIGEST_FIELDS: &[&str] = &[
    "configuration_canonical_sha256",
    "configuration_exact_sha256",
    "executable_sha256",
    "manifest_canonical_sha256",
    "manifest_exact_sha256",
    "operation_roster_sha256",
    "package_lock_canonical_sha256",
    "package_lock_exact_sha256",
    "package_sha256",
    "schema_registry_sha256",
];
const CONFIGURATION_FIELDS: &[&str] = &["canonical_sha256", "document", "schema"];
const SCHEMA_REFERENCE_FIELDS: &[&str] = &["schema_id", "schema_sha256"];
const REQUEST_BODY_FIELDS: &[&str] = &[
    "bulk",
    "compute_grant",
    "control",
    "idempotency_key",
    "operation",
    "request_schema",
    "response_schema",
    "timeout_ms",
];
const OPERATION_IDENTITY_FIELDS: &[&str] = &["artifact_access", "class", "effect", "operation_id"];
const GRANT_FIELDS: &[&str] = &[
    "generation_id",
    "grant_id",
    "issued_for_sequence",
    "max_cpu_time_ms",
    "mode",
    "operation_id",
    "reusable",
    "valid_for_ms",
];

#[derive(Debug, Error)]
#[error("managed-runtime protocol rejected the generation: {reason}")]
pub struct ProtocolError {
    reason: &'static str,
}

impl ProtocolError {
    fn new(reason: &'static str) -> Self {
        Self { reason }
    }

    /// Return the bounded machine-readable failure reason.
    pub fn reason(&self) -> &'static str {
        self.reason
    }
}

type ProtocolResult<T> = Result<T, ProtocolError>;

/// Child-local summary of one inherited-pipe process generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeSessionReceipt {
    pub installation_id: String,
    pub generation_id: String,
    pub ordinal: u64,
    pub request_count: u64,
    pub response_count: u64,
    pub clean_eof: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SchemaReference {
    schema_id: &'static str,
    schema_sha256: String,
}

impl SchemaReference {
    fn new(schema_id: &'static str, bytes: &'static [u8]) -> Self {
        Self {
            schema_id,
            schema_sha256: sha256_bytes(bytes),
        }
    }

    fn value(&self) -> Value {
        json!({
            "schema_id": self.schema_id,
            "schema_sha256": self.schema_sha256,
        })
    }

    fn matches(&self, value: &Value) -> bool {
        exact_object(value, SCHEMA_REFERENCE_FIELDS).is_ok_and(|source| {
            string_field(source, "schema_id") == Some(self.schema_id)
                && string_field(source, "schema_sha256") == Some(self.schema_sha256.as_str())
        })
    }
}

#[derive(Debug, Clone)]
struct OperationContract {
    operation_id: &'static str,
    request_schema: SchemaReference,
    response_schema: SchemaReference,
    max_cpu_time_ms: u64,
    max_request_bytes: usize,
    max_response_bytes: usize,
}

impl OperationContract {
    fn identity(&self) -> Value {
        json!({
            "operation_id": self.operation_id,
            "class": "simulation",
            "effect": "none",
            "artifact_access": {"read": "none", "write": "none"},
        })
    }

    fn manifest_row(&self) -> Value {
        json!({
            "operation_id": self.operation_id,
            "class": "simulation",
            "effect": "none",
            "artifact_access": {"read": "none", "write": "none"},
            "request_schema": self.request_schema.value(),
            "response_schema": self.response_schema.value(),
            "compute_grant": "host-one-shot",
            "timeout_ms": OPERATION_TIMEOUT_MS,
            "max_cpu_time_ms": self.max_cpu_time_ms,
            "max_request_bytes": self.max_request_bytes,
            "max_response_bytes": self.max_response_bytes,
        })
    }
}

#[derive(Debug)]
struct HandshakeState {
    generation: Value,
    identity: Value,
    configuration: RuntimeConfiguration,
    configuration_canonical_sha256: String,
    max_frame_bytes: usize,
}

fn operations() -> [OperationContract; 6] {
    [
        OperationContract {
            operation_id: FINISH_OPERATION_ID,
            request_schema: SchemaReference::new(
                FINISH_REQUEST_SCHEMA_ID,
                FINISH_REQUEST_SCHEMA_BYTES,
            ),
            response_schema: SchemaReference::new(
                FINISH_RESPONSE_SCHEMA_ID,
                FINISH_RESPONSE_SCHEMA_BYTES,
            ),
            max_cpu_time_ms: FINISH_CPU_TIME_MS,
            max_request_bytes: FINISH_REQUEST_BYTES,
            max_response_bytes: FINISH_RESPONSE_BYTES,
        },
        OperationContract {
            operation_id: STANDARD_FINISH_OPERATION_ID,
            request_schema: SchemaReference::new(
                STANDARD_FINISH_REQUEST_SCHEMA_ID,
                STANDARD_FINISH_REQUEST_SCHEMA_BYTES,
            ),
            response_schema: SchemaReference::new(
                STANDARD_FINISH_RESPONSE_SCHEMA_ID,
                STANDARD_FINISH_RESPONSE_SCHEMA_BYTES,
            ),
            max_cpu_time_ms: FINISH_CPU_TIME_MS,
            max_request_bytes: FINISH_REQUEST_BYTES,
            max_response_bytes: FINISH_RESPONSE_BYTES,
        },
        OperationContract {
            operation_id: PREPARE_OPERATION_ID,
            request_schema: SchemaReference::new(
                PREPARE_REQUEST_SCHEMA_ID,
                PREPARE_REQUEST_SCHEMA_BYTES,
            ),
            response_schema: SchemaReference::new(
                PREPARE_RESPONSE_SCHEMA_ID,
                PREPARE_RESPONSE_SCHEMA_BYTES,
            ),
            max_cpu_time_ms: PREPARE_CPU_TIME_MS,
            max_request_bytes: PREPARE_REQUEST_BYTES,
            max_response_bytes: PREPARE_RESPONSE_BYTES,
        },
        OperationContract {
            operation_id: STANDARD_PREPARE_OPERATION_ID,
            request_schema: SchemaReference::new(
                STANDARD_PREPARE_REQUEST_SCHEMA_ID,
                STANDARD_PREPARE_REQUEST_SCHEMA_BYTES,
            ),
            response_schema: SchemaReference::new(
                STANDARD_PREPARE_RESPONSE_SCHEMA_ID,
                STANDARD_PREPARE_RESPONSE_SCHEMA_BYTES,
            ),
            max_cpu_time_ms: PREPARE_CPU_TIME_MS,
            max_request_bytes: PREPARE_REQUEST_BYTES,
            max_response_bytes: PREPARE_RESPONSE_BYTES,
        },
        OperationContract {
            operation_id: STEP_OPERATION_ID,
            request_schema: SchemaReference::new(STEP_REQUEST_SCHEMA_ID, STEP_REQUEST_SCHEMA_BYTES),
            response_schema: SchemaReference::new(
                STEP_RESPONSE_SCHEMA_ID,
                STEP_RESPONSE_SCHEMA_BYTES,
            ),
            max_cpu_time_ms: STEP_CPU_TIME_MS,
            max_request_bytes: STEP_REQUEST_BYTES,
            max_response_bytes: STEP_RESPONSE_BYTES,
        },
        OperationContract {
            operation_id: STANDARD_STEP_OPERATION_ID,
            request_schema: SchemaReference::new(
                STANDARD_STEP_REQUEST_SCHEMA_ID,
                STANDARD_STEP_REQUEST_SCHEMA_BYTES,
            ),
            response_schema: SchemaReference::new(
                STANDARD_STEP_RESPONSE_SCHEMA_ID,
                STANDARD_STEP_RESPONSE_SCHEMA_BYTES,
            ),
            max_cpu_time_ms: STEP_CPU_TIME_MS,
            max_request_bytes: STEP_REQUEST_BYTES,
            max_response_bytes: STEP_RESPONSE_BYTES,
        },
    ]
}

/// Return the exact Engram operation-roster digest compiled into this runtime.
pub fn operation_roster_sha256() -> Result<String, ProtocolError> {
    let value = Value::Array(
        operations()
            .iter()
            .map(OperationContract::manifest_row)
            .collect(),
    );
    let bytes = canonical_json(&value).map_err(|_| protocol_error("runtime.operation-roster"))?;
    let mut digest = Sha256::new();
    digest.update(b"engram-managed-operation-roster-v1\0");
    digest.update(bytes);
    Ok(hex_lower(&digest.finalize()))
}

/// Return the exact generic Engram IPC schema digest compiled into this runtime.
pub fn ipc_schema_sha256() -> String {
    sha256_bytes(IPC_SCHEMA_BYTES)
}

fn protocol_error(reason: &'static str) -> ProtocolError {
    ProtocolError::new(reason)
}

fn exact_object<'a>(value: &'a Value, fields: &[&str]) -> ProtocolResult<&'a Map<String, Value>> {
    let source = value
        .as_object()
        .ok_or_else(|| protocol_error("protocol.shape"))?;
    if source.len() != fields.len() || !fields.iter().all(|field| source.contains_key(*field)) {
        return Err(protocol_error("protocol.shape"));
    }
    Ok(source)
}

fn string_field<'a>(source: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    source.get(field).and_then(Value::as_str)
}

fn u64_field(source: &Map<String, Value>, field: &str) -> Option<u64> {
    source.get(field).and_then(Value::as_u64)
}

fn bool_field(source: &Map<String, Value>, field: &str) -> Option<bool> {
    source.get(field).and_then(Value::as_bool)
}

fn valid_component(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let bytes = value.as_bytes();
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    let mut separator_seen = false;
    let mut prior_separator = false;
    for byte in bytes {
        let separator = matches!(byte, b'.' | b'_' | b'-');
        if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || separator)
            || (separator && prior_separator)
        {
            return false;
        }
        separator_seen |= separator;
        prior_separator = separator;
    }
    separator_seen && !prior_separator
}

fn valid_control_key(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    value.len() <= 64
        && first.is_ascii_alphabetic()
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn valid_control(value: &Value) -> bool {
    let Some(source) = value.as_object() else {
        return false;
    };
    source.len() <= 32
        && source
            .iter()
            .all(|(key, child)| valid_control_key(key) && valid_control_value(child))
}

fn valid_control_value(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.len() <= 64 && values.iter().all(valid_control_scalar),
        scalar => valid_control_scalar(scalar),
    }
}

fn valid_control_scalar(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) => true,
        Value::Number(number) => validate_number(number).is_ok(),
        Value::String(value) => value.len() <= 1_024,
        Value::Array(_) | Value::Object(_) => false,
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_prefixed_hex(value: &str, prefix: &str, hex_length: usize) -> bool {
    value.len() == prefix.len() + hex_length
        && value.starts_with(prefix)
        && value[prefix.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn random_prefixed_hex(prefix: &str, byte_length: usize) -> String {
    let mut bytes = vec![0_u8; byte_length];
    rand::rng().fill(bytes.as_mut_slice());
    format!("{prefix}{}", hex_lower(&bytes))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn read_exact_or_reason<R: Read>(
    input: &mut R,
    buffer: &mut [u8],
    eof_reason: &'static str,
) -> ProtocolResult<()> {
    let mut offset = 0;
    while offset < buffer.len() {
        let count = input
            .read(&mut buffer[offset..])
            .map_err(|_| protocol_error("frame.input-read"))?;
        if count == 0 {
            return Err(protocol_error(eof_reason));
        }
        offset += count;
    }
    Ok(())
}

fn read_frame<R: Read>(
    input: &mut R,
    max_payload_bytes: usize,
    allow_clean_eof: bool,
) -> ProtocolResult<Option<(Value, usize)>> {
    if !(1..=ABSOLUTE_MAX_FRAME_BYTES).contains(&max_payload_bytes) {
        return Err(protocol_error("frame.bound"));
    }
    let mut prefix = [0_u8; 4];
    let first = input
        .read(&mut prefix[..1])
        .map_err(|_| protocol_error("frame.input-read"))?;
    if first == 0 {
        return if allow_clean_eof {
            Ok(None)
        } else {
            Err(protocol_error("frame.eof"))
        };
    }
    read_exact_or_reason(input, &mut prefix[1..], "frame.truncated-prefix")?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > max_payload_bytes {
        return Err(protocol_error("frame.length"));
    }
    let mut payload = vec![0_u8; length];
    read_exact_or_reason(input, &mut payload, "frame.truncated")?;
    let value = strict_json(&payload).map_err(|_| protocol_error("json.malformed"))?;
    if !value.is_object() {
        return Err(protocol_error("frame.object"));
    }
    Ok(Some((value, length)))
}

fn write_frame<W: Write>(
    output: &mut W,
    value: &Value,
    max_payload_bytes: usize,
) -> ProtocolResult<usize> {
    let payload = canonical_json(value).map_err(|_| protocol_error("json.canonicalization"))?;
    if payload.is_empty() || payload.len() > max_payload_bytes || payload.len() > u32::MAX as usize
    {
        return Err(protocol_error("frame.output-bound"));
    }
    output
        .write_all(&(payload.len() as u32).to_be_bytes())
        .map_err(|_| protocol_error("frame.output-write"))?;
    output
        .write_all(&payload)
        .map_err(|_| protocol_error("frame.output-write"))?;
    output
        .flush()
        .map_err(|_| protocol_error("frame.output-write"))?;
    Ok(payload.len())
}

fn deserialize_control<T: DeserializeOwned>(value: &Value) -> ProtocolResult<T> {
    if !valid_control(value) {
        return Err(protocol_error("protocol.control"));
    }
    serde_json::from_value(value.clone()).map_err(|_| protocol_error("runtime.request-schema"))
}

fn response_value<T: Serialize>(response: &T) -> ProtocolResult<Value> {
    let value = to_value(response).map_err(|_| protocol_error("runtime.response-schema"))?;
    if !valid_control(&value) {
        return Err(protocol_error("runtime.response-schema"));
    }
    Ok(value)
}

fn accept_generation(value: &Value) -> ProtocolResult<()> {
    let source = exact_object(value, GENERATION_FIELDS)?;
    if !string_field(source, "installation_id")
        .is_some_and(|value| valid_prefixed_hex(value, "inst_", 64))
        || !string_field(source, "generation_id")
            .is_some_and(|value| valid_prefixed_hex(value, "gen_", 64))
        || !u64_field(source, "ordinal")
            .is_some_and(|value| (1..=MAX_SAFE_JSON_INTEGER).contains(&value))
    {
        return Err(protocol_error("protocol.generation"));
    }
    Ok(())
}

fn accept_identity(value: &Value) -> ProtocolResult<()> {
    let source = exact_object(value, IDENTITY_FIELDS)?;
    if IDENTITY_DIGEST_FIELDS
        .iter()
        .any(|field| !string_field(source, field).is_some_and(valid_sha256))
    {
        return Err(protocol_error("protocol.digest"));
    }
    if !string_field(source, "target_id").is_some_and(valid_component)
        || string_field(source, "profile") != Some(PROFILE)
        || string_field(source, "launch_abi") != Some(LAUNCH_ABI)
        || string_field(source, "operation_roster_sha256")
            != Some(operation_roster_sha256()?.as_str())
        || !string_field(source, "installation_id")
            .is_some_and(|value| valid_prefixed_hex(value, "inst_", 64))
    {
        return Err(protocol_error("protocol.identity"));
    }
    Ok(())
}

fn accept_handshake(value: &Value) -> ProtocolResult<HandshakeState> {
    let source = exact_object(value, ENVELOPE_FIELDS)?;
    if string_field(source, "schema_version") != Some("1.0")
        || string_field(source, "protocol") != Some(IPC_PROTOCOL)
        || string_field(source, "kind") != Some("host.handshake")
        || string_field(source, "sender") != Some("host")
        || u64_field(source, "sequence") != Some(0)
        || !string_field(source, "message_id")
            .is_some_and(|value| valid_prefixed_hex(value, "msg_", 32))
    {
        return Err(protocol_error("protocol.handshake-envelope"));
    }
    let generation = source
        .get("generation")
        .ok_or_else(|| protocol_error("protocol.shape"))?;
    accept_generation(generation)?;
    let body = exact_object(
        source
            .get("body")
            .ok_or_else(|| protocol_error("protocol.shape"))?,
        HANDSHAKE_BODY_FIELDS,
    )?;
    if !string_field(body, "challenge").is_some_and(|value| valid_prefixed_hex(value, "chal_", 64))
    {
        return Err(protocol_error("protocol.identifier"));
    }
    let identity = body
        .get("identity")
        .ok_or_else(|| protocol_error("protocol.shape"))?;
    accept_identity(identity)?;
    let generation_source = generation
        .as_object()
        .ok_or_else(|| protocol_error("protocol.shape"))?;
    let identity_source = identity
        .as_object()
        .ok_or_else(|| protocol_error("protocol.shape"))?;
    if string_field(generation_source, "installation_id")
        != string_field(identity_source, "installation_id")
    {
        return Err(protocol_error("protocol.installation-join"));
    }
    let configuration = exact_object(
        body.get("configuration")
            .ok_or_else(|| protocol_error("protocol.shape"))?,
        CONFIGURATION_FIELDS,
    )?;
    let schema = SchemaReference::new(CONFIGURATION_SCHEMA_ID, CONFIGURATION_SCHEMA_BYTES);
    if !configuration
        .get("schema")
        .is_some_and(|value| schema.matches(value))
    {
        return Err(protocol_error("protocol.configuration-schema"));
    }
    let document = configuration
        .get("document")
        .ok_or_else(|| protocol_error("protocol.shape"))?;
    let canonical_document =
        canonical_json(document).map_err(|_| protocol_error("protocol.configuration-payload"))?;
    let canonical_digest = sha256_bytes(&canonical_document);
    if string_field(configuration, "canonical_sha256") != Some(canonical_digest.as_str())
        || string_field(identity_source, "configuration_canonical_sha256")
            != Some(canonical_digest.as_str())
    {
        return Err(protocol_error("protocol.configuration-digest"));
    }
    let typed_configuration: RuntimeConfiguration = serde_json::from_value(document.clone())
        .map_err(|_| protocol_error("protocol.configuration-payload"))?;
    if !typed_configuration.validate() {
        return Err(protocol_error("protocol.configuration-payload"));
    }
    let max_frame_bytes = u64_field(body, "max_frame_bytes")
        .filter(|value| (HANDSHAKE_MIN_FRAME_BYTES..=MAX_FRAME_BYTES as u64).contains(value))
        .ok_or_else(|| protocol_error("frame.bound"))? as usize;
    Ok(HandshakeState {
        generation: generation.clone(),
        identity: identity.clone(),
        configuration: typed_configuration,
        configuration_canonical_sha256: canonical_digest,
        max_frame_bytes,
    })
}

fn bounded_text(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum
}

fn valid_entity_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn bounded_text_list(values: &[String], maximum_items: usize, unique: bool) -> bool {
    values.len() <= maximum_items
        && values.iter().all(|value| bounded_text(value, 64))
        && (!unique || {
            let identities: HashSet<&str> = values.iter().map(String::as_str).collect();
            identities.len() == values.len()
        })
}

fn sorted_unique_entity_ids(values: &[String], maximum_items: usize) -> bool {
    !values.is_empty()
        && values.len() <= maximum_items
        && values.iter().all(|value| valid_entity_id(value))
        && values.windows(2).all(|pair| pair[0] < pair[1])
}

fn valid_prepare_request(request: &PrepareRequest) -> bool {
    request.schema_version == PREPARE_REQUEST_SCHEMA_ID
        && bounded_text(&request.run_id, 64)
        && (1..=MAX_DRONES).contains(&request.drone_ids.len())
        && bounded_text_list(&request.drone_ids, MAX_DRONES, true)
        && (1..=MAX_TICK_MS).contains(&request.tick_ms)
        && (1..=MAX_TICKS).contains(&request.max_ticks)
        && (3..=MAX_DRONES * 3).contains(&request.initial_position_m.len())
        && (3..=MAX_DRONES * 3).contains(&request.initial_velocity_mps.len())
        && (3..=MAX_DRONES * 3).contains(&request.sensor_variance_m2.len())
        && finite_bounded(&request.initial_position_m, MAX_POSITION_ABS_M)
        && finite_bounded(&request.initial_velocity_mps, MAX_SPEED_MPS)
        && finite_positive_bounded(&request.sensor_variance_m2, MAX_SENSOR_VARIANCE_M2)
}

fn valid_step_request(request: &StepRequest) -> bool {
    request.schema_version == STEP_REQUEST_SCHEMA_ID
        && bounded_text(&request.run_id, 64)
        && (1..=MAX_TICKS).contains(&request.tick_index)
        && (1..=MAX_DRONES).contains(&request.drone_ids.len())
        && bounded_text_list(&request.drone_ids, MAX_DRONES, true)
        && (3..=MAX_DRONES * 3).contains(&request.actuator_intent_acceleration_mps2.len())
        && (3..=MAX_DRONES * 3).contains(&request.sensor_offset_m.len())
        && (1..=MAX_DRONES).contains(&request.fault_codes.len())
        && finite_bounded(
            &request.actuator_intent_acceleration_mps2,
            MAX_ACCELERATION_MPS2,
        )
        && finite_bounded(&request.sensor_offset_m, MAX_SENSOR_OFFSET_ABS_M)
}

fn valid_finish_request(request: &FinishRequest) -> bool {
    request.schema_version == FINISH_REQUEST_SCHEMA_ID
        && bounded_text(&request.run_id, 64)
        && request.tick_index <= MAX_TICKS
        && request.reason == "completed"
}

fn valid_digest_roster(values: &[&str]) -> bool {
    values.iter().copied().all(valid_sha256)
}

fn valid_frame_response(response: &SimulationFrameResponse, operation_id: &str) -> bool {
    let (schema, reasons): (&str, &[&str]) = if operation_id == PREPARE_OPERATION_ID {
        (
            PREPARE_RESPONSE_SCHEMA_ID,
            &[
                "prepared",
                "run-already-active",
                "invalid-input",
                "fusion-failed",
                "internal-panic-contained",
            ],
        )
    } else {
        (
            STEP_RESPONSE_SCHEMA_ID,
            &[
                "stepped",
                "no-active-run",
                "run-id-mismatch",
                "tick-out-of-order",
                "tick-budget-exhausted",
                "roster-mismatch",
                "invalid-input",
                "overload-injected",
                "simulation-boundary",
                "fusion-failed",
                "internal-panic-contained",
            ],
        )
    };
    if response.schema_version != schema
        || !reasons.contains(&response.reason.as_str())
        || response.authority != AUTHORITY
        || !bounded_text(&response.run_id, 64)
        || response.tick_index > MAX_TICKS
        || !bounded_text_list(&response.drone_ids, MAX_DRONES, true)
        || !bounded_text_list(&response.fused_track_ids, MAX_DRONES, true)
        || !valid_digest_roster(&[
            &response.run_digest,
            &response.prior_state_digest,
            &response.state_digest,
            &response.request_digest,
            &response.receipt_digest,
            &response.transcript_digest,
        ])
        || !finite_bounded(&response.simulated_position_m, MAX_POSITION_ABS_M)
        || !finite_bounded(&response.simulated_velocity_mps, MAX_SPEED_MPS)
        || !finite_bounded(&response.sensor_input_position_m, MAX_POSITION_ABS_M)
        || !finite_bounded(&response.fused_position_m, MAX_POSITION_ABS_M)
        || !finite_bounded(&response.fused_velocity_mps, MAX_SPEED_MPS)
        || !finite_bounded(
            &response.actuator_intent_acceleration_mps2,
            MAX_ACCELERATION_MPS2,
        )
        || !finite_bounded(
            &response.actuator_output_acceleration_mps2,
            MAX_ACCELERATION_MPS2,
        )
    {
        return false;
    }
    let count = response.drone_ids.len();
    let empty = count == 0;
    let vector_length = count * 3;
    (empty || response.fused_track_ids.len() == count)
        && response.simulated_position_m.len() == vector_length
        && response.simulated_velocity_mps.len() == vector_length
        && response.sensor_input_admitted.len() == count
        && response.sensor_input_position_m.len() == vector_length
        && response.fused_estimate_available.len() == count
        && response.fused_position_m.len() == vector_length
        && response.fused_velocity_mps.len() == vector_length
        && response.actuator_intent_acceleration_mps2.len() == vector_length
        && response.actuator_output_acceleration_mps2.len() == vector_length
        && response.actuator_saturated.len() == count
        && response.fault_codes.len() == count
        && match response.outcome {
            Outcome::Succeeded => {
                !response.terminal
                    && ((operation_id == PREPARE_OPERATION_ID && response.reason == "prepared")
                        || (operation_id == STEP_OPERATION_ID && response.reason == "stepped"))
            }
            Outcome::Rejected => !matches!(
                response.reason.as_str(),
                "prepared"
                    | "stepped"
                    | "fusion-failed"
                    | "overload-injected"
                    | "simulation-boundary"
                    | "internal-panic-contained"
            ),
            Outcome::Failed => matches!(
                response.reason.as_str(),
                "fusion-failed"
                    | "overload-injected"
                    | "simulation-boundary"
                    | "internal-panic-contained"
            ),
        }
}

fn valid_finish_response(response: &FinishResponse) -> bool {
    response.schema_version == FINISH_RESPONSE_SCHEMA_ID
        && matches!(
            response.reason.as_str(),
            "finished"
                | "no-active-run"
                | "run-id-mismatch"
                | "tick-out-of-order"
                | "invalid-input"
                | "internal-panic-contained"
        )
        && response.authority == AUTHORITY
        && bounded_text(&response.run_id, 64)
        && response.tick_index <= MAX_TICKS
        && bounded_text_list(&response.drone_ids, MAX_DRONES, true)
        && valid_digest_roster(&[
            &response.run_digest,
            &response.state_digest,
            &response.request_digest,
            &response.receipt_digest,
            &response.transcript_digest,
        ])
        && response.step_count <= MAX_TICKS
        && match response.outcome {
            Outcome::Succeeded => {
                response.reason == "finished" && response.terminal && response.cleaned_up
            }
            Outcome::Rejected => response.reason != "finished",
            Outcome::Failed => response.reason == "internal-panic-contained" && response.terminal,
        }
}

fn valid_standard_prepare_response(response: &StandardPrepareResponse) -> bool {
    let count = response.channel_ids.len();
    response.schema_version == STANDARD_PREPARE_RESPONSE_SCHEMA_ID
        && response.status == Outcome::Succeeded
        && response.reason == "prepared"
        && !response.terminal
        && valid_entity_id(&response.study_run_id)
        && valid_sha256(&response.closed_loop_definition_sha256)
        && valid_sha256(&response.runtime_adapter_configuration_sha256)
        && response.step_index == 0
        && response.tic_unit == crate::contract::STANDARD_TIC_UNIT
        && response.causality_policy == crate::contract::STANDARD_CAUSALITY_POLICY
        && response.step_duration_tics == crate::contract::STANDARD_STEP_DURATION_TICS
        && response.simulation_time_tics == 0
        && (1..=MAX_DRONES).contains(&count)
        && sorted_unique_entity_ids(&response.channel_ids, MAX_DRONES)
        && response.subject_ids.len() == count
        && response
            .subject_ids
            .iter()
            .all(|value| valid_entity_id(value))
        && response.observation_widths == vec![crate::contract::STANDARD_OBSERVATION_WIDTH; count]
        && response.observation_present == vec![true; count]
        && valid_standard_observation_values(&response.observation_values, count)
        && response.fault_dispositions == vec![StandardFaultDisposition::None; count]
        && response.fault_codes == vec!["none".to_string(); count]
        && response.run_state_active
}

fn valid_standard_step_response(response: &StandardStepResponse) -> bool {
    let count = response.channel_ids.len();
    response.schema_version == STANDARD_STEP_RESPONSE_SCHEMA_ID
        && response.status == Outcome::Succeeded
        && response.reason == "stepped"
        && !response.terminal
        && valid_entity_id(&response.study_run_id)
        && (1..=MAX_TICKS).contains(&response.step_index)
        && standard_step_id(&response.study_run_id, response.step_index)
            .is_ok_and(|expected| response.step_id == expected)
        && valid_sha256(&response.source_snapshot_sha256)
        && valid_sha256(&response.runtime_request_sha256)
        && response.tic_unit == crate::contract::STANDARD_TIC_UNIT
        && response.causality_policy == crate::contract::STANDARD_CAUSALITY_POLICY
        && response.step_duration_tics == crate::contract::STANDARD_STEP_DURATION_TICS
        && response
            .step_index
            .checked_mul(response.step_duration_tics)
            .is_some_and(|expected| response.simulation_time_tics == expected)
        && (1..=MAX_DRONES).contains(&count)
        && sorted_unique_entity_ids(&response.channel_ids, MAX_DRONES)
        && response.subject_ids.len() == count
        && response
            .subject_ids
            .iter()
            .all(|value| valid_entity_id(value))
        && response.observation_widths == vec![crate::contract::STANDARD_OBSERVATION_WIDTH; count]
        && response.observation_present.len() == count
        && valid_standard_observation_values(&response.observation_values, count)
        && valid_standard_fault_roster(
            &response.fault_dispositions,
            &response.fault_codes,
            &response.observation_present,
        )
        && response.run_state_active
}

fn valid_standard_observation_values(values: &[f64], count: usize) -> bool {
    count
        .checked_mul(crate::contract::STANDARD_OBSERVATION_WIDTH as usize)
        .is_some_and(|expected| values.len() == expected)
        && values.chunks_exact(6).all(|channel| {
            finite_bounded(&channel[..3], MAX_POSITION_ABS_M)
                && finite_bounded(&channel[3..], MAX_SPEED_MPS)
        })
}

fn valid_standard_fault_roster(
    dispositions: &[StandardFaultDisposition],
    codes: &[String],
    observation_present: &[bool],
) -> bool {
    dispositions.len() == codes.len()
        && codes.len() == observation_present.len()
        && codes.iter().all(|code| valid_standard_fault_code(code))
        && dispositions.iter().zip(codes).zip(observation_present).all(
            |((disposition, code), present)| match disposition {
                StandardFaultDisposition::None => *present && code == "none",
                StandardFaultDisposition::ActuatorHold => *present && code == "actuator.safe-hold",
                StandardFaultDisposition::SensorUnavailable => {
                    !*present && code == "sensor-unavailable"
                }
                StandardFaultDisposition::Overload | StandardFaultDisposition::Fatal => false,
            },
        )
}

fn valid_standard_fault_code(value: &str) -> bool {
    !value.is_empty() && value.len() <= STANDARD_FAULT_CODE_MAX_UTF8_BYTES
}

fn valid_standard_finish_response(response: &StandardFinishResponse) -> bool {
    response.schema_version == STANDARD_FINISH_RESPONSE_SCHEMA_ID
        && response.status == Outcome::Succeeded
        && response.reason == "finished"
        && response.terminal
        && valid_entity_id(&response.study_run_id)
        && (1..=MAX_TICKS).contains(&response.final_step_index)
        && valid_sha256(&response.final_snapshot_sha256)
        && response.tic_unit == crate::contract::STANDARD_TIC_UNIT
        && response.causality_policy == crate::contract::STANDARD_CAUSALITY_POLICY
        && response.step_duration_tics == crate::contract::STANDARD_STEP_DURATION_TICS
        && response
            .final_step_index
            .checked_mul(response.step_duration_tics)
            .is_some_and(|expected| response.final_simulation_time_tics == expected)
        && response.run_state_cleared
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeSurface {
    Idle,
    Project,
    Standard,
    Terminal,
}

struct ManagedSimulationRuntime {
    project: SimulationRuntime,
    standard: StandardSimulationRuntime,
    surface: RuntimeSurface,
}

impl ManagedSimulationRuntime {
    fn new(state: &HandshakeState) -> ProtocolResult<Self> {
        let standard = StandardSimulationRuntime::new(
            state.configuration.standard_simulator_profile.clone(),
            state.configuration_canonical_sha256.clone(),
        )
        .map_err(|error| protocol_error(error.reason()))?;
        Ok(Self {
            project: SimulationRuntime::new(),
            standard,
            surface: RuntimeSurface::Idle,
        })
    }

    fn require_surface(&self, expected: RuntimeSurface) -> ProtocolResult<()> {
        if self.surface != expected {
            return Err(protocol_error("runtime.surface-state"));
        }
        Ok(())
    }

    fn abort(&mut self) {
        self.project.abort();
        self.standard.abort();
        self.surface = RuntimeSurface::Terminal;
    }
}

fn mint_message_id(seen: &HashSet<String>) -> ProtocolResult<String> {
    for _ in 0..16 {
        let candidate = random_prefixed_hex("msg_", 16);
        if !seen.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(protocol_error("runtime.message-id"))
}

struct DispatchResult {
    status: &'static str,
    control: Value,
}

fn dispatch_operation(
    runtime: &mut ManagedSimulationRuntime,
    operation: &OperationContract,
    control: &Value,
) -> ProtocolResult<DispatchResult> {
    match operation.operation_id {
        PREPARE_OPERATION_ID => {
            runtime.require_surface(RuntimeSurface::Idle)?;
            let request: PrepareRequest = deserialize_control(control)?;
            if !valid_prepare_request(&request) {
                return Err(protocol_error("runtime.request-schema"));
            }
            let digest =
                request_digest(&request).map_err(|_| protocol_error("runtime.request-schema"))?;
            let response = match catch_unwind(AssertUnwindSafe(|| {
                runtime.project.prepare(request.clone())
            })) {
                Ok(result) => result,
                Err(_) => runtime.project.contain_panic_frame(
                    PREPARE_RESPONSE_SCHEMA_ID,
                    PREPARE_REQUEST_SCHEMA_ID,
                    &request.run_id,
                    0,
                    &digest,
                ),
            }
            .map_err(|_| protocol_error("runtime.receipt-digest"))?;
            if !valid_frame_response(&response, operation.operation_id) {
                return Err(protocol_error("runtime.response-schema"));
            }
            if response.outcome == Outcome::Succeeded {
                runtime.surface = RuntimeSurface::Project;
            } else if response.terminal {
                runtime.surface = RuntimeSurface::Terminal;
            }
            Ok(DispatchResult {
                status: response.outcome.ipc_status(),
                control: response_value(&response)?,
            })
        }
        STEP_OPERATION_ID => {
            runtime.require_surface(RuntimeSurface::Project)?;
            let request: StepRequest = deserialize_control(control)?;
            if !valid_step_request(&request) {
                return Err(protocol_error("runtime.request-schema"));
            }
            let digest =
                request_digest(&request).map_err(|_| protocol_error("runtime.request-schema"))?;
            let response =
                match catch_unwind(AssertUnwindSafe(|| runtime.project.step(request.clone()))) {
                    Ok(result) => result,
                    Err(_) => runtime.project.contain_panic_frame(
                        STEP_RESPONSE_SCHEMA_ID,
                        STEP_REQUEST_SCHEMA_ID,
                        &request.run_id,
                        request.tick_index,
                        &digest,
                    ),
                }
                .map_err(|_| protocol_error("runtime.receipt-digest"))?;
            if !valid_frame_response(&response, operation.operation_id) {
                return Err(protocol_error("runtime.response-schema"));
            }
            if response.terminal {
                runtime.surface = RuntimeSurface::Terminal;
            }
            Ok(DispatchResult {
                status: response.outcome.ipc_status(),
                control: response_value(&response)?,
            })
        }
        FINISH_OPERATION_ID => {
            runtime.require_surface(RuntimeSurface::Project)?;
            let request: FinishRequest = deserialize_control(control)?;
            if !valid_finish_request(&request) {
                return Err(protocol_error("runtime.request-schema"));
            }
            let digest =
                request_digest(&request).map_err(|_| protocol_error("runtime.request-schema"))?;
            let response =
                match catch_unwind(AssertUnwindSafe(|| runtime.project.finish(request.clone()))) {
                    Ok(result) => result,
                    Err(_) => runtime.project.contain_panic_finish(&request, &digest),
                }
                .map_err(|_| protocol_error("runtime.receipt-digest"))?;
            if !valid_finish_response(&response) {
                return Err(protocol_error("runtime.response-schema"));
            }
            if response.outcome == Outcome::Succeeded || response.terminal {
                runtime.surface = RuntimeSurface::Terminal;
            }
            Ok(DispatchResult {
                status: response.outcome.ipc_status(),
                control: response_value(&response)?,
            })
        }
        STANDARD_PREPARE_OPERATION_ID => {
            runtime.require_surface(RuntimeSurface::Idle)?;
            let request: StandardPrepareRequest = deserialize_control(control)?;
            let response = catch_unwind(AssertUnwindSafe(|| runtime.standard.prepare(request)))
                .map_err(|_| protocol_error("runtime.internal-panic-contained"))?
                .map_err(|error| protocol_error(error.reason()))?;
            if !valid_standard_prepare_response(&response) {
                return Err(protocol_error("runtime.response-schema"));
            }
            runtime.surface = RuntimeSurface::Standard;
            Ok(DispatchResult {
                status: response.status.ipc_status(),
                control: response_value(&response)?,
            })
        }
        STANDARD_STEP_OPERATION_ID => {
            runtime.require_surface(RuntimeSurface::Standard)?;
            let request: StandardStepRequest = deserialize_control(control)?;
            let response = catch_unwind(AssertUnwindSafe(|| runtime.standard.step(request)))
                .map_err(|_| protocol_error("runtime.internal-panic-contained"))?
                .map_err(|error| protocol_error(error.reason()))?;
            if !valid_standard_step_response(&response) {
                return Err(protocol_error("runtime.response-schema"));
            }
            if response.terminal {
                runtime.surface = RuntimeSurface::Terminal;
            }
            Ok(DispatchResult {
                status: response.status.ipc_status(),
                control: response_value(&response)?,
            })
        }
        STANDARD_FINISH_OPERATION_ID => {
            runtime.require_surface(RuntimeSurface::Standard)?;
            let request: StandardFinishRequest = deserialize_control(control)?;
            let response = catch_unwind(AssertUnwindSafe(|| runtime.standard.finish(request)))
                .map_err(|_| protocol_error("runtime.internal-panic-contained"))?
                .map_err(|error| protocol_error(error.reason()))?;
            if !valid_standard_finish_response(&response) {
                return Err(protocol_error("runtime.response-schema"));
            }
            runtime.surface = RuntimeSurface::Terminal;
            Ok(DispatchResult {
                status: response.status.ipc_status(),
                control: response_value(&response)?,
            })
        }
        _ => Err(protocol_error("protocol.operation")),
    }
}

/// Serve one exact Engram Host API 2 process generation on inherited pipes.
///
/// The function performs no network, filesystem, process, NCP, or physical-plant
/// operation. Clean EOF clears any active simulator state before returning.
///
/// # Errors
///
/// Returns [`ProtocolError`] after any framing, replay, schema, grant, budget,
/// or local-response violation. The process generation must then terminate.
pub fn serve_managed_runtime<R: Read, W: Write>(
    input: &mut R,
    output: &mut W,
) -> Result<RuntimeSessionReceipt, ProtocolError> {
    catch_unwind(AssertUnwindSafe(|| serve_generation(input, output)))
        .map_err(|_| protocol_error("runtime.internal-panic-contained"))?
}

fn serve_generation<R: Read, W: Write>(
    input: &mut R,
    output: &mut W,
) -> ProtocolResult<RuntimeSessionReceipt> {
    let (host_handshake, _) = read_frame(input, ABSOLUTE_MAX_FRAME_BYTES, false)?
        .ok_or_else(|| protocol_error("frame.eof"))?;
    let state = accept_handshake(&host_handshake)?;
    let host_message_id = host_handshake
        .get("message_id")
        .and_then(Value::as_str)
        .ok_or_else(|| protocol_error("protocol.identifier"))?
        .to_string();
    let mut seen_messages = HashSet::from([host_message_id]);
    let handshake_message_id = mint_message_id(&seen_messages)?;
    let response = runtime_handshake(&host_handshake, &state, handshake_message_id.clone())?;
    write_frame(output, &response, state.max_frame_bytes)?;
    seen_messages.insert(handshake_message_id);

    let operation_roster = operations();
    let mut runtime = ManagedSimulationRuntime::new(&state)?;
    let mut seen_idempotency = HashSet::new();
    let mut seen_grants = HashSet::new();
    let mut host_sequence = 1_u64;
    let mut runtime_sequence = 1_u64;
    let mut request_count = 0_u64;
    let mut response_count = 0_u64;
    let mut cumulative_cpu_time_ms = 0_u64;

    loop {
        let Some((request, payload_length)) = read_frame(input, state.max_frame_bytes, true)?
        else {
            runtime.abort();
            let generation = state
                .generation
                .as_object()
                .ok_or_else(|| protocol_error("protocol.generation"))?;
            return Ok(RuntimeSessionReceipt {
                installation_id: string_field(generation, "installation_id")
                    .ok_or_else(|| protocol_error("protocol.generation"))?
                    .to_string(),
                generation_id: string_field(generation, "generation_id")
                    .ok_or_else(|| protocol_error("protocol.generation"))?
                    .to_string(),
                ordinal: u64_field(generation, "ordinal")
                    .ok_or_else(|| protocol_error("protocol.generation"))?,
                request_count,
                response_count,
                clean_eof: true,
            });
        };
        request_count = request_count
            .checked_add(1)
            .ok_or_else(|| protocol_error("runtime.operation-budget"))?;
        if request_count > MAX_OPERATIONS_PER_GENERATION {
            return Err(protocol_error("runtime.operation-budget"));
        }
        let accepted = accept_request(
            &request,
            payload_length,
            &state,
            host_sequence,
            &operation_roster,
            &seen_messages,
            &seen_idempotency,
            &mut seen_grants,
            cumulative_cpu_time_ms,
        )?;
        let result = dispatch_operation(&mut runtime, accepted.operation, &accepted.control)?;
        cumulative_cpu_time_ms = cumulative_cpu_time_ms
            .checked_add(accepted.cpu_charge)
            .ok_or_else(|| protocol_error("runtime.cpu-budget"))?;
        let response_message_id = mint_message_id(&seen_messages)?;
        let response = json!({
            "schema_version": "1.0",
            "protocol": IPC_PROTOCOL,
            "kind": "operation.response",
            "sender": "runtime",
            "generation": state.generation,
            "sequence": runtime_sequence,
            "message_id": response_message_id,
            "body": {
                "request_message_id": accepted.message_id,
                "idempotency_key": accepted.idempotency_key,
                "operation": accepted.operation.identity(),
                "response_schema": accepted.operation.response_schema.value(),
                "status": result.status,
                "control": result.control,
                "bulk": {"inline": false, "references": []},
            },
        });
        write_frame(
            output,
            &response,
            state
                .max_frame_bytes
                .min(accepted.operation.max_response_bytes),
        )?;
        seen_messages.insert(accepted.message_id);
        seen_messages.insert(response_message_id);
        seen_idempotency.insert(accepted.idempotency_key);
        host_sequence = host_sequence
            .checked_add(1)
            .ok_or_else(|| protocol_error("protocol.request-envelope"))?;
        runtime_sequence = runtime_sequence
            .checked_add(1)
            .ok_or_else(|| protocol_error("protocol.request-envelope"))?;
        response_count = response_count
            .checked_add(1)
            .ok_or_else(|| protocol_error("runtime.operation-budget"))?;
    }
}

fn runtime_handshake(
    host: &Value,
    state: &HandshakeState,
    message_id: String,
) -> ProtocolResult<Value> {
    let host_source = exact_object(host, ENVELOPE_FIELDS)?;
    let host_body = exact_object(
        host_source
            .get("body")
            .ok_or_else(|| protocol_error("protocol.shape"))?,
        HANDSHAKE_BODY_FIELDS,
    )?;
    let host_challenge = host_body
        .get("challenge")
        .cloned()
        .ok_or_else(|| protocol_error("protocol.shape"))?;
    Ok(json!({
        "schema_version": "1.0",
        "protocol": IPC_PROTOCOL,
        "kind": "runtime.handshake",
        "sender": "runtime",
        "generation": state.generation,
        "sequence": 0,
        "message_id": message_id,
        "body": {
            "host_challenge": host_challenge,
            "runtime_nonce": random_prefixed_hex("nonce_", 32),
            "identity": state.identity,
            "ready_claim": false,
        },
    }))
}

struct AcceptedRequest<'a> {
    operation: &'a OperationContract,
    message_id: String,
    idempotency_key: String,
    control: Value,
    cpu_charge: u64,
}

#[expect(
    clippy::too_many_arguments,
    reason = "the request validator joins every replay and grant budget"
)]
fn accept_request<'a>(
    value: &Value,
    payload_length: usize,
    state: &HandshakeState,
    expected_sequence: u64,
    operations: &'a [OperationContract],
    seen_messages: &HashSet<String>,
    seen_idempotency: &HashSet<String>,
    seen_grants: &mut HashSet<String>,
    cumulative_cpu_time_ms: u64,
) -> ProtocolResult<AcceptedRequest<'a>> {
    let source = exact_object(value, ENVELOPE_FIELDS)?;
    if string_field(source, "schema_version") != Some("1.0")
        || string_field(source, "protocol") != Some(IPC_PROTOCOL)
        || string_field(source, "kind") != Some("operation.request")
        || string_field(source, "sender") != Some("host")
        || source.get("generation") != Some(&state.generation)
        || u64_field(source, "sequence") != Some(expected_sequence)
    {
        return Err(protocol_error("protocol.request-envelope"));
    }
    let message_id = string_field(source, "message_id")
        .filter(|value| valid_prefixed_hex(value, "msg_", 32))
        .ok_or_else(|| protocol_error("protocol.identifier"))?
        .to_string();
    if seen_messages.contains(&message_id) {
        return Err(protocol_error("protocol.message-replay"));
    }
    let body = exact_object(
        source
            .get("body")
            .ok_or_else(|| protocol_error("protocol.shape"))?,
        REQUEST_BODY_FIELDS,
    )?;
    let idempotency_key = string_field(body, "idempotency_key")
        .filter(|value| valid_prefixed_hex(value, "idem_", 64))
        .ok_or_else(|| protocol_error("protocol.identifier"))?
        .to_string();
    if seen_idempotency.contains(&idempotency_key) {
        return Err(protocol_error("protocol.idempotency-replay"));
    }
    let operation_identity = body
        .get("operation")
        .ok_or_else(|| protocol_error("protocol.shape"))?;
    exact_object(operation_identity, OPERATION_IDENTITY_FIELDS)?;
    let operation_id = operation_identity
        .get("operation_id")
        .and_then(Value::as_str)
        .filter(|value| valid_component(value))
        .ok_or_else(|| protocol_error("protocol.operation"))?;
    let operation = operations
        .iter()
        .find(|candidate| candidate.operation_id == operation_id)
        .ok_or_else(|| protocol_error("protocol.operation"))?;
    if operation_identity != &operation.identity() {
        return Err(protocol_error("protocol.operation"));
    }
    if payload_length > operation.max_request_bytes {
        return Err(protocol_error("protocol.request-bytes"));
    }
    if !body
        .get("request_schema")
        .is_some_and(|value| operation.request_schema.matches(value))
    {
        return Err(protocol_error("protocol.request-schema"));
    }
    if !body
        .get("response_schema")
        .is_some_and(|value| operation.response_schema.matches(value))
    {
        return Err(protocol_error("protocol.response-schema"));
    }
    if u64_field(body, "timeout_ms") != Some(OPERATION_TIMEOUT_MS) {
        return Err(protocol_error("protocol.timeout"));
    }
    if body.get("bulk") != Some(&json!({"inline": false, "references": []})) {
        return Err(protocol_error("protocol.bulk"));
    }
    let grant = exact_object(
        body.get("compute_grant")
            .ok_or_else(|| protocol_error("protocol.shape"))?,
        GRANT_FIELDS,
    )?;
    let grant_id = string_field(grant, "grant_id")
        .filter(|value| valid_prefixed_hex(value, "grant_", 64))
        .ok_or_else(|| protocol_error("protocol.identifier"))?;
    if seen_grants.contains(grant_id) {
        return Err(protocol_error("protocol.grant-replay"));
    }
    let generation_id = state
        .generation
        .get("generation_id")
        .and_then(Value::as_str)
        .ok_or_else(|| protocol_error("protocol.generation"))?;
    if string_field(grant, "mode") != Some("host-one-shot")
        || string_field(grant, "generation_id") != Some(generation_id)
        || string_field(grant, "operation_id") != Some(operation.operation_id)
        || u64_field(grant, "issued_for_sequence") != Some(expected_sequence)
        || u64_field(grant, "max_cpu_time_ms") != Some(operation.max_cpu_time_ms)
        || u64_field(grant, "valid_for_ms") != Some(OPERATION_TIMEOUT_MS)
        || bool_field(grant, "reusable") != Some(false)
    {
        return Err(protocol_error("protocol.compute-grant"));
    }
    if cumulative_cpu_time_ms
        .checked_add(operation.max_cpu_time_ms)
        .is_none_or(|value| value > MAX_GENERATION_CPU_TIME_MS)
    {
        return Err(protocol_error("runtime.cpu-budget"));
    }
    let control = body
        .get("control")
        .filter(|value| valid_control(value))
        .ok_or_else(|| protocol_error("protocol.control"))?
        .clone();
    seen_grants.insert(grant_id.to_string());
    Ok(AcceptedRequest {
        operation,
        message_id,
        idempotency_key,
        control,
        cpu_charge: operation.max_cpu_time_ms,
    })
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::contract::{
        StandardFaultScheduleEntry, StandardScheduledFault, StandardSimulatorProfile,
        STANDARD_ACTION_COMPONENT_IDS, STANDARD_ACTION_SPACE_ID, STANDARD_ACTION_UNIT_IDS,
        STANDARD_ACTION_WIDTH, STANDARD_CAUSALITY_POLICY, STANDARD_OBSERVATION_COMPONENT_IDS,
        STANDARD_OBSERVATION_SPACE_ID, STANDARD_OBSERVATION_UNIT_IDS, STANDARD_OBSERVATION_WIDTH,
        STANDARD_PROFILE_SCHEMA_ID, STANDARD_ROSTER_RULE, STANDARD_STEP_DURATION_TICS,
        STANDARD_SUBJECT_KIND, STANDARD_TIC_UNIT, STANDARD_VECTOR_FLATTENING_RULE,
    };

    #[test]
    fn standard_fault_code_bound_uses_utf8_bytes_and_keeps_the_vocabulary_closed() {
        let ascii_at_limit = "a".repeat(STANDARD_FAULT_CODE_MAX_UTF8_BYTES);
        let unicode_at_limit = "é".repeat(STANDARD_FAULT_CODE_MAX_UTF8_BYTES / 2);
        let ascii_over_limit = "a".repeat(STANDARD_FAULT_CODE_MAX_UTF8_BYTES + 1);
        let unicode_over_limit = format!("{unicode_at_limit}é");

        assert_eq!(ascii_at_limit.len(), STANDARD_FAULT_CODE_MAX_UTF8_BYTES);
        assert_eq!(unicode_at_limit.len(), STANDARD_FAULT_CODE_MAX_UTF8_BYTES);
        assert!(valid_standard_fault_code(&ascii_at_limit));
        assert!(valid_standard_fault_code(&unicode_at_limit));
        assert!(!valid_standard_fault_code(&ascii_over_limit));
        assert!(!valid_standard_fault_code(&unicode_over_limit));
        assert!(!valid_standard_fault_code(""));
        assert!(!valid_standard_fault_roster(
            &[StandardFaultDisposition::None],
            &[ascii_at_limit],
            &[true],
        ));
    }

    fn configuration() -> RuntimeConfiguration {
        RuntimeConfiguration {
            schema_version: CONFIGURATION_SCHEMA_ID.to_string(),
            max_drones: MAX_DRONES as u64,
            max_ticks: MAX_TICKS,
            max_tick_ms: MAX_TICK_MS,
            max_acceleration_mps2: MAX_ACCELERATION_MPS2,
            max_speed_mps: MAX_SPEED_MPS,
            max_position_abs_m: MAX_POSITION_ABS_M,
            max_sensor_offset_abs_m: MAX_SENSOR_OFFSET_ABS_M,
            max_sensor_variance_m2: MAX_SENSOR_VARIANCE_M2,
            standard_simulator_profile: StandardSimulatorProfile {
                schema_version: STANDARD_PROFILE_SCHEMA_ID.to_string(),
                tick_ms: 20,
                tic_unit: STANDARD_TIC_UNIT.to_string(),
                step_duration_tics: STANDARD_STEP_DURATION_TICS,
                causality_policy: STANDARD_CAUSALITY_POLICY.to_string(),
                roster_rule: STANDARD_ROSTER_RULE.to_string(),
                vector_flattening_rule: STANDARD_VECTOR_FLATTENING_RULE.to_string(),
                internal_drone_id_prefix: "drone-".to_string(),
                internal_drone_id_start: 1,
                internal_drone_id_decimal_width: 2,
                initial_position_origin_m: vec![0.0, 0.0, 100.0],
                initial_position_stride_m: vec![500.0, 0.0, 0.0],
                initial_velocity_mps: vec![0.0; 3],
                sensor_variance_m2: vec![1.0; 3],
                safe_hold_output_acceleration_mps2: vec![0.0; 3],
                recoverable_fault_schedule: vec![StandardFaultScheduleEntry {
                    step_index: 3,
                    channel_ordinal: 1,
                    fault_disposition: StandardScheduledFault::SensorUnavailable,
                }],
                subject_kind: STANDARD_SUBJECT_KIND.to_string(),
                observation_space_id: STANDARD_OBSERVATION_SPACE_ID.to_string(),
                action_space_id: STANDARD_ACTION_SPACE_ID.to_string(),
                observation_width: STANDARD_OBSERVATION_WIDTH,
                action_width: STANDARD_ACTION_WIDTH,
                observation_component_ids: STANDARD_OBSERVATION_COMPONENT_IDS
                    .map(str::to_string)
                    .to_vec(),
                observation_unit_ids: STANDARD_OBSERVATION_UNIT_IDS.map(str::to_string).to_vec(),
                action_component_ids: STANDARD_ACTION_COMPONENT_IDS.map(str::to_string).to_vec(),
                action_unit_ids: STANDARD_ACTION_UNIT_IDS.map(str::to_string).to_vec(),
                simulator_only: true,
            },
        }
    }

    fn generation() -> Value {
        json!({
            "installation_id": format!("inst_{}", "a".repeat(64)),
            "generation_id": format!("gen_{}", "b".repeat(64)),
            "ordinal": 1,
        })
    }

    fn handshake() -> Value {
        let configuration = to_value(&configuration()).expect("configuration serializes");
        let configuration_digest =
            sha256_bytes(&canonical_json(&configuration).expect("configuration canonicalizes"));
        json!({
            "schema_version": "1.0",
            "protocol": IPC_PROTOCOL,
            "kind": "host.handshake",
            "sender": "host",
            "generation": generation(),
            "sequence": 0,
            "message_id": format!("msg_{}", "1".repeat(32)),
            "body": {
                "challenge": format!("chal_{}", "c".repeat(64)),
                "identity": {
                    "manifest_exact_sha256": "1".repeat(64),
                    "manifest_canonical_sha256": "2".repeat(64),
                    "package_lock_exact_sha256": "3".repeat(64),
                    "package_lock_canonical_sha256": "4".repeat(64),
                    "package_sha256": "5".repeat(64),
                    "executable_sha256": "6".repeat(64),
                    "configuration_exact_sha256": configuration_digest,
                    "configuration_canonical_sha256": configuration_digest,
                    "target_id": "macos-aarch64-darwin",
                    "profile": PROFILE,
                    "launch_abi": LAUNCH_ABI,
                    "operation_roster_sha256": operation_roster_sha256()
                        .expect("typed operation roster canonicalizes"),
                    "schema_registry_sha256": "7".repeat(64),
                    "installation_id": format!("inst_{}", "a".repeat(64)),
                },
                "configuration": {
                    "schema": SchemaReference::new(
                        CONFIGURATION_SCHEMA_ID,
                        CONFIGURATION_SCHEMA_BYTES,
                    ).value(),
                    "canonical_sha256": configuration_digest,
                    "document": configuration,
                },
                "max_frame_bytes": MAX_FRAME_BYTES,
            },
        })
    }

    fn prepare_control(drone_count: usize) -> Value {
        let positions: Vec<f64> = (0..drone_count)
            .flat_map(|index| [index as f64 * 500.0, 0.0, 100.0])
            .collect();
        json!({
            "schema_version": PREPARE_REQUEST_SCHEMA_ID,
            "run_id": "run-wire-01",
            "drone_ids": (1..=drone_count)
                .map(|index| format!("drone-{index:02}"))
                .collect::<Vec<_>>(),
            "tick_ms": 20,
            "max_ticks": 8,
            "initial_position_m": positions,
            "initial_velocity_mps": vec![0.0; drone_count * 3],
            "sensor_variance_m2": vec![1.0; drone_count * 3],
        })
    }

    fn step_control(drone_count: usize, tick_index: u64, fault: &str) -> Value {
        json!({
            "schema_version": STEP_REQUEST_SCHEMA_ID,
            "run_id": "run-wire-01",
            "tick_index": tick_index,
            "drone_ids": (1..=drone_count)
                .map(|index| format!("drone-{index:02}"))
                .collect::<Vec<_>>(),
            "actuator_intent_acceleration_mps2": vec![1.0; drone_count * 3],
            "sensor_offset_m": vec![0.0; drone_count * 3],
            "fault_codes": vec![fault; drone_count],
        })
    }

    fn finish_control(tick_index: u64) -> Value {
        json!({
            "schema_version": FINISH_REQUEST_SCHEMA_ID,
            "run_id": "run-wire-01",
            "tick_index": tick_index,
            "reason": "completed",
        })
    }

    fn configuration_digest() -> String {
        let value = to_value(&configuration()).expect("configuration serializes");
        sha256_bytes(&canonical_json(&value).expect("configuration canonicalizes"))
    }

    fn standard_prepare_control(channel_count: usize, step_count: u64) -> Value {
        json!({
            "schema_version": STANDARD_PREPARE_REQUEST_SCHEMA_ID,
            "study_run_id": "study-run-standard-wire-01",
            "closed_loop_definition_sha256": "8".repeat(64),
            "runtime_adapter_configuration_sha256": configuration_digest(),
            "step_count": step_count,
            "tic_unit": STANDARD_TIC_UNIT,
            "causality_policy": STANDARD_CAUSALITY_POLICY,
            "step_duration_tics": STANDARD_STEP_DURATION_TICS,
            "channel_ids": (1..=channel_count)
                .map(|index| format!("channel-{index:02}"))
                .collect::<Vec<_>>(),
            "subject_kinds": vec![STANDARD_SUBJECT_KIND; channel_count],
            "subject_ids": (1..=channel_count)
                .map(|index| format!("subject-{index:02}"))
                .collect::<Vec<_>>(),
            "observation_space_ids": vec![STANDARD_OBSERVATION_SPACE_ID; channel_count],
            "action_space_ids": vec![STANDARD_ACTION_SPACE_ID; channel_count],
            "observation_widths": vec![STANDARD_OBSERVATION_WIDTH; channel_count],
            "action_widths": vec![STANDARD_ACTION_WIDTH; channel_count],
            "observation_component_ids": (0..channel_count)
                .flat_map(|_| STANDARD_OBSERVATION_COMPONENT_IDS)
                .collect::<Vec<_>>(),
            "observation_unit_ids": (0..channel_count)
                .flat_map(|_| STANDARD_OBSERVATION_UNIT_IDS)
                .collect::<Vec<_>>(),
            "action_component_ids": (0..channel_count)
                .flat_map(|_| STANDARD_ACTION_COMPONENT_IDS)
                .collect::<Vec<_>>(),
            "action_unit_ids": (0..channel_count)
                .flat_map(|_| STANDARD_ACTION_UNIT_IDS)
                .collect::<Vec<_>>(),
            "action_min_values": vec![-10.0; channel_count * 3],
            "action_max_values": vec![10.0; channel_count * 3],
            "safe_action_values": vec![0.0; channel_count * 3],
        })
    }

    fn standard_step_control(channel_count: usize, step_index: u64) -> Value {
        json!({
            "schema_version": STANDARD_STEP_REQUEST_SCHEMA_ID,
            "study_run_id": "study-run-standard-wire-01",
            "step_index": step_index,
            "step_id": crate::standard::standard_step_id(
                "study-run-standard-wire-01",
                step_index,
            ).expect("fixture step identity derives"),
            "source_snapshot_sha256": format!("{step_index:064x}"),
            "runtime_request_sha256": format!("{:064x}", step_index + 2_048),
            "tic_unit": STANDARD_TIC_UNIT,
            "causality_policy": STANDARD_CAUSALITY_POLICY,
            "step_duration_tics": STANDARD_STEP_DURATION_TICS,
            "source_simulation_time_tics": (step_index - 1) * STANDARD_STEP_DURATION_TICS,
            "target_simulation_time_tics": step_index * STANDARD_STEP_DURATION_TICS,
            "channel_ids": (1..=channel_count)
                .map(|index| format!("channel-{index:02}"))
                .collect::<Vec<_>>(),
            "subject_ids": (1..=channel_count)
                .map(|index| format!("subject-{index:02}"))
                .collect::<Vec<_>>(),
            "action_widths": vec![3; channel_count],
            "action_values": vec![1.0; channel_count * 3],
            "saturated_values": vec![false; channel_count * 3],
            "action_dispositions": vec!["bounded-neural-proposal"; channel_count],
        })
    }

    fn standard_finish_control(final_step_index: u64) -> Value {
        json!({
            "schema_version": STANDARD_FINISH_REQUEST_SCHEMA_ID,
            "study_run_id": "study-run-standard-wire-01",
            "final_step_index": final_step_index,
            "final_snapshot_sha256": "f".repeat(64),
            "tic_unit": STANDARD_TIC_UNIT,
            "causality_policy": STANDARD_CAUSALITY_POLICY,
            "step_duration_tics": STANDARD_STEP_DURATION_TICS,
            "final_simulation_time_tics": final_step_index * STANDARD_STEP_DURATION_TICS,
            "reason": "completed",
        })
    }

    fn request(
        operation: &OperationContract,
        sequence: u64,
        marker: char,
        control: Value,
    ) -> Value {
        json!({
            "schema_version": "1.0",
            "protocol": IPC_PROTOCOL,
            "kind": "operation.request",
            "sender": "host",
            "generation": generation(),
            "sequence": sequence,
            "message_id": format!("msg_{}", marker.to_string().repeat(32)),
            "body": {
                "idempotency_key": format!("idem_{}", marker.to_string().repeat(64)),
                "operation": operation.identity(),
                "request_schema": operation.request_schema.value(),
                "response_schema": operation.response_schema.value(),
                "compute_grant": {
                    "mode": "host-one-shot",
                    "grant_id": format!("grant_{}", marker.to_string().repeat(64)),
                    "generation_id": format!("gen_{}", "b".repeat(64)),
                    "operation_id": operation.operation_id,
                    "issued_for_sequence": sequence,
                    "max_cpu_time_ms": operation.max_cpu_time_ms,
                    "valid_for_ms": OPERATION_TIMEOUT_MS,
                    "reusable": false,
                },
                "timeout_ms": OPERATION_TIMEOUT_MS,
                "control": control,
                "bulk": {"inline": false, "references": []},
            },
        })
    }

    fn wire(values: &[Value]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for value in values {
            write_frame(&mut bytes, value, ABSOLUTE_MAX_FRAME_BYTES).expect("frame writes");
        }
        bytes
    }

    fn output_frames(bytes: &[u8]) -> Vec<Value> {
        let mut input = Cursor::new(bytes);
        let mut frames = Vec::new();
        while let Some((value, _)) =
            read_frame(&mut input, ABSOLUTE_MAX_FRAME_BYTES, true).expect("output parses")
        {
            frames.push(value);
        }
        frames
    }

    #[test]
    fn exact_private_pipe_transcript_runs_prepare_step_finish() {
        let operation_roster = operations();
        let input = wire(&[
            handshake(),
            request(&operation_roster[2], 1, '2', prepare_control(3)),
            request(&operation_roster[4], 2, '3', step_control(3, 1, "none")),
            request(&operation_roster[0], 3, '4', finish_control(1)),
        ]);
        let mut input = Cursor::new(input);
        let mut output = Vec::new();

        let receipt = serve_managed_runtime(&mut input, &mut output).expect("session succeeds");
        let frames = output_frames(&output);

        assert_eq!((receipt.request_count, receipt.response_count), (3, 3));
        assert!(receipt.clean_eof);
        assert_eq!(frames.len(), 4);
        assert_eq!(frames[0]["kind"], "runtime.handshake");
        assert_eq!(frames[0]["body"]["ready_claim"], false);
        for frame in &frames[1..] {
            assert_eq!(frame["kind"], "operation.response");
            assert_eq!(frame["body"]["status"], "succeeded");
            assert_eq!(frame["body"]["control"]["authority"], AUTHORITY);
        }
        assert_eq!(frames[3]["body"]["control"]["cleaned_up"], true);
    }

    #[test]
    fn exact_standard_private_pipe_transcript_runs_prepare_step_finish() {
        let operation_roster = operations();
        let prepare = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_PREPARE_OPERATION_ID)
            .expect("standard prepare operation exists");
        let step = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_STEP_OPERATION_ID)
            .expect("standard step operation exists");
        let finish = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_FINISH_OPERATION_ID)
            .expect("standard finish operation exists");
        let input = wire(&[
            handshake(),
            request(prepare, 1, '2', standard_prepare_control(3, 1)),
            request(step, 2, '3', standard_step_control(3, 1)),
            request(finish, 3, '4', standard_finish_control(1)),
        ]);
        let mut input = Cursor::new(input);
        let mut output = Vec::new();

        let receipt =
            serve_managed_runtime(&mut input, &mut output).expect("standard session succeeds");
        let frames = output_frames(&output);

        assert_eq!((receipt.request_count, receipt.response_count), (3, 3));
        assert!(receipt.clean_eof);
        assert_eq!(
            frames[1]["body"]["control"]["schema_version"],
            STANDARD_PREPARE_RESPONSE_SCHEMA_ID
        );
        assert_eq!(
            frames[2]["body"]["control"]["fault_dispositions"],
            json!(["none", "none", "none"])
        );
        assert_eq!(frames[3]["body"]["control"]["run_state_cleared"], true);
    }

    #[test]
    fn standard_pipe_rejects_width_drift_before_core_state_exists() {
        let operation_roster = operations();
        let prepare = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_PREPARE_OPERATION_ID)
            .expect("standard prepare operation exists");
        let mut control = standard_prepare_control(1, 1);
        control["observation_widths"] = json!([2]);
        let mut input = Cursor::new(wire(&[handshake(), request(prepare, 1, '2', control)]));

        let error = serve_managed_runtime(&mut input, &mut Vec::new())
            .expect_err("standard width drift fails closed");

        assert_eq!(error.reason(), "standard.width-mismatch");
    }

    #[test]
    fn standard_pipe_rejects_missing_reordered_and_wrong_unit_rosters() {
        let operation_roster = operations();
        let prepare = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_PREPARE_OPERATION_ID)
            .expect("standard prepare operation exists");

        let mut missing = standard_prepare_control(2, 1);
        missing
            .as_object_mut()
            .expect("control is an object")
            .remove("observation_unit_ids");
        let mut reordered = standard_prepare_control(2, 1);
        reordered["observation_component_ids"]
            .as_array_mut()
            .expect("component roster is an array")
            .swap(0, 1);
        let mut wrong_unit = standard_prepare_control(2, 1);
        wrong_unit["observation_unit_ids"][3] = Value::String("si.metre".to_string());

        for (control, reason) in [
            (missing, "runtime.request-schema"),
            (reordered, "standard.semantic-mismatch"),
            (wrong_unit, "standard.semantic-mismatch"),
        ] {
            let mut input = Cursor::new(wire(&[handshake(), request(prepare, 1, '2', control)]));
            let error = serve_managed_runtime(&mut input, &mut Vec::new())
                .expect_err("semantic roster drift fails closed");
            assert_eq!(error.reason(), reason);
        }
    }

    #[test]
    fn standard_pipe_rejects_clock_drift_before_core_state_exists() {
        let operation_roster = operations();
        let prepare = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_PREPARE_OPERATION_ID)
            .expect("standard prepare operation exists");
        let mut control = standard_prepare_control(1, 1);
        control["step_duration_tics"] = json!(STANDARD_STEP_DURATION_TICS + 1);
        let mut input = Cursor::new(wire(&[handshake(), request(prepare, 1, '2', control)]));

        let error = serve_managed_runtime(&mut input, &mut Vec::new())
            .expect_err("standard clock drift fails closed");

        assert_eq!(error.reason(), "standard.clock-mismatch");
    }

    #[test]
    fn standard_pipe_rejects_step_roster_drift() {
        let operation_roster = operations();
        let prepare = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_PREPARE_OPERATION_ID)
            .expect("standard prepare operation exists");
        let step = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_STEP_OPERATION_ID)
            .expect("standard step operation exists");
        let mut drift = standard_step_control(2, 1);
        drift["subject_ids"][1] = Value::String("subject-drift".to_string());
        let mut input = Cursor::new(wire(&[
            handshake(),
            request(prepare, 1, '2', standard_prepare_control(2, 1)),
            request(step, 2, '3', drift),
        ]));

        let error = serve_managed_runtime(&mut input, &mut Vec::new())
            .expect_err("standard roster drift fails closed");

        assert_eq!(error.reason(), "standard.roster-mismatch");
    }

    #[test]
    fn standard_pipe_rejects_out_of_order_lineage() {
        let operation_roster = operations();
        let prepare = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_PREPARE_OPERATION_ID)
            .expect("standard prepare operation exists");
        let step = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_STEP_OPERATION_ID)
            .expect("standard step operation exists");
        let mut input = Cursor::new(wire(&[
            handshake(),
            request(prepare, 1, '2', standard_prepare_control(1, 2)),
            request(step, 2, '3', standard_step_control(1, 2)),
        ]));

        let error = serve_managed_runtime(&mut input, &mut Vec::new())
            .expect_err("standard lineage drift fails closed");

        assert_eq!(error.reason(), "standard.lineage-mismatch");
    }

    #[test]
    fn standard_pipe_rejects_non_derived_step_identity() {
        let operation_roster = operations();
        let prepare = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_PREPARE_OPERATION_ID)
            .expect("standard prepare operation exists");
        let step = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_STEP_OPERATION_ID)
            .expect("standard step operation exists");
        let mut drift = standard_step_control(1, 1);
        drift["step_id"] = Value::String(format!("step_{}", "0".repeat(32)));
        let mut input = Cursor::new(wire(&[
            handshake(),
            request(prepare, 1, '2', standard_prepare_control(1, 1)),
            request(step, 2, '3', drift),
        ]));

        let error = serve_managed_runtime(&mut input, &mut Vec::new())
            .expect_err("non-derived step identity fails closed");

        assert_eq!(error.reason(), "standard.lineage-mismatch");
    }

    #[test]
    fn standard_pipe_rejects_project_fault_vocabulary() {
        let operation_roster = operations();
        let prepare = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_PREPARE_OPERATION_ID)
            .expect("standard prepare operation exists");
        let step = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_STEP_OPERATION_ID)
            .expect("standard step operation exists");
        let mut invalid = standard_step_control(1, 1);
        invalid["action_dispositions"] = json!(["sensor-dropout"]);
        let mut input = Cursor::new(wire(&[
            handshake(),
            request(prepare, 1, '2', standard_prepare_control(1, 1)),
            request(step, 2, '3', invalid),
        ]));

        let error = serve_managed_runtime(&mut input, &mut Vec::new())
            .expect_err("standard v3 has no fault-injection vocabulary");

        assert_eq!(error.reason(), "runtime.request-schema");
    }

    #[test]
    fn standard_pipe_admits_safe_hold_without_manufacturing_a_fault() {
        let operation_roster = operations();
        let prepare = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_PREPARE_OPERATION_ID)
            .expect("standard prepare operation exists");
        let step = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_STEP_OPERATION_ID)
            .expect("standard step operation exists");
        let mut control = standard_step_control(2, 1);
        control["action_values"] = json!([1.0, 1.0, 1.0, 0.0, 0.0, 0.0]);
        control["action_dispositions"] = json!(["bounded-neural-proposal", "safe-hold"]);
        let mut input = Cursor::new(wire(&[
            handshake(),
            request(prepare, 1, '2', standard_prepare_control(2, 1)),
            request(step, 2, '3', control),
        ]));
        let mut output = Vec::new();

        serve_managed_runtime(&mut input, &mut output).expect("safe hold is admitted");
        let frames = output_frames(&output);

        assert_eq!(
            frames[2]["body"]["control"]["fault_dispositions"],
            json!(["none", "none"])
        );
        assert_eq!(
            frames[2]["body"]["control"]["fault_codes"],
            json!(["none", "none"])
        );
    }

    #[test]
    fn standard_pipe_emits_scheduled_fault_then_admits_hold_washout_and_resume() {
        let operation_roster = operations();
        let prepare = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_PREPARE_OPERATION_ID)
            .expect("standard prepare operation exists");
        let step = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_STEP_OPERATION_ID)
            .expect("standard step operation exists");
        let finish = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_FINISH_OPERATION_ID)
            .expect("standard finish operation exists");
        let mut hold = standard_step_control(3, 4);
        hold["action_values"] = json!([0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
        hold["action_dispositions"] = json!([
            "safe-hold",
            "bounded-neural-proposal",
            "bounded-neural-proposal"
        ]);
        let mut washout = standard_step_control(3, 5);
        washout["action_values"] = json!([0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
        let input = wire(&[
            handshake(),
            request(prepare, 1, '2', standard_prepare_control(3, 6)),
            request(step, 2, '3', standard_step_control(3, 1)),
            request(step, 3, '4', standard_step_control(3, 2)),
            request(step, 4, '5', standard_step_control(3, 3)),
            request(step, 5, '6', hold),
            request(step, 6, '7', washout),
            request(step, 7, '8', standard_step_control(3, 6)),
            request(finish, 8, '9', standard_finish_control(6)),
        ]);
        let mut input = Cursor::new(input);
        let mut output = Vec::new();

        serve_managed_runtime(&mut input, &mut output)
            .expect("scheduled fault and recovery sequence succeeds");
        let frames = output_frames(&output);

        assert_eq!(frames.len(), 9);
        assert_eq!(
            frames[4]["body"]["control"]["fault_dispositions"],
            json!(["sensor-unavailable", "none", "none"])
        );
        assert_eq!(
            frames[4]["body"]["control"]["fault_codes"],
            json!(["sensor-unavailable", "none", "none"])
        );
        assert_eq!(
            frames[4]["body"]["control"]["observation_present"],
            json!([false, true, true])
        );
        for frame in &frames[5..8] {
            assert_eq!(
                frame["body"]["control"]["fault_dispositions"],
                json!(["none", "none", "none"])
            );
            assert_eq!(
                frame["body"]["control"]["observation_present"],
                json!([true, true, true])
            );
        }
        assert_eq!(frames[8]["body"]["control"]["run_state_cleared"], true);
    }

    #[test]
    fn standard_pipe_rejects_cross_surface_activation() {
        let operation_roster = operations();
        let standard_prepare = operation_roster
            .iter()
            .find(|operation| operation.operation_id == STANDARD_PREPARE_OPERATION_ID)
            .expect("standard prepare operation exists");
        let mut input = Cursor::new(wire(&[
            handshake(),
            request(&operation_roster[2], 1, '2', prepare_control(1)),
            request(standard_prepare, 2, '3', standard_prepare_control(1, 1)),
        ]));

        let error = serve_managed_runtime(&mut input, &mut Vec::new())
            .expect_err("one generation cannot activate two simulation surfaces");

        assert_eq!(error.reason(), "runtime.surface-state");
    }

    #[test]
    fn overload_fault_returns_terminal_failure_and_clean_eof() {
        let operation_roster = operations();
        let input = wire(&[
            handshake(),
            request(&operation_roster[2], 1, '2', prepare_control(2)),
            request(&operation_roster[4], 2, '3', step_control(2, 1, "overload")),
        ]);
        let mut input = Cursor::new(input);
        let mut output = Vec::new();

        let receipt = serve_managed_runtime(&mut input, &mut output).expect("fault is receipted");
        let frames = output_frames(&output);

        assert!(receipt.clean_eof);
        assert_eq!(frames[2]["body"]["status"], "failed");
        assert_eq!(frames[2]["body"]["control"]["reason"], "overload-injected");
        assert_eq!(frames[2]["body"]["control"]["terminal"], true);
    }

    #[test]
    fn handshake_rejects_operation_roster_drift() {
        let mut changed = handshake();
        changed["body"]["identity"]["operation_roster_sha256"] = Value::String("0".repeat(64));
        let mut input = Cursor::new(wire(&[changed]));
        let error = serve_managed_runtime(&mut input, &mut Vec::new())
            .expect_err("roster drift fails closed");

        assert_eq!(error.reason(), "protocol.identity");
    }

    #[test]
    fn request_rejects_replayed_compute_grant() {
        let operation_roster = operations();
        let first = request(&operation_roster[2], 1, '2', prepare_control(1));
        let mut replay = request(&operation_roster[4], 2, '3', step_control(1, 1, "none"));
        replay["body"]["compute_grant"]["grant_id"] =
            first["body"]["compute_grant"]["grant_id"].clone();
        let mut input = Cursor::new(wire(&[handshake(), first, replay]));
        let error = serve_managed_runtime(&mut input, &mut Vec::new())
            .expect_err("grant replay fails closed");

        assert_eq!(error.reason(), "protocol.grant-replay");
    }

    #[test]
    fn request_rejects_project_schema_shape_before_dispatch() {
        let operation_roster = operations();
        let mut invalid = prepare_control(1);
        invalid["initial_position_m"] = json!([0.0, 0.0]);
        let mut input = Cursor::new(wire(&[
            handshake(),
            request(&operation_roster[2], 1, '2', invalid),
        ]));
        let error = serve_managed_runtime(&mut input, &mut Vec::new())
            .expect_err("shape violation fails closed");

        assert_eq!(error.reason(), "runtime.request-schema");
    }

    #[test]
    fn internal_response_vector_rejects_negative_zero_before_framing() {
        let request: PrepareRequest =
            serde_json::from_value(prepare_control(1)).expect("prepare control is typed");
        let mut runtime = SimulationRuntime::new();
        let mut response = runtime.prepare(request).expect("valid prepare response");
        response.simulated_position_m[0] = -0.0;

        assert!(!valid_frame_response(&response, PREPARE_OPERATION_ID));
        let error = response_value(&response).expect_err("negative zero fails closed");
        assert_eq!(error.reason(), "runtime.response-schema");
    }

    #[test]
    fn internal_fused_velocity_rejects_wrong_width_and_nonfinite_values() {
        let request: PrepareRequest =
            serde_json::from_value(prepare_control(1)).expect("prepare control is typed");
        let mut runtime = SimulationRuntime::new();
        let response = runtime.prepare(request).expect("valid prepare response");

        let mut wrong_width = response.clone();
        wrong_width.fused_velocity_mps.pop();
        assert!(!valid_frame_response(&wrong_width, PREPARE_OPERATION_ID));

        let mut nonfinite = response;
        nonfinite.fused_velocity_mps[0] = f64::INFINITY;
        assert!(!valid_frame_response(&nonfinite, PREPARE_OPERATION_ID));
    }

    #[test]
    fn standard_internal_response_vector_rejects_negative_zero_before_framing() {
        let mut runtime = StandardSimulationRuntime::new(
            configuration().standard_simulator_profile,
            configuration_digest(),
        )
        .expect("standard profile is valid");
        let control = standard_prepare_control(1, 1);
        let request: StandardPrepareRequest =
            serde_json::from_value(control).expect("standard prepare control is typed");
        let mut response = runtime.prepare(request).expect("standard prepare succeeds");
        response.observation_values[0] = -0.0;

        assert!(!valid_standard_prepare_response(&response));
        let error = response_value(&response).expect_err("negative zero fails closed");
        assert_eq!(error.reason(), "runtime.response-schema");
    }

    #[test]
    fn standard_internal_response_rejects_unpaired_fault_disposition() {
        let mut runtime = StandardSimulationRuntime::new(
            configuration().standard_simulator_profile,
            configuration_digest(),
        )
        .expect("standard profile is valid");
        let request: StandardPrepareRequest =
            serde_json::from_value(standard_prepare_control(1, 1))
                .expect("standard prepare control is typed");
        let mut response = runtime.prepare(request).expect("standard prepare succeeds");
        response.fault_dispositions[0] = StandardFaultDisposition::ActuatorHold;

        assert!(!valid_standard_prepare_response(&response));
    }

    #[test]
    fn clean_eof_after_prepare_has_a_bounded_local_receipt() {
        let operation_roster = operations();
        let mut input = Cursor::new(wire(&[
            handshake(),
            request(&operation_roster[2], 1, '2', prepare_control(1)),
        ]));

        let receipt =
            serve_managed_runtime(&mut input, &mut Vec::new()).expect("EOF clears simulator state");

        assert_eq!((receipt.request_count, receipt.response_count), (1, 1));
        assert!(receipt.clean_eof);
    }

    #[test]
    fn framing_rejects_truncated_prefix_and_duplicate_json() {
        let prefix_error = read_frame(&mut Cursor::new(vec![0_u8, 1]), 1_024, false)
            .expect_err("prefix is truncated");
        let duplicate = br#"{"value":1,"value":2}"#;
        let mut duplicate_wire = (duplicate.len() as u32).to_be_bytes().to_vec();
        duplicate_wire.extend_from_slice(duplicate);
        let duplicate_error = read_frame(&mut Cursor::new(duplicate_wire), 1_024, false)
            .expect_err("duplicates fail closed");

        assert_eq!(prefix_error.reason(), "frame.truncated-prefix");
        assert_eq!(duplicate_error.reason(), "json.malformed");
    }
}

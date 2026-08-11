//! Dependency-isolated, perception-only NCP session runner for headless deployments.
//!
//! The runner opens one feature-neuron session, performs a bounded number of
//! steps, and closes the session. It never subscribes to commands, publishes
//! sensor frames, constructs plant authority, or registers a Tauri command.
//! It requires a compatible NCP wire-0.8 responder. The `engram/ncp` default is
//! only a routing address. Current Engram native-1.0 material is incompatible,
//! and this package contains no protocol translator.
//!
//! During the supervised lifecycle, every handled path after a confirmed open
//! makes a bounded close attempt. An open timeout leaves remote state unconfirmed.
//! Closing that identifier could terminate an unrelated session, so the runner
//! reports the ambiguity and makes no cleanup claim.

#![cfg(feature = "ncp")]
#![forbid(unsafe_code)]

use ncp_core::keys::Keys;
use ncp_core::{
    ChannelValue, CloseSession, NetworkRef, NetworkRefKind, ObservationFrame, OpenSession,
    RecordSpec, RecordTarget, SimConfig, StepRequest, StimulusFrame, StimulusSpec, StimulusTarget,
};
use ncp_zenoh::{ZenohBus, ZenohConfig, NCP_ZENOH_CONFIG_ENV};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fmt, fs,
    future::Future,
    io::Read,
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::time::Instant;
use zenoh::bytes::ZBytes;

pub const DEFAULT_REALM: &str = "engram/ncp";
pub const DEFAULT_MODEL: &str = "iaf_psc_alpha";
pub const DEFAULT_DRIVE_PA: f64 = 500.0;
pub const DEFAULT_ADVANCE_MS: f64 = 10.0;
pub const DEFAULT_STEPS: usize = 1;
pub const DEFAULT_OPERATION_TIMEOUT_MS: u64 = 15_000;
pub const DEFAULT_LIFECYCLE_TIMEOUT_MS: u64 = 60_000;
pub const MAX_HEADLESS_STEPS: usize = 4_096;
pub const MAX_LIFECYCLE_TIMEOUT_MS: u64 = 300_000;
pub const NCP_RPC_TIMEOUT: Duration = Duration::from_secs(15);

pub const MAX_REALM_BYTES: usize = 128;
pub const MAX_SESSION_ID_BYTES: usize = 64;
pub const MAX_MODEL_NAME_BYTES: usize = 128;
pub const MAX_ABS_DRIVE_PA: f64 = 1_000_000.0;
pub const MAX_ADVANCE_MS: f64 = 10_000.0;
pub const MAX_FEATURE_NEURON_SESSIONS: usize = 256;
pub const MAX_NCP_RPC_REPLY_BYTES: usize = 1024 * 1024;
pub const MAX_NCP_RPC_REPLIES: usize = 1;

const MIN_OPERATION_TIMEOUT_MS: u64 = 10;
const MAX_OPERATION_TIMEOUT_MS: u64 = 15_000;
const REQUIRED_OPERATION_BUDGETS: u64 = 4;
const MAX_ZENOH_CONFIG_BYTES: u64 = 1024 * 1024;
const EXPECTED_NCP_WIRE: &str = "0.8";
const EXPECTED_NCP_CONTRACT_HASH: &str = "d1b50a2d8a265276";

pub const USAGE: &str = "Usage:\n  crebain-ncp-headless self-check\n  crebain-ncp-headless validate --session-id <id> [options]\n  crebain-ncp-headless run --session-id <id> [options]\n\nOptions:\n  --realm <realm>                  NCP realm (default: engram/ncp)\n  --model <name>                   Built-in model (default: iaf_psc_alpha)\n  --drive-pa <number>              Current for each step (default: 500)\n  --advance-ms <number>            Simulated time per step (default: 10)\n  --steps <integer>                Step count, 1..=4096 (default: 1)\n  --operation-timeout-ms <integer> Per-operation bound, 10..=15000 (default: 15000)\n  --lifecycle-timeout-ms <integer> Whole-run bound, up to 300000 (default: 60000)\n\nThe run command requires a compatible NCP wire-0.8 responder.\nIt requires NCP_ZENOH_CONFIG and accepts only the strict client configuration posture.\nThat local check does not prove TLS, ACL, peer identity, or end-to-end effect.\nThe default realm does not establish responder compatibility.\nThe validate command checks the configuration but opens no Zenoh session.\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NcpInputField {
    Realm,
    SessionId,
    Model,
    Step,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NcpInputError {
    pub field: NcpInputField,
    pub reason: String,
}

impl fmt::Display for NcpInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.reason)
    }
}

impl std::error::Error for NcpInputError {}

/// Validate a borrowed NCP realm without allocating on success.
///
/// # Errors
///
/// Returns [`NcpInputError`] when the realm is empty, oversized, or unsafe.
pub fn validate_realm(realm: &str) -> Result<(), NcpInputError> {
    validate_bounded_text(NcpInputField::Realm, "realm", realm, MAX_REALM_BYTES)?;
    if realm.split('/').all(valid_key_segment) {
        Ok(())
    } else {
        Err(NcpInputError {
            field: NcpInputField::Realm,
            reason: "NCP realm contains an empty or unsafe key segment".to_string(),
        })
    }
}

/// Validate a borrowed NCP session identifier.
///
/// # Errors
///
/// Returns [`NcpInputError`] when the identifier is empty, oversized, or unsafe.
pub fn validate_session_id(session_id: &str) -> Result<(), NcpInputError> {
    validate_bounded_text(
        NcpInputField::SessionId,
        "session id",
        session_id,
        MAX_SESSION_ID_BYTES,
    )?;
    if valid_key_segment(session_id) {
        Ok(())
    } else {
        Err(NcpInputError {
            field: NcpInputField::SessionId,
            reason: "NCP session id contains an unsafe key-expression character".to_string(),
        })
    }
}

fn valid_key_segment(value: &str) -> bool {
    ncp_core::keys::valid_id_segment(value)
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
}

/// Validate a borrowed built-in model name.
///
/// # Errors
///
/// Returns [`NcpInputError`] when the name is empty, oversized, or unsafe.
pub fn validate_model_name(model: &str) -> Result<(), NcpInputError> {
    validate_bounded_text(
        NcpInputField::Model,
        "model name",
        model,
        MAX_MODEL_NAME_BYTES,
    )?;
    let mut bytes = model.bytes();
    let starts_with_alphanumeric = bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric());
    if starts_with_alphanumeric
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        Ok(())
    } else {
        Err(NcpInputError {
            field: NcpInputField::Model,
            reason: "NCP model name must start with an ASCII letter or digit and contain only letters, digits, '_', '-', or '.'".to_string(),
        })
    }
}

fn validate_bounded_text(
    field: NcpInputField,
    label: &str,
    value: &str,
    max_bytes: usize,
) -> Result<(), NcpInputError> {
    if value.is_empty() {
        return Err(NcpInputError {
            field,
            reason: format!("NCP {label} must not be empty"),
        });
    }
    if value.len() > max_bytes {
        return Err(NcpInputError {
            field,
            reason: format!("NCP {label} exceeds the {max_bytes}-byte limit"),
        });
    }
    Ok(())
}

/// Validate one feature-neuron step input pair.
///
/// # Errors
///
/// Returns [`NcpInputError`] for non-finite or out-of-range values.
pub fn validate_step_inputs(drive_pa: f64, advance_ms: f64) -> Result<(), NcpInputError> {
    if !drive_pa.is_finite() || !(-MAX_ABS_DRIVE_PA..=MAX_ABS_DRIVE_PA).contains(&drive_pa) {
        return Err(NcpInputError {
            field: NcpInputField::Step,
            reason: format!("NCP drive_pa must be finite and within +/-{MAX_ABS_DRIVE_PA} pA"),
        });
    }
    if !advance_ms.is_finite() || advance_ms <= 0.0 || advance_ms > MAX_ADVANCE_MS {
        return Err(NcpInputError {
            field: NcpInputField::Step,
            reason: format!(
                "NCP advance_ms must be finite, greater than zero, and at most {MAX_ADVANCE_MS} ms"
            ),
        });
    }
    Ok(())
}

/// Configuration for one bounded, perception-only NCP session.
#[derive(Clone, Debug, PartialEq)]
pub struct HeadlessSessionConfig {
    pub realm: String,
    pub session_id: String,
    pub model: String,
    pub drive_pa: f64,
    pub advance_ms: f64,
    pub steps: usize,
    pub operation_timeout_ms: u64,
    pub lifecycle_timeout_ms: u64,
}

impl HeadlessSessionConfig {
    #[must_use]
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            realm: DEFAULT_REALM.to_string(),
            session_id: session_id.into(),
            model: DEFAULT_MODEL.to_string(),
            drive_pa: DEFAULT_DRIVE_PA,
            advance_ms: DEFAULT_ADVANCE_MS,
            steps: DEFAULT_STEPS,
            operation_timeout_ms: DEFAULT_OPERATION_TIMEOUT_MS,
            lifecycle_timeout_ms: DEFAULT_LIFECYCLE_TIMEOUT_MS,
        }
    }

    /// Validate all input and resource bounds before transport can open.
    ///
    /// # Errors
    ///
    /// Returns [`HeadlessError::InvalidConfiguration`] for any invalid field.
    pub fn validate(&self) -> Result<(), HeadlessError> {
        validate_compiled_contract()?;
        validate_realm(&self.realm).map_err(|reason| HeadlessError::InvalidConfiguration {
            field: "realm",
            reason: reason.to_string(),
        })?;
        validate_session_id(&self.session_id).map_err(|reason| {
            HeadlessError::InvalidConfiguration {
                field: "session_id",
                reason: reason.to_string(),
            }
        })?;
        validate_model_name(&self.model).map_err(|reason| HeadlessError::InvalidConfiguration {
            field: "model",
            reason: reason.to_string(),
        })?;
        validate_step_inputs(self.drive_pa, self.advance_ms).map_err(|reason| {
            HeadlessError::InvalidConfiguration {
                field: "step",
                reason: reason.to_string(),
            }
        })?;
        if !(1..=MAX_HEADLESS_STEPS).contains(&self.steps) {
            return Err(HeadlessError::InvalidConfiguration {
                field: "steps",
                reason: format!("must be between 1 and {MAX_HEADLESS_STEPS}"),
            });
        }
        if !(MIN_OPERATION_TIMEOUT_MS..=MAX_OPERATION_TIMEOUT_MS)
            .contains(&self.operation_timeout_ms)
        {
            return Err(HeadlessError::InvalidConfiguration {
                field: "operation_timeout_ms",
                reason: format!(
                    "must be between {MIN_OPERATION_TIMEOUT_MS} and {MAX_OPERATION_TIMEOUT_MS}"
                ),
            });
        }
        if self.lifecycle_timeout_ms > MAX_LIFECYCLE_TIMEOUT_MS {
            return Err(HeadlessError::InvalidConfiguration {
                field: "lifecycle_timeout_ms",
                reason: format!("must be at most {MAX_LIFECYCLE_TIMEOUT_MS}"),
            });
        }
        let minimum_lifecycle_ms = self
            .operation_timeout_ms
            .checked_mul(REQUIRED_OPERATION_BUDGETS)
            .ok_or_else(|| HeadlessError::InvalidConfiguration {
                field: "lifecycle_timeout_ms",
                reason: "operation timeout multiplication overflowed".to_string(),
            })?;
        if self.lifecycle_timeout_ms < minimum_lifecycle_ms {
            return Err(HeadlessError::InvalidConfiguration {
                field: "lifecycle_timeout_ms",
                reason: format!(
                    "must be at least {minimum_lifecycle_ms} for connect, open, one step, and close"
                ),
            });
        }
        Ok(())
    }

    fn operation_timeout(&self) -> Duration {
        Duration::from_millis(self.operation_timeout_ms)
    }

    fn lifecycle_timeout(&self) -> Duration {
        Duration::from_millis(self.lifecycle_timeout_ms)
    }
}

fn validate_compiled_contract() -> Result<(), HeadlessError> {
    if ncp_core::NCP_VERSION != EXPECTED_NCP_WIRE
        || ncp_core::CONTRACT_HASH != EXPECTED_NCP_CONTRACT_HASH
    {
        return Err(HeadlessError::InvalidConfiguration {
            field: "ncp_contract",
            reason: format!(
                "compiled wire/hash is {}/{}, expected {EXPECTED_NCP_WIRE}/{EXPECTED_NCP_CONTRACT_HASH}",
                ncp_core::NCP_VERSION,
                ncp_core::CONTRACT_HASH
            ),
        });
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeadlessPhase {
    Connect,
    Open,
    Step(usize),
    Close,
}

impl fmt::Display for HeadlessPhase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connect => formatter.write_str("connect"),
            Self::Open => formatter.write_str("open"),
            Self::Step(index) => write!(formatter, "step {index}"),
            Self::Close => formatter.write_str("close"),
        }
    }
}

/// Structured failure for parsing, preflight, or the bounded session lifecycle.
#[derive(Debug)]
pub enum HeadlessError {
    Usage(String),
    InvalidConfiguration {
        field: &'static str,
        reason: String,
    },
    SecureConfig {
        reason: String,
    },
    Operation {
        phase: HeadlessPhase,
        reason: String,
    },
    Timeout {
        phase: HeadlessPhase,
        timeout_ms: u128,
    },
    LifecycleAndClose {
        primary: Box<HeadlessError>,
        close: Box<HeadlessError>,
    },
    LifecycleTask {
        reason: String,
    },
    Output {
        reason: String,
    },
}

impl fmt::Display for HeadlessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage(reason) => write!(formatter, "{reason}"),
            Self::InvalidConfiguration { field, reason } => {
                write!(formatter, "invalid {field}: {reason}")
            }
            Self::SecureConfig { reason } => write!(formatter, "secure config: {reason}"),
            Self::Operation { phase, reason } => write!(formatter, "{phase} failed: {reason}"),
            Self::Timeout { phase, timeout_ms } => {
                write!(formatter, "{phase} timed out after {timeout_ms} ms")
            }
            Self::LifecycleAndClose { primary, close } => {
                write!(
                    formatter,
                    "{primary}; the required close attempt also failed: {close}"
                )
            }
            Self::LifecycleTask { reason } => {
                write!(formatter, "headless lifecycle task failed: {reason}")
            }
            Self::Output { reason } => write!(formatter, "output failed: {reason}"),
        }
    }
}

impl std::error::Error for HeadlessError {}

#[derive(Clone, Debug, PartialEq)]
pub enum HeadlessCommand {
    Help,
    SelfCheck,
    Validate(HeadlessSessionConfig),
    Run(HeadlessSessionConfig),
}

/// Parse an explicit headless command. No argument defaults to no action.
///
/// # Errors
///
/// Returns [`HeadlessError::Usage`] for malformed, duplicate, or invalid arguments.
pub fn parse_args<I, S>(arguments: I) -> Result<HeadlessCommand, HeadlessError>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let arguments = arguments
        .into_iter()
        .map(|argument| {
            argument
                .into()
                .into_string()
                .map_err(|_| HeadlessError::Usage("arguments must be valid UTF-8".to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let Some(command) = arguments.first().map(String::as_str) else {
        return Err(HeadlessError::Usage(
            "an explicit self-check, validate, or run command is required".to_string(),
        ));
    };
    if arguments
        .iter()
        .any(|argument| matches!(argument.as_str(), "-h" | "--help"))
    {
        return Ok(HeadlessCommand::Help);
    }
    match command {
        "help" => {
            if arguments.len() == 1 {
                Ok(HeadlessCommand::Help)
            } else {
                Err(HeadlessError::Usage(
                    "help does not accept additional arguments".to_string(),
                ))
            }
        }
        "self-check" => {
            if arguments.len() == 1 {
                Ok(HeadlessCommand::SelfCheck)
            } else {
                Err(HeadlessError::Usage(
                    "self-check does not accept additional arguments".to_string(),
                ))
            }
        }
        "validate" | "run" => {
            let config = parse_session_options(&arguments[1..])?;
            if command == "validate" {
                Ok(HeadlessCommand::Validate(config))
            } else {
                Ok(HeadlessCommand::Run(config))
            }
        }
        _ => Err(HeadlessError::Usage(format!(
            "unknown command {command:?}; use self-check, validate, or run"
        ))),
    }
}

fn parse_session_options(arguments: &[String]) -> Result<HeadlessSessionConfig, HeadlessError> {
    let mut realm = None;
    let mut session_id = None;
    let mut model = None;
    let mut drive_pa = None;
    let mut advance_ms = None;
    let mut steps = None;
    let mut operation_timeout_ms = None;
    let mut lifecycle_timeout_ms = None;
    let mut index = 0;

    while index < arguments.len() {
        let flag = arguments[index].as_str();
        let value = arguments
            .get(index + 1)
            .ok_or_else(|| HeadlessError::Usage(format!("{flag} requires a value")))?;
        match flag {
            "--realm" => set_once(&mut realm, value.clone(), flag)?,
            "--session-id" => set_once(&mut session_id, value.clone(), flag)?,
            "--model" => set_once(&mut model, value.clone(), flag)?,
            "--drive-pa" => set_once(&mut drive_pa, parse_number(value, flag)?, flag)?,
            "--advance-ms" => set_once(&mut advance_ms, parse_number(value, flag)?, flag)?,
            "--steps" => set_once(&mut steps, parse_number(value, flag)?, flag)?,
            "--operation-timeout-ms" => {
                set_once(&mut operation_timeout_ms, parse_number(value, flag)?, flag)?;
            }
            "--lifecycle-timeout-ms" => {
                set_once(&mut lifecycle_timeout_ms, parse_number(value, flag)?, flag)?;
            }
            _ => return Err(HeadlessError::Usage(format!("unknown option {flag:?}"))),
        }
        index += 2;
    }

    let session_id = session_id.ok_or_else(|| {
        HeadlessError::Usage("--session-id is required for validate and run".to_string())
    })?;
    let mut config = HeadlessSessionConfig::new(session_id);
    if let Some(value) = realm {
        config.realm = value;
    }
    if let Some(value) = model {
        config.model = value;
    }
    if let Some(value) = drive_pa {
        config.drive_pa = value;
    }
    if let Some(value) = advance_ms {
        config.advance_ms = value;
    }
    if let Some(value) = steps {
        config.steps = value;
    }
    if let Some(value) = operation_timeout_ms {
        config.operation_timeout_ms = value;
    }
    if let Some(value) = lifecycle_timeout_ms {
        config.lifecycle_timeout_ms = value;
    }
    config.validate()?;
    Ok(config)
}

fn set_once<T>(slot: &mut Option<T>, value: T, flag: &str) -> Result<(), HeadlessError> {
    if slot.replace(value).is_some() {
        Err(HeadlessError::Usage(format!(
            "{flag} must not be specified more than once"
        )))
    } else {
        Ok(())
    }
}

fn parse_number<T>(value: &str, flag: &str) -> Result<T, HeadlessError>
where
    T: std::str::FromStr,
    T::Err: fmt::Display,
{
    value
        .parse::<T>()
        .map_err(|error| HeadlessError::Usage(format!("invalid value for {flag}: {error}")))
}

#[derive(Debug, Serialize)]
pub struct HeadlessSelfCheckReport {
    pub kind: &'static str,
    pub status: &'static str,
    pub ncp_wire: &'static str,
    pub contract_hash: &'static str,
    pub strict_client_configuration: &'static str,
    pub scope: &'static str,
    pub peer_requirement: &'static str,
    pub network_opened: bool,
}

#[derive(Debug, Serialize)]
pub struct HeadlessValidationReport {
    pub kind: &'static str,
    pub status: &'static str,
    pub ncp_wire: &'static str,
    pub config_bytes: u64,
    pub strict_client_configuration_validated: bool,
    pub peer_requirement: &'static str,
    pub network_opened: bool,
    pub security_policy_proven: bool,
}

#[derive(Debug, Serialize)]
pub struct HeadlessSessionReport {
    pub kind: &'static str,
    pub status: &'static str,
    pub ncp_wire: &'static str,
    pub realm: String,
    pub session_id: String,
    pub model: String,
    pub steps_requested: usize,
    pub steps_completed: usize,
    pub spike_counts: Vec<f64>,
    pub peer_requirement: &'static str,
    pub execution_evidence: HeadlessExecutionEvidence,
    pub claim_boundary: HeadlessClaimBoundary,
}

#[derive(Debug, Serialize)]
pub struct HeadlessExecutionEvidence {
    pub rpc_close_confirmed: bool,
    pub strict_client_configuration_validated: bool,
}

#[derive(Debug, Serialize)]
pub struct HeadlessClaimBoundary {
    pub security_policy_proven: bool,
    pub responder_identity_proven: bool,
    pub end_to_end_effect_proven: bool,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum HeadlessOutput {
    SelfCheck(HeadlessSelfCheckReport),
    Validation(HeadlessValidationReport),
    Session(HeadlessSessionReport),
}

#[derive(Debug)]
pub enum HeadlessDispatch {
    Help,
    Offline(HeadlessOutput),
    Run(HeadlessSessionConfig),
}

/// Check the compiled wire and local runner invariants without file or network I/O.
///
/// # Errors
///
/// Returns [`HeadlessError`] if a compiled invariant does not match wire 0.8.
pub fn self_check() -> Result<HeadlessSelfCheckReport, HeadlessError> {
    HeadlessSessionConfig::new("self-check").validate()?;
    Ok(HeadlessSelfCheckReport {
        kind: "crebain_ncp_headless_self_check",
        status: "ok",
        ncp_wire: ncp_core::NCP_VERSION,
        contract_hash: ncp_core::CONTRACT_HASH,
        strict_client_configuration: "required_for_run",
        scope: "perception_rpc_only",
        peer_requirement: "compatible_ncp_wire_0.8_responder",
        network_opened: false,
    })
}

/// Validate bounded input and the strict Zenoh client configuration without opening transport.
///
/// # Errors
///
/// Returns [`HeadlessError`] when input or the configuration file is invalid.
pub fn validate_offline(
    config: &HeadlessSessionConfig,
) -> Result<HeadlessValidationReport, HeadlessError> {
    config.validate()?;
    let secure_config = validated_secure_config_from_env()?;
    Ok(HeadlessValidationReport {
        kind: "crebain_ncp_headless_validation",
        status: "strict_client_configuration_validated",
        ncp_wire: ncp_core::NCP_VERSION,
        config_bytes: secure_config.bytes,
        strict_client_configuration_validated: true,
        peer_requirement: "compatible_ncp_wire_0.8_responder",
        network_opened: false,
        security_policy_proven: false,
    })
}

/// Resolve a command before any asynchronous runtime is constructed.
///
/// # Errors
///
/// Returns [`HeadlessError`] when an offline check or run configuration fails.
pub fn dispatch(command: HeadlessCommand) -> Result<HeadlessDispatch, HeadlessError> {
    match command {
        HeadlessCommand::Help => Ok(HeadlessDispatch::Help),
        HeadlessCommand::SelfCheck => self_check()
            .map(HeadlessOutput::SelfCheck)
            .map(HeadlessDispatch::Offline),
        HeadlessCommand::Validate(config) => validate_offline(&config)
            .map(HeadlessOutput::Validation)
            .map(HeadlessDispatch::Offline),
        HeadlessCommand::Run(config) => {
            config.validate()?;
            Ok(HeadlessDispatch::Run(config))
        }
    }
}

/// Run one strictly configured perception session.
///
/// This is the only function that opens NCP transport. The local configuration
/// checks do not attest the deployed security policy or remote peer identity.
///
/// # Errors
///
/// Returns [`HeadlessError`] for preflight, timeout, peer, reply, or cleanup failure.
pub async fn run_strict_client(
    config: &HeadlessSessionConfig,
) -> Result<HeadlessSessionReport, HeadlessError> {
    config.validate()?;
    let secure_config = validated_secure_config_from_env()?;
    run_owned_with_connector(
        ProductionConnector {
            config: secure_config.config,
        },
        config.clone(),
    )
    .await
}

#[derive(Debug)]
struct SecureConfigPreflight {
    bytes: u64,
    config: ZenohConfig,
}

fn preflight_secure_config_from_env() -> Result<SecureConfigPreflight, HeadlessError> {
    let path = env::var_os(NCP_ZENOH_CONFIG_ENV).ok_or_else(|| HeadlessError::SecureConfig {
        reason: format!("{NCP_ZENOH_CONFIG_ENV} is required"),
    })?;
    preflight_secure_config(Path::new(&path))
}

fn validated_secure_config_from_env() -> Result<SecureConfigPreflight, HeadlessError> {
    let secure_config = preflight_secure_config_from_env()?;
    validate_secure_client_config(&secure_config.config)?;
    Ok(secure_config)
}

fn preflight_secure_config(path: &Path) -> Result<SecureConfigPreflight, HeadlessError> {
    let max_config_bytes =
        usize::try_from(MAX_ZENOH_CONFIG_BYTES).map_err(|error| HeadlessError::SecureConfig {
            reason: format!("configured byte limit is unsupported on this platform: {error}"),
        })?;
    let file = fs::File::open(path).map_err(|error| HeadlessError::SecureConfig {
        reason: format!("cannot open {}: {error}", path.display()),
    })?;
    let metadata = file
        .metadata()
        .map_err(|error| HeadlessError::SecureConfig {
            reason: format!("cannot read metadata for {}: {error}", path.display()),
        })?;
    if !metadata.is_file() {
        return Err(HeadlessError::SecureConfig {
            reason: format!("{} is not a regular file", path.display()),
        });
    }
    if metadata.len() > MAX_ZENOH_CONFIG_BYTES {
        return Err(HeadlessError::SecureConfig {
            reason: format!(
                "{} exceeds the {MAX_ZENOH_CONFIG_BYTES}-byte limit",
                path.display()
            ),
        });
    }
    let initial_capacity = usize::try_from(metadata.len())
        .unwrap_or(max_config_bytes)
        .min(max_config_bytes)
        .saturating_add(1);
    let mut content = Vec::with_capacity(initial_capacity);
    file.take(MAX_ZENOH_CONFIG_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|error| HeadlessError::SecureConfig {
            reason: format!("cannot read {}: {error}", path.display()),
        })?;
    if content.len() > max_config_bytes {
        return Err(HeadlessError::SecureConfig {
            reason: format!(
                "{} exceeds the {MAX_ZENOH_CONFIG_BYTES}-byte limit",
                path.display()
            ),
        });
    }
    let text = std::str::from_utf8(&content).map_err(|error| HeadlessError::SecureConfig {
        reason: format!("{} is not valid UTF-8: {error}", path.display()),
    })?;
    let config = ZenohConfig::from_json5(text).map_err(|error| HeadlessError::SecureConfig {
        reason: format!("cannot parse {}: {error}", path.display()),
    })?;
    Ok(SecureConfigPreflight {
        bytes: content.len() as u64,
        config,
    })
}

fn secure_config_value(
    config: &ZenohConfig,
    path: &str,
) -> Result<serde_json::Value, HeadlessError> {
    let json = config
        .get_json(path)
        .map_err(|error| HeadlessError::SecureConfig {
            reason: format!("secure config is missing {path}: {error}"),
        })?;
    serde_json::from_str(&json).map_err(|error| HeadlessError::SecureConfig {
        reason: format!("secure config {path} is not valid JSON: {error}"),
    })
}

fn require_secure_config_path(config: &ZenohConfig, path: &str) -> Result<(), HeadlessError> {
    match secure_config_value(config, path)? {
        serde_json::Value::String(value) if !value.trim().is_empty() => Ok(()),
        _ => Err(HeadlessError::SecureConfig {
            reason: format!("secure client config requires a non-empty {path}"),
        }),
    }
}

fn collect_endpoint_strings<'a>(value: &'a serde_json::Value, endpoints: &mut Vec<&'a str>) {
    match value {
        serde_json::Value::String(endpoint) => endpoints.push(endpoint),
        serde_json::Value::Array(values) => {
            for value in values {
                collect_endpoint_strings(value, endpoints);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values() {
                collect_endpoint_strings(value, endpoints);
            }
        }
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {}
    }
}

// Keep these gates equal to the immutable ncp-zenoh v0.8.0 open_secure policy.
// Parsing once and passing this exact object to with_config removes the file
// reopen race while retaining the pinned secure-client requirements.
fn validate_secure_client_config(config: &ZenohConfig) -> Result<(), HeadlessError> {
    if secure_config_value(config, "mode")?.as_str() != Some("client") {
        return Err(HeadlessError::SecureConfig {
            reason: "secure client config requires mode=\"client\"".to_string(),
        });
    }
    for path in ["scouting/multicast/enabled", "scouting/gossip/enabled"] {
        if secure_config_value(config, path)?.as_bool() != Some(false) {
            return Err(HeadlessError::SecureConfig {
                reason: format!("secure client config requires {path}=false"),
            });
        }
    }

    let endpoints_value = secure_config_value(config, "connect/endpoints")?;
    let mut endpoints = Vec::new();
    collect_endpoint_strings(&endpoints_value, &mut endpoints);
    if endpoints.is_empty()
        || endpoints
            .iter()
            .any(|endpoint| !endpoint.starts_with("tls/"))
    {
        return Err(HeadlessError::SecureConfig {
            reason: "secure client config requires one or more exclusively tls/ connect endpoints"
                .to_string(),
        });
    }

    let listeners_value = secure_config_value(config, "listen/endpoints")?;
    let mut listeners = Vec::new();
    collect_endpoint_strings(&listeners_value, &mut listeners);
    if !listeners.is_empty() {
        return Err(HeadlessError::SecureConfig {
            reason: "secure client config must not expose listen endpoints".to_string(),
        });
    }

    for path in [
        "transport/link/tls/root_ca_certificate",
        "transport/link/tls/connect_certificate",
        "transport/link/tls/connect_private_key",
    ] {
        require_secure_config_path(config, path)?;
    }
    if secure_config_value(config, "transport/link/tls/verify_name_on_connect")?.as_bool()
        != Some(true)
    {
        return Err(HeadlessError::SecureConfig {
            reason: "secure client config requires transport/link/tls/verify_name_on_connect=true"
                .to_string(),
        });
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeatureNeuronPhase {
    Connect,
    Open,
    Step,
    Close,
}

impl fmt::Display for FeatureNeuronPhase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connect => formatter.write_str("connect"),
            Self::Open => formatter.write_str("open_session"),
            Self::Step => formatter.write_str("step_request"),
            Self::Close => formatter.write_str("close_session"),
        }
    }
}

#[derive(Debug)]
pub enum FeatureNeuronError {
    Input(NcpInputError),
    State {
        reason: String,
    },
    Request {
        phase: FeatureNeuronPhase,
        reason: String,
    },
    Rpc {
        phase: FeatureNeuronPhase,
        reason: String,
    },
    InvalidReply {
        phase: FeatureNeuronPhase,
        reason: String,
    },
    Rejected {
        phase: FeatureNeuronPhase,
        reason: String,
    },
}

impl fmt::Display for FeatureNeuronError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Input(error) => error.fmt(formatter),
            Self::State { reason } => write!(formatter, "NCP session state rejected: {reason}"),
            Self::Request { phase, reason } => {
                write!(formatter, "invalid NCP {phase} request: {reason}")
            }
            Self::Rpc { phase, reason } => write!(formatter, "NCP {phase} failed: {reason}"),
            Self::InvalidReply { phase, reason } => {
                write!(formatter, "invalid NCP {phase} reply: {reason}")
            }
            Self::Rejected { phase, reason } => write!(formatter, "NCP {phase} rejected: {reason}"),
        }
    }
}

impl std::error::Error for FeatureNeuronError {}

impl From<NcpInputError> for FeatureNeuronError {
    fn from(error: NcpInputError) -> Self {
        Self::Input(error)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum FeatureSessionState {
    Opening,
    Open(ncp_core::SessionRef),
    Stepping(ncp_core::SessionRef),
    Closing(ncp_core::SessionRef),
    UncertainOpen,
    UncertainClose(ncp_core::SessionRef),
}

struct FeatureSessionEntry {
    state: FeatureSessionState,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
}

/// Shared typed client for the wire-0.8 feature-neuron RPC lifecycle.
///
/// The client retains each server-issued session generation. It serializes all
/// operations for a logical session and echoes that generation on step and close.
/// Ambiguous open, step, or close outcomes remain as bounded fail-closed tombstones.
#[derive(Clone)]
pub struct FeatureNeuronClient {
    bus: ZenohBus,
    sessions: Arc<Mutex<HashMap<String, FeatureSessionEntry>>>,
}

impl FeatureNeuronClient {
    #[must_use]
    pub fn new(bus: ZenohBus) -> Self {
        Self {
            bus,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Open one validated built-in feature-neuron session.
    ///
    /// # Errors
    ///
    /// Returns [`FeatureNeuronError`] for invalid input, invalid state, or an
    /// invalid peer response. An ambiguous outcome requires a new connection.
    pub async fn open(&self, session_id: &str, model: &str) -> Result<(), FeatureNeuronError> {
        validate_session_id(session_id)?;
        validate_model_name(model)?;
        let lifecycle = self.reserve_open(session_id)?;
        let _guard = lifecycle.lock().await;
        let request = feature_neuron_open_request(session_id, model);
        let opened = match self
            .rpc::<_, ncp_core::SessionOpened>(FeatureNeuronPhase::Open, &request, "session_opened")
            .await
        {
            Ok(opened) => opened,
            Err(error) => {
                self.mark_open_uncertain(session_id, &lifecycle);
                return Err(error);
            }
        };
        if !opened.ok {
            self.remove_open_reservation(session_id, &lifecycle);
            return Err(FeatureNeuronError::Rejected {
                phase: FeatureNeuronPhase::Open,
                reason: opened
                    .error
                    .unwrap_or_else(|| "peer returned ok=false".to_string()),
            });
        }
        let session = match confirmed_open_session(&opened) {
            Ok(session) => session,
            Err(error) => {
                self.mark_open_uncertain(session_id, &lifecycle);
                return Err(error);
            }
        };
        self.confirm_open(session_id, &lifecycle, session)
    }

    /// Apply one bounded current stimulus and return the validated spike count.
    ///
    /// # Errors
    ///
    /// Returns [`FeatureNeuronError`] for invalid input, invalid state, or an
    /// invalid peer response.
    pub async fn step(
        &self,
        session_id: &str,
        drive_pa: f64,
        advance_ms: f64,
    ) -> Result<f64, FeatureNeuronError> {
        validate_session_id(session_id)?;
        validate_step_inputs(drive_pa, advance_ms)?;
        let lifecycle = self.existing_lifecycle(session_id)?;
        let _guard = lifecycle.lock().await;
        let session = self.begin_step(session_id, &lifecycle)?;
        let request = feature_neuron_step_request(session_id, &session, drive_pa, advance_ms);
        let observation: ObservationFrame = self
            .rpc(FeatureNeuronPhase::Step, &request, "observation_frame")
            .await?;
        verify_reply_session(
            FeatureNeuronPhase::Step,
            session_id,
            &observation.session_id,
        )?;
        verify_reply_generation(FeatureNeuronPhase::Step, &session, &observation.session)?;
        let count = spike_count(&observation, "spk", "feat")?;
        self.confirm_step(session_id, &lifecycle, &session)?;
        Ok(count)
    }

    /// Confirm that this client owns a currently open session incarnation.
    ///
    /// The check is serialized with open, step, and close for the same logical
    /// session. A caller that needs the state to remain stable must also retain
    /// its own higher-level lifecycle guard after this method returns.
    ///
    /// # Errors
    ///
    /// Returns [`FeatureNeuronError`] for invalid input or any non-open state.
    pub async fn ensure_open(&self, session_id: &str) -> Result<(), FeatureNeuronError> {
        validate_session_id(session_id)?;
        let lifecycle = self.existing_lifecycle(session_id)?;
        let _guard = lifecycle.lock().await;
        self.open_session_ref(session_id, &lifecycle).map(drop)
    }

    /// Close one validated feature-neuron session through the typed NCP RPC.
    ///
    /// # Errors
    ///
    /// Returns [`FeatureNeuronError`] for invalid input, invalid state, or an
    /// invalid peer response. An ambiguous outcome requires a new connection.
    pub async fn close(&self, session_id: &str) -> Result<(), FeatureNeuronError> {
        validate_session_id(session_id)?;
        let lifecycle = self.existing_lifecycle(session_id)?;
        let _guard = lifecycle.lock().await;
        let session = self.begin_close(session_id, &lifecycle)?;
        let request = CloseSession {
            session_id: session_id.to_string(),
            session: session.clone(),
            ..Default::default()
        };
        let closed: ncp_core::SessionClosed = match self
            .rpc(FeatureNeuronPhase::Close, &request, "session_closed")
            .await
        {
            Ok(closed) => closed,
            Err(error) => {
                self.mark_close_uncertain(session_id, &lifecycle, &session);
                return Err(error);
            }
        };
        if let Err(error) = ensure_close_succeeded_for_session(session_id, &session, &closed) {
            self.mark_close_uncertain(session_id, &lifecycle, &session);
            return Err(error);
        }
        self.confirm_close(session_id, &lifecycle, &session)
    }

    async fn rpc<Req, Resp>(
        &self,
        phase: FeatureNeuronPhase,
        message: &Req,
        expected_reply_kind: &str,
    ) -> Result<Resp, FeatureNeuronError>
    where
        Req: Serialize,
        Resp: DeserializeOwned,
    {
        let request =
            serde_json::to_value(message).map_err(|error| FeatureNeuronError::Request {
                phase,
                reason: format!("cannot serialize request: {error}"),
            })?;
        ncp_core::validate(&request).map_err(|error| FeatureNeuronError::Request {
            phase,
            reason: error.to_string(),
        })?;
        let session_id = request
            .get("session_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| FeatureNeuronError::Request {
                phase,
                reason: "request carries no string session_id".to_string(),
            })?;
        let request_kind = request
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| FeatureNeuronError::Request {
                phase,
                reason: "request carries no string kind".to_string(),
            })?;
        if ncp_core::expected_rpc_reply_kind(request_kind) != Some(expected_reply_kind) {
            return Err(FeatureNeuronError::Request {
                phase,
                reason: format!("request {request_kind:?} cannot expect {expected_reply_kind:?}"),
            });
        }
        let bytes = serde_json::to_vec(message).map_err(|error| FeatureNeuronError::Request {
            phase,
            reason: format!("cannot serialize request bytes: {error}"),
        })?;
        let reply = self.request_bounded(phase, request_kind, &bytes).await?;
        let response = decode_rpc_reply(phase, request_kind, session_id, &reply)?;
        if phase == FeatureNeuronPhase::Open {
            let version = response
                .get("ncp_version")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| FeatureNeuronError::InvalidReply {
                    phase,
                    reason: "reply carries no string ncp_version".to_string(),
                })?;
            let contract_hash = response
                .get("contract_hash")
                .and_then(serde_json::Value::as_str);
            ncp_core::negotiate(version, contract_hash).map_err(|error| {
                FeatureNeuronError::InvalidReply {
                    phase,
                    reason: format!("session version negotiation failed: {error}"),
                }
            })?;
        }
        serde_json::from_value(response).map_err(|error| FeatureNeuronError::InvalidReply {
            phase,
            reason: format!("cannot decode typed reply: {error}"),
        })
    }

    async fn request_bounded(
        &self,
        phase: FeatureNeuronPhase,
        request_kind: &str,
        message: &[u8],
    ) -> Result<Vec<u8>, FeatureNeuronError> {
        let rpc_key = self
            .bus
            .keys()
            .rpc_for_kind(request_kind)
            .map_err(|error| FeatureNeuronError::Request {
                phase,
                reason: format!("cannot route request: {error}"),
            })?;
        let replies = self
            .bus
            .session()
            .get(rpc_key.clone())
            .payload(message)
            .timeout(NCP_RPC_TIMEOUT)
            .await
            .map_err(|error| FeatureNeuronError::Rpc {
                phase,
                reason: format!("Zenoh get failed: {error}"),
            })?;
        let mut collector = BoundedReplyCollector::default();
        while let Ok(reply) = replies.recv_async().await {
            let result = match reply.result() {
                Ok(sample) => collector.push_success(sample.payload()),
                Err(error) => collector.push_error(error.payload()),
            };
            if let Err(reason) = result {
                return Err(FeatureNeuronError::InvalidReply { phase, reason });
            }
        }
        collector.finish().map_err(|error| match error {
            BoundedReplyError::Remote(reason) => FeatureNeuronError::Rpc {
                phase,
                reason: format!("error reply for {rpc_key}: {reason}"),
            },
            BoundedReplyError::NoReply => FeatureNeuronError::Rpc {
                phase,
                reason: format!("no reply for {rpc_key}"),
            },
        })
    }

    fn reserve_open(
        &self,
        session_id: &str,
    ) -> Result<Arc<tokio::sync::Mutex<()>>, FeatureNeuronError> {
        let mut sessions = lock_unpoisoned(&self.sessions);
        reserve_feature_session(&mut sessions, session_id)
    }

    fn existing_lifecycle(
        &self,
        session_id: &str,
    ) -> Result<Arc<tokio::sync::Mutex<()>>, FeatureNeuronError> {
        lock_unpoisoned(&self.sessions)
            .get(session_id)
            .map(|entry| Arc::clone(&entry.lifecycle))
            .ok_or_else(|| FeatureNeuronError::State {
                reason: format!("session {session_id:?} is not open"),
            })
    }

    fn open_session_ref(
        &self,
        session_id: &str,
        lifecycle: &Arc<tokio::sync::Mutex<()>>,
    ) -> Result<ncp_core::SessionRef, FeatureNeuronError> {
        let sessions = lock_unpoisoned(&self.sessions);
        let entry = current_entry(&sessions, session_id, lifecycle)?;
        match &entry.state {
            FeatureSessionState::Open(session) => Ok(session.clone()),
            state => Err(session_state_error(session_id, state)),
        }
    }

    fn begin_step(
        &self,
        session_id: &str,
        lifecycle: &Arc<tokio::sync::Mutex<()>>,
    ) -> Result<ncp_core::SessionRef, FeatureNeuronError> {
        let mut sessions = lock_unpoisoned(&self.sessions);
        let entry = current_entry_mut(&mut sessions, session_id, lifecycle)?;
        begin_step_transition(session_id, &mut entry.state)
    }

    fn confirm_step(
        &self,
        session_id: &str,
        lifecycle: &Arc<tokio::sync::Mutex<()>>,
        session: &ncp_core::SessionRef,
    ) -> Result<(), FeatureNeuronError> {
        let mut sessions = lock_unpoisoned(&self.sessions);
        let entry = current_entry_mut(&mut sessions, session_id, lifecycle)?;
        confirm_step_transition(session_id, &mut entry.state, session)
    }

    fn begin_close(
        &self,
        session_id: &str,
        lifecycle: &Arc<tokio::sync::Mutex<()>>,
    ) -> Result<ncp_core::SessionRef, FeatureNeuronError> {
        let mut sessions = lock_unpoisoned(&self.sessions);
        let entry = current_entry_mut(&mut sessions, session_id, lifecycle)?;
        begin_close_transition(session_id, &mut entry.state)
    }

    fn confirm_open(
        &self,
        session_id: &str,
        lifecycle: &Arc<tokio::sync::Mutex<()>>,
        session: ncp_core::SessionRef,
    ) -> Result<(), FeatureNeuronError> {
        let mut sessions = lock_unpoisoned(&self.sessions);
        let entry = current_entry_mut(&mut sessions, session_id, lifecycle)?;
        if entry.state != FeatureSessionState::Opening {
            return Err(session_state_error(session_id, &entry.state));
        }
        entry.state = FeatureSessionState::Open(session);
        Ok(())
    }

    fn confirm_close(
        &self,
        session_id: &str,
        lifecycle: &Arc<tokio::sync::Mutex<()>>,
        session: &ncp_core::SessionRef,
    ) -> Result<(), FeatureNeuronError> {
        let mut sessions = lock_unpoisoned(&self.sessions);
        let entry = current_entry(&sessions, session_id, lifecycle)?;
        if entry.state != FeatureSessionState::Closing(session.clone()) {
            return Err(session_state_error(session_id, &entry.state));
        }
        sessions.remove(session_id);
        Ok(())
    }

    fn mark_open_uncertain(&self, session_id: &str, lifecycle: &Arc<tokio::sync::Mutex<()>>) {
        let mut sessions = lock_unpoisoned(&self.sessions);
        if let Ok(entry) = current_entry_mut(&mut sessions, session_id, lifecycle) {
            if entry.state == FeatureSessionState::Opening {
                entry.state = FeatureSessionState::UncertainOpen;
            }
        }
    }

    fn remove_open_reservation(&self, session_id: &str, lifecycle: &Arc<tokio::sync::Mutex<()>>) {
        let mut sessions = lock_unpoisoned(&self.sessions);
        let should_remove = current_entry(&sessions, session_id, lifecycle)
            .is_ok_and(|entry| entry.state == FeatureSessionState::Opening);
        if should_remove {
            sessions.remove(session_id);
        }
    }

    fn mark_close_uncertain(
        &self,
        session_id: &str,
        lifecycle: &Arc<tokio::sync::Mutex<()>>,
        session: &ncp_core::SessionRef,
    ) {
        let mut sessions = lock_unpoisoned(&self.sessions);
        if let Ok(entry) = current_entry_mut(&mut sessions, session_id, lifecycle) {
            if entry.state == FeatureSessionState::Closing(session.clone()) {
                entry.state = FeatureSessionState::UncertainClose(session.clone());
            }
        }
    }
}

fn reserve_feature_session(
    sessions: &mut HashMap<String, FeatureSessionEntry>,
    session_id: &str,
) -> Result<Arc<tokio::sync::Mutex<()>>, FeatureNeuronError> {
    if let Some(entry) = sessions.get(session_id) {
        return Err(session_state_error(session_id, &entry.state));
    }
    if sessions.len() >= MAX_FEATURE_NEURON_SESSIONS {
        return Err(FeatureNeuronError::State {
            reason: format!(
                "session registry limit ({MAX_FEATURE_NEURON_SESSIONS}) reached; reconnect before opening"
            ),
        });
    }
    let lifecycle = Arc::new(tokio::sync::Mutex::new(()));
    sessions.insert(
        session_id.to_string(),
        FeatureSessionEntry {
            state: FeatureSessionState::Opening,
            lifecycle: Arc::clone(&lifecycle),
        },
    );
    Ok(lifecycle)
}

fn begin_step_transition(
    session_id: &str,
    state: &mut FeatureSessionState,
) -> Result<ncp_core::SessionRef, FeatureNeuronError> {
    match state {
        FeatureSessionState::Open(session) => {
            let session = session.clone();
            *state = FeatureSessionState::Stepping(session.clone());
            Ok(session)
        }
        state => Err(session_state_error(session_id, state)),
    }
}

fn confirm_step_transition(
    session_id: &str,
    state: &mut FeatureSessionState,
    session: &ncp_core::SessionRef,
) -> Result<(), FeatureNeuronError> {
    if *state != FeatureSessionState::Stepping(session.clone()) {
        return Err(session_state_error(session_id, state));
    }
    *state = FeatureSessionState::Open(session.clone());
    Ok(())
}

fn begin_close_transition(
    session_id: &str,
    state: &mut FeatureSessionState,
) -> Result<ncp_core::SessionRef, FeatureNeuronError> {
    match state {
        FeatureSessionState::Open(session) | FeatureSessionState::Stepping(session) => {
            let session = session.clone();
            *state = FeatureSessionState::Closing(session.clone());
            Ok(session)
        }
        state => Err(session_state_error(session_id, state)),
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn current_entry<'a>(
    sessions: &'a HashMap<String, FeatureSessionEntry>,
    session_id: &str,
    lifecycle: &Arc<tokio::sync::Mutex<()>>,
) -> Result<&'a FeatureSessionEntry, FeatureNeuronError> {
    sessions
        .get(session_id)
        .filter(|entry| Arc::ptr_eq(&entry.lifecycle, lifecycle))
        .ok_or_else(|| FeatureNeuronError::State {
            reason: format!("session {session_id:?} was replaced while this operation waited"),
        })
}

fn current_entry_mut<'a>(
    sessions: &'a mut HashMap<String, FeatureSessionEntry>,
    session_id: &str,
    lifecycle: &Arc<tokio::sync::Mutex<()>>,
) -> Result<&'a mut FeatureSessionEntry, FeatureNeuronError> {
    sessions
        .get_mut(session_id)
        .filter(|entry| Arc::ptr_eq(&entry.lifecycle, lifecycle))
        .ok_or_else(|| FeatureNeuronError::State {
            reason: format!("session {session_id:?} was replaced while this operation waited"),
        })
}

fn session_state_error(session_id: &str, state: &FeatureSessionState) -> FeatureNeuronError {
    let status = match state {
        FeatureSessionState::Opening => "an open is in progress or was cancelled",
        FeatureSessionState::Open(_) => "it is already open",
        FeatureSessionState::Stepping(_) => {
            "a step is in progress or its outcome is unconfirmed; only cleanup close is permitted"
        }
        FeatureSessionState::Closing(_) => "a close is in progress or was cancelled",
        FeatureSessionState::UncertainOpen => "the open outcome is unconfirmed",
        FeatureSessionState::UncertainClose(_) => "the close outcome is unconfirmed",
    };
    FeatureNeuronError::State {
        reason: format!(
            "session {session_id:?} cannot transition because {status}; reconnect first"
        ),
    }
}

fn feature_neuron_open_request(session_id: &str, model: &str) -> OpenSession {
    let mut population_sizes = ncp_core::Map::new();
    population_sizes.insert("feat".to_string(), 1);
    OpenSession {
        session_id: session_id.to_string(),
        network: NetworkRef {
            kind: NetworkRefKind::Builtin,
            ref_: model.to_string(),
            population_sizes,
            ..Default::default()
        },
        record: RecordSpec {
            targets: vec![RecordTarget {
                port: "spk".to_string(),
                target: "feat".to_string(),
                observable: ncp_core::Observable::Spikes,
                ..Default::default()
            }],
        },
        stimulus: StimulusSpec {
            targets: vec![StimulusTarget {
                port: "drive".to_string(),
                target: "feat".to_string(),
                kind: ncp_core::StimulusKind::CurrentPa,
                ..Default::default()
            }],
        },
        sim: SimConfig::default(),
        ..Default::default()
    }
}

fn feature_neuron_step_request(
    session_id: &str,
    session: &ncp_core::SessionRef,
    drive_pa: f64,
    advance_ms: f64,
) -> StepRequest {
    let mut values = ncp_core::Map::new();
    values.insert(
        "drive".to_string(),
        ChannelValue::scalar(drive_pa, Some("pA")),
    );
    StepRequest {
        session_id: session_id.to_string(),
        advance_ms: Some(advance_ms),
        stimulus: Some(StimulusFrame {
            session_id: session_id.to_string(),
            values,
            session: session.clone(),
            ..Default::default()
        }),
        session: session.clone(),
        ..Default::default()
    }
}

fn validate_session_ref(
    phase: FeatureNeuronPhase,
    session: &ncp_core::SessionRef,
) -> Result<(), FeatureNeuronError> {
    if ncp_core::is_canonical_uuid_v4(&session.generation) {
        Ok(())
    } else {
        Err(FeatureNeuronError::InvalidReply {
            phase,
            reason: "session generation is not a canonical lowercase UUIDv4".to_string(),
        })
    }
}

fn confirmed_open_session(
    opened: &ncp_core::SessionOpened,
) -> Result<ncp_core::SessionRef, FeatureNeuronError> {
    let session = opened
        .session
        .as_ref()
        .ok_or_else(|| FeatureNeuronError::InvalidReply {
            phase: FeatureNeuronPhase::Open,
            reason: "successful reply omitted the server-issued session generation".to_string(),
        })?;
    validate_session_ref(FeatureNeuronPhase::Open, session)?;
    Ok(session.clone())
}

fn verify_reply_generation(
    phase: FeatureNeuronPhase,
    expected: &ncp_core::SessionRef,
    returned: &ncp_core::SessionRef,
) -> Result<(), FeatureNeuronError> {
    validate_session_ref(phase, returned)?;
    if returned == expected {
        Ok(())
    } else {
        Err(FeatureNeuronError::InvalidReply {
            phase,
            reason: "session generation does not match the open incarnation".to_string(),
        })
    }
}

fn decode_rpc_reply(
    phase: FeatureNeuronPhase,
    request_kind: &str,
    session_id: &str,
    reply: &[u8],
) -> Result<serde_json::Value, FeatureNeuronError> {
    let value =
        ncp_core::validate_rpc_reply_for(request_kind, session_id, reply).map_err(|error| {
            FeatureNeuronError::InvalidReply {
                phase,
                reason: error.to_string(),
            }
        })?;
    if ncp_core::message_kind(&value) == Some("error") {
        let reason = value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("peer returned an invalid error frame")
            .to_string();
        Err(FeatureNeuronError::Rejected { phase, reason })
    } else {
        Ok(value)
    }
}

#[derive(Debug)]
enum CollectedReply {
    Success(Vec<u8>),
    RemoteError(String),
}

#[derive(Debug)]
enum BoundedReplyError {
    Remote(String),
    NoReply,
}

#[derive(Debug, Default)]
struct BoundedReplyCollector {
    reply: Option<CollectedReply>,
    replies_seen: usize,
}

impl BoundedReplyCollector {
    fn push_success(&mut self, payload: &ZBytes) -> Result<(), String> {
        self.push(payload, |bytes| CollectedReply::Success(bytes.to_vec()))
    }

    fn push_error(&mut self, payload: &ZBytes) -> Result<(), String> {
        self.push(payload, |bytes| {
            CollectedReply::RemoteError(String::from_utf8_lossy(bytes).into_owned())
        })
    }

    fn push(
        &mut self,
        payload: &ZBytes,
        collect: impl FnOnce(&[u8]) -> CollectedReply,
    ) -> Result<(), String> {
        if self.replies_seen >= MAX_NCP_RPC_REPLIES {
            return Err(format!(
                "RPC reply count exceeds the {MAX_NCP_RPC_REPLIES}-reply limit; responder identity is ambiguous"
            ));
        }
        self.replies_seen += 1;
        let bytes = payload.len();
        if bytes > MAX_NCP_RPC_REPLY_BYTES {
            return Err(format!(
                "RPC reply is {bytes} bytes and exceeds the {MAX_NCP_RPC_REPLY_BYTES}-byte materialization limit"
            ));
        }
        let contiguous = payload.to_bytes();
        self.reply = Some(collect(&contiguous));
        Ok(())
    }

    fn finish(self) -> Result<Vec<u8>, BoundedReplyError> {
        match self.reply {
            Some(CollectedReply::Success(bytes)) => Ok(bytes),
            Some(CollectedReply::RemoteError(reason)) => Err(BoundedReplyError::Remote(reason)),
            None => Err(BoundedReplyError::NoReply),
        }
    }
}

fn verify_reply_session(
    phase: FeatureNeuronPhase,
    requested_session_id: &str,
    returned_session_id: &str,
) -> Result<(), FeatureNeuronError> {
    if returned_session_id == requested_session_id {
        Ok(())
    } else {
        Err(FeatureNeuronError::InvalidReply {
            phase,
            reason: "session id does not match the request".to_string(),
        })
    }
}

/// Extract a finite, nonnegative spike count from one validated observation port.
///
/// # Errors
///
/// Returns [`FeatureNeuronError`] when the record or any spike time is invalid.
pub fn spike_count(
    frame: &ObservationFrame,
    port: &str,
    target: &str,
) -> Result<f64, FeatureNeuronError> {
    let observation = frame
        .records
        .get(port)
        .ok_or_else(|| FeatureNeuronError::InvalidReply {
            phase: FeatureNeuronPhase::Step,
            reason: format!("observation is missing required spike port {port:?}"),
        })?;
    if observation.port != port {
        return Err(FeatureNeuronError::InvalidReply {
            phase: FeatureNeuronPhase::Step,
            reason: format!(
                "observation record {port:?} declares mismatched port {:?}",
                observation.port
            ),
        });
    }
    if observation.target != target {
        return Err(FeatureNeuronError::InvalidReply {
            phase: FeatureNeuronPhase::Step,
            reason: format!(
                "observation port {port:?} declares target {:?}, expected {target:?}",
                observation.target
            ),
        });
    }
    if observation.observable != ncp_core::Observable::Spikes {
        return Err(FeatureNeuronError::InvalidReply {
            phase: FeatureNeuronPhase::Step,
            reason: format!(
                "observation port {port:?} returned {:?}, expected spikes",
                observation.observable
            ),
        });
    }
    if observation
        .times
        .iter()
        .any(|time| !time.is_finite() || *time < 0.0)
    {
        return Err(FeatureNeuronError::InvalidReply {
            phase: FeatureNeuronPhase::Step,
            reason: format!(
                "observation port {port:?} contains a non-finite or negative spike time"
            ),
        });
    }
    let bounded_count =
        u32::try_from(observation.times.len()).map_err(|_| FeatureNeuronError::InvalidReply {
            phase: FeatureNeuronPhase::Step,
            reason: "spike count exceeds the u32 reporting bound".to_string(),
        })?;
    let count = f64::from(bounded_count);
    validate_spike_count(count).map_err(|reason| FeatureNeuronError::InvalidReply {
        phase: FeatureNeuronPhase::Step,
        reason,
    })?;
    Ok(count)
}

fn validate_spike_count(value: f64) -> Result<(), String> {
    if value.is_finite() && value >= 0.0 {
        Ok(())
    } else {
        Err("spike count must be finite and nonnegative".to_string())
    }
}

/// Verify a close reply is successful and bound to the requested session.
///
/// # Errors
///
/// Returns [`FeatureNeuronError`] for a mismatched or rejected reply.
pub fn ensure_close_succeeded(
    session_id: &str,
    closed: &ncp_core::SessionClosed,
) -> Result<(), FeatureNeuronError> {
    validate_session_id(session_id)?;
    verify_reply_session(FeatureNeuronPhase::Close, session_id, &closed.session_id)?;
    if closed.ok {
        Ok(())
    } else {
        Err(FeatureNeuronError::Rejected {
            phase: FeatureNeuronPhase::Close,
            reason: format!("session {session_id:?}; peer returned ok=false"),
        })
    }
}

/// Verify a close reply is successful and bound to the requested incarnation.
///
/// # Errors
///
/// Returns [`FeatureNeuronError`] for a mismatched, stale, or rejected reply.
pub fn ensure_close_succeeded_for_session(
    session_id: &str,
    session: &ncp_core::SessionRef,
    closed: &ncp_core::SessionClosed,
) -> Result<(), FeatureNeuronError> {
    ensure_close_succeeded(session_id, closed)?;
    verify_reply_generation(FeatureNeuronPhase::Close, session, &closed.session)
}

trait PerceptionSession: Send + Sync + 'static {
    type Error: fmt::Display + Send + 'static;

    fn open_feature_neuron<'a>(
        &'a self,
        session_id: &'a str,
        model: &'a str,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;

    fn step_feature_neuron<'a>(
        &'a self,
        session_id: &'a str,
        drive_pa: f64,
        advance_ms: f64,
    ) -> impl Future<Output = Result<f64, Self::Error>> + Send + 'a;

    fn close<'a>(
        &'a self,
        session_id: &'a str,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'a;
}

impl PerceptionSession for FeatureNeuronClient {
    type Error = FeatureNeuronError;

    async fn open_feature_neuron(&self, session_id: &str, model: &str) -> Result<(), Self::Error> {
        self.open(session_id, model).await
    }

    async fn step_feature_neuron(
        &self,
        session_id: &str,
        drive_pa: f64,
        advance_ms: f64,
    ) -> Result<f64, Self::Error> {
        self.step(session_id, drive_pa, advance_ms).await
    }

    async fn close(&self, session_id: &str) -> Result<(), Self::Error> {
        FeatureNeuronClient::close(self, session_id).await
    }
}

trait PerceptionConnector: Send + Sync + 'static {
    type Session: PerceptionSession;
    type Error: fmt::Display + Send + 'static;

    fn connect_secure<'a>(
        &'a self,
        realm: &'a str,
    ) -> impl Future<Output = Result<Self::Session, Self::Error>> + Send + 'a;
}

struct ProductionConnector {
    config: ZenohConfig,
}

impl PerceptionConnector for ProductionConnector {
    type Session = FeatureNeuronClient;
    type Error = FeatureNeuronError;

    async fn connect_secure(&self, realm: &str) -> Result<Self::Session, Self::Error> {
        validate_realm(realm)?;
        let keys = Keys::try_new(realm.to_string()).map_err(|error| FeatureNeuronError::Rpc {
            phase: FeatureNeuronPhase::Connect,
            reason: format!("invalid realm: {error}"),
        })?;
        let bus = ZenohBus::with_config(self.config.clone(), keys)
            .await
            .map_err(|error| FeatureNeuronError::Rpc {
                phase: FeatureNeuronPhase::Connect,
                reason: error.to_string(),
            })?;
        Ok(FeatureNeuronClient::new(bus))
    }
}

async fn run_owned_with_connector<C>(
    connector: C,
    config: HeadlessSessionConfig,
) -> Result<HeadlessSessionReport, HeadlessError>
where
    C: PerceptionConnector,
{
    // The lifecycle owns its connector and configuration. Dropping the caller's
    // future detaches this bounded task instead of cancelling it between a
    // confirmed open and the required close attempt.
    tokio::spawn(async move { run_with_connector(&connector, &config).await })
        .await
        .map_err(|error| HeadlessError::LifecycleTask {
            reason: error.to_string(),
        })?
}

async fn run_with_connector<C>(
    connector: &C,
    config: &HeadlessSessionConfig,
) -> Result<HeadlessSessionReport, HeadlessError>
where
    C: PerceptionConnector,
{
    config.validate()?;
    let operation_timeout = config.operation_timeout();
    let lifecycle_started = Instant::now();
    let work_timeout = config
        .lifecycle_timeout()
        .checked_sub(operation_timeout)
        .ok_or_else(|| HeadlessError::InvalidConfiguration {
            field: "lifecycle_timeout_ms",
            reason: "does not reserve the required close window".to_string(),
        })?;
    let work_deadline = lifecycle_started + work_timeout;

    let session = run_before_deadline(
        HeadlessPhase::Connect,
        work_deadline,
        operation_timeout,
        connector.connect_secure(&config.realm),
    )
    .await?;
    run_before_deadline(
        HeadlessPhase::Open,
        work_deadline,
        operation_timeout,
        session.open_feature_neuron(&config.session_id, &config.model),
    )
    .await?;

    let mut spike_counts = Vec::with_capacity(config.steps);
    let mut primary_error = None;
    for index in 1..=config.steps {
        match run_before_deadline(
            HeadlessPhase::Step(index),
            work_deadline,
            operation_timeout,
            session.step_feature_neuron(&config.session_id, config.drive_pa, config.advance_ms),
        )
        .await
        {
            Ok(spike_count) => {
                if let Err(reason) = validate_spike_count(spike_count) {
                    primary_error = Some(HeadlessError::Operation {
                        phase: HeadlessPhase::Step(index),
                        reason,
                    });
                    break;
                }
                spike_counts.push(spike_count);
            }
            Err(error) => {
                primary_error = Some(error);
                break;
            }
        }
    }

    // Once open succeeds, always poll a bounded close attempt. The close budget
    // was reserved before connect, so step failure or deadline expiry cannot
    // consume it.
    let close_result = run_with_timeout(
        HeadlessPhase::Close,
        operation_timeout,
        session.close(&config.session_id),
    )
    .await;

    match (primary_error, close_result) {
        (None, Ok(())) => Ok(HeadlessSessionReport {
            kind: "crebain_ncp_headless_session",
            status: "rpc_lifecycle_complete",
            ncp_wire: ncp_core::NCP_VERSION,
            realm: config.realm.clone(),
            session_id: config.session_id.clone(),
            model: config.model.clone(),
            steps_requested: config.steps,
            steps_completed: spike_counts.len(),
            spike_counts,
            peer_requirement: "compatible_ncp_wire_0.8_responder",
            execution_evidence: HeadlessExecutionEvidence {
                rpc_close_confirmed: true,
                strict_client_configuration_validated: true,
            },
            claim_boundary: HeadlessClaimBoundary {
                security_policy_proven: false,
                responder_identity_proven: false,
                end_to_end_effect_proven: false,
            },
        }),
        (Some(primary), Ok(())) => Err(primary),
        (None, Err(close)) => Err(close),
        (Some(primary), Err(close)) => Err(HeadlessError::LifecycleAndClose {
            primary: Box::new(primary),
            close: Box::new(close),
        }),
    }
}

async fn run_before_deadline<T, E, F>(
    phase: HeadlessPhase,
    deadline: Instant,
    operation_timeout: Duration,
    future: F,
) -> Result<T, HeadlessError>
where
    E: fmt::Display,
    F: Future<Output = Result<T, E>>,
{
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(HeadlessError::Timeout {
            phase,
            timeout_ms: 0,
        });
    }
    run_with_timeout(phase, operation_timeout.min(remaining), future).await
}

async fn run_with_timeout<T, E, F>(
    phase: HeadlessPhase,
    timeout: Duration,
    future: F,
) -> Result<T, HeadlessError>
where
    E: fmt::Display,
    F: Future<Output = Result<T, E>>,
{
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| HeadlessError::Timeout {
            phase,
            timeout_ms: timeout.as_millis(),
        })?
        .map_err(|error| HeadlessError::Operation {
            phase,
            reason: error.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    #[derive(Default)]
    struct FakeState {
        calls: Vec<String>,
        connect_result: Option<Result<(), String>>,
        open_result: Option<Result<(), String>>,
        step_results: VecDeque<Result<f64, String>>,
        close_result: Option<Result<(), String>>,
        pending_open: bool,
        pending_step: bool,
    }

    #[derive(Clone)]
    struct FakeSession {
        state: Arc<Mutex<FakeState>>,
    }

    struct FakeConnector {
        state: Arc<Mutex<FakeState>>,
    }

    impl FakeConnector {
        fn new(state: FakeState) -> Self {
            Self {
                state: Arc::new(Mutex::new(state)),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .calls
                .clone()
        }
    }

    impl PerceptionConnector for FakeConnector {
        type Session = FakeSession;
        type Error = String;

        async fn connect_secure(&self, realm: &str) -> Result<Self::Session, Self::Error> {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.calls.push(format!("connect:{realm}:secure"));
            state.connect_result.take().unwrap_or(Ok(()))?;
            Ok(FakeSession {
                state: Arc::clone(&self.state),
            })
        }
    }

    impl PerceptionSession for FakeSession {
        type Error = String;

        async fn open_feature_neuron(
            &self,
            session_id: &str,
            model: &str,
        ) -> Result<(), Self::Error> {
            let pending = {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state.calls.push(format!("open:{session_id}:{model}"));
                state.pending_open
            };
            if pending {
                std::future::pending::<Result<(), String>>().await
            } else {
                self.state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .open_result
                    .take()
                    .unwrap_or(Ok(()))
            }
        }

        async fn step_feature_neuron(
            &self,
            session_id: &str,
            drive_pa: f64,
            advance_ms: f64,
        ) -> Result<f64, Self::Error> {
            let pending = {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state
                    .calls
                    .push(format!("step:{session_id}:{drive_pa}:{advance_ms}"));
                state.pending_step
            };
            if pending {
                std::future::pending::<Result<f64, String>>().await
            } else {
                self.state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .step_results
                    .pop_front()
                    .unwrap_or(Ok(0.0))
            }
        }

        async fn close(&self, session_id: &str) -> Result<(), Self::Error> {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.calls.push(format!("close:{session_id}"));
            state.close_result.take().unwrap_or(Ok(()))
        }
    }

    fn fast_config(steps: usize) -> HeadlessSessionConfig {
        HeadlessSessionConfig {
            steps,
            operation_timeout_ms: MIN_OPERATION_TIMEOUT_MS,
            lifecycle_timeout_ms: MIN_OPERATION_TIMEOUT_MS * REQUIRED_OPERATION_BUDGETS,
            ..HeadlessSessionConfig::new("headless-test")
        }
    }

    fn test_session(generation: &str) -> ncp_core::SessionRef {
        ncp_core::SessionRef {
            generation: generation.to_string(),
        }
    }

    const TEST_GENERATION: &str = "00000000-0000-4000-8000-0000000000a2";
    const STALE_GENERATION: &str = "00000000-0000-4000-8000-0000000000b3";

    #[test]
    fn parser_requires_an_explicit_command_and_session() {
        assert!(matches!(
            parse_args(Vec::<String>::new()),
            Err(HeadlessError::Usage(_))
        ));
        assert!(matches!(
            parse_args(["run"]),
            Err(HeadlessError::Usage(reason)) if reason.contains("--session-id")
        ));
        assert_eq!(parse_args(["--help"]).unwrap(), HeadlessCommand::Help);
    }

    #[test]
    fn parser_applies_bounded_defaults_and_rejects_duplicates() {
        let command = parse_args(["run", "--session-id", "session-a"]).unwrap();
        assert_eq!(
            command,
            HeadlessCommand::Run(HeadlessSessionConfig::new("session-a"))
        );
        assert!(matches!(
            parse_args([
                "validate",
                "--session-id",
                "session-a",
                "--steps",
                "1",
                "--steps",
                "2"
            ]),
            Err(HeadlessError::Usage(reason)) if reason.contains("more than once")
        ));
    }

    #[test]
    fn parser_rejects_unknown_odd_and_non_utf8_arguments() {
        assert!(matches!(
            parse_args([
                "run",
                "--session-id",
                "session-a",
                "--unknown",
                "value"
            ]),
            Err(HeadlessError::Usage(reason)) if reason.contains("unknown option")
        ));
        assert!(matches!(
            parse_args(["run", "--session-id", "session-a", "--steps"]),
            Err(HeadlessError::Usage(reason)) if reason.contains("requires a value")
        ));

        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;

            let arguments = vec![
                OsString::from("run"),
                OsString::from("--session-id"),
                OsString::from_vec(vec![0xff]),
            ];
            assert!(matches!(
                parse_args(arguments),
                Err(HeadlessError::Usage(reason)) if reason.contains("UTF-8")
            ));
        }
    }

    #[test]
    fn config_rejects_unbounded_work_and_missing_close_budget() {
        let mut config = HeadlessSessionConfig::new("session-a");
        config.steps = MAX_HEADLESS_STEPS + 1;
        assert!(matches!(
            config.validate(),
            Err(HeadlessError::InvalidConfiguration { field: "steps", .. })
        ));

        config.steps = 1;
        config.lifecycle_timeout_ms = config.operation_timeout_ms * 3;
        assert!(matches!(
            config.validate(),
            Err(HeadlessError::InvalidConfiguration {
                field: "lifecycle_timeout_ms",
                ..
            })
        ));
    }

    #[test]
    fn config_accepts_timeout_boundaries_and_rejects_values_outside_them() {
        let mut config = HeadlessSessionConfig::new("session-a");
        config.operation_timeout_ms = MIN_OPERATION_TIMEOUT_MS;
        config.lifecycle_timeout_ms = MIN_OPERATION_TIMEOUT_MS * REQUIRED_OPERATION_BUDGETS;
        assert!(config.validate().is_ok());

        config.operation_timeout_ms = MAX_OPERATION_TIMEOUT_MS;
        config.lifecycle_timeout_ms = MAX_OPERATION_TIMEOUT_MS * REQUIRED_OPERATION_BUDGETS;
        assert!(config.validate().is_ok());

        config.operation_timeout_ms = MIN_OPERATION_TIMEOUT_MS - 1;
        assert!(matches!(
            config.validate(),
            Err(HeadlessError::InvalidConfiguration {
                field: "operation_timeout_ms",
                ..
            })
        ));

        config.operation_timeout_ms = MAX_OPERATION_TIMEOUT_MS + 1;
        assert!(matches!(
            config.validate(),
            Err(HeadlessError::InvalidConfiguration {
                field: "operation_timeout_ms",
                ..
            })
        ));

        config.operation_timeout_ms = MIN_OPERATION_TIMEOUT_MS;
        config.lifecycle_timeout_ms = MAX_LIFECYCLE_TIMEOUT_MS + 1;
        assert!(matches!(
            config.validate(),
            Err(HeadlessError::InvalidConfiguration {
                field: "lifecycle_timeout_ms",
                ..
            })
        ));
    }

    #[test]
    fn parser_rejects_zero_steps() {
        assert!(matches!(
            parse_args(["run", "--session-id", "session-a", "--steps", "0"]),
            Err(HeadlessError::InvalidConfiguration { field: "steps", .. })
        ));
    }

    #[test]
    fn session_identifier_limit_matches_the_wire_contract() {
        assert!(validate_session_id(&"s".repeat(MAX_SESSION_ID_BYTES)).is_ok());
        assert!(validate_session_id(&"s".repeat(MAX_SESSION_ID_BYTES + 1)).is_err());
    }

    #[test]
    fn step_request_echoes_the_server_issued_generation_in_both_locations() {
        let session = test_session(TEST_GENERATION);
        let request = feature_neuron_step_request("session-a", &session, 500.0, 10.0);
        assert_eq!(request.session, session);
        assert_eq!(
            request.stimulus.as_ref().map(|frame| &frame.session),
            Some(&request.session)
        );
        let value = serde_json::to_value(request).unwrap();
        assert!(ncp_core::validate(&value).is_ok(), "{value}");
    }

    #[test]
    fn close_request_carries_the_server_issued_generation() {
        let session = test_session(TEST_GENERATION);
        let request = CloseSession {
            session_id: "session-a".to_string(),
            session: session.clone(),
            ..Default::default()
        };
        assert_eq!(request.session, session);
        let value = serde_json::to_value(request).unwrap();
        assert!(ncp_core::validate(&value).is_ok(), "{value}");
    }

    #[test]
    fn successful_open_requires_a_canonical_server_generation() {
        let missing = ncp_core::SessionOpened {
            session_id: "session-a".to_string(),
            ok: true,
            session: None,
            ..Default::default()
        };
        assert!(matches!(
            confirmed_open_session(&missing),
            Err(FeatureNeuronError::InvalidReply {
                phase: FeatureNeuronPhase::Open,
                ..
            })
        ));

        let invalid = ncp_core::SessionOpened {
            session_id: "session-a".to_string(),
            ok: true,
            session: Some(test_session("not-a-generation")),
            ..Default::default()
        };
        assert!(confirmed_open_session(&invalid).is_err());
    }

    #[test]
    fn stale_step_and_close_generations_are_rejected() {
        let expected = test_session(TEST_GENERATION);
        let stale = test_session(STALE_GENERATION);
        assert!(verify_reply_generation(FeatureNeuronPhase::Step, &expected, &stale).is_err());

        let closed = ncp_core::SessionClosed {
            session_id: "session-a".to_string(),
            ok: true,
            session: stale,
            ..Default::default()
        };
        assert!(ensure_close_succeeded_for_session("session-a", &expected, &closed).is_err());
    }

    #[test]
    fn uncertain_step_cannot_be_reused_but_can_be_closed() {
        let session = test_session(TEST_GENERATION);
        let mut state = FeatureSessionState::Open(session.clone());

        assert_eq!(
            begin_step_transition("session-a", &mut state).unwrap(),
            session
        );
        assert_eq!(state, FeatureSessionState::Stepping(session.clone()));
        assert!(begin_step_transition("session-a", &mut state).is_err());

        assert_eq!(
            begin_close_transition("session-a", &mut state).unwrap(),
            session
        );
        assert_eq!(state, FeatureSessionState::Closing(session));
    }

    #[test]
    fn confirmed_step_restores_the_exact_open_incarnation() {
        let session = test_session(TEST_GENERATION);
        let mut state = FeatureSessionState::Open(session.clone());
        begin_step_transition("session-a", &mut state).unwrap();
        confirm_step_transition("session-a", &mut state, &session).unwrap();
        assert_eq!(state, FeatureSessionState::Open(session));
    }

    #[test]
    fn spike_count_rejects_negative_times() {
        let mut frame = ObservationFrame::default();
        frame.records.insert(
            "spk".to_string(),
            ncp_core::Observation {
                port: "spk".to_string(),
                target: "feat".to_string(),
                observable: ncp_core::Observable::Spikes,
                times: vec![-0.1],
                senders: vec![0],
                ..Default::default()
            },
        );
        assert!(matches!(
            spike_count(&frame, "spk", "feat"),
            Err(FeatureNeuronError::InvalidReply { reason, .. }) if reason.contains("negative")
        ));
    }

    #[test]
    fn typed_reply_gate_rejects_wrong_kind_and_surfaces_typed_error() {
        let session = test_session(TEST_GENERATION);
        let wrong_kind = serde_json::to_vec(&ncp_core::SessionClosed {
            session_id: "session-a".to_string(),
            ok: true,
            session: session.clone(),
            ..Default::default()
        })
        .unwrap();
        assert!(matches!(
            decode_rpc_reply(
                FeatureNeuronPhase::Step,
                "step_request",
                "session-a",
                &wrong_kind
            ),
            Err(FeatureNeuronError::InvalidReply { .. })
        ));

        let error = serde_json::to_vec(&ncp_core::ErrorFrame {
            error: "denied".to_string(),
            session_id: Some("session-a".to_string()),
            request_kind: Some("step_request".to_string()),
            session: Some(session),
            ..Default::default()
        })
        .unwrap();
        assert!(matches!(
            decode_rpc_reply(
                FeatureNeuronPhase::Step,
                "step_request",
                "session-a",
                &error
            ),
            Err(FeatureNeuronError::Rejected { reason, .. }) if reason == "denied"
        ));
    }

    #[test]
    fn reply_collector_accepts_one_bounded_success() {
        let mut collector = BoundedReplyCollector::default();
        let boundary = vec![7; MAX_NCP_RPC_REPLY_BYTES];
        collector
            .push_success(&ZBytes::from(boundary.clone()))
            .unwrap();
        assert_eq!(collector.finish().unwrap(), boundary);
    }

    #[test]
    fn reply_collector_surfaces_one_bounded_error() {
        let mut collector = BoundedReplyCollector::default();
        collector
            .push_error(&ZBytes::from(b"remote denied".to_vec()))
            .unwrap();
        assert!(matches!(
            collector.finish(),
            Err(BoundedReplyError::Remote(reason)) if reason == "remote denied"
        ));
    }

    #[test]
    fn reply_collector_rejects_oversize_before_materialization() {
        let mut collector = BoundedReplyCollector::default();
        let oversized = ZBytes::from(vec![0; MAX_NCP_RPC_REPLY_BYTES + 1]);
        let error = collector.push_success(&oversized).unwrap_err();
        assert!(error.contains("materialization limit"));
    }

    #[test]
    fn reply_collector_rejects_a_second_reply_before_materialization() {
        let mut collector = BoundedReplyCollector::default();
        collector.push_success(&ZBytes::from(vec![1])).unwrap();
        let oversized_second = ZBytes::from(vec![0; MAX_NCP_RPC_REPLY_BYTES + 1]);
        let error = collector.push_error(&oversized_second).unwrap_err();
        assert!(error.contains("reply count"));
    }

    #[test]
    fn reply_collector_rejects_no_reply() {
        assert!(matches!(
            BoundedReplyCollector::default().finish(),
            Err(BoundedReplyError::NoReply)
        ));
    }

    #[test]
    fn feature_session_registry_rejects_capacity_plus_one() {
        let mut sessions = HashMap::new();
        for index in 0..MAX_FEATURE_NEURON_SESSIONS {
            reserve_feature_session(&mut sessions, &format!("session-{index}"))
                .expect("entries within the bound must be admitted");
        }
        assert!(matches!(
            reserve_feature_session(&mut sessions, "session-overflow"),
            Err(FeatureNeuronError::State { reason }) if reason.contains("registry limit")
        ));
    }

    #[test]
    fn secure_config_preflight_rejects_directory_oversize_and_malformed_input() {
        use std::io::Write;

        let directory = tempfile::tempdir().unwrap();
        assert!(matches!(
            preflight_secure_config(directory.path()),
            Err(HeadlessError::SecureConfig { reason }) if reason.contains("regular file")
        ));

        let oversized = tempfile::NamedTempFile::new().unwrap();
        oversized
            .as_file()
            .set_len(MAX_ZENOH_CONFIG_BYTES + 1)
            .unwrap();
        assert!(matches!(
            preflight_secure_config(oversized.path()),
            Err(HeadlessError::SecureConfig { reason }) if reason.contains("byte limit")
        ));

        let mut malformed = tempfile::NamedTempFile::new().unwrap();
        malformed.write_all(b"{ invalid config").unwrap();
        assert!(matches!(
            preflight_secure_config(malformed.path()),
            Err(HeadlessError::SecureConfig { reason }) if reason.contains("cannot parse")
        ));

        let mut non_utf8 = tempfile::NamedTempFile::new().unwrap();
        non_utf8.write_all(&[0xff]).unwrap();
        assert!(matches!(
            preflight_secure_config(non_utf8.path()),
            Err(HeadlessError::SecureConfig { reason }) if reason.contains("valid UTF-8")
        ));
    }

    fn strict_client_config(connect: &str, listen: &str, verify_name: bool) -> ZenohConfig {
        ZenohConfig::from_json5(&format!(
            r#"{{
                mode: "client",
                scouting: {{
                    multicast: {{ enabled: false }},
                    gossip: {{ enabled: false }},
                }},
                connect: {{ endpoints: {connect} }},
                listen: {{ endpoints: {listen} }},
                transport: {{ link: {{ tls: {{
                    root_ca_certificate: "ca.pem",
                    connect_certificate: "client.pem",
                    connect_private_key: "client.key",
                    verify_name_on_connect: {verify_name},
                }} }} }},
            }}"#
        ))
        .unwrap()
    }

    #[test]
    fn strict_secure_snapshot_accepts_the_pinned_client_posture() {
        let config = strict_client_config(r#"["tls/127.0.0.1:7447"]"#, "[]", true);
        assert!(validate_secure_client_config(&config).is_ok());
    }

    #[test]
    fn strict_secure_snapshot_rejects_plaintext_connect_endpoint() {
        let plaintext = strict_client_config(r#"["tcp/127.0.0.1:7447"]"#, "[]", true);
        assert!(validate_secure_client_config(&plaintext).is_err());
    }

    #[test]
    fn strict_secure_snapshot_rejects_listen_endpoint() {
        let listener = strict_client_config(
            r#"["tls/127.0.0.1:7447"]"#,
            r#"["tls/127.0.0.1:7448"]"#,
            true,
        );
        assert!(validate_secure_client_config(&listener).is_err());
    }

    #[test]
    fn strict_secure_snapshot_rejects_disabled_name_check() {
        let no_name_check = strict_client_config(r#"["tls/127.0.0.1:7447"]"#, "[]", false);
        assert!(validate_secure_client_config(&no_name_check).is_err());
    }

    #[test]
    fn strict_secure_snapshot_rejects_server_mode_scouting_and_missing_identity() {
        let valid = strict_client_config(r#"["tls/127.0.0.1:7447"]"#, "[]", true);

        let mut server = valid.clone();
        server.insert_json5("mode", r#""peer""#).unwrap();
        assert!(validate_secure_client_config(&server).is_err());

        let mut scouting = valid.clone();
        scouting
            .insert_json5("scouting/multicast/enabled", "true")
            .unwrap();
        assert!(validate_secure_client_config(&scouting).is_err());

        let mut missing_identity = valid;
        missing_identity
            .insert_json5("transport/link/tls/connect_private_key", r#""""#)
            .unwrap();
        assert!(validate_secure_client_config(&missing_identity).is_err());
    }

    #[test]
    fn self_check_is_wire_exact_secure_and_network_free() {
        let report = self_check().unwrap();
        assert_eq!(report.ncp_wire, EXPECTED_NCP_WIRE);
        assert_eq!(report.contract_hash, EXPECTED_NCP_CONTRACT_HASH);
        assert_eq!(report.strict_client_configuration, "required_for_run");
        assert_eq!(report.scope, "perception_rpc_only");
        assert!(!report.network_opened);
    }

    #[test]
    fn dispatch_keeps_offline_commands_synchronous_and_run_explicit() {
        assert!(matches!(
            dispatch(HeadlessCommand::SelfCheck).unwrap(),
            HeadlessDispatch::Offline(HeadlessOutput::SelfCheck(_))
        ));
        assert!(matches!(
            dispatch(HeadlessCommand::Run(HeadlessSessionConfig::new("session-a"))).unwrap(),
            HeadlessDispatch::Run(config) if config.session_id == "session-a"
        ));
    }

    #[tokio::test]
    async fn successful_session_uses_exact_order_and_closes() {
        let connector = FakeConnector::new(FakeState {
            step_results: VecDeque::from([Ok(2.0), Ok(3.0)]),
            ..FakeState::default()
        });
        let report = run_with_connector(&connector, &fast_config(2))
            .await
            .unwrap();
        assert_eq!(report.spike_counts, vec![2.0, 3.0]);
        assert_eq!(report.steps_completed, 2);
        assert!(report.execution_evidence.rpc_close_confirmed);
        assert!(
            report
                .execution_evidence
                .strict_client_configuration_validated
        );
        assert!(!report.claim_boundary.security_policy_proven);
        assert!(!report.claim_boundary.responder_identity_proven);
        assert!(!report.claim_boundary.end_to_end_effect_proven);
        assert_eq!(
            connector.calls(),
            [
                "connect:engram/ncp:secure",
                "open:headless-test:iaf_psc_alpha",
                "step:headless-test:500:10",
                "step:headless-test:500:10",
                "close:headless-test"
            ]
        );
    }

    #[tokio::test]
    async fn step_failure_still_closes_the_confirmed_session() {
        let connector = FakeConnector::new(FakeState {
            step_results: VecDeque::from([Err("peer rejected step".to_string())]),
            ..FakeState::default()
        });
        let error = run_with_connector(&connector, &fast_config(1))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            HeadlessError::Operation {
                phase: HeadlessPhase::Step(1),
                ..
            }
        ));
        assert_eq!(
            connector.calls().last().map(String::as_str),
            Some("close:headless-test")
        );
    }

    #[tokio::test]
    async fn open_failure_does_not_step_or_close_an_unconfirmed_session() {
        let connector = FakeConnector::new(FakeState {
            open_result: Some(Err("not opened".to_string())),
            ..FakeState::default()
        });
        let error = run_with_connector(&connector, &fast_config(1))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            HeadlessError::Operation {
                phase: HeadlessPhase::Open,
                ..
            }
        ));
        assert_eq!(
            connector.calls(),
            [
                "connect:engram/ncp:secure",
                "open:headless-test:iaf_psc_alpha"
            ]
        );
    }

    #[tokio::test]
    async fn open_timeout_reports_ambiguity_without_claiming_remote_cleanup() {
        let connector = FakeConnector::new(FakeState {
            pending_open: true,
            ..FakeState::default()
        });
        let error = run_with_connector(&connector, &fast_config(1))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            HeadlessError::Timeout {
                phase: HeadlessPhase::Open,
                ..
            }
        ));
        assert_eq!(
            connector.calls(),
            [
                "connect:engram/ncp:secure",
                "open:headless-test:iaf_psc_alpha"
            ]
        );
    }

    #[tokio::test]
    async fn primary_and_close_failures_are_both_retained() {
        let connector = FakeConnector::new(FakeState {
            step_results: VecDeque::from([Err("step failed".to_string())]),
            close_result: Some(Err("close failed".to_string())),
            ..FakeState::default()
        });
        let error = run_with_connector(&connector, &fast_config(1))
            .await
            .unwrap_err();
        assert!(matches!(error, HeadlessError::LifecycleAndClose { .. }));
        let message = error.to_string();
        assert!(message.contains("step failed"));
        assert!(message.contains("close failed"));
    }

    #[tokio::test]
    async fn timed_out_step_still_gets_a_bounded_close_attempt() {
        let connector = FakeConnector::new(FakeState {
            pending_step: true,
            ..FakeState::default()
        });
        let error = run_with_connector(&connector, &fast_config(1))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            HeadlessError::Timeout {
                phase: HeadlessPhase::Step(1),
                ..
            }
        ));
        assert_eq!(
            connector.calls().last().map(String::as_str),
            Some("close:headless-test")
        );
    }

    #[tokio::test]
    async fn cancelling_the_caller_does_not_cancel_cleanup_after_open() {
        let connector = FakeConnector::new(FakeState {
            pending_step: true,
            ..FakeState::default()
        });
        let observed_state = Arc::clone(&connector.state);
        let config = HeadlessSessionConfig {
            operation_timeout_ms: 25,
            lifecycle_timeout_ms: 100,
            ..fast_config(1)
        };

        let caller = tokio::spawn(run_owned_with_connector(connector, config));
        tokio::time::timeout(Duration::from_millis(100), async {
            loop {
                let step_started = observed_state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .calls
                    .iter()
                    .any(|call| call.starts_with("step:"));
                if step_started {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the owned lifecycle must reach a step");

        caller.abort();
        assert!(caller
            .await
            .expect_err("the caller must be cancelled")
            .is_cancelled());

        tokio::time::timeout(Duration::from_millis(200), async {
            loop {
                let close_attempted = observed_state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .calls
                    .iter()
                    .any(|call| call == "close:headless-test");
                if close_attempted {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the detached lifecycle must retain its bounded close attempt");
    }

    #[tokio::test]
    async fn nonfinite_or_negative_spike_counts_fail_and_still_close() {
        for invalid_count in [f64::NAN, -1.0] {
            let connector = FakeConnector::new(FakeState {
                step_results: VecDeque::from([Ok(invalid_count)]),
                ..FakeState::default()
            });
            let error = run_with_connector(&connector, &fast_config(1))
                .await
                .unwrap_err();
            assert!(matches!(
                error,
                HeadlessError::Operation {
                    phase: HeadlessPhase::Step(1),
                    ..
                }
            ));
            assert_eq!(
                connector.calls().last().map(String::as_str),
                Some("close:headless-test")
            );
        }
    }
}

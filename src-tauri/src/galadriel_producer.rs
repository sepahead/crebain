//! Bounded publication runtime for Galadriel observation and lifecycle evidence.
//!
//! The runtime is deliberately inert unless an operator explicitly enables it.
//! Enabled startup pins one registry, frame, projection context, producer build,
//! and fusion configuration before opening an authenticated Zenoh session.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ncp_core::{valid_id_segment, Keys, JSON_SAFE_INTEGER_MAX};
use ncp_zenoh::{Plane, ZenohBus};

use crate::galadriel_registry::{
    DeploymentRegistry, MAX_ACTIVE_TRACKS, MAX_FRAME_ITEMS, MAX_MONITOR_QUEUE_EVENTS,
    MAX_REGISTRY_BYTES,
};
use crate::pid_observation::{sidecar_key, PidObservation, SidecarEnvelope};
use crate::producer_monitor::{
    monitor_key, FrameSummary, Heartbeat, ModalityMissReason, ModalityOutcomeKind, MonitorEnvelope,
    ProducerEvent, QueueHealth, MAX_HEARTBEAT_DURATION_MS,
};
use crate::sensor_fusion::{FrozenOpportunityTrack, OpportunityInput, SensorModality};

/// Exact opt-in switch. No other value enables publication.
pub const ENABLE_ENV: &str = "CREBAIN_GALADRIEL_ENABLE";
/// NCP realm used for both named perception routes.
pub const REALM_ENV: &str = "CREBAIN_GALADRIEL_REALM";
/// Concrete authenticated producer identity carried by every envelope.
pub const PRODUCER_ID_ENV: &str = "CREBAIN_GALADRIEL_PRODUCER_ID";
/// Path to the immutable deployment-registry JSON document.
pub const REGISTRY_PATH_ENV: &str = "CREBAIN_GALADRIEL_REGISTRY_PATH";
/// Expected lowercase SHA-256 digest of the canonical deployment registry.
pub const REGISTRY_DIGEST_ENV: &str = "CREBAIN_GALADRIEL_REGISTRY_DIGEST";
/// Explicit deployed common-frame identifier.
pub const FRAME_ID_ENV: &str = "CREBAIN_GALADRIEL_FRAME_ID";
/// Explicit deployed projection-context identifier.
pub const CONTEXT_ID_ENV: &str = "CREBAIN_GALADRIEL_CONTEXT_ID";
/// Expected producer-software digest pinned by the selected context.
pub const SOFTWARE_DIGEST_ENV: &str = "CREBAIN_GALADRIEL_SOFTWARE_DIGEST";
/// Expected bounded fusion-configuration digest pinned by the selected context.
pub const CONFIGURATION_DIGEST_ENV: &str = "CREBAIN_GALADRIEL_CONFIGURATION_DIGEST";
/// Optional heartbeat interval in milliseconds.
pub const HEARTBEAT_INTERVAL_ENV: &str = "CREBAIN_GALADRIEL_HEARTBEAT_INTERVAL_MS";
/// Optional receiver heartbeat deadline in milliseconds.
pub const HEARTBEAT_DEADLINE_ENV: &str = "CREBAIN_GALADRIEL_HEARTBEAT_DEADLINE_MS";
/// Optional observation-lane capacity.
pub const OBSERVATION_CAPACITY_ENV: &str = "CREBAIN_GALADRIEL_OBSERVATION_QUEUE_CAPACITY";
/// Optional outcome/miss-lane capacity.
pub const OUTCOME_CAPACITY_ENV: &str = "CREBAIN_GALADRIEL_OUTCOME_QUEUE_CAPACITY";
/// Optional frame-summary-lane capacity.
pub const SUMMARY_CAPACITY_ENV: &str = "CREBAIN_GALADRIEL_SUMMARY_QUEUE_CAPACITY";
/// Optional heartbeat-lane capacity.
pub const HEARTBEAT_CAPACITY_ENV: &str = "CREBAIN_GALADRIEL_HEARTBEAT_QUEUE_CAPACITY";

const DEFAULT_HEARTBEAT_INTERVAL_MS: u64 = 1_000;
const DEFAULT_HEARTBEAT_DEADLINE_MS: u64 = 3_000;
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const IDENTITY_MAX_BYTES: usize = 64;
const SHA256_HEX_LEN: usize = 64;
const WORKER_IDLE_POLL: Duration = Duration::from_millis(100);
const JSON_SAFE_U64_MAX: u64 = JSON_SAFE_INTEGER_MAX as u64;

/// Failure to configure, admit to, transmit from, or stop the runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProducerRuntimeError {
    /// An enabled deployment variable is missing or malformed.
    Configuration(String),
    /// The pinned registry could not be read or validated.
    Registry(String),
    /// The enabled deployment cannot open its secure NCP transport.
    Transport(String),
    /// A frame batch violates the configured contract.
    InvalidFrame(String),
    /// The global JSON-safe event sequence cannot accommodate an admission.
    EventSequenceExhausted,
    /// Admission was attempted after shutdown began.
    ShuttingDown,
    /// Runtime startup was attempted outside a Tokio runtime.
    NoAsyncRuntime,
}

impl fmt::Display for ProducerRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(error) => {
                write!(formatter, "invalid Galadriel configuration: {error}")
            }
            Self::Registry(error) => write!(formatter, "invalid Galadriel registry: {error}"),
            Self::Transport(error) => write!(formatter, "Galadriel transport failed: {error}"),
            Self::InvalidFrame(error) => {
                write!(formatter, "invalid Galadriel frame batch: {error}")
            }
            Self::EventSequenceExhausted => {
                write!(formatter, "Galadriel monitor event sequence exhausted")
            }
            Self::ShuttingDown => write!(formatter, "Galadriel producer is shutting down"),
            Self::NoAsyncRuntime => write!(
                formatter,
                "Galadriel producer startup requires an active Tokio runtime"
            ),
        }
    }
}

impl std::error::Error for ProducerRuntimeError {}

/// One fusion frame's bounded publication material.
///
/// `events` may contain only modality outcomes and modality misses. The runtime
/// pins the summary registry digest, recomputes its outcome/v1 counts, and binds
/// every record to the configured frame and context before admission.
#[derive(Debug, Clone)]
pub struct FusionFrameBatch {
    /// In-process numeric identities frozen before association and update.
    /// Used only to prove complete Cartesian opportunity accounting.
    pub frozen_track_ids: Vec<u64>,
    /// Frozen track classes used to re-derive the candidate Cartesian product.
    pub frozen_opportunity_tracks: Vec<FrozenOpportunityTrack>,
    /// Ordered input modalities/classes used to verify attempts and miss depth.
    pub opportunity_inputs: Vec<OpportunityInput>,
    /// Frozen-v1 observation envelopes to transmit on the observation lane.
    pub observations: Vec<PidObservation>,
    /// Outcome and miss monitor events in deterministic producer order.
    pub events: Vec<ProducerEvent>,
    /// Whole-frame accounting record finalized by the runtime.
    pub summary: FrameSummary,
}

/// Queue capacities for the four independently admitted lanes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueCapacities {
    /// Frozen-v1 observation lane.
    pub observations: u32,
    /// Modality outcome/miss lane.
    pub outcomes: u32,
    /// Frame summary lane.
    pub summaries: u32,
    /// Heartbeat lane.
    pub heartbeats: u32,
}

impl QueueCapacities {
    fn from_registry(registry: &DeploymentRegistry) -> Result<Self, ProducerRuntimeError> {
        let total = registry.opportunity_policy().max_monitor_queue_events();
        if total < 4 {
            return Err(ProducerRuntimeError::Configuration(
                "registry max_monitor_queue_events must reserve at least one slot per lane"
                    .to_string(),
            ));
        }
        let observations = (total / 4)
            .max(1)
            .min(registry.opportunity_policy().max_frame_inputs());
        let outcomes = total - observations - 2;
        Ok(Self {
            observations,
            outcomes,
            summaries: 1,
            heartbeats: 1,
        })
    }

    fn total(self) -> Option<u32> {
        self.observations
            .checked_add(self.outcomes)?
            .checked_add(self.summaries)?
            .checked_add(self.heartbeats)
    }

    fn validate(self, registry: &DeploymentRegistry) -> Result<(), ProducerRuntimeError> {
        if [
            self.observations,
            self.outcomes,
            self.summaries,
            self.heartbeats,
        ]
        .contains(&0)
        {
            return Err(ProducerRuntimeError::Configuration(
                "every Galadriel publisher lane must have positive capacity".to_string(),
            ));
        }
        let total = self.total().ok_or_else(|| {
            ProducerRuntimeError::Configuration("publisher queue capacity overflow".to_string())
        })?;
        let policy = registry.opportunity_policy();
        if total > MAX_MONITOR_QUEUE_EVENTS || total > policy.max_monitor_queue_events() {
            return Err(ProducerRuntimeError::Configuration(format!(
                "aggregate publisher capacity {total} exceeds registry/wire maximum {}",
                policy
                    .max_monitor_queue_events()
                    .min(MAX_MONITOR_QUEUE_EVENTS)
            )));
        }
        if self.observations > policy.max_frame_inputs() {
            return Err(ProducerRuntimeError::Configuration(format!(
                "observation capacity {} exceeds registry max_frame_inputs {}",
                self.observations,
                policy.max_frame_inputs()
            )));
        }
        if self.outcomes > policy.max_outcomes_per_frame() {
            return Err(ProducerRuntimeError::Configuration(format!(
                "outcome capacity {} exceeds registry max_outcomes_per_frame {}",
                self.outcomes,
                policy.max_outcomes_per_frame()
            )));
        }
        Ok(())
    }
}

/// Queue occupancy at one status snapshot.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QueueDepths {
    /// Waiting frozen-v1 observations.
    pub observations: u32,
    /// Waiting outcome/miss monitor events.
    pub outcomes: u32,
    /// Waiting frame summaries.
    pub summaries: u32,
    /// Waiting heartbeats.
    pub heartbeats: u32,
}

impl QueueDepths {
    fn total(self) -> u32 {
        self.observations
            .saturating_add(self.outcomes)
            .saturating_add(self.summaries)
            .saturating_add(self.heartbeats)
    }
}

/// Cumulative, JSON-safe publication counters for one producer epoch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProducerCounters {
    /// Observation envelopes admitted to their lane.
    pub admitted_observations: u64,
    /// Monitor envelopes admitted across all monitor lanes.
    pub admitted_monitor_events: u64,
    /// Observation envelopes successfully handed to Zenoh.
    pub published_observations: u64,
    /// Monitor envelopes successfully handed to Zenoh.
    pub published_monitor_events: u64,
    /// Observation envelopes dropped at admission or after transport failure.
    pub dropped_observations: u64,
    /// Monitor envelopes dropped at admission or after transport failure.
    pub dropped_monitor_events: u64,
    /// Observation transport calls that failed or timed out.
    pub failed_observation_publishes: u64,
    /// Monitor transport calls that failed or timed out.
    pub failed_monitor_publishes: u64,
}

impl ProducerCounters {
    fn published_total(self) -> u64 {
        self.published_observations
            .saturating_add(self.published_monitor_events)
            .min(JSON_SAFE_U64_MAX)
    }

    fn dropped_total(self) -> u64 {
        self.dropped_observations
            .saturating_add(self.dropped_monitor_events)
            .min(JSON_SAFE_U64_MAX)
    }
}

/// Immutable view of runtime health and bounded queue state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProducerStatus {
    /// Fresh producer epoch used as the NCP session id.
    pub epoch: String,
    /// Last fusion sequence reported by frame admission or status update.
    pub last_fusion_seq: Option<u64>,
    /// Current number of active fusion tracks.
    pub active_track_count: u32,
    /// Permanent epoch-level degradation latch.
    pub degraded: bool,
    /// Next monitor sequence, or `None` after checked exhaustion.
    pub next_event_seq: Option<u64>,
    /// Per-lane queue occupancy.
    pub queue_depths: QueueDepths,
    /// Per-lane aggregate counters.
    pub counters: ProducerCounters,
    /// Whether shutdown has been requested.
    pub shutdown_requested: bool,
}

/// Result of one atomic frame admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionReport {
    /// Sequences reserved for all outcome/miss events followed by the summary.
    pub assigned_monitor_sequences: Vec<u64>,
    /// Observation envelopes accepted by the observation lane.
    pub admitted_observations: u32,
    /// Observation envelopes dropped newest by the observation lane.
    pub dropped_observations: u32,
    /// Outcome/miss envelopes accepted by the outcome lane.
    pub admitted_events: u32,
    /// Outcome/miss envelopes dropped newest by the outcome lane.
    pub dropped_events: u32,
    /// Whether the summary entered its independent lane.
    pub summary_admitted: bool,
    /// Final degradation bit encoded into the summary.
    pub frame_degraded: bool,
}

#[derive(Debug, Clone)]
struct RuntimeSettings {
    realm: String,
    producer_id: String,
    frame_id: u64,
    context_id: u64,
    software_digest: String,
    configuration_digest: String,
    heartbeat_interval: Duration,
    heartbeat_deadline_ms: u64,
    capacities: QueueCapacities,
}

#[derive(Debug)]
struct QueuedBytes {
    fusion_seq: u64,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct QueuedMonitor {
    event_seq: u64,
    bytes: Vec<u8>,
    is_summary: bool,
    fusion_seq: Option<u64>,
}

#[derive(Debug)]
struct RuntimeState {
    next_event_seq: Option<u64>,
    observations: VecDeque<QueuedBytes>,
    outcomes: VecDeque<QueuedMonitor>,
    summaries: VecDeque<QueuedMonitor>,
    heartbeats: VecDeque<QueuedMonitor>,
    in_flight_observations: usize,
    in_flight_observation_seq: Option<u64>,
    in_flight_monitor_events: usize,
    terminal_accounting: bool,
    last_admitted_fusion_seq: Option<u64>,
    last_admitted_prior_id: Option<u64>,
    last_fusion_seq: Option<u64>,
    active_track_count: u32,
    degraded: bool,
    counters: ProducerCounters,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            next_event_seq: Some(1),
            observations: VecDeque::new(),
            outcomes: VecDeque::new(),
            summaries: VecDeque::new(),
            heartbeats: VecDeque::new(),
            in_flight_observations: 0,
            in_flight_observation_seq: None,
            in_flight_monitor_events: 0,
            terminal_accounting: false,
            last_admitted_fusion_seq: None,
            last_admitted_prior_id: None,
            last_fusion_seq: None,
            active_track_count: 0,
            degraded: false,
            counters: ProducerCounters::default(),
        }
    }
}

struct SharedRuntime {
    settings: RuntimeSettings,
    epoch: String,
    registry: Arc<DeploymentRegistry>,
    observation_key: String,
    monitor_key: String,
    started_at: Instant,
    state: Mutex<RuntimeState>,
    shutdown: AtomicBool,
    observation_notify: tokio::sync::Notify,
    monitor_notify: tokio::sync::Notify,
    shutdown_notify: tokio::sync::Notify,
}

/// Cloneable admission/status surface suitable for application state.
#[derive(Clone)]
pub struct GaladrielHandle {
    shared: Arc<SharedRuntime>,
}

impl GaladrielHandle {
    /// Configured NCP realm.
    pub fn realm(&self) -> &str {
        &self.shared.settings.realm
    }

    /// Configured producer identity.
    pub fn producer_id(&self) -> &str {
        &self.shared.settings.producer_id
    }

    /// Explicit deployed common-frame identifier.
    pub fn frame_id(&self) -> u64 {
        self.shared.settings.frame_id
    }

    /// Explicit deployed projection-context identifier.
    pub fn context_id(&self) -> u64 {
        self.shared.settings.context_id
    }

    /// Context-pinned bounded fusion-configuration digest.
    pub fn configuration_digest(&self) -> &str {
        &self.shared.settings.configuration_digest
    }

    /// Context-pinned producer software digest.
    pub fn software_digest(&self) -> &str {
        &self.shared.settings.software_digest
    }

    /// Validated immutable deployment registry.
    pub fn registry(&self) -> &DeploymentRegistry {
        &self.shared.registry
    }

    /// Canonical frozen-v1 observation key.
    #[cfg(test)]
    pub fn observation_key(&self) -> &str {
        &self.shared.observation_key
    }

    /// Canonical producer-monitor key.
    #[cfg(test)]
    pub fn monitor_key(&self) -> &str {
        &self.shared.monitor_key
    }

    /// Atomically validate, sequence, and admit one fusion frame batch.
    ///
    /// # Errors
    ///
    /// Returns [`ProducerRuntimeError::InvalidFrame`] for any provenance,
    /// registry, count, or envelope mismatch; sequence exhaustion and shutdown
    /// are reported explicitly. Invalid batches have no queue side effects.
    pub fn admit_frame(
        &self,
        batch: FusionFrameBatch,
    ) -> Result<AdmissionReport, ProducerRuntimeError> {
        admit_frame(&self.shared, batch)
    }

    /// Update heartbeat status independently of frame publication.
    ///
    /// # Errors
    ///
    /// Rejects nonmonotonic/JSON-unsafe fusion sequences, excessive active-track
    /// counts, and updates attempted after shutdown.
    pub fn update_fusion_status(
        &self,
        last_fusion_seq: Option<u64>,
        active_track_count: u32,
    ) -> Result<(), ProducerRuntimeError> {
        if active_track_count
            > self
                .shared
                .registry
                .opportunity_policy()
                .max_active_tracks()
            || active_track_count > MAX_ACTIVE_TRACKS
        {
            return Err(ProducerRuntimeError::InvalidFrame(format!(
                "active_track_count {active_track_count} exceeds configured maximum"
            )));
        }
        if last_fusion_seq.is_some_and(|sequence| sequence > JSON_SAFE_U64_MAX) {
            return Err(ProducerRuntimeError::InvalidFrame(
                "last_fusion_seq exceeds the exact JSON integer range".to_string(),
            ));
        }
        let mut state = lock_unpoisoned(&self.shared.state);
        if self.shared.shutdown.load(Ordering::Acquire) {
            return Err(ProducerRuntimeError::ShuttingDown);
        }
        if let (Some(previous), Some(next)) = (state.last_fusion_seq, last_fusion_seq) {
            if next < previous {
                return Err(ProducerRuntimeError::InvalidFrame(format!(
                    "last_fusion_seq regressed from {previous} to {next}"
                )));
            }
        }
        state.last_fusion_seq = last_fusion_seq.or(state.last_fusion_seq);
        state.active_track_count = active_track_count;
        Ok(())
    }

    /// Snapshot bounded queue state and permanent epoch health.
    pub fn status(&self) -> ProducerStatus {
        let state = lock_unpoisoned(&self.shared.state);
        ProducerStatus {
            epoch: self.shared.epoch.clone(),
            last_fusion_seq: state.last_fusion_seq,
            active_track_count: state.active_track_count,
            degraded: state.degraded,
            next_event_seq: state.next_event_seq,
            queue_depths: queue_depths(&state),
            counters: state.counters,
            shutdown_requested: self.shared.shutdown.load(Ordering::Acquire),
        }
    }

    /// Permanently latch this epoch degraded after an internal producer fault.
    ///
    /// This is intentionally infallible so evidence assembly failures remain
    /// visible even when shutdown has already begun.
    pub fn mark_degraded(&self) {
        lock_unpoisoned(&self.shared.state).degraded = true;
    }
}

/// Owning runtime guard. Dropping it signals shutdown and aborts every task.
pub struct GaladrielRuntime {
    handle: GaladrielHandle,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl GaladrielRuntime {
    /// Clone the application-facing admission/status handle.
    pub fn handle(&self) -> GaladrielHandle {
        self.handle.clone()
    }

    /// Gracefully stop heartbeat production, drain bounded lanes, then join tasks.
    /// Tasks that do not finish within the fixed shutdown bound are aborted.
    pub async fn shutdown(mut self) {
        request_shutdown(&self.handle.shared);
        let tasks = std::mem::take(&mut self.tasks);
        for mut task in tasks {
            match tokio::time::timeout(SHUTDOWN_TIMEOUT, &mut task).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => lock_unpoisoned(&self.handle.shared.state).degraded = true,
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    lock_unpoisoned(&self.handle.shared.state).degraded = true;
                }
            }
        }
        account_abandoned_evidence(&self.handle.shared);
    }
}

impl Drop for GaladrielRuntime {
    fn drop(&mut self) {
        request_shutdown(&self.handle.shared);
        account_abandoned_evidence(&self.handle.shared);
        for task in &self.tasks {
            task.abort();
        }
    }
}

trait BytePublisher: Send + Sync + 'static {
    fn put_evidence<'a>(
        &'a self,
        key: &'a str,
        payload: &'a [u8],
    ) -> impl Future<Output = Result<(), String>> + Send + 'a;
}

struct ZenohPublisher {
    bus: ZenohBus,
}

impl BytePublisher for ZenohPublisher {
    #[expect(
        clippy::manual_async_fn,
        reason = "the trait's explicit Send future guarantee is required by tokio::spawn"
    )]
    fn put_evidence<'a>(
        &'a self,
        key: &'a str,
        payload: &'a [u8],
    ) -> impl Future<Output = Result<(), String>> + Send + 'a {
        async move {
            self.bus
                .put(key, payload, Plane::Perception)
                .await
                .map_err(|error| error.to_string())
        }
    }
}

/// Start the secure producer from environment configuration.
///
/// Returns `Ok(None)` only for an absent switch or the explicit value `0`.
/// Enabled startup validates all pins before calling [`ZenohBus::open_secure`].
///
/// # Errors
///
/// Returns [`ProducerRuntimeError`] for ambiguous opt-in values, missing or
/// malformed enabled configuration, registry/pin mismatches, a secure transport
/// open failure, or startup outside an active Tokio runtime.
pub async fn start_from_env() -> Result<Option<GaladrielRuntime>, ProducerRuntimeError> {
    let Some((settings, registry)) = settings_from_lookup(environment_value)? else {
        return Ok(None);
    };
    let keys = Keys::try_new(settings.realm.clone())
        .map_err(|error| ProducerRuntimeError::Configuration(error.to_string()))?;
    let epoch = fresh_process_epoch();
    validate_settings(&settings, &registry, &epoch)?;
    let bus = ZenohBus::open_secure(keys)
        .await
        .map_err(|error| ProducerRuntimeError::Transport(error.to_string()))?;
    start_with_publisher(ZenohPublisher { bus }, settings, registry, epoch).map(Some)
}

fn start_with_publisher<P: BytePublisher>(
    publisher: P,
    settings: RuntimeSettings,
    registry: DeploymentRegistry,
    epoch: String,
) -> Result<GaladrielRuntime, ProducerRuntimeError> {
    tokio::runtime::Handle::try_current().map_err(|_| ProducerRuntimeError::NoAsyncRuntime)?;
    validate_settings(&settings, &registry, &epoch)?;
    let observation_key = sidecar_key(&settings.realm, &epoch).ok_or_else(|| {
        ProducerRuntimeError::Configuration("failed to construct observation key".to_string())
    })?;
    let monitor_key = monitor_key(&settings.realm, &epoch).ok_or_else(|| {
        ProducerRuntimeError::Configuration("failed to construct monitor key".to_string())
    })?;
    let shared = Arc::new(SharedRuntime {
        settings,
        epoch,
        registry: Arc::new(registry),
        observation_key,
        monitor_key,
        started_at: Instant::now(),
        state: Mutex::new(RuntimeState::default()),
        shutdown: AtomicBool::new(false),
        observation_notify: tokio::sync::Notify::new(),
        monitor_notify: tokio::sync::Notify::new(),
        shutdown_notify: tokio::sync::Notify::new(),
    });
    let publisher = Arc::new(publisher);
    let tasks = vec![
        tokio::spawn(observation_worker(shared.clone(), publisher.clone())),
        tokio::spawn(monitor_worker(shared.clone(), publisher)),
        tokio::spawn(heartbeat_worker(shared.clone())),
    ];
    Ok(GaladrielRuntime {
        handle: GaladrielHandle { shared },
        tasks,
    })
}

fn environment_value(name: &str) -> Result<Option<String>, String> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} contains non-UTF-8 data")),
    }
}

fn settings_from_lookup<F>(
    lookup: F,
) -> Result<Option<(RuntimeSettings, DeploymentRegistry)>, ProducerRuntimeError>
where
    F: Fn(&str) -> Result<Option<String>, String>,
{
    let enabled = lookup(ENABLE_ENV).map_err(ProducerRuntimeError::Configuration)?;
    match enabled.as_deref() {
        None | Some("0") => return Ok(None),
        Some("1") => {}
        Some(value) => {
            return Err(ProducerRuntimeError::Configuration(format!(
                "{ENABLE_ENV} must be exactly 0 or 1, got {value:?}"
            )));
        }
    }

    let required = |name: &str| -> Result<String, ProducerRuntimeError> {
        lookup(name)
            .map_err(ProducerRuntimeError::Configuration)?
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ProducerRuntimeError::Configuration(format!(
                    "enabled deployment requires nonempty {name}"
                ))
            })
    };
    let registry_path = required(REGISTRY_PATH_ENV)?;
    let expected_registry_digest = required(REGISTRY_DIGEST_ENV)?;
    let registry_bytes = read_registry_bounded(std::path::Path::new(&registry_path))?;
    let registry = DeploymentRegistry::from_json_pinned(&registry_bytes, &expected_registry_digest)
        .map_err(|error| ProducerRuntimeError::Registry(error.to_string()))?;

    let mut capacities = QueueCapacities::from_registry(&registry)?;
    capacities.observations =
        optional_u32(&lookup, OBSERVATION_CAPACITY_ENV, capacities.observations)?;
    capacities.outcomes = optional_u32(&lookup, OUTCOME_CAPACITY_ENV, capacities.outcomes)?;
    capacities.summaries = optional_u32(&lookup, SUMMARY_CAPACITY_ENV, capacities.summaries)?;
    capacities.heartbeats = optional_u32(&lookup, HEARTBEAT_CAPACITY_ENV, capacities.heartbeats)?;

    let settings = RuntimeSettings {
        realm: required(REALM_ENV)?,
        producer_id: required(PRODUCER_ID_ENV)?,
        frame_id: parse_positive_json_id(FRAME_ID_ENV, &required(FRAME_ID_ENV)?)?,
        context_id: parse_positive_json_id(CONTEXT_ID_ENV, &required(CONTEXT_ID_ENV)?)?,
        software_digest: required(SOFTWARE_DIGEST_ENV)?,
        configuration_digest: required(CONFIGURATION_DIGEST_ENV)?,
        heartbeat_interval: Duration::from_millis(optional_u64(
            &lookup,
            HEARTBEAT_INTERVAL_ENV,
            DEFAULT_HEARTBEAT_INTERVAL_MS,
        )?),
        heartbeat_deadline_ms: optional_u64(
            &lookup,
            HEARTBEAT_DEADLINE_ENV,
            DEFAULT_HEARTBEAT_DEADLINE_MS,
        )?,
        capacities,
    };
    validate_settings(&settings, &registry, "configuration-validation-epoch")?;
    Ok(Some((settings, registry)))
}

fn optional_u32<F>(lookup: &F, name: &str, default: u32) -> Result<u32, ProducerRuntimeError>
where
    F: Fn(&str) -> Result<Option<String>, String>,
{
    let Some(value) = lookup(name).map_err(ProducerRuntimeError::Configuration)? else {
        return Ok(default);
    };
    value.parse::<u32>().map_err(|error| {
        ProducerRuntimeError::Configuration(format!("{name} must be a decimal u32: {error}"))
    })
}

fn optional_u64<F>(lookup: &F, name: &str, default: u64) -> Result<u64, ProducerRuntimeError>
where
    F: Fn(&str) -> Result<Option<String>, String>,
{
    let Some(value) = lookup(name).map_err(ProducerRuntimeError::Configuration)? else {
        return Ok(default);
    };
    value.parse::<u64>().map_err(|error| {
        ProducerRuntimeError::Configuration(format!("{name} must be a decimal u64: {error}"))
    })
}

fn parse_positive_json_id(name: &str, value: &str) -> Result<u64, ProducerRuntimeError> {
    let parsed = value.parse::<u64>().map_err(|error| {
        ProducerRuntimeError::Configuration(format!("{name} must be a decimal u64: {error}"))
    })?;
    if parsed == 0 || parsed > JSON_SAFE_U64_MAX {
        return Err(ProducerRuntimeError::Configuration(format!(
            "{name} must be within 1..={JSON_SAFE_U64_MAX}"
        )));
    }
    Ok(parsed)
}

fn read_registry_bounded(path: &std::path::Path) -> Result<Vec<u8>, ProducerRuntimeError> {
    use std::io::Read;

    let file = std::fs::File::open(path).map_err(|error| {
        ProducerRuntimeError::Registry(format!("failed to open {}: {error}", path.display()))
    })?;
    let limit = u64::try_from(MAX_REGISTRY_BYTES)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes).map_err(|error| {
        ProducerRuntimeError::Registry(format!("failed to read {}: {error}", path.display()))
    })?;
    if bytes.len() > MAX_REGISTRY_BYTES {
        return Err(ProducerRuntimeError::Registry(format!(
            "registry {} exceeds {MAX_REGISTRY_BYTES} bytes",
            path.display()
        )));
    }
    Ok(bytes)
}

fn validate_settings(
    settings: &RuntimeSettings,
    registry: &DeploymentRegistry,
    epoch: &str,
) -> Result<(), ProducerRuntimeError> {
    Keys::try_new(settings.realm.clone())
        .map_err(|error| ProducerRuntimeError::Configuration(error.to_string()))?;
    validate_identity("producer_id", &settings.producer_id)?;
    validate_identity("process epoch", epoch)?;
    validate_sha256(SOFTWARE_DIGEST_ENV, &settings.software_digest)?;
    validate_sha256(CONFIGURATION_DIGEST_ENV, &settings.configuration_digest)?;
    settings.capacities.validate(registry)?;

    let interval_ms = u64::try_from(settings.heartbeat_interval.as_millis()).map_err(|_| {
        ProducerRuntimeError::Configuration("heartbeat interval is too large".to_string())
    })?;
    if interval_ms == 0 || interval_ms > MAX_HEARTBEAT_DURATION_MS {
        return Err(ProducerRuntimeError::Configuration(format!(
            "heartbeat interval must be within 1..={MAX_HEARTBEAT_DURATION_MS} ms"
        )));
    }
    if settings.heartbeat_deadline_ms < interval_ms
        || settings.heartbeat_deadline_ms > MAX_HEARTBEAT_DURATION_MS
    {
        return Err(ProducerRuntimeError::Configuration(format!(
            "heartbeat deadline must be within {interval_ms}..={MAX_HEARTBEAT_DURATION_MS} ms"
        )));
    }

    let frame = registry.frame(settings.frame_id).ok_or_else(|| {
        ProducerRuntimeError::Configuration(format!(
            "configured frame_id {} is absent from the pinned registry",
            settings.frame_id
        ))
    })?;
    let context = registry.context(settings.context_id).ok_or_else(|| {
        ProducerRuntimeError::Configuration(format!(
            "configured context_id {} is absent from the pinned registry",
            settings.context_id
        ))
    })?;
    if context.frame_id() != frame.frame_id() {
        return Err(ProducerRuntimeError::Configuration(format!(
            "configured context {} binds frame {}, not configured frame {}",
            context.context_id(),
            context.frame_id(),
            frame.frame_id()
        )));
    }
    if context.producer_software_digest() != settings.software_digest {
        return Err(ProducerRuntimeError::Configuration(format!(
            "{SOFTWARE_DIGEST_ENV} does not match selected context"
        )));
    }
    if context.producer_configuration_digest() != settings.configuration_digest {
        return Err(ProducerRuntimeError::Configuration(format!(
            "{CONFIGURATION_DIGEST_ENV} does not match selected context"
        )));
    }
    Ok(())
}

fn validate_identity(name: &str, value: &str) -> Result<(), ProducerRuntimeError> {
    if value.len() > IDENTITY_MAX_BYTES || !valid_id_segment(value) {
        return Err(ProducerRuntimeError::Configuration(format!(
            "{name} is not a valid NCP identity segment"
        )));
    }
    Ok(())
}

fn validate_sha256(name: &str, value: &str) -> Result<(), ProducerRuntimeError> {
    if value.len() != SHA256_HEX_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ProducerRuntimeError::Configuration(format!(
            "{name} must be lowercase SHA-256 hexadecimal"
        )));
    }
    Ok(())
}

fn fresh_process_epoch() -> String {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let random: u128 = rand::random();
    format!("crebain-{timestamp_ms:x}-{random:032x}")
}

fn admit_frame(
    shared: &Arc<SharedRuntime>,
    mut batch: FusionFrameBatch,
) -> Result<AdmissionReport, ProducerRuntimeError> {
    validate_and_finalize_batch(shared, &mut batch)?;
    let observation_bytes = batch
        .observations
        .into_iter()
        .map(|observation| {
            let fusion_seq = observation.seq;
            SidecarEnvelope::try_new(
                shared.epoch.clone(),
                shared.settings.producer_id.clone(),
                observation,
            )
            .and_then(|envelope| envelope.encode())
            .map(|bytes| QueuedBytes { fusion_seq, bytes })
            .map_err(|error| ProducerRuntimeError::InvalidFrame(error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let monitor_count = batch.events.len().checked_add(1).ok_or_else(|| {
        ProducerRuntimeError::InvalidFrame("monitor event count overflow".to_string())
    })?;
    let mut state = lock_unpoisoned(&shared.state);
    if shared.shutdown.load(Ordering::Acquire) {
        return Err(ProducerRuntimeError::ShuttingDown);
    }
    if state
        .last_admitted_fusion_seq
        .is_some_and(|previous| batch.summary.fusion_seq <= previous)
    {
        return Err(ProducerRuntimeError::InvalidFrame(format!(
            "fusion_seq {} is not strictly greater than {:?}",
            batch.summary.fusion_seq, state.last_admitted_fusion_seq
        )));
    }
    if state
        .last_fusion_seq
        .is_some_and(|previous| batch.summary.fusion_seq < previous)
    {
        return Err(ProducerRuntimeError::InvalidFrame(format!(
            "fusion_seq {} is older than the status high-water mark {:?}",
            batch.summary.fusion_seq, state.last_fusion_seq
        )));
    }
    if state
        .last_admitted_prior_id
        .is_some_and(|previous| batch.summary.prior_id <= previous)
    {
        return Err(ProducerRuntimeError::InvalidFrame(format!(
            "prior_id {} is not strictly greater than {:?}",
            batch.summary.prior_id, state.last_admitted_prior_id
        )));
    }
    if state.degraded {
        batch.summary.degraded = true;
    }

    let sequences = reserve_event_sequences(&mut state, monitor_count)?;
    state.last_admitted_fusion_seq = Some(batch.summary.fusion_seq);
    state.last_admitted_prior_id = Some(batch.summary.prior_id);
    state.last_fusion_seq = Some(batch.summary.fusion_seq);
    state.active_track_count = batch.summary.active_track_count;
    if batch.summary.degraded {
        state.degraded = true;
    }

    let mut admitted_observations = 0_u32;
    let mut dropped_observations = 0_u32;
    for queued in observation_bytes {
        if state.observations.len() < shared.settings.capacities.observations as usize {
            state.observations.push_back(queued);
            admitted_observations = admitted_observations.saturating_add(1);
            bump(&mut state.counters.admitted_observations, 1);
        } else {
            dropped_observations = dropped_observations.saturating_add(1);
            record_observation_drop(&mut state, 1);
        }
    }

    let mut admitted_events = 0_u32;
    let mut dropped_events = 0_u32;
    for (event, event_seq) in batch.events.into_iter().zip(sequences.iter().copied()) {
        let encoded = MonitorEnvelope::try_new(
            shared.epoch.clone(),
            shared.settings.producer_id.clone(),
            event_seq,
            event,
        )
        .and_then(|envelope| envelope.encode());
        if state.outcomes.len() >= shared.settings.capacities.outcomes as usize {
            dropped_events = dropped_events.saturating_add(1);
            record_monitor_drop(&mut state, 1);
            continue;
        }
        match encoded {
            Ok(bytes) => {
                state.outcomes.push_back(QueuedMonitor {
                    event_seq,
                    bytes,
                    is_summary: false,
                    fusion_seq: None,
                });
                admitted_events = admitted_events.saturating_add(1);
                bump(&mut state.counters.admitted_monitor_events, 1);
            }
            Err(_) => {
                dropped_events = dropped_events.saturating_add(1);
                record_monitor_drop(&mut state, 1);
            }
        }
    }

    let summary_seq = *sequences
        .last()
        .unwrap_or_else(|| unreachable!("frame reservation always includes summary"));
    let summary_lane_full = state.summaries.len() >= shared.settings.capacities.summaries as usize;
    let frame_dropped = dropped_observations > 0 || dropped_events > 0 || summary_lane_full;
    if frame_dropped {
        batch.summary.degraded = true;
        batch.summary.truncated = true;
        state.degraded = true;
    }
    let summary_encoded = MonitorEnvelope::try_new(
        shared.epoch.clone(),
        shared.settings.producer_id.clone(),
        summary_seq,
        ProducerEvent::FrameSummary(batch.summary.clone()),
    )
    .and_then(|envelope| envelope.encode());
    let summary_admitted = if summary_lane_full {
        record_monitor_drop(&mut state, 1);
        false
    } else if let Ok(bytes) = summary_encoded {
        state.summaries.push_back(QueuedMonitor {
            event_seq: summary_seq,
            bytes,
            is_summary: true,
            fusion_seq: Some(batch.summary.fusion_seq),
        });
        bump(&mut state.counters.admitted_monitor_events, 1);
        true
    } else {
        batch.summary.degraded = true;
        batch.summary.truncated = true;
        state.degraded = true;
        record_monitor_drop(&mut state, 1);
        false
    };
    let frame_degraded = batch.summary.degraded || !summary_admitted;
    drop(state);

    if admitted_observations > 0 {
        shared.observation_notify.notify_one();
    }
    if admitted_events > 0 || summary_admitted {
        shared.monitor_notify.notify_one();
    }

    Ok(AdmissionReport {
        assigned_monitor_sequences: sequences,
        admitted_observations,
        dropped_observations,
        admitted_events,
        dropped_events,
        summary_admitted,
        frame_degraded,
    })
}

fn validate_and_finalize_batch(
    shared: &SharedRuntime,
    batch: &mut FusionFrameBatch,
) -> Result<(), ProducerRuntimeError> {
    let policy = shared.registry.opportunity_policy();
    if batch.events.len() > policy.max_outcomes_per_frame() as usize
        || batch.events.len() > MAX_FRAME_ITEMS as usize
    {
        return Err(ProducerRuntimeError::InvalidFrame(format!(
            "event count {} exceeds configured maximum {}",
            batch.events.len(),
            policy.max_outcomes_per_frame().min(MAX_FRAME_ITEMS)
        )));
    }
    if batch.observations.len() > policy.max_frame_inputs() as usize
        || batch.observations.len() > MAX_FRAME_ITEMS as usize
    {
        return Err(ProducerRuntimeError::InvalidFrame(format!(
            "observation count {} exceeds configured maximum {}",
            batch.observations.len(),
            policy.max_frame_inputs().min(MAX_FRAME_ITEMS)
        )));
    }
    if batch.summary.frame_id != shared.settings.frame_id
        || batch.summary.context_id != shared.settings.context_id
    {
        return Err(ProducerRuntimeError::InvalidFrame(format!(
            "summary frame/context ({}/{}) differs from configured ({}/{})",
            batch.summary.frame_id,
            batch.summary.context_id,
            shared.settings.frame_id,
            shared.settings.context_id
        )));
    }
    let frame = shared
        .registry
        .frame(shared.settings.frame_id)
        .unwrap_or_else(|| unreachable!("startup validated configured frame"));
    let context = shared
        .registry
        .context(shared.settings.context_id)
        .unwrap_or_else(|| unreachable!("startup validated configured context"));
    if !frame
        .applicability()
        .contains(batch.summary.fusion_timestamp_ms)
        || !context
            .applicability()
            .contains(batch.summary.fusion_timestamp_ms)
    {
        return Err(ProducerRuntimeError::InvalidFrame(format!(
            "fusion timestamp {} is outside configured registry applicability",
            batch.summary.fusion_timestamp_ms
        )));
    }
    let expected_modalities = context
        .expected_modalities()
        .iter()
        .map(|definition| definition.modality())
        .collect::<Vec<_>>();
    if batch.summary.expected_modalities != expected_modalities {
        return Err(ProducerRuntimeError::InvalidFrame(
            "summary expected_modalities differ from configured context".to_string(),
        ));
    }
    if batch.summary.input_count > policy.max_frame_inputs() {
        return Err(ProducerRuntimeError::InvalidFrame(format!(
            "summary input_count {} exceeds configured maximum {}",
            batch.summary.input_count,
            policy.max_frame_inputs()
        )));
    }
    if batch.summary.active_track_count > policy.max_active_tracks()
        || batch.summary.active_track_count > MAX_ACTIVE_TRACKS
    {
        return Err(ProducerRuntimeError::InvalidFrame(format!(
            "summary active_track_count {} exceeds configured maximum",
            batch.summary.active_track_count
        )));
    }

    if batch.frozen_track_ids.len() > policy.max_active_tracks() as usize
        || batch.frozen_track_ids.len() > MAX_ACTIVE_TRACKS as usize
    {
        return Err(ProducerRuntimeError::InvalidFrame(format!(
            "frozen track count {} exceeds configured maximum",
            batch.frozen_track_ids.len()
        )));
    }
    for (index, track_id) in batch.frozen_track_ids.iter().copied().enumerate() {
        if track_id == 0 || track_id > JSON_SAFE_U64_MAX {
            return Err(ProducerRuntimeError::InvalidFrame(format!(
                "frozen_track_ids[{index}] is outside the exact JSON integer range"
            )));
        }
        if index > 0 && batch.frozen_track_ids[index - 1] >= track_id {
            return Err(ProducerRuntimeError::InvalidFrame(
                "frozen_track_ids must be strictly increasing".to_string(),
            ));
        }
    }
    if batch.frozen_opportunity_tracks.len() != batch.frozen_track_ids.len()
        || batch
            .frozen_opportunity_tracks
            .iter()
            .zip(&batch.frozen_track_ids)
            .any(|(track, track_id)| track.track_id != *track_id)
    {
        return Err(ProducerRuntimeError::InvalidFrame(
            "frozen opportunity metadata differs from frozen_track_ids".to_string(),
        ));
    }
    if batch.opportunity_inputs.len() != batch.summary.input_count as usize {
        return Err(ProducerRuntimeError::InvalidFrame(format!(
            "{} opportunity inputs differ from summary input_count {}",
            batch.opportunity_inputs.len(),
            batch.summary.input_count
        )));
    }
    for (index, input) in batch.opportunity_inputs.iter().enumerate() {
        if input.measurement_index != index as u32 {
            return Err(ProducerRuntimeError::InvalidFrame(
                "opportunity input indices must be contiguous in frame order".to_string(),
            ));
        }
        if !expected_modalities.contains(&input.modality) {
            return Err(ProducerRuntimeError::InvalidFrame(format!(
                "input modality {:?} is absent from the configured context",
                input.modality
            )));
        }
    }
    let frozen_track_set = batch
        .frozen_track_ids
        .iter()
        .copied()
        .collect::<HashSet<_>>();

    #[derive(Debug, Default)]
    struct PairLedger {
        next_attempt: u32,
        last_measurement_index: Option<u32>,
        measurement_indices: Vec<u32>,
        candidate_count: Option<u32>,
        in_gate_count: Option<u32>,
        observed_in_gate_count: u32,
        in_gate_count_unverifiable: bool,
        terminal: bool,
        miss_reason: Option<ModalityMissReason>,
    }

    let mut expected_observations = Vec::new();
    let mut outcome_identities = HashSet::new();
    let mut miss_identities = HashSet::new();
    let mut v1_identities = HashSet::new();
    let mut pair_ledgers: HashMap<(u64, SensorModality), PairLedger> = HashMap::new();
    let mut last_pair_rank = None;
    let mut birth_phase = false;
    let mut birth_track_ids = HashSet::new();
    let mut birth_measurement_indices = HashSet::new();
    let mut last_birth_identity = None;
    for event in &batch.events {
        event
            .validate()
            .map_err(|error| ProducerRuntimeError::InvalidFrame(error.to_string()))?;
        match event {
            ProducerEvent::ModalityOutcome(outcome) => {
                let modality_index = expected_modalities
                    .iter()
                    .position(|modality| *modality == outcome.modality)
                    .ok_or_else(|| {
                        ProducerRuntimeError::InvalidFrame(format!(
                            "outcome modality {:?} is absent from the configured context",
                            outcome.modality
                        ))
                    })?;
                if !outcome_identities.insert((
                    outcome.track_id,
                    outcome.modality,
                    outcome.attempt_index,
                )) {
                    return Err(ProducerRuntimeError::InvalidFrame(format!(
                        "duplicate outcome identity ({}/{:?}/{})",
                        outcome.track_id, outcome.modality, outcome.attempt_index
                    )));
                }
                validate_event_frame(
                    batch.summary.fusion_seq,
                    batch.summary.fusion_timestamp_ms,
                    batch.summary.frame_id,
                    batch.summary.context_id,
                    batch.summary.prior_id,
                    outcome.fusion_seq,
                    outcome.fusion_timestamp_ms,
                    outcome.frame_id,
                    outcome.context_id,
                    outcome.prior_id,
                )?;
                if outcome
                    .measurement_index
                    .is_some_and(|index| index >= batch.summary.input_count)
                {
                    return Err(ProducerRuntimeError::InvalidFrame(format!(
                        "outcome measurement_index {:?} is outside input_count {}",
                        outcome.measurement_index, batch.summary.input_count
                    )));
                }

                if outcome.outcome == ModalityOutcomeKind::TrackBirth {
                    birth_phase = true;
                    if frozen_track_set.contains(&outcome.track_id) {
                        return Err(ProducerRuntimeError::InvalidFrame(format!(
                            "track_birth {} was already present in the frozen snapshot",
                            outcome.track_id
                        )));
                    }
                    if outcome.attempt_index != 0 || !birth_track_ids.insert(outcome.track_id) {
                        return Err(ProducerRuntimeError::InvalidFrame(format!(
                            "track_birth {} must have one attempt_index 0 event",
                            outcome.track_id
                        )));
                    }
                    let measurement_index = outcome.measurement_index.unwrap_or_else(|| {
                        unreachable!("validated track birth has a measurement index")
                    });
                    if !birth_measurement_indices.insert(measurement_index) {
                        return Err(ProducerRuntimeError::InvalidFrame(format!(
                            "measurement_index {measurement_index} creates more than one track"
                        )));
                    }
                    if batch.opportunity_inputs[measurement_index as usize].modality
                        != outcome.modality
                    {
                        return Err(ProducerRuntimeError::InvalidFrame(format!(
                            "track_birth modality {:?} differs from input {measurement_index}",
                            outcome.modality
                        )));
                    }
                    let identity = (measurement_index, outcome.track_id, modality_index);
                    if last_birth_identity.is_some_and(|previous| identity <= previous) {
                        return Err(ProducerRuntimeError::InvalidFrame(
                            "track_birth events are not in canonical measurement/track order"
                                .to_string(),
                        ));
                    }
                    last_birth_identity = Some(identity);
                    continue;
                }

                if birth_phase {
                    return Err(ProducerRuntimeError::InvalidFrame(
                        "Cartesian pair events cannot follow track_birth events".to_string(),
                    ));
                }
                let track_index = batch
                    .frozen_track_ids
                    .binary_search(&outcome.track_id)
                    .map_err(|_| {
                        ProducerRuntimeError::InvalidFrame(format!(
                            "outcome track {} is absent from the frozen snapshot",
                            outcome.track_id
                        ))
                    })?;
                let pair_rank = track_index
                    .checked_mul(expected_modalities.len())
                    .and_then(|rank| rank.checked_add(modality_index))
                    .ok_or_else(|| {
                        ProducerRuntimeError::InvalidFrame("pair rank overflow".to_string())
                    })?;
                if last_pair_rank.is_some_and(|previous| pair_rank < previous) {
                    return Err(ProducerRuntimeError::InvalidFrame(
                        "Cartesian pair events are not in canonical track/modality order"
                            .to_string(),
                    ));
                }
                last_pair_rank = Some(pair_rank);
                let pair = (outcome.track_id, outcome.modality);
                let ledger = pair_ledgers.entry(pair).or_default();
                if ledger.miss_reason.is_some() {
                    return Err(ProducerRuntimeError::InvalidFrame(format!(
                        "outcome for ({}/{:?}) follows its aggregate miss",
                        outcome.track_id, outcome.modality
                    )));
                }
                let measurement_index = outcome.measurement_index.ok_or_else(|| {
                    ProducerRuntimeError::InvalidFrame(format!(
                        "canonical attempt for ({}/{:?}) requires measurement_index",
                        outcome.track_id, outcome.modality
                    ))
                })?;
                if ledger
                    .last_measurement_index
                    .is_some_and(|previous| measurement_index <= previous)
                {
                    return Err(ProducerRuntimeError::InvalidFrame(format!(
                        "measurement indices for ({}/{:?}) are not strictly increasing",
                        outcome.track_id, outcome.modality
                    )));
                }
                ledger.last_measurement_index = Some(measurement_index);
                ledger.measurement_indices.push(measurement_index);
                if outcome.attempt_index != ledger.next_attempt {
                    return Err(ProducerRuntimeError::InvalidFrame(format!(
                        "attempt_index {} for ({}/{:?}) is not contiguous from {}",
                        outcome.attempt_index,
                        outcome.track_id,
                        outcome.modality,
                        ledger.next_attempt
                    )));
                }
                ledger.next_attempt = ledger.next_attempt.checked_add(1).ok_or_else(|| {
                    ProducerRuntimeError::InvalidFrame("attempt count overflow".to_string())
                })?;
                if ledger.next_attempt > policy.max_attempts_per_track_modality() {
                    return Err(ProducerRuntimeError::InvalidFrame(format!(
                        "attempt count for ({}/{:?}) exceeds configured maximum {}",
                        outcome.track_id,
                        outcome.modality,
                        policy.max_attempts_per_track_modality()
                    )));
                }
                match (ledger.candidate_count, ledger.in_gate_count) {
                    (None, None) => {
                        ledger.candidate_count = Some(outcome.candidate_count);
                        ledger.in_gate_count = Some(outcome.in_gate_count);
                    }
                    (Some(candidate_count), Some(in_gate_count))
                        if candidate_count == outcome.candidate_count
                            && in_gate_count == outcome.in_gate_count => {}
                    _ => {
                        return Err(ProducerRuntimeError::InvalidFrame(format!(
                            "pair-level gate counts disagree for ({}/{:?})",
                            outcome.track_id, outcome.modality
                        )));
                    }
                }
                if outcome
                    .gate_evidence
                    .is_some_and(|evidence| evidence.d2 < evidence.threshold)
                {
                    ledger.observed_in_gate_count = ledger
                        .observed_in_gate_count
                        .checked_add(1)
                        .ok_or_else(|| {
                            ProducerRuntimeError::InvalidFrame(
                                "observed in-gate count overflow".to_string(),
                            )
                        })?;
                }
                if outcome.gate_evidence.is_none() {
                    ledger.in_gate_count_unverifiable = true;
                }
                if matches!(
                    outcome.outcome,
                    ModalityOutcomeKind::Updated
                        | ModalityOutcomeKind::UpdateRejected
                        | ModalityOutcomeKind::UnsupportedFilter
                        | ModalityOutcomeKind::IncomparableProjection
                ) {
                    ledger.terminal = true;
                }
                if outcome.v1_expected {
                    if !v1_identities.insert((outcome.track_id, outcome.modality)) {
                        return Err(ProducerRuntimeError::InvalidFrame(format!(
                            "duplicate v1-expected identity ({}/{:?})",
                            outcome.track_id, outcome.modality
                        )));
                    }
                    expected_observations.push((
                        outcome.track_id,
                        outcome.modality,
                        outcome.consistency_projection,
                    ));
                }
            }
            ProducerEvent::ModalityMiss(miss) => {
                if birth_phase {
                    return Err(ProducerRuntimeError::InvalidFrame(
                        "Cartesian misses cannot follow track_birth events".to_string(),
                    ));
                }
                let modality_index = expected_modalities
                    .iter()
                    .position(|modality| *modality == miss.modality)
                    .ok_or_else(|| {
                        ProducerRuntimeError::InvalidFrame(format!(
                            "miss modality {:?} is absent from the configured context",
                            miss.modality
                        ))
                    })?;
                let track_index = batch
                    .frozen_track_ids
                    .binary_search(&miss.track_id)
                    .map_err(|_| {
                        ProducerRuntimeError::InvalidFrame(format!(
                            "miss track {} is absent from the frozen snapshot",
                            miss.track_id
                        ))
                    })?;
                let pair_rank = track_index
                    .checked_mul(expected_modalities.len())
                    .and_then(|rank| rank.checked_add(modality_index))
                    .ok_or_else(|| {
                        ProducerRuntimeError::InvalidFrame("pair rank overflow".to_string())
                    })?;
                if last_pair_rank.is_some_and(|previous| pair_rank < previous) {
                    return Err(ProducerRuntimeError::InvalidFrame(
                        "Cartesian pair events are not in canonical track/modality order"
                            .to_string(),
                    ));
                }
                last_pair_rank = Some(pair_rank);
                if !miss_identities.insert((miss.track_id, miss.modality)) {
                    return Err(ProducerRuntimeError::InvalidFrame(format!(
                        "duplicate miss identity ({}/{:?})",
                        miss.track_id, miss.modality
                    )));
                }
                validate_event_frame(
                    batch.summary.fusion_seq,
                    batch.summary.fusion_timestamp_ms,
                    batch.summary.frame_id,
                    batch.summary.context_id,
                    batch.summary.prior_id,
                    miss.fusion_seq,
                    miss.fusion_timestamp_ms,
                    miss.frame_id,
                    miss.context_id,
                    miss.prior_id,
                )?;
                let ledger = pair_ledgers
                    .entry((miss.track_id, miss.modality))
                    .or_default();
                if ledger.terminal {
                    return Err(ProducerRuntimeError::InvalidFrame(format!(
                        "terminal outcome for ({}/{:?}) cannot also carry a miss",
                        miss.track_id, miss.modality
                    )));
                }
                ledger.miss_reason = Some(miss.reason);
            }
            ProducerEvent::Heartbeat(_) | ProducerEvent::FrameSummary(_) => {
                return Err(ProducerRuntimeError::InvalidFrame(
                    "frame events may contain only modality_outcome or modality_miss".to_string(),
                ));
            }
        }
    }

    for track in &batch.frozen_opportunity_tracks {
        for modality in &expected_modalities {
            let track_id = track.track_id;
            let pair = (track_id, *modality);
            let ledger = pair_ledgers.get(&pair).ok_or_else(|| {
                ProducerRuntimeError::InvalidFrame(format!(
                    "Cartesian ledger omits frozen pair ({track_id}/{modality:?})"
                ))
            })?;
            let modality_input_count = batch
                .opportunity_inputs
                .iter()
                .filter(|input| input.modality == *modality)
                .count();
            let expected_candidate_indices = batch
                .opportunity_inputs
                .iter()
                .filter(|input| input.modality == *modality && input.class == track.class)
                .map(|input| input.measurement_index)
                .collect::<Vec<_>>();
            let candidate_count = ledger.candidate_count.unwrap_or(0);
            let in_gate_count = ledger.in_gate_count.unwrap_or(0);
            if ledger.measurement_indices != expected_candidate_indices {
                return Err(ProducerRuntimeError::InvalidFrame(format!(
                    "attempt measurement indices for ({track_id}/{modality:?}) do not match the frozen candidate rule"
                )));
            }
            if candidate_count as usize != expected_candidate_indices.len()
                || candidate_count != ledger.next_attempt
            {
                return Err(ProducerRuntimeError::InvalidFrame(format!(
                    "candidate_count {candidate_count} for ({track_id}/{modality:?}) differs from {} emitted attempts",
                    ledger.next_attempt
                )));
            }
            if !ledger.in_gate_count_unverifiable && in_gate_count != ledger.observed_in_gate_count
            {
                return Err(ProducerRuntimeError::InvalidFrame(format!(
                    "in_gate_count {in_gate_count} for ({track_id}/{modality:?}) differs from {} accepted gates",
                    ledger.observed_in_gate_count
                )));
            }
            match (ledger.terminal, ledger.miss_reason) {
                (true, None) => {}
                (true, Some(_)) => {
                    return Err(ProducerRuntimeError::InvalidFrame(format!(
                        "terminal pair ({track_id}/{modality:?}) also has a miss"
                    )));
                }
                (false, None) => {
                    return Err(ProducerRuntimeError::InvalidFrame(format!(
                        "nonterminal pair ({track_id}/{modality:?}) lacks an aggregate miss"
                    )));
                }
                (false, Some(reason)) => {
                    let reason_matches = if candidate_count == 0 {
                        if modality_input_count == 0 {
                            reason == ModalityMissReason::NoMeasurement
                        } else {
                            reason == ModalityMissReason::NoCandidate
                        }
                    } else if in_gate_count == 0 {
                        reason == ModalityMissReason::NoInGateCandidate
                    } else {
                        reason == ModalityMissReason::NotAssigned
                    };
                    if !reason_matches {
                        return Err(ProducerRuntimeError::InvalidFrame(format!(
                            "miss reason {reason:?} contradicts pair counts for ({track_id}/{modality:?})"
                        )));
                    }
                }
            }
        }
    }

    if batch.observations.len() != expected_observations.len() {
        return Err(ProducerRuntimeError::InvalidFrame(format!(
            "{} observations cannot satisfy {} v1-expected outcomes",
            batch.observations.len(),
            expected_observations.len()
        )));
    }
    let mut observation_identities = HashSet::new();
    for observation in &batch.observations {
        observation
            .validate()
            .map_err(ProducerRuntimeError::InvalidFrame)?;
        if observation.seq != batch.summary.fusion_seq {
            return Err(ProducerRuntimeError::InvalidFrame(format!(
                "observation seq {} differs from fusion_seq {}",
                observation.seq, batch.summary.fusion_seq
            )));
        }
        if !expected_modalities.contains(&observation.modality) {
            return Err(ProducerRuntimeError::InvalidFrame(format!(
                "observation modality {:?} is absent from the configured context",
                observation.modality
            )));
        }
        if !observation_identities.insert((observation.track_id, observation.modality)) {
            return Err(ProducerRuntimeError::InvalidFrame(format!(
                "duplicate observation identity ({}/{:?})",
                observation.track_id, observation.modality
            )));
        }
        if let Some(projection) = observation.consistency_projection {
            if projection.frame_id != batch.summary.frame_id
                || projection.context_id != batch.summary.context_id
                || projection.prior_id != batch.summary.prior_id
            {
                return Err(ProducerRuntimeError::InvalidFrame(
                    "observation projection provenance differs from frame summary".to_string(),
                ));
            }
        }
        let Some(index) = expected_observations.iter().position(|expected| {
            (expected.0, expected.1) == (observation.track_id, observation.modality)
        }) else {
            return Err(ProducerRuntimeError::InvalidFrame(format!(
                "observation track/modality ({}/{:?}) has no v1-expected outcome",
                observation.track_id, observation.modality
            )));
        };
        if observation.consistency_projection != expected_observations[index].2 {
            return Err(ProducerRuntimeError::InvalidFrame(format!(
                "observation projection for ({}/{:?}) differs from its v1-expected outcome",
                observation.track_id, observation.modality
            )));
        }
        expected_observations.remove(index);
    }

    batch.summary.registry_digest = shared.registry.digest().to_string();
    batch.summary.outcome_count = u32::try_from(batch.events.len()).map_err(|_| {
        ProducerRuntimeError::InvalidFrame("outcome count cannot fit the wire".to_string())
    })?;
    batch.summary.v1_expected_count = u32::try_from(batch.observations.len()).map_err(|_| {
        ProducerRuntimeError::InvalidFrame("v1 count cannot fit the wire".to_string())
    })?;
    if batch.summary.truncated {
        batch.summary.degraded = true;
    }
    batch
        .summary
        .validate()
        .map_err(|error| ProducerRuntimeError::InvalidFrame(error.to_string()))
}

#[expect(
    clippy::too_many_arguments,
    reason = "explicit wire identities prevent tuple-order mistakes"
)]
fn validate_event_frame(
    expected_fusion_seq: u64,
    expected_timestamp_ms: u64,
    expected_frame_id: u64,
    expected_context_id: u64,
    expected_prior_id: u64,
    actual_fusion_seq: u64,
    actual_timestamp_ms: u64,
    actual_frame_id: u64,
    actual_context_id: u64,
    actual_prior_id: u64,
) -> Result<(), ProducerRuntimeError> {
    if (
        actual_fusion_seq,
        actual_timestamp_ms,
        actual_frame_id,
        actual_context_id,
        actual_prior_id,
    ) != (
        expected_fusion_seq,
        expected_timestamp_ms,
        expected_frame_id,
        expected_context_id,
        expected_prior_id,
    ) {
        return Err(ProducerRuntimeError::InvalidFrame(
            "monitor event provenance differs from frame summary".to_string(),
        ));
    }
    Ok(())
}

fn reserve_event_sequences(
    state: &mut RuntimeState,
    count: usize,
) -> Result<Vec<u64>, ProducerRuntimeError> {
    let start = state.next_event_seq.ok_or_else(|| {
        state.degraded = true;
        ProducerRuntimeError::EventSequenceExhausted
    })?;
    let count = u64::try_from(count).map_err(|_| {
        state.degraded = true;
        ProducerRuntimeError::EventSequenceExhausted
    })?;
    let end = start
        .checked_add(count.saturating_sub(1))
        .filter(|end| *end <= JSON_SAFE_U64_MAX)
        .ok_or_else(|| {
            state.degraded = true;
            ProducerRuntimeError::EventSequenceExhausted
        })?;
    state.next_event_seq = if end == JSON_SAFE_U64_MAX {
        None
    } else {
        end.checked_add(1)
    };
    Ok((start..=end).collect())
}

fn record_observation_drop(state: &mut RuntimeState, amount: usize) {
    state.degraded = true;
    bump(&mut state.counters.dropped_observations, amount);
}

fn record_monitor_drop(state: &mut RuntimeState, amount: usize) {
    state.degraded = true;
    bump(&mut state.counters.dropped_monitor_events, amount);
}

fn bump(counter: &mut u64, amount: usize) {
    let amount = u64::try_from(amount).unwrap_or(u64::MAX);
    *counter = counter.saturating_add(amount).min(JSON_SAFE_U64_MAX);
}

fn queue_depths(state: &RuntimeState) -> QueueDepths {
    QueueDepths {
        observations: u32::try_from(state.observations.len()).unwrap_or(u32::MAX),
        outcomes: u32::try_from(state.outcomes.len()).unwrap_or(u32::MAX),
        summaries: u32::try_from(state.summaries.len()).unwrap_or(u32::MAX),
        heartbeats: u32::try_from(state.heartbeats.len()).unwrap_or(u32::MAX),
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

async fn observation_worker<P: BytePublisher>(shared: Arc<SharedRuntime>, publisher: Arc<P>) {
    loop {
        let (item, should_stop) = {
            let mut state = lock_unpoisoned(&shared.state);
            let item = state.observations.pop_front();
            if let Some(item) = item.as_ref() {
                state.in_flight_observations = state.in_flight_observations.saturating_add(1);
                state.in_flight_observation_seq = Some(item.fusion_seq);
            }
            let should_stop = item.is_none() && shared.shutdown.load(Ordering::Acquire);
            (item, should_stop)
        };
        if let Some(item) = item {
            let published = tokio::time::timeout(
                PUBLISH_TIMEOUT,
                publisher.put_evidence(&shared.observation_key, &item.bytes),
            )
            .await
            .is_ok_and(|result| result.is_ok());
            let mut state = lock_unpoisoned(&shared.state);
            if state.terminal_accounting {
                continue;
            }
            state.in_flight_observations = state.in_flight_observations.saturating_sub(1);
            state.in_flight_observation_seq = None;
            if published {
                bump(&mut state.counters.published_observations, 1);
            } else {
                bump(&mut state.counters.failed_observation_publishes, 1);
                record_observation_drop(&mut state, 1);
            }
            drop(state);
            shared.monitor_notify.notify_one();
        } else if should_stop {
            break;
        } else {
            wait_for_work(&shared.observation_notify).await;
        }
    }
}

async fn monitor_worker<P: BytePublisher>(shared: Arc<SharedRuntime>, publisher: Arc<P>) {
    loop {
        let (item, should_stop) = {
            let mut state = lock_unpoisoned(&shared.state);
            let item = pop_lowest_monitor(&mut state);
            if item.is_some() {
                state.in_flight_monitor_events = state.in_flight_monitor_events.saturating_add(1);
            }
            let should_stop = item.is_none()
                && state.outcomes.is_empty()
                && state.summaries.is_empty()
                && state.heartbeats.is_empty()
                && shared.shutdown.load(Ordering::Acquire);
            (item, should_stop)
        };
        if let Some(item) = item {
            let published = tokio::time::timeout(
                PUBLISH_TIMEOUT,
                publisher.put_evidence(&shared.monitor_key, &item.bytes),
            )
            .await
            .is_ok_and(|result| result.is_ok());
            let mut state = lock_unpoisoned(&shared.state);
            if state.terminal_accounting {
                continue;
            }
            state.in_flight_monitor_events = state.in_flight_monitor_events.saturating_sub(1);
            if published {
                bump(&mut state.counters.published_monitor_events, 1);
            } else {
                bump(&mut state.counters.failed_monitor_publishes, 1);
                record_monitor_drop(&mut state, 1);
            }
        } else if should_stop {
            break;
        } else {
            wait_for_work(&shared.monitor_notify).await;
        }
    }
}

async fn heartbeat_worker(shared: Arc<SharedRuntime>) {
    loop {
        let shutdown = shared.shutdown_notify.notified();
        if shared.shutdown.load(Ordering::Acquire) {
            break;
        }
        if tokio::time::timeout(shared.settings.heartbeat_interval, shutdown)
            .await
            .is_ok()
        {
            if shared.shutdown.load(Ordering::Acquire) {
                break;
            }
            continue;
        }
        if enqueue_heartbeat(&shared) {
            shared.monitor_notify.notify_one();
        }
    }
}

fn enqueue_heartbeat(shared: &SharedRuntime) -> bool {
    let mut state = lock_unpoisoned(&shared.state);
    if shared.shutdown.load(Ordering::Acquire) {
        return false;
    }
    let event_seq = match reserve_event_sequences(&mut state, 1) {
        Ok(sequences) => sequences[0],
        Err(_) => {
            record_monitor_drop(&mut state, 1);
            return false;
        }
    };
    if state.heartbeats.len() >= shared.settings.capacities.heartbeats as usize {
        record_monitor_drop(&mut state, 1);
        return false;
    }
    let depths = queue_depths(&state);
    let capacity = shared
        .settings
        .capacities
        .total()
        .unwrap_or(MAX_MONITOR_QUEUE_EVENTS);
    let producer_timestamp_ms = unix_timestamp_ms();
    let uptime_ms = u64::try_from(shared.started_at.elapsed().as_millis())
        .unwrap_or(JSON_SAFE_U64_MAX)
        .min(JSON_SAFE_U64_MAX);
    let declared_interval_ms = u64::try_from(shared.settings.heartbeat_interval.as_millis())
        .unwrap_or(MAX_HEARTBEAT_DURATION_MS);
    let event = ProducerEvent::Heartbeat(Heartbeat {
        producer_timestamp_ms,
        uptime_ms,
        declared_interval_ms,
        declared_deadline_ms: shared.settings.heartbeat_deadline_ms,
        last_fusion_seq: state.last_fusion_seq,
        active_track_count: state.active_track_count,
        degraded: state.degraded,
        queue_health: QueueHealth {
            capacity,
            depth: depths.total(),
            dropped_event_count: state.counters.dropped_total(),
            published_event_count: state.counters.published_total(),
        },
    });
    let encoded = MonitorEnvelope::try_new(
        shared.epoch.clone(),
        shared.settings.producer_id.clone(),
        event_seq,
        event,
    )
    .and_then(|envelope| envelope.encode());
    match encoded {
        Ok(bytes) => {
            state.heartbeats.push_back(QueuedMonitor {
                event_seq,
                bytes,
                is_summary: false,
                fusion_seq: None,
            });
            bump(&mut state.counters.admitted_monitor_events, 1);
            true
        }
        Err(_) => {
            record_monitor_drop(&mut state, 1);
            false
        }
    }
}

fn unix_timestamp_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(JSON_SAFE_U64_MAX)
    .min(JSON_SAFE_U64_MAX)
}

fn pop_lowest_monitor(state: &mut RuntimeState) -> Option<QueuedMonitor> {
    loop {
        let lane = [
            state.outcomes.front().map(|event| (event.event_seq, 0_u8)),
            state.summaries.front().map(|event| (event.event_seq, 1_u8)),
            state
                .heartbeats
                .front()
                .map(|event| (event.event_seq, 2_u8)),
        ]
        .into_iter()
        .flatten()
        .min_by_key(|(event_seq, _)| *event_seq)
        .map(|(_, lane)| lane)?;
        if lane == 1 {
            let summary_seq = state
                .summaries
                .front()
                .and_then(|summary| summary.fusion_seq)
                .unwrap_or_else(|| unreachable!("summary queue carries fusion sequence"));
            let waiting_observation = state
                .observations
                .iter()
                .any(|observation| observation.fusion_seq <= summary_seq)
                || state
                    .in_flight_observation_seq
                    .is_some_and(|fusion_seq| fusion_seq <= summary_seq);
            if waiting_observation {
                return None;
            }
        }
        let mut item = match lane {
            0 => state.outcomes.pop_front(),
            1 => state.summaries.pop_front(),
            2 => state.heartbeats.pop_front(),
            _ => unreachable!("monitor lane selector is bounded"),
        }?;
        if item.is_summary && state.degraded && force_degraded_summary(&mut item).is_err() {
            record_monitor_drop(state, 1);
            continue;
        }
        return Some(item);
    }
}

fn force_degraded_summary(item: &mut QueuedMonitor) -> Result<(), String> {
    let mut envelope = serde_json::from_slice::<MonitorEnvelope>(&item.bytes)
        .map_err(|error| format!("queued frame summary failed to decode: {error}"))?;
    let ProducerEvent::FrameSummary(summary) = &mut envelope.event else {
        return Err("summary lane contained a non-summary event".to_string());
    };
    summary.degraded = true;
    item.bytes = envelope
        .encode()
        .map_err(|error| format!("degraded frame summary failed to encode: {error}"))?;
    Ok(())
}

async fn wait_for_work(notify: &tokio::sync::Notify) {
    let notified = notify.notified();
    let _ = tokio::time::timeout(WORKER_IDLE_POLL, notified).await;
}

fn request_shutdown(shared: &SharedRuntime) {
    if !shared.shutdown.swap(true, Ordering::AcqRel) {
        shared.observation_notify.notify_waiters();
        shared.monitor_notify.notify_waiters();
        shared.shutdown_notify.notify_one();
    }
}

fn account_abandoned_evidence(shared: &SharedRuntime) {
    let mut state = lock_unpoisoned(&shared.state);
    if state.terminal_accounting {
        return;
    }
    state.terminal_accounting = true;
    let pending_observations = state
        .observations
        .len()
        .saturating_add(state.in_flight_observations);
    let pending_monitor = state
        .outcomes
        .len()
        .saturating_add(state.summaries.len())
        .saturating_add(state.heartbeats.len())
        .saturating_add(state.in_flight_monitor_events);
    if pending_observations > 0 || pending_monitor > 0 {
        state.degraded = true;
        bump(
            &mut state.counters.dropped_observations,
            pending_observations,
        );
        bump(&mut state.counters.dropped_monitor_events, pending_monitor);
    }
    state.observations.clear();
    state.outcomes.clear();
    state.summaries.clear();
    state.heartbeats.clear();
    state.in_flight_observations = 0;
    state.in_flight_observation_seq = None;
    state.in_flight_monitor_events = 0;
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};

    use super::*;
    use crate::pid_observation::ConsistencyProjection;
    use crate::producer_monitor::{
        GateEvidence, GateMethod, ModalityMiss, ModalityMissReason, ModalityOutcome,
        ModalityOutcomeKind,
    };
    use crate::sensor_fusion::{DetectionClassKind, SensorModality};

    const FRAME_ID: u64 = 17;
    const CONTEXT_ID: u64 = 23;
    const SOFTWARE_DIGEST: &str =
        "8888888888888888888888888888888888888888888888888888888888888888";
    const CONFIGURATION_DIGEST: &str =
        "9999999999999999999999999999999999999999999999999999999999999999";
    const EPOCH: &str = "crebain-test-epoch";

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct SentEvidence {
        key: String,
        bytes: Vec<u8>,
    }

    #[derive(Debug, Default)]
    struct RecorderState {
        failures_remaining: usize,
        sent: Vec<SentEvidence>,
    }

    #[derive(Clone, Default)]
    struct RecordingPublisher {
        state: Arc<Mutex<RecorderState>>,
    }

    impl RecordingPublisher {
        fn fail_next(&self, count: usize) {
            lock_unpoisoned(&self.state).failures_remaining = count;
        }

        fn sent(&self) -> Vec<SentEvidence> {
            lock_unpoisoned(&self.state).sent.clone()
        }
    }

    impl BytePublisher for RecordingPublisher {
        #[expect(
            clippy::manual_async_fn,
            reason = "the test implementation must satisfy the trait's Send future guarantee"
        )]
        fn put_evidence<'a>(
            &'a self,
            key: &'a str,
            payload: &'a [u8],
        ) -> impl Future<Output = Result<(), String>> + Send + 'a {
            async move {
                let mut state = lock_unpoisoned(&self.state);
                if state.failures_remaining > 0 {
                    state.failures_remaining -= 1;
                    return Err("injected transport failure".to_string());
                }
                state.sent.push(SentEvidence {
                    key: key.to_string(),
                    bytes: payload.to_vec(),
                });
                Ok(())
            }
        }
    }

    #[derive(Clone)]
    struct DelayedObservationFailurePublisher {
        state: Arc<Mutex<RecorderState>>,
        observation_started: Arc<tokio::sync::Notify>,
        release_observation: Arc<tokio::sync::Notify>,
    }

    impl BytePublisher for DelayedObservationFailurePublisher {
        #[expect(
            clippy::manual_async_fn,
            reason = "the test implementation must satisfy the trait's Send future guarantee"
        )]
        fn put_evidence<'a>(
            &'a self,
            key: &'a str,
            payload: &'a [u8],
        ) -> impl Future<Output = Result<(), String>> + Send + 'a {
            async move {
                if key.ends_with("/galadriel-pid") {
                    self.observation_started.notify_one();
                    self.release_observation.notified().await;
                    return Err("delayed observation failure".to_string());
                }
                lock_unpoisoned(&self.state).sent.push(SentEvidence {
                    key: key.to_string(),
                    bytes: payload.to_vec(),
                });
                Ok(())
            }
        }
    }

    fn digest(character: char) -> String {
        character.to_string().repeat(SHA256_HEX_LEN)
    }

    fn content(identifier: &str, character: char) -> Value {
        json!({
            "identifier": identifier,
            "content_digest": digest(character),
        })
    }

    fn test_registry() -> DeploymentRegistry {
        let document = json!({
            "schema_version": "1.0",
            "registry_version": "test-deployment",
            "opportunity_policy": {
                "rule": "frozen_active_track_modality_input_order_v1",
                "max_active_tracks": 8,
                "max_frame_inputs": 8,
                "max_attempts_per_track_modality": 8,
                "max_outcomes_per_frame": 8,
                "max_monitor_queue_events": 16,
            },
            "frames": [{
                "frame_id": FRAME_ID,
                "canonical_enu_frame": "map_enu",
                "origin": content("site_origin", '1'),
                "datum": content("wgs84", '2'),
                "axis_order": ["east", "north", "up"],
                "axis_directions": ["positive_east", "positive_north", "positive_up"],
                "handedness": "right_handed",
                "linear_unit": "meter",
                "applicability": {
                    "valid_from_timestamp_ms": 1_000,
                    "valid_until_timestamp_ms": 2_000,
                },
                "source_frames": [{
                    "canonical_source_frame": "camera_optical",
                    "transform_authority": "tf2_static",
                    "aggregate_extrinsic": content("camera_extrinsic", '3'),
                    "transform_chain": [{
                        "from_frame": "camera_optical",
                        "to_frame": "map_enu",
                        "transform": content("camera_extrinsic", '3'),
                    }],
                }],
            }],
            "contexts": [{
                "context_id": CONTEXT_ID,
                "frame_id": FRAME_ID,
                "applicability": {
                    "valid_from_timestamp_ms": 1_000,
                    "valid_until_timestamp_ms": 2_000,
                },
                "projection_algorithm": {
                    "identifier": "common_enu_residual",
                    "version": "1.0.0",
                    "content_digest": digest('4'),
                },
                "output_dimensions": 3,
                "axis_order": ["east", "north", "up"],
                "covariance_semantics": "frozen_prior_projected_observation_covariance",
                "linearization_semantics": "immutable_pre_association_prior",
                "expected_modalities": [{
                    "modality": "visual",
                    "canonical_source_frame": "camera_optical",
                    "calibration": content("camera_calibration", '5'),
                    "extrinsic": content("camera_extrinsic", '3'),
                }],
                "producer_software_digest": SOFTWARE_DIGEST,
                "producer_configuration_digest": CONFIGURATION_DIGEST,
            }],
        });
        DeploymentRegistry::from_json(
            &serde_json::to_vec(&document).expect("registry fixture encodes"),
        )
        .expect("registry fixture validates")
    }

    fn settings(capacities: QueueCapacities) -> RuntimeSettings {
        RuntimeSettings {
            realm: "ncp".to_string(),
            producer_id: "crebain-test".to_string(),
            frame_id: FRAME_ID,
            context_id: CONTEXT_ID,
            software_digest: SOFTWARE_DIGEST.to_string(),
            configuration_digest: CONFIGURATION_DIGEST.to_string(),
            heartbeat_interval: Duration::from_millis(MAX_HEARTBEAT_DURATION_MS),
            heartbeat_deadline_ms: MAX_HEARTBEAT_DURATION_MS,
            capacities,
        }
    }

    fn capacities(
        observations: u32,
        outcomes: u32,
        summaries: u32,
        heartbeats: u32,
    ) -> QueueCapacities {
        QueueCapacities {
            observations,
            outcomes,
            summaries,
            heartbeats,
        }
    }

    fn start_test_runtime(
        recorder: RecordingPublisher,
        queue_capacities: QueueCapacities,
    ) -> GaladrielRuntime {
        start_with_publisher(
            recorder,
            settings(queue_capacities),
            test_registry(),
            EPOCH.to_string(),
        )
        .expect("test runtime starts")
    }

    fn projection(prior_id: u64) -> ConsistencyProjection {
        ConsistencyProjection {
            values: [0.25, -0.5, 0.75],
            dimensions: 3,
            frame_id: FRAME_ID,
            context_id: CONTEXT_ID,
            prior_id,
        }
    }

    fn summary(fusion_seq: u64, prior_id: u64) -> FrameSummary {
        FrameSummary {
            fusion_seq,
            fusion_timestamp_ms: 1_500,
            frame_id: FRAME_ID,
            context_id: CONTEXT_ID,
            prior_id,
            registry_digest: digest('0'),
            expected_modalities: vec![SensorModality::Visual],
            active_track_count: 2,
            input_count: 0,
            outcome_count: 0,
            v1_expected_count: 0,
            degraded: false,
            truncated: false,
        }
    }

    fn summary_with_inputs(fusion_seq: u64, prior_id: u64) -> FrameSummary {
        FrameSummary {
            input_count: 2,
            ..summary(fusion_seq, prior_id)
        }
    }

    fn frozen_track(track_id: u64, class: DetectionClassKind) -> FrozenOpportunityTrack {
        FrozenOpportunityTrack { track_id, class }
    }

    fn single_frozen_track() -> Vec<FrozenOpportunityTrack> {
        vec![frozen_track(5, DetectionClassKind::Drone)]
    }

    fn two_frozen_tracks() -> Vec<FrozenOpportunityTrack> {
        vec![
            frozen_track(5, DetectionClassKind::Drone),
            frozen_track(6, DetectionClassKind::Bird),
        ]
    }

    fn opportunity_inputs() -> Vec<OpportunityInput> {
        vec![
            OpportunityInput {
                measurement_index: 0,
                modality: SensorModality::Visual,
                class: DetectionClassKind::Drone,
            },
            OpportunityInput {
                measurement_index: 1,
                modality: SensorModality::Visual,
                class: DetectionClassKind::Bird,
            },
        ]
    }

    fn miss(fusion_seq: u64, prior_id: u64, track_id: u64) -> ProducerEvent {
        ProducerEvent::ModalityMiss(ModalityMiss {
            fusion_seq,
            fusion_timestamp_ms: 1_500,
            frame_id: FRAME_ID,
            context_id: CONTEXT_ID,
            prior_id,
            track_id,
            modality: SensorModality::Visual,
            reason: ModalityMissReason::NoMeasurement,
        })
    }

    fn observation(fusion_seq: u64, prior_id: u64, track_id: u64) -> PidObservation {
        PidObservation {
            track_id,
            timestamp_ms: 1_500,
            seq: fusion_seq,
            modality: SensorModality::Visual,
            nis: 0.5,
            dof: 3,
            innovation: None,
            innovation_cov: None,
            consistency_projection: Some(projection(prior_id)),
        }
    }

    fn updated(fusion_seq: u64, prior_id: u64, track_id: u64, attempt_index: u32) -> ProducerEvent {
        ProducerEvent::ModalityOutcome(ModalityOutcome {
            fusion_seq,
            fusion_timestamp_ms: 1_500,
            frame_id: FRAME_ID,
            context_id: CONTEXT_ID,
            prior_id,
            track_id,
            modality: SensorModality::Visual,
            attempt_index,
            measurement_index: Some(attempt_index),
            outcome: ModalityOutcomeKind::Updated,
            v1_expected: true,
            candidate_count: 1,
            in_gate_count: 1,
            gate_evidence: Some(GateEvidence {
                method: GateMethod::Mahalanobis,
                d2: 0.5,
                threshold: 1.0,
            }),
            consistency_projection: Some(projection(prior_id)),
        })
    }

    fn updated_for_input(
        fusion_seq: u64,
        prior_id: u64,
        track_id: u64,
        attempt_index: u32,
        measurement_index: u32,
    ) -> ProducerEvent {
        let mut event = updated(fusion_seq, prior_id, track_id, attempt_index);
        let ProducerEvent::ModalityOutcome(outcome) = &mut event else {
            unreachable!("updated fixture is an outcome");
        };
        outcome.measurement_index = Some(measurement_index);
        event
    }

    fn empty_batch(fusion_seq: u64, prior_id: u64) -> FusionFrameBatch {
        let mut summary = summary(fusion_seq, prior_id);
        summary.active_track_count = 0;
        summary.input_count = 0;
        FusionFrameBatch {
            frozen_track_ids: Vec::new(),
            frozen_opportunity_tracks: Vec::new(),
            opportunity_inputs: Vec::new(),
            observations: Vec::new(),
            events: Vec::new(),
            summary,
        }
    }

    fn run_async(test: impl Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("test runtime builds")
            .block_on(test);
    }

    async fn wait_for_sent(recorder: &RecordingPublisher, expected: usize) {
        for _ in 0..200 {
            if recorder.sent().len() >= expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("timed out waiting for {expected} evidence records");
    }

    #[test]
    fn opt_in_accepts_only_zero_one_or_absent() {
        let disabled = HashMap::<String, String>::new();
        let result = settings_from_lookup(|name| Ok(disabled.get(name).cloned()))
            .expect("absent switch is valid");
        assert!(result.is_none());

        let invalid = HashMap::from([(ENABLE_ENV.to_string(), "true".to_string())]);
        let error = settings_from_lookup(|name| Ok(invalid.get(name).cloned()))
            .expect_err("ambiguous switch must fail");
        assert!(matches!(error, ProducerRuntimeError::Configuration(_)));
    }

    #[test]
    fn canonical_keys_and_encoded_bytes_match_frozen_envelopes() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder.clone(), capacities(2, 2, 2, 2));
            let handle = runtime.handle();
            let observation = observation(7, 31, 5);
            let outcome = updated(7, 31, 5, 0);
            let mut expected_summary = summary_with_inputs(7, 31);
            expected_summary.registry_digest = handle.registry().digest().to_string();
            expected_summary.outcome_count = 1;
            expected_summary.v1_expected_count = 1;

            handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: vec![frozen_track(5, DetectionClassKind::Drone)],
                    opportunity_inputs: opportunity_inputs(),
                    observations: vec![observation.clone()],
                    events: vec![outcome.clone()],
                    summary: summary_with_inputs(7, 31),
                })
                .expect("frame admits");
            wait_for_sent(&recorder, 3).await;

            assert_eq!(
                handle.observation_key(),
                "ncp/session/crebain-test-epoch/sensor/galadriel-pid"
            );
            assert_eq!(
                handle.monitor_key(),
                "ncp/session/crebain-test-epoch/sensor/galadriel-monitor"
            );
            let sent = recorder.sent();
            let observation_record = sent
                .iter()
                .find(|record| record.key == handle.observation_key())
                .expect("observation record exists");
            let expected_observation = SidecarEnvelope::try_new(EPOCH, "crebain-test", observation)
                .and_then(|envelope| envelope.encode())
                .expect("expected observation encodes");
            assert_eq!(observation_record.bytes, expected_observation);

            let monitor_records = sent
                .iter()
                .filter(|record| record.key == handle.monitor_key())
                .collect::<Vec<_>>();
            let expected_outcome = MonitorEnvelope::try_new(EPOCH, "crebain-test", 1, outcome)
                .and_then(|envelope| envelope.encode())
                .expect("expected outcome encodes");
            let expected_summary = MonitorEnvelope::try_new(
                EPOCH,
                "crebain-test",
                2,
                ProducerEvent::FrameSummary(expected_summary),
            )
            .and_then(|envelope| envelope.encode())
            .expect("expected summary encodes");
            assert_eq!(monitor_records[0].bytes, expected_outcome);
            assert_eq!(monitor_records[1].bytes, expected_summary);
            runtime.shutdown().await;
        });
    }

    #[test]
    fn monitor_worker_selects_lowest_sequence_across_lanes() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder.clone(), capacities(1, 2, 2, 2));
            let handle = runtime.handle();
            assert!(enqueue_heartbeat(&handle.shared));
            handle.shared.monitor_notify.notify_one();
            handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: single_frozen_track(),
                    opportunity_inputs: Vec::new(),
                    observations: Vec::new(),
                    events: vec![miss(7, 31, 5)],
                    summary: summary(7, 31),
                })
                .expect("frame admits");
            wait_for_sent(&recorder, 3).await;

            let sequences = recorder
                .sent()
                .iter()
                .filter(|record| record.key == handle.monitor_key())
                .map(|record| {
                    serde_json::from_slice::<MonitorEnvelope>(&record.bytes)
                        .expect("monitor record decodes")
                        .event_seq
                })
                .collect::<Vec<_>>();
            assert_eq!(sequences, vec![1, 2, 3]);
            runtime.shutdown().await;
        });
    }

    #[test]
    fn dropped_outcome_consumes_sequence_and_degrades_summary() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder.clone(), capacities(1, 1, 1, 1));
            let handle = runtime.handle();
            let report = handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5, 6],
                    frozen_opportunity_tracks: two_frozen_tracks(),
                    opportunity_inputs: Vec::new(),
                    observations: Vec::new(),
                    events: vec![miss(7, 31, 5), miss(7, 31, 6)],
                    summary: summary(7, 31),
                })
                .expect("bounded frame admits");
            assert_eq!(report.assigned_monitor_sequences, vec![1, 2, 3]);
            assert_eq!(report.dropped_events, 1);
            assert!(report.frame_degraded);
            wait_for_sent(&recorder, 2).await;

            let envelopes = recorder
                .sent()
                .iter()
                .filter(|record| record.key == handle.monitor_key())
                .map(|record| {
                    serde_json::from_slice::<MonitorEnvelope>(&record.bytes)
                        .expect("monitor record decodes")
                })
                .collect::<Vec<_>>();
            assert_eq!(
                envelopes
                    .iter()
                    .map(|envelope| envelope.event_seq)
                    .collect::<Vec<_>>(),
                vec![1, 3]
            );
            let ProducerEvent::FrameSummary(summary) = &envelopes[1].event else {
                panic!("second monitor record must be a summary");
            };
            assert!(summary.degraded && summary.truncated);
            assert_eq!(summary.outcome_count, 2);
            assert_eq!(handle.status().counters.dropped_monitor_events, 1);
            runtime.shutdown().await;
        });
    }

    #[test]
    fn observation_drop_does_not_consume_outcome_or_summary_lanes() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder.clone(), capacities(1, 2, 1, 1));
            let handle = runtime.handle();
            let report = handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5, 6],
                    frozen_opportunity_tracks: two_frozen_tracks(),
                    opportunity_inputs: opportunity_inputs(),
                    observations: vec![observation(7, 31, 5), observation(7, 31, 6)],
                    events: vec![
                        updated_for_input(7, 31, 5, 0, 0),
                        updated_for_input(7, 31, 6, 0, 1),
                    ],
                    summary: summary_with_inputs(7, 31),
                })
                .expect("bounded frame admits");
            assert_eq!(report.dropped_observations, 1);
            assert_eq!(report.admitted_events, 2);
            assert!(report.summary_admitted);
            assert!(report.frame_degraded);
            wait_for_sent(&recorder, 4).await;
            assert_eq!(handle.status().counters.dropped_observations, 1);
            runtime.shutdown().await;
        });
    }

    #[test]
    fn heartbeat_lane_remains_available_when_outcome_lane_is_full() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(1, 1, 1, 1));
            let handle = runtime.handle();
            handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: single_frozen_track(),
                    opportunity_inputs: Vec::new(),
                    observations: Vec::new(),
                    events: vec![miss(7, 31, 5)],
                    summary: summary(7, 31),
                })
                .expect("frame admits");
            assert!(enqueue_heartbeat(&handle.shared));
            let depths = handle.status().queue_depths;
            assert_eq!(depths.outcomes, 1);
            assert_eq!(depths.summaries, 1);
            assert_eq!(depths.heartbeats, 1);
            runtime.shutdown().await;
        });
    }

    #[test]
    fn transport_failure_permanently_degrades_epoch() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            recorder.fail_next(1);
            let runtime = start_test_runtime(recorder.clone(), capacities(1, 1, 1, 1));
            let handle = runtime.handle();
            handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: single_frozen_track(),
                    opportunity_inputs: Vec::new(),
                    observations: Vec::new(),
                    events: vec![miss(7, 31, 5)],
                    summary: summary(7, 31),
                })
                .expect("frame admits");
            wait_for_sent(&recorder, 1).await;
            let status = handle.status();
            assert!(status.degraded);
            assert_eq!(status.counters.failed_monitor_publishes, 1);
            assert_eq!(status.counters.dropped_monitor_events, 1);
            runtime.shutdown().await;
        });
    }

    #[test]
    fn checked_sequence_exhaustion_never_wraps() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(1, 1, 2, 1));
            let handle = runtime.handle();
            lock_unpoisoned(&handle.shared.state).next_event_seq = Some(JSON_SAFE_U64_MAX);
            let first = handle
                .admit_frame(empty_batch(7, 31))
                .expect("last safe sequence admits");
            assert_eq!(first.assigned_monitor_sequences, vec![JSON_SAFE_U64_MAX]);
            let error = handle
                .admit_frame(empty_batch(8, 32))
                .expect_err("exhausted sequence rejects next frame");
            assert_eq!(error, ProducerRuntimeError::EventSequenceExhausted);
            let status = handle.status();
            assert_eq!(status.next_event_seq, None);
            assert!(status.degraded);
            runtime.shutdown().await;
        });
    }

    #[test]
    fn duplicate_fusion_sequence_is_rejected_without_reservation() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(1, 1, 2, 1));
            let handle = runtime.handle();
            handle
                .admit_frame(empty_batch(7, 31))
                .expect("first frame admits");
            let error = handle
                .admit_frame(empty_batch(7, 32))
                .expect_err("duplicate frame must fail");
            assert!(matches!(error, ProducerRuntimeError::InvalidFrame(_)));
            assert_eq!(handle.status().next_event_seq, Some(2));
            runtime.shutdown().await;
        });
    }

    #[test]
    fn heartbeat_status_update_does_not_preempt_frame_admission() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(1, 1, 1, 1));
            let handle = runtime.handle();
            handle
                .update_fusion_status(Some(7), 2)
                .expect("status update accepts current fusion sequence");
            handle
                .admit_frame(empty_batch(7, 31))
                .expect("first admission remains open after status update");
            runtime.shutdown().await;
        });
    }

    #[test]
    fn explicit_internal_fault_latch_is_visible_in_heartbeat() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder.clone(), capacities(1, 1, 1, 1));
            let handle = runtime.handle();
            handle.mark_degraded();
            assert!(enqueue_heartbeat(&handle.shared));
            handle.shared.monitor_notify.notify_one();
            wait_for_sent(&recorder, 1).await;
            let envelope = serde_json::from_slice::<MonitorEnvelope>(&recorder.sent()[0].bytes)
                .expect("heartbeat decodes");
            let ProducerEvent::Heartbeat(heartbeat) = envelope.event else {
                panic!("record must be a heartbeat");
            };
            assert!(heartbeat.degraded);
            runtime.shutdown().await;
        });
    }

    #[test]
    fn duplicate_outcome_identity_is_rejected() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(2, 2, 1, 1));
            let handle = runtime.handle();
            let error = handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: single_frozen_track(),
                    opportunity_inputs: opportunity_inputs(),
                    observations: vec![observation(7, 31, 5), observation(7, 31, 6)],
                    events: vec![updated(7, 31, 5, 0), updated(7, 31, 5, 0)],
                    summary: summary_with_inputs(7, 31),
                })
                .expect_err("duplicate outcome must fail");
            assert!(matches!(error, ProducerRuntimeError::InvalidFrame(_)));
            runtime.shutdown().await;
        });
    }

    #[test]
    fn duplicate_v1_expected_identity_is_rejected_across_attempts() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(2, 2, 1, 1));
            let handle = runtime.handle();
            let error = handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: single_frozen_track(),
                    opportunity_inputs: opportunity_inputs(),
                    observations: vec![observation(7, 31, 5), observation(7, 31, 6)],
                    events: vec![updated(7, 31, 5, 0), updated(7, 31, 5, 1)],
                    summary: summary_with_inputs(7, 31),
                })
                .expect_err("duplicate v1 identity must fail");
            assert!(matches!(error, ProducerRuntimeError::InvalidFrame(_)));
            runtime.shutdown().await;
        });
    }

    #[test]
    fn duplicate_miss_identity_is_rejected() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(1, 2, 1, 1));
            let handle = runtime.handle();
            let error = handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: single_frozen_track(),
                    opportunity_inputs: Vec::new(),
                    observations: Vec::new(),
                    events: vec![miss(7, 31, 5), miss(7, 31, 5)],
                    summary: summary(7, 31),
                })
                .expect_err("duplicate miss must fail");
            assert!(matches!(error, ProducerRuntimeError::InvalidFrame(_)));
            runtime.shutdown().await;
        });
    }

    #[test]
    fn duplicate_observation_identity_is_rejected() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(2, 2, 1, 1));
            let handle = runtime.handle();
            let error = handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5, 6],
                    frozen_opportunity_tracks: two_frozen_tracks(),
                    opportunity_inputs: opportunity_inputs(),
                    observations: vec![observation(7, 31, 5), observation(7, 31, 5)],
                    events: vec![
                        updated_for_input(7, 31, 5, 0, 0),
                        updated_for_input(7, 31, 6, 0, 1),
                    ],
                    summary: summary_with_inputs(7, 31),
                })
                .expect_err("duplicate observation must fail");
            assert!(matches!(error, ProducerRuntimeError::InvalidFrame(_)));
            runtime.shutdown().await;
        });
    }

    #[test]
    fn reused_prior_is_rejected_before_sequence_reservation() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(1, 1, 2, 1));
            let handle = runtime.handle();
            handle
                .admit_frame(empty_batch(7, 31))
                .expect("first prior admits");
            let error = handle
                .admit_frame(empty_batch(8, 31))
                .expect_err("a prior cannot be reused by a newer frame");
            assert!(matches!(error, ProducerRuntimeError::InvalidFrame(_)));
            assert_eq!(handle.status().next_event_seq, Some(2));
            runtime.shutdown().await;
        });
    }

    #[test]
    fn latched_degradation_is_carried_by_later_frame_summary() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder.clone(), capacities(1, 1, 1, 1));
            let handle = runtime.handle();
            handle.mark_degraded();
            let report = handle
                .admit_frame(empty_batch(7, 31))
                .expect("degraded frame still admits explicit closure");
            assert!(report.frame_degraded);
            wait_for_sent(&recorder, 1).await;
            let envelope = serde_json::from_slice::<MonitorEnvelope>(&recorder.sent()[0].bytes)
                .expect("summary decodes");
            let ProducerEvent::FrameSummary(summary) = envelope.event else {
                panic!("record must be a frame summary");
            };
            assert!(summary.degraded);
            assert!(!summary.truncated);
            runtime.shutdown().await;
        });
    }

    #[test]
    fn observation_failure_degrades_blocked_summary_before_transmission() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let publisher = DelayedObservationFailurePublisher {
                state: recorder.state.clone(),
                observation_started: Arc::new(tokio::sync::Notify::new()),
                release_observation: Arc::new(tokio::sync::Notify::new()),
            };
            let runtime = start_with_publisher(
                publisher.clone(),
                settings(capacities(1, 1, 1, 1)),
                test_registry(),
                EPOCH.to_string(),
            )
            .expect("test runtime starts");
            let handle = runtime.handle();
            handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: single_frozen_track(),
                    opportunity_inputs: opportunity_inputs(),
                    observations: vec![observation(7, 31, 5)],
                    events: vec![updated(7, 31, 5, 0)],
                    summary: summary_with_inputs(7, 31),
                })
                .expect("frame admits");
            publisher.observation_started.notified().await;
            assert!(!recorder.sent().iter().any(|record| {
                serde_json::from_slice::<MonitorEnvelope>(&record.bytes)
                    .is_ok_and(|envelope| matches!(envelope.event, ProducerEvent::FrameSummary(_)))
            }));

            publisher.release_observation.notify_one();
            wait_for_sent(&recorder, 2).await;
            let summary = recorder
                .sent()
                .into_iter()
                .filter_map(|record| serde_json::from_slice::<MonitorEnvelope>(&record.bytes).ok())
                .find_map(|envelope| match envelope.event {
                    ProducerEvent::FrameSummary(summary) => Some(summary),
                    _ => None,
                })
                .expect("summary is eventually transmitted");
            assert!(summary.degraded);
            assert_eq!(handle.status().counters.failed_observation_publishes, 1);
            runtime.shutdown().await;
        });
    }

    #[test]
    fn omitted_frozen_cartesian_pair_is_rejected() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(1, 1, 1, 1));
            let handle = runtime.handle();
            let mut batch = empty_batch(7, 31);
            batch.frozen_track_ids = vec![5];
            batch.frozen_opportunity_tracks = single_frozen_track();
            let error = handle
                .admit_frame(batch)
                .expect_err("every frozen track/modality pair requires closure");
            assert!(matches!(error, ProducerRuntimeError::InvalidFrame(_)));
            runtime.shutdown().await;
        });
    }

    #[test]
    fn deepest_miss_reason_is_rederived_from_frozen_inputs() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(1, 1, 1, 1));
            let handle = runtime.handle();
            let mut frame_summary = summary(7, 31);
            frame_summary.input_count = 1;
            let error = handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: single_frozen_track(),
                    opportunity_inputs: vec![OpportunityInput {
                        measurement_index: 0,
                        modality: SensorModality::Visual,
                        class: DetectionClassKind::Bird,
                    }],
                    observations: Vec::new(),
                    events: vec![miss(7, 31, 5)],
                    summary: frame_summary,
                })
                .expect_err("visual input with the wrong class requires no_candidate");
            assert!(matches!(error, ProducerRuntimeError::InvalidFrame(_)));
            runtime.shutdown().await;
        });
    }

    #[test]
    fn omitted_candidate_input_is_rejected_even_when_counts_claim_zero() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(1, 1, 1, 1));
            let handle = runtime.handle();
            let mut frame_summary = summary(7, 31);
            frame_summary.input_count = 1;
            let mut false_miss_event = miss(7, 31, 5);
            let ProducerEvent::ModalityMiss(false_miss) = &mut false_miss_event else {
                unreachable!("miss fixture is a miss event");
            };
            false_miss.reason = ModalityMissReason::NoCandidate;
            let error = handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: single_frozen_track(),
                    opportunity_inputs: vec![OpportunityInput {
                        measurement_index: 0,
                        modality: SensorModality::Visual,
                        class: DetectionClassKind::Drone,
                    }],
                    observations: Vec::new(),
                    events: vec![false_miss_event],
                    summary: frame_summary,
                })
                .expect_err("matching input must appear as an attempt outcome");
            assert!(matches!(error, ProducerRuntimeError::InvalidFrame(_)));
            runtime.shutdown().await;
        });
    }

    #[test]
    fn noncontiguous_pair_attempts_are_rejected() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(1, 1, 1, 1));
            let handle = runtime.handle();
            let error = handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: single_frozen_track(),
                    opportunity_inputs: opportunity_inputs(),
                    observations: vec![observation(7, 31, 5)],
                    events: vec![updated(7, 31, 5, 1)],
                    summary: summary_with_inputs(7, 31),
                })
                .expect_err("attempt indices must begin at zero");
            assert!(matches!(error, ProducerRuntimeError::InvalidFrame(_)));
            runtime.shutdown().await;
        });
    }

    #[test]
    fn terminal_outcome_and_aggregate_miss_are_rejected() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(1, 2, 1, 1));
            let handle = runtime.handle();
            let error = handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: single_frozen_track(),
                    opportunity_inputs: opportunity_inputs(),
                    observations: vec![observation(7, 31, 5)],
                    events: vec![updated(7, 31, 5, 0), miss(7, 31, 5)],
                    summary: summary_with_inputs(7, 31),
                })
                .expect_err("terminal disposition suppresses the aggregate miss");
            assert!(matches!(error, ProducerRuntimeError::InvalidFrame(_)));
            runtime.shutdown().await;
        });
    }

    #[test]
    fn v1_observation_projection_must_exactly_match_outcome() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let runtime = start_test_runtime(recorder, capacities(1, 1, 1, 1));
            let handle = runtime.handle();
            let mut mismatched = observation(7, 31, 5);
            mismatched
                .consistency_projection
                .as_mut()
                .expect("fixture projection")
                .values[0] += 1.0;
            let error = handle
                .admit_frame(FusionFrameBatch {
                    frozen_track_ids: vec![5],
                    frozen_opportunity_tracks: single_frozen_track(),
                    opportunity_inputs: opportunity_inputs(),
                    observations: vec![mismatched],
                    events: vec![updated(7, 31, 5, 0)],
                    summary: summary_with_inputs(7, 31),
                })
                .expect_err("joined projections must be numerically identical");
            assert!(matches!(error, ProducerRuntimeError::InvalidFrame(_)));
            runtime.shutdown().await;
        });
    }

    #[test]
    fn dropping_runtime_aborts_owned_tasks() {
        run_async(async {
            let recorder = RecordingPublisher::default();
            let weak = Arc::downgrade(&recorder.state);
            let runtime = start_test_runtime(recorder.clone(), capacities(1, 1, 1, 1));
            drop(recorder);
            drop(runtime);
            for _ in 0..20 {
                if weak.upgrade().is_none() {
                    return;
                }
                tokio::task::yield_now().await;
            }
            assert!(weak.upgrade().is_none(), "runtime tasks remained detached");
        });
    }
}

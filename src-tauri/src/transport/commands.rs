use super::camera_work::CameraWorkPermit;
use super::{
    create_bridge, CameraFrame, CameraFrameDelivery, CameraInfoData, CameraStreamKind, ImuData,
    ModelStates, PoseData, Transport, TransportError, TransportStats,
};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex, MutexGuard as StdMutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{oneshot, Mutex};

#[derive(Default)]
struct TransportEngine {
    generation: u64,
    bridge: Option<Arc<dyn Transport>>,
}

impl TransportEngine {
    fn accepts_install(&self, generation: u64) -> bool {
        self.generation == generation && self.bridge.is_none()
    }

    fn matches_expected_generation(&self, expected_generation: u64) -> bool {
        expected_generation == self.generation
    }
}

struct ActiveTransport {
    generation: u64,
    bridge: Arc<dyn Transport>,
}

// The mutex is held only to rotate a generation and swap or clone the Arc,
// never across a transport operation. The atomic mirror lets synchronous
// telemetry callbacks reject an invalidated generation without blocking.
static TRANSPORT_ENGINE: LazyLock<Mutex<TransportEngine>> =
    LazyLock::new(|| Mutex::new(TransportEngine::default()));
static ACTIVE_TRANSPORT_GENERATION: AtomicU64 = AtomicU64::new(0);
static CAMERA_DELIVERIES: LazyLock<StdMutex<CameraDeliveryState>> =
    LazyLock::new(|| StdMutex::new(CameraDeliveryState::default()));
// Camera subscribe/unsubscribe operations are uncommon control-plane work.
// Serializing them prevents a late declaration or cleanup for one topic from
// overtaking the exact subscription identity that superseded it.
static CAMERA_SUBSCRIPTION_OP: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

const MAX_TOPIC_LEN: usize = 256;
const TRANSPORT_EVENT_PREFIX: &str = "crebain:transport:";
const TRANSPORT_OP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CAMERA_DELIVERY_TOPICS: usize = 64;
const CAMERA_DELIVERY_LEASE: Duration = Duration::from_secs(30);

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraFrameReady {
    delivery_id: String,
    generation: String,
    camera_subscription_id: String,
}

#[derive(Debug)]
enum CameraDeliveryPhase {
    Ready(CameraFrameDelivery),
    InFlight(CameraWorkPermit),
}

#[derive(Debug)]
struct PendingCameraDelivery {
    topic: String,
    generation: u64,
    subscription_id: u64,
    expires_at: Instant,
    expiry_cancel: oneshot::Sender<()>,
    phase: CameraDeliveryPhase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CameraSubscriptionIdentity {
    generation: u64,
    subscription_id: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CameraSubscriptionState {
    Active(CameraSubscriptionIdentity),
    Quarantined(CameraSubscriptionIdentity),
}

impl CameraSubscriptionState {
    fn identity(self) -> CameraSubscriptionIdentity {
        match self {
            Self::Active(identity) | Self::Quarantined(identity) => identity,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CameraDeliveryLease {
    delivery_id: u64,
    expires_at: Instant,
}

#[derive(Debug)]
struct CameraDeliveryExpiry {
    lease: CameraDeliveryLease,
    cancelled: oneshot::Receiver<()>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CameraSubscriptionCleanup {
    topic: String,
    identity: CameraSubscriptionIdentity,
}

#[derive(Debug)]
struct CameraDeliveryExpiration {
    quarantined_subscription: Option<CameraSubscriptionCleanup>,
}

#[derive(Debug, Default)]
struct CameraDeliveryState {
    next_delivery_id: u64,
    by_id: HashMap<u64, PendingCameraDelivery>,
    by_topic: HashMap<String, u64>,
    subscriptions: HashMap<String, CameraSubscriptionState>,
}

impl CameraDeliveryState {
    fn enqueue(
        &mut self,
        topic: String,
        generation: u64,
        subscription_id: u64,
        delivery: CameraFrameDelivery,
    ) -> std::result::Result<(CameraDeliveryExpiry, CameraFrameReady), CameraFrameDelivery> {
        self.enqueue_at(topic, generation, subscription_id, delivery, Instant::now())
    }

    fn enqueue_at(
        &mut self,
        topic: String,
        generation: u64,
        subscription_id: u64,
        delivery: CameraFrameDelivery,
        now: Instant,
    ) -> std::result::Result<(CameraDeliveryExpiry, CameraFrameReady), CameraFrameDelivery> {
        let identity = CameraSubscriptionIdentity {
            generation,
            subscription_id,
        };
        if self.subscriptions.get(&topic) != Some(&CameraSubscriptionState::Active(identity)) {
            return Err(delivery);
        }
        if self.by_topic.contains_key(&topic) || self.by_topic.len() >= MAX_CAMERA_DELIVERY_TOPICS {
            return Err(delivery);
        }
        let Some(expires_at) = now.checked_add(CAMERA_DELIVERY_LEASE) else {
            return Err(delivery);
        };
        let Some(delivery_id) = self.next_delivery_id.checked_add(1) else {
            return Err(delivery);
        };
        let (expiry_cancel, cancelled) = oneshot::channel();
        self.next_delivery_id = delivery_id;
        self.by_topic.insert(topic.clone(), delivery_id);
        self.by_id.insert(
            delivery_id,
            PendingCameraDelivery {
                topic,
                generation,
                subscription_id,
                expires_at,
                expiry_cancel,
                phase: CameraDeliveryPhase::Ready(delivery),
            },
        );
        Ok((
            CameraDeliveryExpiry {
                lease: CameraDeliveryLease {
                    delivery_id,
                    expires_at,
                },
                cancelled,
            },
            CameraFrameReady {
                delivery_id: delivery_id.to_string(),
                generation: generation.to_string(),
                camera_subscription_id: subscription_id.to_string(),
            },
        ))
    }

    fn enqueue_and_notify(
        &mut self,
        topic: String,
        generation: u64,
        subscription_id: u64,
        delivery: CameraFrameDelivery,
        notify: impl FnOnce(&CameraFrameReady) -> Result<(), String>,
    ) -> Result<CameraDeliveryExpiry, String> {
        let (expiry, ready) = self
            .enqueue(topic, generation, subscription_id, delivery)
            .map_err(|_delivery| "Camera delivery topic is already occupied".to_string())?;
        let notification =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| notify(&ready)));
        match notification {
            Ok(Ok(())) => Ok(expiry),
            Ok(Err(error)) => {
                self.discard_unpulled_exact(expiry.lease.delivery_id);
                Err(error)
            }
            Err(_panic) => {
                // Notification is external code invoked while the delivery-state
                // mutex is held. Contain its unwind here so the exact ready entry
                // and permit can be retired without poisoning the registry.
                self.discard_unpulled_exact(expiry.lease.delivery_id);
                Err("Camera delivery notification panicked".to_string())
            }
        }
    }

    #[cfg(test)]
    fn take(
        &mut self,
        topic: &str,
        delivery_id: u64,
        generation: u64,
        subscription_id: u64,
    ) -> Result<CameraFrame, String> {
        self.take_with_expiry_cleanup(topic, delivery_id, generation, subscription_id)
            .0
    }

    fn take_with_expiry_cleanup(
        &mut self,
        topic: &str,
        delivery_id: u64,
        generation: u64,
        subscription_id: u64,
    ) -> (
        Result<CameraFrame, String>,
        Option<CameraSubscriptionCleanup>,
    ) {
        self.take_at_with_expiry_cleanup(
            topic,
            delivery_id,
            generation,
            subscription_id,
            Instant::now(),
        )
    }

    #[cfg(test)]
    fn take_at(
        &mut self,
        topic: &str,
        delivery_id: u64,
        generation: u64,
        subscription_id: u64,
        now: Instant,
    ) -> Result<CameraFrame, String> {
        self.take_at_with_expiry_cleanup(topic, delivery_id, generation, subscription_id, now)
            .0
    }

    fn take_at_with_expiry_cleanup(
        &mut self,
        topic: &str,
        delivery_id: u64,
        generation: u64,
        subscription_id: u64,
        now: Instant,
    ) -> (
        Result<CameraFrame, String>,
        Option<CameraSubscriptionCleanup>,
    ) {
        if let Err(error) =
            self.validate_pending_identity(topic, delivery_id, generation, subscription_id)
        {
            return (Err(error), None);
        }
        if let Some(expiration) = self.expire_delivery_if_due(delivery_id, now) {
            return (
                Err("Camera delivery lease expired".to_string()),
                expiration.quarantined_subscription,
            );
        }
        let Some(pending) = self.by_id.remove(&delivery_id) else {
            return (
                Err("Camera delivery state is inconsistent".to_string()),
                None,
            );
        };
        let PendingCameraDelivery {
            topic: pending_topic,
            generation: pending_generation,
            subscription_id: pending_subscription_id,
            expires_at,
            expiry_cancel,
            phase,
        } = pending;
        debug_assert_eq!(pending_topic, topic);
        debug_assert_eq!(pending_generation, generation);
        debug_assert_eq!(pending_subscription_id, subscription_id);
        let delivery = match phase {
            CameraDeliveryPhase::Ready(delivery) => delivery,
            CameraDeliveryPhase::InFlight(permit) => {
                self.by_id.insert(
                    delivery_id,
                    PendingCameraDelivery {
                        topic: pending_topic,
                        generation: pending_generation,
                        subscription_id: pending_subscription_id,
                        expires_at,
                        expiry_cancel,
                        phase: CameraDeliveryPhase::InFlight(permit),
                    },
                );
                return (Err("Camera delivery was already pulled".to_string()), None);
            }
        };
        let (frame, permit) = delivery.into_parts();
        self.by_id.insert(
            delivery_id,
            PendingCameraDelivery {
                topic: topic.to_string(),
                generation,
                subscription_id: pending_subscription_id,
                expires_at,
                expiry_cancel,
                phase: CameraDeliveryPhase::InFlight(permit),
            },
        );
        (Ok(frame), None)
    }

    #[cfg(test)]
    fn acknowledge(
        &mut self,
        topic: &str,
        delivery_id: u64,
        generation: u64,
        subscription_id: u64,
    ) -> Result<(), String> {
        self.acknowledge_with_expiry_cleanup(topic, delivery_id, generation, subscription_id)
            .0
    }

    fn acknowledge_with_expiry_cleanup(
        &mut self,
        topic: &str,
        delivery_id: u64,
        generation: u64,
        subscription_id: u64,
    ) -> (Result<(), String>, Option<CameraSubscriptionCleanup>) {
        self.acknowledge_at_with_expiry_cleanup(
            topic,
            delivery_id,
            generation,
            subscription_id,
            Instant::now(),
        )
    }

    #[cfg(test)]
    fn acknowledge_at(
        &mut self,
        topic: &str,
        delivery_id: u64,
        generation: u64,
        subscription_id: u64,
        now: Instant,
    ) -> Result<(), String> {
        self.acknowledge_at_with_expiry_cleanup(
            topic,
            delivery_id,
            generation,
            subscription_id,
            now,
        )
        .0
    }

    fn acknowledge_at_with_expiry_cleanup(
        &mut self,
        topic: &str,
        delivery_id: u64,
        generation: u64,
        subscription_id: u64,
        now: Instant,
    ) -> (Result<(), String>, Option<CameraSubscriptionCleanup>) {
        if let Err(error) =
            self.validate_pending_identity(topic, delivery_id, generation, subscription_id)
        {
            return (Err(error), None);
        }
        if let Some(expiration) = self.expire_delivery_if_due(delivery_id, now) {
            return (
                Err("Camera delivery lease expired".to_string()),
                expiration.quarantined_subscription,
            );
        }
        let Some(pending) = self.by_id.remove(&delivery_id) else {
            return (
                Err("Camera delivery state is inconsistent".to_string()),
                None,
            );
        };
        let PendingCameraDelivery {
            topic: pending_topic,
            generation: pending_generation,
            subscription_id: pending_subscription_id,
            expires_at,
            expiry_cancel,
            phase,
        } = pending;
        debug_assert_eq!(pending_topic, topic);
        debug_assert_eq!(pending_generation, generation);
        debug_assert_eq!(pending_subscription_id, subscription_id);
        match phase {
            CameraDeliveryPhase::InFlight(_permit) => {}
            CameraDeliveryPhase::Ready(delivery) => {
                self.by_id.insert(
                    delivery_id,
                    PendingCameraDelivery {
                        topic: pending_topic,
                        generation: pending_generation,
                        subscription_id: pending_subscription_id,
                        expires_at,
                        expiry_cancel,
                        phase: CameraDeliveryPhase::Ready(delivery),
                    },
                );
                return (
                    Err("Camera delivery must be pulled before acknowledgement".to_string()),
                    None,
                );
            }
        }
        self.by_topic.remove(topic);
        (Ok(()), None)
    }

    fn validate_pending_identity(
        &self,
        topic: &str,
        delivery_id: u64,
        generation: u64,
        subscription_id: u64,
    ) -> Result<(), String> {
        if self.by_topic.get(topic) != Some(&delivery_id) {
            return Err("Camera delivery is absent or no longer current".to_string());
        }
        let Some(pending) = self.by_id.get(&delivery_id) else {
            return Err("Camera delivery state is inconsistent".to_string());
        };
        if pending.topic != topic
            || pending.generation != generation
            || pending.subscription_id != subscription_id
        {
            return Err("Camera delivery identity does not match".to_string());
        }
        Ok(())
    }

    fn discard_unpulled_exact(&mut self, delivery_id: u64) {
        let Some(pending) = self.by_id.get(&delivery_id) else {
            return;
        };
        if !matches!(&pending.phase, CameraDeliveryPhase::Ready(_)) {
            return;
        }
        let topic = pending.topic.clone();
        self.by_id.remove(&delivery_id);
        if self.by_topic.get(&topic) == Some(&delivery_id) {
            self.by_topic.remove(&topic);
        }
    }

    fn discard_unpulled_topic_exact(&mut self, topic: &str, identity: CameraSubscriptionIdentity) {
        let Some(delivery_id) = self.by_topic.get(topic).copied() else {
            return;
        };
        let should_discard = self.by_id.get(&delivery_id).is_some_and(|pending| {
            pending.generation == identity.generation
                && pending.subscription_id == identity.subscription_id
                && matches!(&pending.phase, CameraDeliveryPhase::Ready(_))
        });
        if should_discard {
            self.discard_unpulled_exact(delivery_id);
        }
    }

    fn expire_delivery_if_due(
        &mut self,
        delivery_id: u64,
        now: Instant,
    ) -> Option<CameraDeliveryExpiration> {
        let pending = self.by_id.get(&delivery_id)?;
        if now < pending.expires_at {
            return None;
        }
        let lease = CameraDeliveryLease {
            delivery_id,
            expires_at: pending.expires_at,
        };
        self.expire_exact(lease, now)
    }

    fn expire_exact(
        &mut self,
        lease: CameraDeliveryLease,
        now: Instant,
    ) -> Option<CameraDeliveryExpiration> {
        let pending = self.by_id.get(&lease.delivery_id)?;
        if pending.expires_at != lease.expires_at || now < lease.expires_at {
            return None;
        }
        let identity = CameraSubscriptionIdentity {
            generation: pending.generation,
            subscription_id: pending.subscription_id,
        };
        let topic = pending.topic.clone();
        let pending = self.by_id.remove(&lease.delivery_id)?;
        if self.by_topic.get(&topic) == Some(&lease.delivery_id) {
            self.by_topic.remove(&topic);
        }
        let quarantined_subscription =
            if self.subscriptions.get(&topic) == Some(&CameraSubscriptionState::Active(identity)) {
                self.subscriptions.insert(
                    topic.clone(),
                    CameraSubscriptionState::Quarantined(identity),
                );
                Some(CameraSubscriptionCleanup { topic, identity })
            } else {
                None
            };
        drop(pending);
        Some(CameraDeliveryExpiration {
            quarantined_subscription,
        })
    }

    fn subscription_state(&self, topic: &str) -> Option<CameraSubscriptionState> {
        self.subscriptions.get(topic).copied()
    }

    fn activate(
        &mut self,
        topic: String,
        identity: CameraSubscriptionIdentity,
    ) -> Result<(), String> {
        if !self.subscriptions.contains_key(&topic)
            && self.subscriptions.len() >= MAX_CAMERA_DELIVERY_TOPICS
        {
            return Err("Camera subscription limit exceeded".to_string());
        }
        self.subscriptions
            .insert(topic, CameraSubscriptionState::Active(identity));
        Ok(())
    }

    fn quarantine_exact(&mut self, topic: &str, identity: CameraSubscriptionIdentity) -> bool {
        let Some(state) = self.subscriptions.get(topic).copied() else {
            return false;
        };
        if state.identity() != identity {
            return false;
        }
        self.subscriptions.insert(
            topic.to_string(),
            CameraSubscriptionState::Quarantined(identity),
        );
        true
    }

    fn is_quarantined_exact(&self, topic: &str, identity: CameraSubscriptionIdentity) -> bool {
        self.subscriptions.get(topic) == Some(&CameraSubscriptionState::Quarantined(identity))
    }

    fn remove_subscription_exact(
        &mut self,
        topic: &str,
        identity: CameraSubscriptionIdentity,
    ) -> bool {
        if self
            .subscriptions
            .get(topic)
            .is_none_or(|state| state.identity() != identity)
        {
            return false;
        }
        self.subscriptions.remove(topic);
        self.discard_unpulled_topic_exact(topic, identity);
        true
    }

    fn retire_generation(&mut self) {
        self.subscriptions.clear();
        let ready_ids = self
            .by_id
            .iter()
            .filter_map(|(delivery_id, pending)| {
                matches!(&pending.phase, CameraDeliveryPhase::Ready(_)).then_some(*delivery_id)
            })
            .collect::<Vec<_>>();
        for delivery_id in ready_ids {
            self.discard_unpulled_exact(delivery_id);
        }
    }
}

fn lock_camera_deliveries() -> StdMutexGuard<'static, CameraDeliveryState> {
    CAMERA_DELIVERIES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn queue_camera_delivery<R: Runtime>(
    app: &AppHandle<R>,
    topic: &str,
    event_name: &str,
    generation: u64,
    subscription_id: u64,
    delivery: CameraFrameDelivery,
) {
    if !generation_is_current(generation) {
        return;
    }
    let mut state = lock_camera_deliveries();
    if !generation_is_current(generation) {
        return;
    }
    let expiry = state.enqueue_and_notify(
        topic.to_string(),
        generation,
        subscription_id,
        delivery,
        |ready| {
            app.emit(event_name, ready)
                .map_err(|error| error.to_string())
        },
    );
    drop(state);
    match expiry {
        Ok(expiry) => schedule_camera_delivery_expiry(expiry),
        Err(error) => log::debug!("Dropping camera delivery for {topic}: {error}"),
    }
}

fn schedule_camera_delivery_expiry(expiry: CameraDeliveryExpiry) {
    tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::Instant::from_std(expiry.lease.expires_at);
        if tokio::time::timeout_at(deadline, expiry.cancelled)
            .await
            .is_err()
        {
            let cleanup = {
                let mut state = lock_camera_deliveries();
                state
                    .expire_exact(expiry.lease, Instant::now())
                    .and_then(|expiration| expiration.quarantined_subscription)
            };
            if let Some(cleanup) = cleanup {
                cleanup_expired_camera_subscription(cleanup).await;
            }
        }
    });
}

async fn cleanup_expired_camera_subscription(cleanup: CameraSubscriptionCleanup) {
    let _operation_guard = CAMERA_SUBSCRIPTION_OP.lock().await;
    let remains_quarantined = {
        let state = lock_camera_deliveries();
        state.is_quarantined_exact(&cleanup.topic, cleanup.identity)
    };
    if !remains_quarantined {
        return;
    }

    let active = match current_bridge(Some(cleanup.identity.generation)).await {
        Ok(active) => active,
        Err(error) => {
            log::debug!(
                "Retaining expired camera quarantine for '{}': {}",
                cleanup.topic,
                error
            );
            return;
        }
    };
    match with_timeout(active.bridge.unsubscribe(&cleanup.topic)).await {
        Ok(()) => {
            lock_camera_deliveries().remove_subscription_exact(&cleanup.topic, cleanup.identity);
        }
        Err(error) => {
            log::warn!(
                "Failed to remove expired camera subscription '{}': {}",
                cleanup.topic,
                error
            );
        }
    }
}

fn schedule_expired_camera_subscription_cleanup(cleanup: CameraSubscriptionCleanup) {
    tauri::async_runtime::spawn(cleanup_expired_camera_subscription(cleanup));
}

/// Clone the active bridge out of a briefly-held lock.
async fn current_bridge(expected_generation: Option<u64>) -> Result<ActiveTransport, String> {
    let engine = TRANSPORT_ENGINE.lock().await;
    if let Some(expected_generation) = expected_generation {
        if expected_generation != engine.generation {
            return Err(stale_generation_error(expected_generation));
        }
    }
    let bridge = engine
        .bridge
        .clone()
        .ok_or_else(|| "Transport not connected".to_string())?;
    Ok(ActiveTransport {
        generation: engine.generation,
        bridge,
    })
}

fn next_generation(generation: u64) -> Result<u64, String> {
    generation
        .checked_add(1)
        .ok_or_else(|| "Transport lifecycle generation exhausted".to_string())
}

async fn begin_lifecycle_change() -> Result<(u64, Option<Arc<dyn Transport>>), String> {
    let mut engine = TRANSPORT_ENGINE.lock().await;
    rotate_engine(&mut engine)
}

fn rotate_engine(
    engine: &mut TransportEngine,
) -> Result<(u64, Option<Arc<dyn Transport>>), String> {
    let generation = next_generation(engine.generation)?;
    engine.generation = generation;
    ACTIVE_TRANSPORT_GENERATION.store(generation, Ordering::Release);
    lock_camera_deliveries().retire_generation();
    Ok((generation, engine.bridge.take()))
}

async fn begin_disconnect(
    expected_generation: u64,
) -> Result<Option<(u64, Option<Arc<dyn Transport>>)>, String> {
    let mut engine = TRANSPORT_ENGINE.lock().await;
    if !engine.matches_expected_generation(expected_generation) {
        return Ok(None);
    }
    rotate_engine(&mut engine).map(Some)
}

fn generation_is_current(generation: u64) -> bool {
    ACTIVE_TRANSPORT_GENERATION.load(Ordering::Acquire) == generation
}

fn stale_generation_error(generation: u64) -> String {
    format!("Transport operation for stale generation {generation} was superseded")
}

fn require_generation(generation: Option<&str>) -> Result<u64, String> {
    let generation =
        generation.ok_or_else(|| "Transport lifecycle generation is required".to_string())?;
    parse_canonical_positive_u64(generation, "Transport lifecycle generation")
}

fn parse_delivery_id(delivery_id: &str) -> Result<u64, String> {
    parse_canonical_positive_u64(delivery_id, "Camera delivery ID")
}

fn parse_canonical_positive_u64(value: &str, label: &str) -> Result<u64, String> {
    if value.is_empty()
        || value.len() > 20
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || value.starts_with('0')
    {
        return Err(format!(
            "{label} must be a canonical positive u64 decimal string"
        ));
    }
    let parsed = value
        .parse::<u64>()
        .map_err(|_| format!("{label} exceeds u64"))?;
    if parsed.to_string() != value {
        return Err(format!("{label} must be canonical"));
    }
    Ok(parsed)
}

async fn finish_subscription(
    active: &ActiveTransport,
    topic: &str,
    result: Result<(), String>,
) -> Result<(), String> {
    result?;
    if generation_is_current(active.generation) {
        return Ok(());
    }

    // A disconnect can invalidate the generation while a native declaration
    // is awaiting. Best-effort removal drops any declaration that completed on
    // the old bridge; generation-gated callbacks already prevent stale emits.
    if let Err(error) = with_timeout(active.bridge.unsubscribe(topic)).await {
        log::debug!("Failed to remove stale subscription for {topic}: {error}");
    }
    Err(stale_generation_error(active.generation))
}

/// Run a transport operation with a timeout so a stalled transport cannot
/// block the command surface forever.
async fn with_timeout<T>(op: impl Future<Output = super::Result<T>>) -> Result<T, String> {
    match tokio::time::timeout(TRANSPORT_OP_TIMEOUT, op).await {
        Ok(result) => result.map_err(|e| e.to_string()),
        Err(_) => Err(TransportError::Timeout.to_string()),
    }
}

fn validate_topic(topic: &str) -> Result<(), String> {
    if topic.is_empty() || topic.trim() != topic {
        return Err("Transport topic must not be empty or padded".to_string());
    }
    if topic.contains('\0') {
        return Err("Transport topic must not contain null bytes".to_string());
    }
    if topic.len() > MAX_TOPIC_LEN {
        return Err(format!(
            "Transport topic is too long: {} bytes exceeds {}",
            topic.len(),
            MAX_TOPIC_LEN
        ));
    }
    if topic == "/" || !topic.starts_with('/') {
        return Err("Transport topic must be an absolute ROS name".to_string());
    }
    if topic.contains("//") {
        return Err("Transport topic must not contain empty path segments".to_string());
    }
    // ROS-graph character whitelist. This also keeps Zenoh key-expression
    // metacharacters (`*`, `?`, `#`, `$`, ...) out of topics passed verbatim as
    // key expressions.
    if !topic
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '/'))
    {
        return Err("Transport topic contains unsupported characters".to_string());
    }
    Ok(())
}

/// Map a ROS topic to a Tauri event name.
///
/// Tauri 2.x (`EventName::new`) rejects event names containing anything
/// outside alphanumerics, `-`, `/`, `:` and `_`, so an emit with an illegal
/// name fails and the frontend never receives the payload. ASCII
/// alphanumerics, `-` and `/` pass through; every other byte is escaped as
/// `_` + two uppercase hex digits (`_` itself becomes `_5F`, keeping the
/// mapping bijective). Must stay byte-identical with `getTransportEventName`
/// in `src/lib/transportEvents.ts`.
fn transport_event_name(topic: &str) -> String {
    let mut event_name = String::from(TRANSPORT_EVENT_PREFIX);
    for byte in topic.as_bytes() {
        let c = *byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '/') {
            event_name.push(c);
        } else {
            event_name.push_str(&format!("_{:02X}", byte));
        }
    }
    event_name
}

/// Connect to the transport layer (Zenoh or fallback)
#[tauri::command]
pub async fn transport_connect() -> Result<String, String> {
    log::info!("Connecting to transport layer...");

    // Rotate first. Any connect, subscription, or callback that started before
    // this point is stale even while its future is still in flight.
    let (generation, old_bridge) = begin_lifecycle_change().await?;
    if let Some(old_bridge) = old_bridge {
        if let Err(error) = with_timeout(old_bridge.disconnect()).await {
            log::warn!("Failed to disconnect old transport: {error}");
        }
    }

    // Create bridge (will pick Zenoh if enabled/configured)
    let mut bridge = match with_timeout(create_bridge()).await {
        Ok(bridge) => bridge,
        Err(_error) if !generation_is_current(generation) => {
            return Err(stale_generation_error(generation));
        }
        Err(error) => return Err(error),
    };

    // Connect
    if let Err(error) = with_timeout(bridge.connect()).await {
        if generation_is_current(generation) {
            return Err(error);
        }
        return Err(stale_generation_error(generation));
    }

    let bridge: Arc<dyn Transport> = Arc::from(bridge);
    let installed = {
        let mut engine = TRANSPORT_ENGINE.lock().await;
        if engine.accepts_install(generation) {
            engine.bridge = Some(Arc::clone(&bridge));
            true
        } else {
            false
        }
    };
    if !installed {
        if let Err(error) = with_timeout(bridge.disconnect()).await {
            log::debug!("Failed to close superseded transport generation {generation}: {error}");
        }
        return Err(stale_generation_error(generation));
    }

    log::info!("Transport generation {generation} connected successfully");
    Ok(generation.to_string())
}

/// Disconnect from the transport layer
#[tauri::command]
pub async fn transport_disconnect(generation: Option<String>) -> Result<(), String> {
    let generation = require_generation(generation.as_deref())?;
    log::info!("Disconnecting transport...");

    // Rotate and take the bridge first so callbacks become stale immediately,
    // even if the bounded native close stalls.
    let Some((_generation, bridge)) = begin_disconnect(generation).await? else {
        log::debug!("Ignoring disconnect for a stale transport generation");
        return Ok(());
    };
    if let Some(bridge) = bridge {
        with_timeout(bridge.disconnect()).await?;
    }
    Ok(())
}

/// Subscribe to a camera topic.
///
/// The topic event carries only a bounded delivery descriptor. The renderer
/// pulls the frame exactly once and acknowledges after its listeners settle or
/// their bounded quarantine deadline; the native lease remains authoritative.
#[tauri::command]
pub async fn transport_subscribe_camera<R: Runtime>(
    app: AppHandle<R>,
    topic: String,
    compressed: Option<bool>,
    camera_subscription_id: String,
    generation: Option<String>,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let generation = require_generation(generation.as_deref())?;
    let subscription_id = parse_delivery_id(&camera_subscription_id)?;
    let identity = CameraSubscriptionIdentity {
        generation,
        subscription_id,
    };
    let _operation_guard = CAMERA_SUBSCRIPTION_OP.lock().await;
    let active = current_bridge(Some(generation)).await?;
    let generation = active.generation;

    let existing_state = {
        let state = lock_camera_deliveries();
        state.subscription_state(&topic)
    };
    if let Some(existing) = existing_state {
        if existing == CameraSubscriptionState::Active(identity) {
            return Ok(());
        }
        if existing.identity() == identity {
            return Err(
                "Camera subscription identity is quarantined; reopen with a new identity"
                    .to_string(),
            );
        }
        lock_camera_deliveries().quarantine_exact(&topic, existing.identity());
        // The transport stores one declaration per exact topic. Remove the
        // superseded callback before installing the newer identity.
        with_timeout(active.bridge.unsubscribe(&topic)).await?;
        lock_camera_deliveries().remove_subscription_exact(&topic, existing.identity());
    }
    lock_camera_deliveries().activate(topic.clone(), identity)?;

    let event_name = transport_event_name(&topic);
    log::debug!(
        "Subscribing transport topic '{}' as event '{}'",
        topic,
        event_name
    );

    let callback_topic = topic.clone();
    let callback = Box::new(move |delivery: CameraFrameDelivery| {
        queue_camera_delivery(
            &app,
            &callback_topic,
            &event_name,
            generation,
            subscription_id,
            delivery,
        );
    });

    let stream_kind = if compressed.unwrap_or(false) {
        CameraStreamKind::Compressed
    } else {
        CameraStreamKind::Raw
    };
    let result = with_timeout(
        active
            .bridge
            .subscribe_camera(&topic, stream_kind, callback),
    )
    .await;
    let outcome = finish_subscription(&active, &topic, result).await;
    if outcome.is_err() {
        lock_camera_deliveries().quarantine_exact(&topic, identity);
    }
    outcome
}

/// Atomically move one ready camera frame into the in-flight delivery state.
#[tauri::command]
pub fn transport_take_camera_frame(
    topic: String,
    delivery_id: String,
    camera_subscription_id: String,
    generation: Option<String>,
) -> Result<CameraFrame, String> {
    validate_topic(&topic)?;
    let generation = require_generation(generation.as_deref())?;
    if !generation_is_current(generation) {
        return Err(stale_generation_error(generation));
    }
    let delivery_id = parse_delivery_id(&delivery_id)?;
    let subscription_id = parse_delivery_id(&camera_subscription_id)?;
    let (result, cleanup) = {
        let mut state = lock_camera_deliveries();
        state.take_with_expiry_cleanup(&topic, delivery_id, generation, subscription_id)
    };
    if let Some(cleanup) = cleanup {
        schedule_expired_camera_subscription_cleanup(cleanup);
    }
    result
}

/// Release an in-flight camera reservation after renderer consumption.
///
/// An acknowledgement intentionally remains valid after lifecycle rotation:
/// the old weighted permit remains owned until the renderer confirms that its
/// already-queued large response was consumed or the monotonic lease expires.
#[tauri::command]
pub fn transport_ack_camera_frame(
    topic: String,
    delivery_id: String,
    camera_subscription_id: String,
    generation: Option<String>,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let generation = require_generation(generation.as_deref())?;
    let delivery_id = parse_delivery_id(&delivery_id)?;
    let subscription_id = parse_delivery_id(&camera_subscription_id)?;
    let (result, cleanup) = {
        let mut state = lock_camera_deliveries();
        state.acknowledge_with_expiry_cleanup(&topic, delivery_id, generation, subscription_id)
    };
    if let Some(cleanup) = cleanup {
        schedule_expired_camera_subscription_cleanup(cleanup);
    }
    result
}

/// Subscribe to a CameraInfo topic
/// messages will be emitted as events with the same name as the topic
#[tauri::command]
pub async fn transport_subscribe_camera_info<R: Runtime>(
    app: AppHandle<R>,
    topic: String,
    generation: Option<String>,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let generation = require_generation(generation.as_deref())?;
    let active = current_bridge(Some(generation)).await?;
    let generation = active.generation;

    let event_name = transport_event_name(&topic);
    log::debug!(
        "Subscribing transport topic '{}' as event '{}'",
        topic,
        event_name
    );

    let callback = Box::new(move |info: CameraInfoData| {
        if !generation_is_current(generation) {
            return;
        }
        if let Err(e) = app.emit(&event_name, info) {
            log::warn!("Failed to emit CameraInfo: {}", e);
        }
    });

    let result = with_timeout(active.bridge.subscribe_camera_info(&topic, callback)).await;
    finish_subscription(&active, &topic, result).await
}

/// Subscribe to an IMU topic
#[tauri::command]
pub async fn transport_subscribe_imu<R: Runtime>(
    app: AppHandle<R>,
    topic: String,
    generation: Option<String>,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let generation = require_generation(generation.as_deref())?;
    let active = current_bridge(Some(generation)).await?;
    let generation = active.generation;

    let event_name = transport_event_name(&topic);
    log::debug!(
        "Subscribing transport topic '{}' as event '{}'",
        topic,
        event_name
    );

    let callback = Box::new(move |data: ImuData| {
        if !generation_is_current(generation) {
            return;
        }
        if let Err(e) = app.emit(&event_name, data) {
            log::warn!("Failed to emit IMU data: {}", e);
        }
    });

    let result = with_timeout(active.bridge.subscribe_imu(&topic, callback)).await;
    finish_subscription(&active, &topic, result).await
}

/// Subscribe to a Pose topic
#[tauri::command]
pub async fn transport_subscribe_pose<R: Runtime>(
    app: AppHandle<R>,
    topic: String,
    generation: Option<String>,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let generation = require_generation(generation.as_deref())?;
    let active = current_bridge(Some(generation)).await?;
    let generation = active.generation;

    let event_name = transport_event_name(&topic);
    log::debug!(
        "Subscribing transport topic '{}' as event '{}'",
        topic,
        event_name
    );

    let callback = Box::new(move |data: PoseData| {
        if !generation_is_current(generation) {
            return;
        }
        if let Err(e) = app.emit(&event_name, data) {
            log::warn!("Failed to emit Pose data: {}", e);
        }
    });

    let result = with_timeout(active.bridge.subscribe_pose(&topic, callback)).await;
    finish_subscription(&active, &topic, result).await
}

/// Subscribe to Model States
#[tauri::command]
pub async fn transport_subscribe_model_states<R: Runtime>(
    app: AppHandle<R>,
    topic: String,
    generation: Option<String>,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let generation = require_generation(generation.as_deref())?;
    let active = current_bridge(Some(generation)).await?;
    let generation = active.generation;

    let event_name = transport_event_name(&topic);
    log::debug!(
        "Subscribing transport topic '{}' as event '{}'",
        topic,
        event_name
    );

    let callback = Box::new(move |data: ModelStates| {
        if !generation_is_current(generation) {
            return;
        }
        if let Err(e) = app.emit(&event_name, data) {
            log::warn!("Failed to emit ModelStates: {}", e);
        }
    });

    let result = with_timeout(active.bridge.subscribe_model_states(&topic, callback)).await;
    finish_subscription(&active, &topic, result).await
}

/// Unsubscribe from a topic
#[tauri::command]
pub async fn transport_unsubscribe(
    topic: String,
    generation: Option<String>,
    camera_subscription_id: Option<String>,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let generation = require_generation(generation.as_deref())?;
    let camera_identity = camera_subscription_id
        .as_deref()
        .map(|delivery_id| {
            parse_delivery_id(delivery_id).map(|subscription_id| CameraSubscriptionIdentity {
                generation,
                subscription_id,
            })
        })
        .transpose()?;

    let _camera_operation_guard;
    if let Some(identity) = camera_identity {
        _camera_operation_guard = Some(CAMERA_SUBSCRIPTION_OP.lock().await);
        let subscription_state = {
            let state = lock_camera_deliveries();
            state.subscription_state(&topic)
        };
        match subscription_state {
            Some(state) if state.identity() == identity => {
                lock_camera_deliveries().quarantine_exact(&topic, identity);
            }
            Some(_) | None => {
                log::debug!("Ignoring stale camera unsubscribe for '{}'", topic);
                return Ok(());
            }
        }
    } else {
        _camera_operation_guard = None;
        if lock_camera_deliveries()
            .subscription_state(&topic)
            .is_some()
        {
            return Err("Camera subscription identity is required for unsubscribe".to_string());
        }
    }

    let active = current_bridge(Some(generation)).await.ok();
    let Some(active) = active else {
        if let Some(identity) = camera_identity {
            lock_camera_deliveries().remove_subscription_exact(&topic, identity);
        }
        log::debug!(
            "Ignoring unsubscribe for '{}' because transport is disconnected",
            topic
        );
        return Ok(());
    };
    let outcome = with_timeout(active.bridge.unsubscribe(&topic)).await;
    if outcome.is_ok() {
        if let Some(identity) = camera_identity {
            lock_camera_deliveries().remove_subscription_exact(&topic, identity);
        }
    }
    outcome
}

/// Get transport statistics
#[tauri::command]
pub async fn transport_get_stats() -> Result<TransportStats, String> {
    let active = current_bridge(None).await?;
    let stats = active.bridge.stats();
    if !generation_is_current(active.generation) {
        return Err(stale_generation_error(active.generation));
    }

    Ok(stats)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEST HELPERS - public validation functions callable from lib.rs tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

pub fn validate_topic_for_test(topic: &str) -> Result<(), String> {
    validate_topic(topic)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::camera_work::CameraWorkBudget;

    fn test_camera_delivery(budget: &CameraWorkBudget, marker: u8) -> CameraFrameDelivery {
        let permit = budget.try_reserve_zenoh(1024).unwrap();
        CameraFrameDelivery::new(
            CameraFrame {
                data: base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    [marker, 2, 3, 4],
                ),
                width: 1,
                height: 1,
                encoding: "rgba8".to_string(),
                timestamp: 1.0,
                frame_id: "camera".to_string(),
                is_bigendian: 0,
                step: 4,
            },
            permit,
        )
    }

    fn activate_test_subscription(
        state: &mut CameraDeliveryState,
        topic: &str,
        generation: u64,
        subscription_id: u64,
    ) {
        state
            .activate(
                topic.to_string(),
                CameraSubscriptionIdentity {
                    generation,
                    subscription_id,
                },
            )
            .unwrap();
    }

    #[test]
    fn camera_delivery_permit_survives_pull_until_exact_acknowledgement() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        activate_test_subscription(&mut state, "/camera/image", 7, 101);
        let (mut expiry, ready) = state
            .enqueue(
                "/camera/image".to_string(),
                7,
                101,
                test_camera_delivery(&budget, 1),
            )
            .unwrap();
        let lease = expiry.lease;
        let delivery_id = lease.delivery_id;
        let reserved = budget.in_flight_bytes();
        assert!(reserved > 0);
        assert_eq!(ready.delivery_id, "1");
        assert_eq!(
            serde_json::to_value(&ready).unwrap(),
            serde_json::json!({
                "deliveryId": "1",
                "generation": "7",
                "cameraSubscriptionId": "101"
            })
        );

        assert!(state
            .acknowledge("/camera/image", delivery_id, 7, 101)
            .is_err());
        assert!(state.take("/camera/image", delivery_id, 7, 102).is_err());
        let frame = state.take("/camera/image", delivery_id, 7, 101).unwrap();
        assert_eq!(frame.width, 1);
        assert_eq!(budget.in_flight_bytes(), reserved);
        assert!(state.take("/camera/image", delivery_id, 7, 101).is_err());
        assert!(state
            .acknowledge("/camera/image", delivery_id, 8, 101)
            .is_err());
        assert!(state
            .acknowledge("/camera/image", delivery_id, 7, 102)
            .is_err());
        assert_eq!(budget.in_flight_bytes(), reserved);

        state
            .acknowledge("/camera/image", delivery_id, 7, 101)
            .unwrap();
        assert_eq!(budget.in_flight_bytes(), 0);
        assert!(matches!(
            expiry.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    #[test]
    fn lifecycle_cleanup_discards_ready_but_retains_in_flight_delivery() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        activate_test_subscription(&mut state, "/camera/first", 9, 201);
        let (mut in_flight_expiry, _) = state
            .enqueue(
                "/camera/first".to_string(),
                9,
                201,
                test_camera_delivery(&budget, 1),
            )
            .unwrap();
        let in_flight_lease = in_flight_expiry.lease;
        let in_flight_id = in_flight_lease.delivery_id;
        let one_reservation = budget.in_flight_bytes();
        let _ = state.take("/camera/first", in_flight_id, 9, 201).unwrap();
        activate_test_subscription(&mut state, "/camera/second", 9, 202);
        let (mut ready_expiry, _) = state
            .enqueue(
                "/camera/second".to_string(),
                9,
                202,
                test_camera_delivery(&budget, 2),
            )
            .unwrap();
        assert_eq!(budget.in_flight_bytes(), one_reservation * 2);

        state.retire_generation();

        assert_eq!(budget.in_flight_bytes(), one_reservation);
        assert!(state.by_topic.contains_key("/camera/first"));
        assert!(!state.by_topic.contains_key("/camera/second"));
        assert!(state.subscriptions.is_empty());
        assert!(matches!(
            ready_expiry.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(matches!(
            in_flight_expiry.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        state
            .acknowledge("/camera/first", in_flight_id, 9, 201)
            .unwrap();
        assert_eq!(budget.in_flight_bytes(), 0);
        assert!(matches!(
            in_flight_expiry.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    #[test]
    fn exact_unsubscribe_discards_ready_but_retains_in_flight_delivery() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        let ready_identity = CameraSubscriptionIdentity {
            generation: 10,
            subscription_id: 251,
        };
        state
            .activate("/camera/ready".to_string(), ready_identity)
            .unwrap();
        let (mut ready_expiry, _) = state
            .enqueue(
                "/camera/ready".to_string(),
                ready_identity.generation,
                ready_identity.subscription_id,
                test_camera_delivery(&budget, 1),
            )
            .unwrap();
        let one_reservation = budget.in_flight_bytes();
        assert!(state.quarantine_exact("/camera/ready", ready_identity));
        assert!(state.remove_subscription_exact("/camera/ready", ready_identity));

        assert_eq!(budget.in_flight_bytes(), 0);
        assert!(!state.by_topic.contains_key("/camera/ready"));
        assert!(matches!(
            ready_expiry.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));

        let in_flight_identity = CameraSubscriptionIdentity {
            generation: 10,
            subscription_id: 252,
        };
        state
            .activate("/camera/in_flight".to_string(), in_flight_identity)
            .unwrap();
        let (mut in_flight_expiry, _) = state
            .enqueue(
                "/camera/in_flight".to_string(),
                in_flight_identity.generation,
                in_flight_identity.subscription_id,
                test_camera_delivery(&budget, 2),
            )
            .unwrap();
        let in_flight_id = in_flight_expiry.lease.delivery_id;
        state
            .take(
                "/camera/in_flight",
                in_flight_id,
                in_flight_identity.generation,
                in_flight_identity.subscription_id,
            )
            .unwrap();
        assert!(state.quarantine_exact("/camera/in_flight", in_flight_identity));
        assert!(state.remove_subscription_exact("/camera/in_flight", in_flight_identity));

        assert_eq!(budget.in_flight_bytes(), one_reservation);
        assert!(state.by_topic.contains_key("/camera/in_flight"));
        assert!(matches!(
            in_flight_expiry.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        state
            .acknowledge(
                "/camera/in_flight",
                in_flight_id,
                in_flight_identity.generation,
                in_flight_identity.subscription_id,
            )
            .unwrap();
        assert_eq!(budget.in_flight_bytes(), 0);
        assert!(matches!(
            in_flight_expiry.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    #[test]
    fn notification_failure_releases_exact_ready_delivery() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        activate_test_subscription(&mut state, "/camera/image", 11, 301);

        let error = state
            .enqueue_and_notify(
                "/camera/image".to_string(),
                11,
                301,
                test_camera_delivery(&budget, 1),
                |_| Err("notification failed".to_string()),
            )
            .unwrap_err();

        assert_eq!(error, "notification failed");
        assert!(state.by_id.is_empty());
        assert!(state.by_topic.is_empty());
        assert_eq!(budget.in_flight_bytes(), 0);
    }

    #[test]
    fn notification_panic_releases_exact_ready_delivery_without_poisoning_state() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let state = StdMutex::new(CameraDeliveryState::default());
        {
            let mut state = state.lock().unwrap();
            activate_test_subscription(&mut state, "/camera/image", 11, 302);

            let error = state
                .enqueue_and_notify(
                    "/camera/image".to_string(),
                    11,
                    302,
                    test_camera_delivery(&budget, 1),
                    |_| panic!("simulated notification panic"),
                )
                .unwrap_err();

            assert_eq!(error, "Camera delivery notification panicked");
            assert!(state.by_id.is_empty());
            assert!(state.by_topic.is_empty());
            assert_eq!(budget.in_flight_bytes(), 0);
        }
        assert!(!state.is_poisoned());

        let mut state = state.lock().unwrap();
        let (mut expiry, _) = state
            .enqueue(
                "/camera/image".to_string(),
                11,
                302,
                test_camera_delivery(&budget, 2),
            )
            .unwrap();
        assert!(state.by_topic.contains_key("/camera/image"));
        state.discard_unpulled_exact(expiry.lease.delivery_id);
        assert!(matches!(
            expiry.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert_eq!(budget.in_flight_bytes(), 0);
    }

    #[test]
    fn lost_ready_descriptor_expires_and_quarantines_its_exact_subscription() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        let identity = CameraSubscriptionIdentity {
            generation: 12,
            subscription_id: 351,
        };
        state
            .activate("/camera/lost".to_string(), identity)
            .unwrap();
        let start = Instant::now();
        let (mut expiry, _) = state
            .enqueue_at(
                "/camera/lost".to_string(),
                identity.generation,
                identity.subscription_id,
                test_camera_delivery(&budget, 1),
                start,
            )
            .unwrap();
        let lease = expiry.lease;
        let before_expiry = lease
            .expires_at
            .checked_sub(Duration::from_nanos(1))
            .unwrap();

        assert!(state.expire_exact(lease, before_expiry).is_none());
        assert!(budget.in_flight_bytes() > 0);
        let expiration = state.expire_exact(lease, lease.expires_at).unwrap();
        assert_eq!(
            expiration.quarantined_subscription,
            Some(CameraSubscriptionCleanup {
                topic: "/camera/lost".to_string(),
                identity,
            })
        );
        assert_eq!(budget.in_flight_bytes(), 0);
        assert!(state.by_id.is_empty());
        assert!(state.by_topic.is_empty());
        assert_eq!(
            state.subscription_state("/camera/lost"),
            Some(CameraSubscriptionState::Quarantined(identity))
        );
        assert!(matches!(
            expiry.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    #[test]
    fn delayed_expiry_cleanup_is_fenced_from_a_reopened_subscription() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        let old_identity = CameraSubscriptionIdentity {
            generation: 12,
            subscription_id: 356,
        };
        let new_identity = CameraSubscriptionIdentity {
            generation: 12,
            subscription_id: 357,
        };
        state
            .activate("/camera/cleanup_race".to_string(), old_identity)
            .unwrap();
        let start = Instant::now();
        let (expiry, _) = state
            .enqueue_at(
                "/camera/cleanup_race".to_string(),
                old_identity.generation,
                old_identity.subscription_id,
                test_camera_delivery(&budget, 1),
                start,
            )
            .unwrap();
        let cleanup = state
            .expire_exact(expiry.lease, expiry.lease.expires_at)
            .unwrap()
            .quarantined_subscription
            .unwrap();

        assert!(state.remove_subscription_exact(&cleanup.topic, cleanup.identity));
        state.activate(cleanup.topic.clone(), new_identity).unwrap();

        assert!(!state.is_quarantined_exact(&cleanup.topic, cleanup.identity));
        assert_eq!(
            state.subscription_state(&cleanup.topic),
            Some(CameraSubscriptionState::Active(new_identity))
        );
    }

    #[test]
    fn acknowledgement_winning_deadline_race_releases_once_without_quarantine() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        let identity = CameraSubscriptionIdentity {
            generation: 12,
            subscription_id: 352,
        };
        state
            .activate("/camera/ack-wins".to_string(), identity)
            .unwrap();
        let start = Instant::now();
        let (expiry, _) = state
            .enqueue_at(
                "/camera/ack-wins".to_string(),
                identity.generation,
                identity.subscription_id,
                test_camera_delivery(&budget, 1),
                start,
            )
            .unwrap();
        let lease = expiry.lease;
        state
            .take_at(
                "/camera/ack-wins",
                lease.delivery_id,
                identity.generation,
                identity.subscription_id,
                start,
            )
            .unwrap();
        let before_expiry = lease
            .expires_at
            .checked_sub(Duration::from_nanos(1))
            .unwrap();

        state
            .acknowledge_at(
                "/camera/ack-wins",
                lease.delivery_id,
                identity.generation,
                identity.subscription_id,
                before_expiry,
            )
            .unwrap();

        assert_eq!(budget.in_flight_bytes(), 0);
        assert!(state.expire_exact(lease, lease.expires_at).is_none());
        assert_eq!(
            state.subscription_state("/camera/ack-wins"),
            Some(CameraSubscriptionState::Active(identity))
        );
    }

    #[test]
    fn late_take_returns_exact_cleanup_when_it_wins_the_expiry_timer_race() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        let identity = CameraSubscriptionIdentity {
            generation: 12,
            subscription_id: 358,
        };
        state
            .activate("/camera/late_take".to_string(), identity)
            .unwrap();
        let start = Instant::now();
        let (mut expiry, _) = state
            .enqueue_at(
                "/camera/late_take".to_string(),
                identity.generation,
                identity.subscription_id,
                test_camera_delivery(&budget, 1),
                start,
            )
            .unwrap();

        let (result, cleanup) = state.take_at_with_expiry_cleanup(
            "/camera/late_take",
            expiry.lease.delivery_id,
            identity.generation,
            identity.subscription_id,
            expiry.lease.expires_at,
        );

        assert_eq!(result.unwrap_err(), "Camera delivery lease expired");
        assert_eq!(
            cleanup,
            Some(CameraSubscriptionCleanup {
                topic: "/camera/late_take".to_string(),
                identity,
            })
        );
        assert_eq!(budget.in_flight_bytes(), 0);
        assert!(matches!(
            expiry.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(state
            .expire_exact(expiry.lease, expiry.lease.expires_at)
            .is_none());
    }

    #[test]
    fn wrong_identity_at_deadline_cannot_expire_a_camera_delivery() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        let take_identity = CameraSubscriptionIdentity {
            generation: 12,
            subscription_id: 359,
        };
        state
            .activate("/camera/wrong_take".to_string(), take_identity)
            .unwrap();
        let start = Instant::now();
        let (take_expiry, _) = state
            .enqueue_at(
                "/camera/wrong_take".to_string(),
                take_identity.generation,
                take_identity.subscription_id,
                test_camera_delivery(&budget, 1),
                start,
            )
            .unwrap();
        let one_reservation = budget.in_flight_bytes();

        let (wrong_take, cleanup) = state.take_at_with_expiry_cleanup(
            "/camera/wrong_take",
            take_expiry.lease.delivery_id,
            take_identity.generation,
            take_identity.subscription_id + 1,
            take_expiry.lease.expires_at,
        );
        assert_eq!(
            wrong_take.unwrap_err(),
            "Camera delivery identity does not match"
        );
        assert!(cleanup.is_none());
        assert_eq!(budget.in_flight_bytes(), one_reservation);
        assert_eq!(
            state.subscription_state("/camera/wrong_take"),
            Some(CameraSubscriptionState::Active(take_identity))
        );
        assert!(state
            .take_at_with_expiry_cleanup(
                "/camera/wrong_take",
                take_expiry.lease.delivery_id,
                take_identity.generation,
                take_identity.subscription_id,
                take_expiry.lease.expires_at,
            )
            .1
            .is_some());

        let ack_identity = CameraSubscriptionIdentity {
            generation: 12,
            subscription_id: 361,
        };
        state
            .activate("/camera/wrong_ack".to_string(), ack_identity)
            .unwrap();
        let (ack_expiry, _) = state
            .enqueue_at(
                "/camera/wrong_ack".to_string(),
                ack_identity.generation,
                ack_identity.subscription_id,
                test_camera_delivery(&budget, 2),
                start,
            )
            .unwrap();
        state
            .take_at(
                "/camera/wrong_ack",
                ack_expiry.lease.delivery_id,
                ack_identity.generation,
                ack_identity.subscription_id,
                start,
            )
            .unwrap();

        let (wrong_ack, cleanup) = state.acknowledge_at_with_expiry_cleanup(
            "/camera/wrong_ack",
            ack_expiry.lease.delivery_id,
            ack_identity.generation + 1,
            ack_identity.subscription_id,
            ack_expiry.lease.expires_at,
        );
        assert_eq!(
            wrong_ack.unwrap_err(),
            "Camera delivery identity does not match"
        );
        assert!(cleanup.is_none());
        assert_eq!(budget.in_flight_bytes(), one_reservation);
        assert_eq!(
            state.subscription_state("/camera/wrong_ack"),
            Some(CameraSubscriptionState::Active(ack_identity))
        );
        assert!(state
            .acknowledge_at_with_expiry_cleanup(
                "/camera/wrong_ack",
                ack_expiry.lease.delivery_id,
                ack_identity.generation,
                ack_identity.subscription_id,
                ack_expiry.lease.expires_at,
            )
            .1
            .is_some());
        assert_eq!(budget.in_flight_bytes(), 0);
    }

    #[test]
    fn expiry_winning_acknowledgement_race_releases_once_and_rejects_late_ack() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        let identity = CameraSubscriptionIdentity {
            generation: 12,
            subscription_id: 353,
        };
        state
            .activate("/camera/expiry-wins".to_string(), identity)
            .unwrap();
        let start = Instant::now();
        let (mut expiry, _) = state
            .enqueue_at(
                "/camera/expiry-wins".to_string(),
                identity.generation,
                identity.subscription_id,
                test_camera_delivery(&budget, 1),
                start,
            )
            .unwrap();
        let lease = expiry.lease;
        state
            .take_at(
                "/camera/expiry-wins",
                lease.delivery_id,
                identity.generation,
                identity.subscription_id,
                start,
            )
            .unwrap();

        let (result, cleanup) = state.acknowledge_at_with_expiry_cleanup(
            "/camera/expiry-wins",
            lease.delivery_id,
            identity.generation,
            identity.subscription_id,
            lease.expires_at,
        );
        assert_eq!(result.unwrap_err(), "Camera delivery lease expired");
        assert_eq!(
            cleanup,
            Some(CameraSubscriptionCleanup {
                topic: "/camera/expiry-wins".to_string(),
                identity,
            })
        );
        assert_eq!(budget.in_flight_bytes(), 0);
        assert!(state
            .acknowledge_at(
                "/camera/expiry-wins",
                lease.delivery_id,
                identity.generation,
                identity.subscription_id,
                lease.expires_at,
            )
            .is_err());
        assert!(state.expire_exact(lease, lease.expires_at).is_none());
        assert!(matches!(
            expiry.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    #[test]
    fn old_expiry_and_late_ack_cannot_mutate_reopened_identity_or_delivery() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        let old_identity = CameraSubscriptionIdentity {
            generation: 12,
            subscription_id: 354,
        };
        let new_identity = CameraSubscriptionIdentity {
            generation: 12,
            subscription_id: 355,
        };
        state
            .activate("/camera/race".to_string(), old_identity)
            .unwrap();
        let start = Instant::now();
        let (old_expiry, _) = state
            .enqueue_at(
                "/camera/race".to_string(),
                old_identity.generation,
                old_identity.subscription_id,
                test_camera_delivery(&budget, 1),
                start,
            )
            .unwrap();
        let old_lease = old_expiry.lease;
        state
            .take_at(
                "/camera/race",
                old_lease.delivery_id,
                old_identity.generation,
                old_identity.subscription_id,
                start,
            )
            .unwrap();
        assert!(state.quarantine_exact("/camera/race", old_identity));
        assert!(state.remove_subscription_exact("/camera/race", old_identity));
        state
            .activate("/camera/race".to_string(), new_identity)
            .unwrap();

        assert!(state
            .enqueue_at(
                "/camera/race".to_string(),
                new_identity.generation,
                new_identity.subscription_id,
                test_camera_delivery(&budget, 2),
                start,
            )
            .is_err());
        let old_expiration = state.expire_exact(old_lease, old_lease.expires_at).unwrap();
        assert!(old_expiration.quarantined_subscription.is_none());
        let (new_expiry, _) = state
            .enqueue_at(
                "/camera/race".to_string(),
                new_identity.generation,
                new_identity.subscription_id,
                test_camera_delivery(&budget, 3),
                old_lease.expires_at,
            )
            .unwrap();
        let new_lease = new_expiry.lease;

        assert!(state
            .acknowledge_at(
                "/camera/race",
                old_lease.delivery_id,
                old_identity.generation,
                old_identity.subscription_id,
                old_lease.expires_at,
            )
            .is_err());
        assert_eq!(
            state.by_topic.get("/camera/race"),
            Some(&new_lease.delivery_id)
        );
        assert_eq!(
            state.subscription_state("/camera/race"),
            Some(CameraSubscriptionState::Active(new_identity))
        );
    }

    #[test]
    fn in_flight_topic_stays_blocked_until_acknowledgement() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        activate_test_subscription(&mut state, "/camera/image", 13, 401);
        let (expiry, _) = state
            .enqueue(
                "/camera/image".to_string(),
                13,
                401,
                test_camera_delivery(&budget, 1),
            )
            .unwrap();
        let lease = expiry.lease;
        let delivery_id = lease.delivery_id;
        let _ = state.take("/camera/image", delivery_id, 13, 401).unwrap();
        activate_test_subscription(&mut state, "/camera/image", 14, 402);

        assert!(state
            .enqueue(
                "/camera/image".to_string(),
                14,
                402,
                test_camera_delivery(&budget, 2),
            )
            .is_err());
        state
            .acknowledge("/camera/image", delivery_id, 13, 401)
            .unwrap();
        assert!(state
            .enqueue(
                "/camera/image".to_string(),
                14,
                402,
                test_camera_delivery(&budget, 3),
            )
            .is_ok());
    }

    #[test]
    fn stale_camera_subscription_callback_cannot_enter_reopened_topic() {
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let mut state = CameraDeliveryState::default();
        let old_identity = CameraSubscriptionIdentity {
            generation: 21,
            subscription_id: 501,
        };
        let new_identity = CameraSubscriptionIdentity {
            generation: 21,
            subscription_id: 502,
        };
        state
            .activate("/camera/reopened".to_string(), old_identity)
            .unwrap();
        assert!(state.quarantine_exact("/camera/reopened", old_identity));
        state
            .activate("/camera/reopened".to_string(), new_identity)
            .unwrap();

        assert!(state
            .enqueue(
                "/camera/reopened".to_string(),
                old_identity.generation,
                old_identity.subscription_id,
                test_camera_delivery(&budget, 1),
            )
            .is_err());
        assert_eq!(budget.in_flight_bytes(), 0);
        assert!(state
            .enqueue(
                "/camera/reopened".to_string(),
                new_identity.generation,
                new_identity.subscription_id,
                test_camera_delivery(&budget, 2),
            )
            .is_ok());
    }

    #[test]
    fn exact_failed_setup_cleanup_does_not_consume_subscription_capacity() {
        let mut state = CameraDeliveryState::default();

        for subscription_id in 1..=(MAX_CAMERA_DELIVERY_TOPICS as u64 * 2) {
            let topic = format!("/camera/setup_failure_{subscription_id}");
            let identity = CameraSubscriptionIdentity {
                generation: 22,
                subscription_id,
            };
            state.activate(topic.clone(), identity).unwrap();
            assert!(state.quarantine_exact(&topic, identity));
            assert!(state.remove_subscription_exact(&topic, identity));
        }

        assert!(state.subscriptions.is_empty());
        assert!(state
            .activate(
                "/camera/after_cleanup".to_string(),
                CameraSubscriptionIdentity {
                    generation: 22,
                    subscription_id: 10_000,
                },
            )
            .is_ok());
    }

    #[test]
    fn camera_delivery_id_parser_requires_canonical_u64_decimal() {
        assert_eq!(parse_delivery_id("18446744073709551615").unwrap(), u64::MAX);
        for invalid in ["", "0", "01", "+1", "-1", "1.0", "18446744073709551616"] {
            assert!(parse_delivery_id(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn lifecycle_generation_parser_accepts_u64_maximum() {
        assert_eq!(
            require_generation(Some("18446744073709551615")).unwrap(),
            u64::MAX
        );
    }

    #[test]
    fn lifecycle_generation_parser_rejects_noncanonical_and_overflow_values() {
        for invalid in ["", "0", "01", "+1", "-1", "1.0", "18446744073709551616"] {
            assert!(
                require_generation(Some(invalid)).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn camera_ready_serializes_u64_maximum_generation_as_decimal_string() {
        let ready = CameraFrameReady {
            delivery_id: "1".to_string(),
            generation: u64::MAX.to_string(),
            camera_subscription_id: "2".to_string(),
        };

        assert_eq!(
            serde_json::to_value(ready).unwrap()["generation"],
            serde_json::Value::String("18446744073709551615".to_string())
        );
    }

    #[test]
    fn validate_topic_accepts_common_ros_topics() {
        assert!(validate_topic("/camera/image_raw").is_ok());
    }

    #[test]
    fn validate_topic_accepts_exact_length_limit() {
        let exact = format!("/{}", "a".repeat(MAX_TOPIC_LEN - 1));
        assert_eq!(exact.len(), MAX_TOPIC_LEN);
        assert!(validate_topic(&exact).is_ok());
    }

    #[test]
    fn validate_topic_rejects_empty_null_and_oversized_topics() {
        assert!(validate_topic("")
            .unwrap_err()
            .contains("must not be empty"));
        assert!(validate_topic("   ")
            .unwrap_err()
            .contains("must not be empty or padded"));
        assert!(validate_topic("/camera\0/image")
            .unwrap_err()
            .contains("null bytes"));
        let oversized = format!("/{}", "a".repeat(MAX_TOPIC_LEN));
        assert!(validate_topic(&oversized).unwrap_err().contains("too long"));
    }

    #[test]
    fn validate_topic_rejects_wildcards_and_metacharacters() {
        for topic in [
            "/**",
            "/camera/*",
            "/cam?era",
            "/cam#era",
            "/cam$era",
            "/cam-era",
            "/cam.era",
        ] {
            assert!(
                validate_topic(topic)
                    .unwrap_err()
                    .contains("unsupported characters"),
                "expected rejection for {}",
                topic
            );
        }
    }

    #[test]
    fn validate_topic_rejects_non_canonical_ros_names() {
        for topic in ["relative/topic", "/", "/double//slash", "/padded "] {
            assert!(
                validate_topic(topic).is_err(),
                "expected rejection for {topic}"
            );
        }
    }

    #[test]
    fn transport_unsubscribe_rejects_invalid_topic_before_connection_check() {
        let error =
            tauri::async_runtime::block_on(transport_unsubscribe(" ".to_string(), None, None))
                .unwrap_err();

        assert!(error.contains("must not be empty"));
    }

    #[test]
    fn stale_connect_generation_cannot_install_after_lifecycle_rotation() {
        let engine = TransportEngine {
            generation: 2,
            bridge: None,
        };

        assert!(!engine.accepts_install(1));
    }

    #[test]
    fn lifecycle_generation_exhaustion_fails_closed() {
        assert!(next_generation(u64::MAX).is_err());
    }

    #[test]
    fn subscription_generation_is_required_after_topic_validation() {
        let error = require_generation(None).unwrap_err();

        assert!(error.contains("generation is required"));
    }

    #[test]
    fn disconnect_without_generation_does_not_change_transport_lifecycle() {
        let before = tauri::async_runtime::block_on(async {
            let engine = TRANSPORT_ENGINE.lock().await;
            (
                engine.generation,
                engine.bridge.is_some(),
                ACTIVE_TRANSPORT_GENERATION.load(Ordering::Acquire),
            )
        });

        let error = tauri::async_runtime::block_on(transport_disconnect(None)).unwrap_err();

        let after = tauri::async_runtime::block_on(async {
            let engine = TRANSPORT_ENGINE.lock().await;
            (
                engine.generation,
                engine.bridge.is_some(),
                ACTIVE_TRANSPORT_GENERATION.load(Ordering::Acquire),
            )
        });
        assert_eq!(error, "Transport lifecycle generation is required");
        assert_eq!(after, before);
    }

    #[test]
    fn conditional_disconnect_does_not_rotate_a_newer_generation() {
        let mut engine = TransportEngine {
            generation: 3,
            bridge: None,
        };

        if engine.matches_expected_generation(2) {
            rotate_engine(&mut engine).unwrap();
        }

        assert_eq!(engine.generation, 3);
    }

    #[test]
    fn transport_event_name_preserves_safe_ascii() {
        assert_eq!(
            transport_event_name("camera/image-raw1"),
            "crebain:transport:camera/image-raw1"
        );
    }

    #[test]
    fn transport_event_name_escapes_underscores_and_utf8() {
        assert_eq!(
            transport_event_name("/camera/image_raw"),
            "crebain:transport:/camera/image_5Fraw"
        );
        assert_eq!(
            transport_event_name("/über/image"),
            "crebain:transport:/_C3_BCber/image"
        );
    }

    #[test]
    fn transport_event_name_emits_only_tauri_legal_characters() {
        // Tauri 2.x EventName::new accepts only [a-zA-Z0-9-/:_]; anything else
        // makes every emit fail and no transport data reaches the frontend.
        let name = transport_event_name("/cam era/image_raw%~");
        assert_eq!(name, "crebain:transport:/cam_20era/image_5Fraw_25_7E");
        assert!(name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')));
    }
}

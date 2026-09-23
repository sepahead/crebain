//! Safe serialized SDK host. The separate binary transfers already owned private streams here.

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use ncp_local::modular_owner::Application;
use ncp_local::modular_wire;
use serde_json::json;

use crate::contract;
use crate::family_application::{CanonicalApplication, EvaluationApplication, FamilyController};
use crate::family_contract;
use crate::family_process::FamilyProcess;
use crate::family_protocol::ObservedEndpoint;
use crate::family_types::FamilyPlan;

/// Pure trusted-launcher arguments. No parsing operation opens or adopts a descriptor.
pub struct LaunchPlan {
    /// Selected local Bun executable.
    pub bun: PathBuf,
    /// Selected local Node executable; graphics are mandatory for this family profile.
    pub node: PathBuf,
    /// Selected CREBAIN-owned family entrypoint.
    pub bridge: PathBuf,
    /// Frozen source identity checked by the installed launcher.
    pub source: String,
    /// Complete frozen endpoint and native plan.
    pub plan: FamilyPlan,
    /// Distinct service descriptors, in canonical-then-evaluation slot order.
    pub service_fds: Vec<i32>,
}

impl LaunchPlan {
    /// Validate all launcher arguments without starting a thread, signal handler, or child.
    pub fn parse(arguments: &[String]) -> Result<Self, &'static str> {
        if arguments.len() != 12 || arguments.iter().map(String::len).sum::<usize>() > 131_072 {
            return Err("bounded trusted family arguments required");
        }
        let keys = [
            "--bun",
            "--node",
            "--bridge",
            "--source-identity",
            "--family-plan-json",
            "--service-fds-json",
        ];
        if arguments
            .chunks_exact(2)
            .zip(keys)
            .any(|(pair, key)| pair[0] != key)
        {
            return Err("closed trusted family arguments required");
        }
        let plan: FamilyPlan = serde_json::from_value(
            modular_wire::parse_value(arguments[9].as_bytes()).map_err(|_| "family plan JSON")?,
        )
        .map_err(|_| "family plan types")?;
        family_contract::validate_plan(&plan).map_err(|_| "family constructor bounds")?;
        let source = arguments[7].clone();
        family_contract::plan_digest(&plan, &source).map_err(|_| "source identity")?;
        let service_fds: Vec<i32> = serde_json::from_value(
            modular_wire::parse_value(arguments[11].as_bytes())
                .map_err(|_| "service descriptor JSON")?,
        )
        .map_err(|_| "service descriptor integers")?;
        if service_fds.len() != plan.limits.endpoint_count as usize
            || service_fds.iter().any(|fd| *fd < 3)
            || service_fds
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != service_fds.len()
        {
            return Err("exact distinct inherited service descriptors required");
        }
        let bun = PathBuf::from(&arguments[1]);
        let node = PathBuf::from(&arguments[3]);
        let bridge = PathBuf::from(&arguments[5]);
        if !bun.is_absolute() || !node.is_absolute() || !bridge.is_absolute() {
            return Err("absolute selected family runtime paths required");
        }
        Ok(Self {
            bun,
            node,
            bridge,
            source,
            plan,
            service_fds,
        })
    }
}

enum Endpoint {
    Canonical(ObservedEndpoint<CanonicalApplication<FamilyProcess>>),
    Evaluation(ObservedEndpoint<EvaluationApplication<FamilyProcess>>),
}

enum Ingress {
    Frame(Vec<u8>),
    Eof,
    Failed,
}

fn next_ingress(
    receiver: &mpsc::Receiver<(usize, Ingress)>,
    pending: &mut [Option<Ingress>],
    closing: Option<usize>,
    deadline: Instant,
) -> Result<(usize, Ingress), &'static str> {
    loop {
        remaining(deadline).map_err(|_| "family absolute deadline")?;
        let ready = closing.filter(|slot| pending[*slot].is_some()).or_else(|| {
            closing
                .is_none()
                .then(|| pending.iter().position(Option::is_some))
                .flatten()
        });
        if let Some(slot) = ready {
            let event = pending[slot]
                .take()
                .ok_or("family pending ingress invariant")?;
            return Ok((slot, event));
        }
        let (slot, event) = receiver
            .recv_timeout(remaining(deadline).map_err(|_| "family absolute deadline")?)
            .map_err(|_| "family ingress deadline or disconnect")?;
        if slot >= pending.len() || pending[slot].is_some() {
            return Err("family ingress roster or one-frame allowance");
        }
        // A terminal ACK is a promise to wait for this endpoint's real EOF.
        // Other frames remain charged to their one outstanding ingress allowance.
        // Failures and EOF on any other endpoint still retire the family immediately.
        if closing.is_some_and(|selected| selected != slot) && matches!(event, Ingress::Frame(_)) {
            pending[slot] = Some(event);
        } else {
            return Ok((slot, event));
        }
    }
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "family absolute deadline"))
}

fn read_exact_or_eof(
    stream: &mut UnixStream,
    bytes: &mut [u8],
    deadline: Instant,
) -> io::Result<bool> {
    let mut offset = 0;
    while offset < bytes.len() {
        if let Err(primary) = stream.set_read_timeout(Some(remaining(deadline)?)) {
            // Darwin rejects SO_RCVTIMEO after peer closure. A failed option is
            // not EOF: make one nonblocking read and require an actual zero result.
            // This path always ends the ingress worker, so its shared socket mode
            // cannot race a later host write or a granted next-frame read.
            stream.set_nonblocking(true)?;
            let mut probe = [0; 1];
            if offset == 0 && matches!(stream.read(&mut probe), Ok(0)) {
                return Ok(false);
            }
            return Err(primary);
        }
        match stream.read(&mut bytes[offset..]) {
            Ok(0) if offset == 0 => return Ok(false),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(count) => offset += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

fn ingress(stream: &mut UnixStream, deadline: Instant) -> Ingress {
    let mut prefix = [0; 4];
    match read_exact_or_eof(stream, &mut prefix, deadline) {
        Ok(false) => return Ingress::Eof,
        Ok(true) => {}
        Err(_) => return Ingress::Failed,
    }
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > 65_536 {
        return Ingress::Failed;
    }
    let mut bytes = vec![0; length];
    match read_exact_or_eof(stream, &mut bytes, deadline) {
        Ok(true) => Ingress::Frame(bytes),
        _ => Ingress::Failed,
    }
}

struct DeadlineWriter<'a> {
    stream: &'a mut UnixStream,
    deadline: Instant,
}
impl Write for DeadlineWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.stream
            .set_write_timeout(Some(remaining(self.deadline)?))?;
        self.stream.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        remaining(self.deadline)?;
        self.stream.flush()
    }
}

fn terminal_diagnostic<A: Application>(slot: usize, endpoint: &ObservedEndpoint<A>) {
    let stamp = endpoint.last_committed().map(|stamp| {
        json!({
            "binding": stamp.binding(), "sequence": stamp.sequence(),
            "request_digest": stamp.request_digest(), "result_digest": stamp.result_digest(),
        })
    });
    let record = json!({"schema":"crebain.family-endpoint-observation.v1", "slot":slot,
        "binding":endpoint.binding(), "last_committed":stamp, "terminal_ack_sent":endpoint.terminal_ack_sent(),
        "channel_closed":endpoint.closed(), "failed":endpoint.failed(),
        "peer_durable_capture_attested":false, "process_retirement_attested":false});
    // One bounded record per frozen endpoint. No peer-controlled text enters diagnostics.
    eprintln!("CREBAIN_FAMILY_ENDPOINT_V1 {record}");
}

fn retire_endpoints(endpoints: &mut [Endpoint]) {
    for (slot, endpoint) in endpoints.iter_mut().enumerate() {
        match endpoint {
            Endpoint::Canonical(endpoint) => {
                terminal_diagnostic(slot, endpoint);
                if !endpoint.closed() {
                    endpoint.retire_channel();
                }
            }
            Endpoint::Evaluation(endpoint) => {
                terminal_diagnostic(slot, endpoint);
                if !endpoint.closed() {
                    endpoint.retire_channel();
                }
            }
        }
    }
}

fn join_readers(readers: Vec<JoinHandle<()>>, deadline: Instant) -> bool {
    let mut result = true;
    for reader in readers {
        while !reader.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        if reader.is_finished() {
            result &= reader.join().is_ok();
        } else {
            result = false;
        }
    }
    result
}

/// Serve separately bound owners on already admitted and exclusively owned socket endpoints.
///
/// Caller-owned endpoints must have close-on-exec set before this function can start Bun.
/// Each ingress worker holds at most one frame until the serialized host grants another read.
/// Completion requires every exact terminal ACK and clean EOF, then actual native bridge exit.
pub fn run(launch: LaunchPlan, mut streams: Vec<UnixStream>) -> Result<(), String> {
    if streams.len() != launch.plan.limits.endpoint_count as usize {
        return Err("family owned stream count".into());
    }
    let deadline = Instant::now() + Duration::from_secs(launch.plan.limits.total_wall_seconds);
    let process = FamilyProcess::spawn(
        &launch.bun,
        &launch.node,
        &launch.bridge,
        &launch.plan,
        &launch.source,
    )
    .map_err(|_| "family private process construction")?;
    let controller = FamilyController::new(launch.plan.clone(), launch.source, process)
        .map_err(|_| "family controller construction")?;
    let mut semantics = ["rgba8", "radiance", "pressure"]
        .into_iter()
        .map(contract::semantic)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "sensor semantic descriptors")?;
    semantics.sort();
    let mut endpoints = vec![Endpoint::Canonical(
        ObservedEndpoint::new(
            launch.plan.canonical_binding.clone(),
            controller
                .canonical()
                .map_err(|_| "canonical application construction")?,
            semantics.clone(),
        )
        .map_err(|_| "canonical SDK owner construction")?,
    )];
    for branch in &launch.plan.branches {
        endpoints.push(Endpoint::Evaluation(
            ObservedEndpoint::new(
                branch.binding.clone(),
                controller
                    .evaluation(branch.slot as usize)
                    .map_err(|_| "evaluation application construction")?,
                semantics.clone(),
            )
            .map_err(|_| "evaluation SDK owner construction")?,
        ));
    }
    let (input_tx, input_rx) = mpsc::sync_channel(streams.len());
    let mut readers = Vec::with_capacity(streams.len());
    let mut grants = Vec::with_capacity(streams.len());
    let inputs = streams
        .iter()
        .map(UnixStream::try_clone)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "family ingress descriptor clone")?;
    for (slot, mut reader) in inputs.into_iter().enumerate() {
        let sender = input_tx.clone();
        let (grant_tx, grant_rx) = mpsc::sync_channel(1);
        grants.push(grant_tx);
        let spawned = thread::Builder::new()
            .name(format!("family-ingress-{slot}"))
            .stack_size(256 * 1024)
            .spawn(move || loop {
                let event = ingress(&mut reader, deadline);
                let terminal = !matches!(event, Ingress::Frame(_));
                if sender.send((slot, event)).is_err() || terminal || grant_rx.recv().is_err() {
                    break;
                }
            });
        match spawned {
            Ok(reader) => readers.push(reader),
            Err(primary) => {
                for stream in &streams {
                    let _shutdown = stream.shutdown(Shutdown::Both);
                }
                drop(grants);
                drop(input_rx);
                let readers_closed = join_readers(readers, Instant::now() + Duration::from_secs(5));
                let native_closed = controller.retire().is_ok();
                return Err(format!("family ingress startup: {primary}; reader retirement={readers_closed}; native retirement={native_closed}"));
            }
        }
    }
    drop(input_tx);
    let mut closed = vec![false; streams.len()];
    let mut pending = (0..streams.len()).map(|_| None).collect::<Vec<_>>();
    let mut closing = None;
    let result = (|| -> Result<(), String> {
        while !closed.iter().all(|value| *value) {
            let (slot, input) = next_ingress(&input_rx, &mut pending, closing, deadline)?;
            if closed[slot] {
                return Err("closed family endpoint received another event".into());
            }
            match input {
                Ingress::Frame(bytes) => {
                    let mut writer = DeadlineWriter {
                        stream: &mut streams[slot],
                        deadline,
                    };
                    let response = match &mut endpoints[slot] {
                        Endpoint::Canonical(endpoint) => {
                            endpoint.exchange(&bytes, &mut writer, |event| {
                                controller.observe_canonical(event)
                            })
                        }
                        Endpoint::Evaluation(endpoint) => {
                            endpoint.exchange(&bytes, &mut writer, |event| {
                                controller.observe_evaluation(slot, event)
                            })
                        }
                    };
                    response.map_err(|error| error.to_string())?;
                    let failed = match &endpoints[slot] {
                        Endpoint::Canonical(endpoint) => endpoint.failed(),
                        Endpoint::Evaluation(endpoint) => endpoint.failed(),
                    };
                    if failed {
                        return Err("family SDK endpoint retired".into());
                    }
                    let terminal_ack_sent = match &endpoints[slot] {
                        Endpoint::Canonical(endpoint) => endpoint.terminal_ack_sent(),
                        Endpoint::Evaluation(endpoint) => endpoint.terminal_ack_sent(),
                    };
                    if terminal_ack_sent {
                        closing = Some(slot);
                    }
                    grants[slot]
                        .try_send(())
                        .map_err(|_| "family ingress worker ended or grant remained pending")?;
                }
                Ingress::Eof => {
                    match &mut endpoints[slot] {
                        Endpoint::Canonical(endpoint) => {
                            endpoint.observe_eof().map_err(|error| error.to_string())?;
                        }
                        Endpoint::Evaluation(endpoint) => {
                            let evidence =
                                endpoint.observe_eof().map_err(|error| error.to_string())?;
                            controller
                                .close_evaluation(slot, evidence)
                                .map_err(|_| "family branch closure observation")?;
                        }
                    }
                    closed[slot] = true;
                    if closing == Some(slot) {
                        closing = None;
                    }
                    if let Err(error) = streams[slot].shutdown(Shutdown::Both) {
                        // The real read-zero observation above is already established.
                        // Darwin can report ENOTCONN when the peer shut down both sides.
                        if error.kind() != io::ErrorKind::NotConnected {
                            return Err("family closed endpoint shutdown".into());
                        }
                    }
                }
                Ingress::Failed => {
                    return Err("family malformed, truncated, or failed channel".into())
                }
            }
        }
        Ok(())
    })();
    // Shutdown wakes all readers, including dormant slots. Drop each grant before joining.
    for stream in &streams {
        let _shutdown = stream.shutdown(Shutdown::Both);
    }
    drop(grants);
    drop(input_rx);
    let readers_closed = join_readers(readers, Instant::now() + Duration::from_secs(5));
    retire_endpoints(&mut endpoints);
    let native_closed = controller.retire().is_ok();
    match result {
        Err(primary) if !readers_closed || !native_closed => Err(format!(
            "{primary}; reader retirement={readers_closed}; native retirement={native_closed}"
        )),
        Err(primary) => Err(primary),
        Ok(()) if readers_closed && native_closed => Ok(()),
        Ok(()) => Err(format!(
            "family cleanup unresolved: readers={readers_closed}; native={native_closed}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_eof_is_distinct_from_a_truncated_prefix_or_payload() {
        for bytes in [vec![], vec![0], vec![0, 0, 0, 2, 1], vec![0, 0, 0, 1, 7]] {
            let (mut reader, mut writer) = UnixStream::pair().unwrap();
            writer.write_all(&bytes).unwrap();
            let writer = if bytes == [0, 0, 0, 1, 7] {
                Some(writer)
            } else {
                drop(writer);
                None
            };
            let event = ingress(&mut reader, Instant::now() + Duration::from_secs(1));
            match bytes.len() {
                0 => assert!(matches!(event, Ingress::Eof)),
                5 if bytes[3] == 1 => {
                    assert!(matches!(event, Ingress::Frame(value) if value == [7]))
                }
                _ => assert!(matches!(event, Ingress::Failed)),
            }
            drop(writer);
        }
    }

    #[test]
    fn peer_shutdown_requires_actual_read_zero_and_never_promotes_pending_or_live_input() {
        let deadline = Instant::now() + Duration::from_secs(1);
        let (mut reader, writer) = UnixStream::pair().unwrap();
        writer.shutdown(Shutdown::Both).unwrap();
        assert!(matches!(ingress(&mut reader, deadline), Ingress::Eof));
        if let Err(error) = reader.shutdown(Shutdown::Both) {
            assert_eq!(error.kind(), io::ErrorKind::NotConnected);
        }

        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(&[0]).unwrap();
        writer.shutdown(Shutdown::Both).unwrap();
        assert!(matches!(ingress(&mut reader, deadline), Ingress::Failed));

        let (mut reader, _live_writer) = UnixStream::pair().unwrap();
        assert!(matches!(
            ingress(&mut reader, Instant::now() + Duration::from_millis(10)),
            Ingress::Failed
        ));
    }

    #[test]
    fn expired_closure_wait_cannot_release_a_previously_buffered_frame() {
        let (send, receive) = mpsc::sync_channel(1);
        let mut pending = vec![Some(Ingress::Frame(vec![1])), None];
        let deadline = Instant::now();
        assert!(next_ingress(&receive, &mut pending, None, deadline).is_err());
        assert!(pending[0].is_some());
        send.send((1, Ingress::Frame(vec![2]))).unwrap();
        assert!(next_ingress(&receive, &mut pending, Some(1), deadline).is_err());
        assert!(pending[0].is_some());
        let future = Instant::now() + Duration::from_secs(1);
        assert!(matches!(
            next_ingress(&receive, &mut pending, None, future),
            Ok((0, Ingress::Frame(value))) if value == [1]
        ));
    }

    #[test]
    fn acknowledged_endpoint_eof_precedes_an_already_queued_canonical_frame() {
        let (send, receive) = mpsc::sync_channel(3);
        let mut pending = vec![None, None];
        let deadline = Instant::now() + Duration::from_secs(1);
        send.send((0, Ingress::Frame(vec![1]))).unwrap();
        send.send((1, Ingress::Frame(vec![2]))).unwrap();
        assert!(
            matches!(next_ingress(&receive, &mut pending, Some(1), deadline),
            Ok((1, Ingress::Frame(value))) if value == [2])
        );
        assert!(pending[0].is_some());
        send.send((1, Ingress::Eof)).unwrap();
        assert!(matches!(
            next_ingress(&receive, &mut pending, Some(1), deadline),
            Ok((1, Ingress::Eof))
        ));
        assert!(
            matches!(next_ingress(&receive, &mut pending, None, deadline),
            Ok((0, Ingress::Frame(value))) if value == [1])
        );
        assert!(pending.iter().all(Option::is_none));
    }

    #[test]
    fn closure_wait_does_not_hide_failure_or_allow_two_pending_frames_per_endpoint() {
        for failure in [Ingress::Eof, Ingress::Failed] {
            let (send, receive) = mpsc::sync_channel(1);
            let mut pending = vec![None, None];
            send.send((0, failure)).unwrap();
            assert!(matches!(
                next_ingress(
                    &receive,
                    &mut pending,
                    Some(1),
                    Instant::now() + Duration::from_secs(1)
                ),
                Ok((0, Ingress::Eof | Ingress::Failed))
            ));
        }
        let (send, receive) = mpsc::sync_channel(2);
        let mut pending = vec![None, None];
        send.send((0, Ingress::Frame(vec![1]))).unwrap();
        send.send((0, Ingress::Frame(vec![2]))).unwrap();
        assert!(next_ingress(
            &receive,
            &mut pending,
            Some(1),
            Instant::now() + Duration::from_secs(1)
        )
        .is_err());
    }
}

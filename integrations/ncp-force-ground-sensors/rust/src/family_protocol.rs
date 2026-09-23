//! Host observations derived from the actual SDK owner and completed channel writes.
//!
//! These values are local observations. They neither attest a peer's durable capture
//! nor prove process retirement. No JSON decoder can mint an endpoint closure.

use std::fmt;
use std::io::{self, Write};

use ncp_local::modular_buffer::BufferBinding;
use ncp_local::modular_owner::{AppResponse, Application, Lifecycle, Owner};
use ncp_local::modular_wire::{Body, ModularError, Outcome};

/// A validated result observed directly after `Owner::process` returned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommittedStamp {
    binding: BufferBinding,
    sequence: u64,
    request_digest: String,
    result_digest: String,
}

impl CommittedStamp {
    /// The constructor-selected endpoint identity.
    pub fn binding(&self) -> &BufferBinding {
        &self.binding
    }

    /// The original execution ordinal, including for an exact replay.
    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    /// The original execution request digest.
    pub fn request_digest(&self) -> &str {
        &self.request_digest
    }

    /// The actual committed result digest.
    pub fn result_digest(&self) -> &str {
        &self.result_digest
    }

    fn from_response<A: Application>(response: &AppResponse<A>) -> Self {
        Self {
            binding: response.binding.clone(),
            sequence: response.sequence,
            request_digest: response.request_digest.clone(),
            result_digest: response.result_digest.clone(),
        }
    }
}

/// Host-only notifications. The NCP peer cannot submit these as application operations.
pub enum Observation<'a, A: Application> {
    /// A new validated committed result, before response transmission.
    Committed {
        /// The execution identity minted from the SDK result.
        stamp: &'a CommittedStamp,
        /// The same complete validated response.
        response: &'a AppResponse<A>,
    },
    /// The exact terminal ACK response was written and flushed successfully.
    TerminalAckSent(&'a CommittedStamp),
}

/// A channel, SDK, or native-notification failure with its original local error.
#[derive(Debug)]
pub enum ProtocolError {
    /// The SDK rejected a frame or its emitted response failed verification.
    Wire(ModularError),
    /// A write or flush failed; an admitted ACK has not thereby been transmitted.
    Write(io::Error),
    /// The native family failed to record an observed committed or ACK fact.
    Notification(ModularError),
    /// The requested transition would falsely claim endpoint closure.
    State,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Wire(error) => write!(formatter, "family SDK response: {error:?}"),
            Self::Write(error) => write!(formatter, "family response transmission: {error}"),
            Self::Notification(error) => write!(formatter, "family native observation: {error:?}"),
            Self::State => formatter.write_str("family endpoint closure remains unconfirmed"),
        }
    }
}

impl std::error::Error for ProtocolError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Write(error) => Some(error),
            _ => None,
        }
    }
}

/// Closed terminal endpoint facts. Construction requires SDK state, ACK write, and EOF.
#[derive(Debug)]
pub struct ClosedEndpoint {
    terminal: CommittedStamp,
}

impl ClosedEndpoint {
    /// The actual terminal result whose ACK was sent before the channel reached EOF.
    pub fn terminal(&self) -> &CommittedStamp {
        &self.terminal
    }
}

/// One real SDK owner, independently bound before its private channel is exposed.
pub struct ObservedEndpoint<A: Application> {
    owner: Owner<A>,
    last_committed: Option<CommittedStamp>,
    terminal: Option<CommittedStamp>,
    terminal_ack_sent: bool,
    channel_closed: bool,
    failed: bool,
}

impl<A: Application> ObservedEndpoint<A> {
    /// Construct a separate SDK owner. No endpoint label substitutes for this instance.
    pub fn new(
        binding: BufferBinding,
        application: A,
        semantics: Vec<String>,
    ) -> Result<Self, ModularError> {
        Ok(Self {
            owner: Owner::new(binding, application, semantics)?,
            last_committed: None,
            terminal: None,
            terminal_ack_sent: false,
            channel_closed: false,
            failed: false,
        })
    }

    /// Expose only the fixed endpoint binding, not a mutable SDK owner.
    pub fn binding(&self) -> &BufferBinding {
        self.owner.binding()
    }

    /// Record whether this endpoint can still participate in the family.
    pub fn failed(&self) -> bool {
        self.failed
    }

    /// Preserve the latest actual committed identity even if later transmission failed.
    pub fn last_committed(&self) -> Option<&CommittedStamp> {
        self.last_committed.as_ref()
    }

    /// Whether the exact terminal ACK response completed its selected-channel write.
    pub fn terminal_ack_sent(&self) -> bool {
        self.terminal_ack_sent
    }

    /// Whether this endpoint reached confirmed clean EOF after its terminal ACK.
    pub fn closed(&self) -> bool {
        self.channel_closed && !self.failed
    }

    /// Observe one actual SDK execution and transmit its exact response frame.
    ///
    /// The host supplies its selected private channel writer. Notification executes
    /// once per new COMMITTED identity, including when the original reply is lost.
    /// Replayed results do not repeat native effects or committed notifications.
    pub fn exchange<W, F>(
        &mut self,
        request: &[u8],
        writer: &mut W,
        mut notify: F,
    ) -> Result<(), ProtocolError>
    where
        W: Write,
        F: FnMut(Observation<'_, A>) -> Result<(), ModularError>,
    {
        if self.failed || self.channel_closed {
            return Err(ProtocolError::State);
        }
        let result = self.exchange_inner(request, writer, &mut notify);
        if result.is_err() {
            self.failed = true;
            self.owner.retire_channel();
        }
        result
    }

    fn exchange_inner<W, F>(
        &mut self,
        request: &[u8],
        writer: &mut W,
        notify: &mut F,
    ) -> Result<(), ProtocolError>
    where
        W: Write,
        F: FnMut(Observation<'_, A>) -> Result<(), ModularError>,
    {
        let bytes = self
            .owner
            .process(request)
            .map_err(ProtocolError::Wire)?
            .to_vec();
        let response =
            AppResponse::<A>::decode(&bytes, self.owner.binding()).map_err(ProtocolError::Wire)?;
        if response.outcome == Outcome::Committed {
            // A syntactically plausible application result is insufficient. Join
            // it to the SDK's retained bytes and actual advanced predecessor.
            if self.owner.retained() != Some(bytes.as_slice())
                || self.owner.predecessor() != Some(response.result_digest.as_str())
                || self.owner.high_water() != response.sequence
            {
                return Err(ProtocolError::State);
            }
            let stamp = CommittedStamp::from_response::<A>(&response);
            if self.last_committed.as_ref() != Some(&stamp) {
                if self
                    .last_committed
                    .as_ref()
                    .is_some_and(|previous| previous.sequence >= stamp.sequence)
                {
                    return Err(ProtocolError::State);
                }
                if matches!(response.body, Body::Finished { .. }) {
                    if self.owner.lifecycle() != Lifecycle::Finished || self.terminal.is_some() {
                        return Err(ProtocolError::State);
                    }
                    self.terminal = Some(stamp.clone());
                }
                self.last_committed = Some(stamp.clone());
                notify(Observation::Committed {
                    stamp: &stamp,
                    response: &response,
                })
                .map_err(ProtocolError::Notification)?;
            }
        }

        let terminal_ack = match &response.body {
            Body::Acknowledged { stamp } => self.terminal.as_ref().is_some_and(|terminal| {
                terminal.sequence == stamp.sequence
                    && terminal.request_digest == stamp.original_request_digest
                    && terminal.result_digest == stamp.result_digest
                    && self.owner.lifecycle() == Lifecycle::Finished
                    && self.owner.retained().is_none()
            }),
            _ => false,
        };
        writer
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .and_then(|()| writer.write_all(&bytes))
            .and_then(|()| writer.flush())
            .map_err(ProtocolError::Write)?;

        if terminal_ack && !self.terminal_ack_sent {
            self.terminal_ack_sent = true;
            let terminal = self.terminal.as_ref().ok_or(ProtocolError::State)?;
            notify(Observation::TerminalAckSent(terminal)).map_err(ProtocolError::Notification)?;
        }
        if self.owner.lifecycle() == Lifecycle::Retired {
            self.failed = true;
        }
        Ok(())
    }

    /// Record EOF from the host's selected channel reader, never a peer JSON claim.
    ///
    /// The reader must distinguish an empty clean EOF from a truncated frame. This
    /// method deliberately supplies no process-retirement or peer-receipt claim.
    pub fn observe_eof(&mut self) -> Result<ClosedEndpoint, ProtocolError> {
        let usage = self.owner.usage();
        let complete = !self.failed
            && !self.channel_closed
            && self.owner.lifecycle() == Lifecycle::Finished
            && self.owner.retained().is_none()
            && self.terminal_ack_sent
            && usage.live_slots == 0
            && usage.incomplete_slots == 0
            && usage.reserved_bytes == 0;
        self.channel_closed = true;
        self.owner.retire_channel();
        if !complete {
            self.failed = true;
            return Err(ProtocolError::State);
        }
        Ok(ClosedEndpoint {
            terminal: self.terminal.clone().ok_or(ProtocolError::State)?,
        })
    }

    /// Retire a failed or canceled channel without creating successful closure facts.
    pub fn retire_channel(&mut self) {
        self.failed = true;
        self.channel_closed = true;
        self.owner.retire_channel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Never;
    use ncp_local::modular_buffer::BufferManifest;
    use ncp_local::modular_client::Client;
    use ncp_local::modular_owner::{
        self, AdmissionDemand, AdmissionView, AppBody, AppOperation, ApplicationOutput, Contract,
        ExecutionContext, ExecutionPermit, ImportSource,
    };
    use ncp_local::modular_wire::{self as wire, Code, Diagnostic, Operation, OperationName};
    use std::cell::Cell;
    use std::rc::Rc;

    struct Probe {
        executions: Rc<Cell<usize>>,
        invalid_output: bool,
    }

    impl Contract for Probe {
        type Prepare = u64;
        type Command = u64;
        type ImportDescriptor = Never;
        type ImportMetadata = Never;
        type Finish = u64;
        type Result = u64;
        type Imported = Never;
        type Terminal = u64;

        fn descriptor() -> &'static [u8] {
            br#"{"schema":"crebain.family-ledger-synthetic.v1"}"#
        }

        fn allows(operation: OperationName) -> bool {
            matches!(
                operation,
                OperationName::Prepare | OperationName::Application | OperationName::Finish
            )
        }

        fn check_input(operation: &AppOperation<Self>) -> Result<(), ModularError> {
            match operation {
                Operation::Prepare(1) | Operation::Application(1) | Operation::Finish(1) => Ok(()),
                _ => Err(ModularError::Wire),
            }
        }

        fn check_response(
            _: &AppOperation<Self>,
            body: &AppBody<Self>,
            _: &ExecutionContext,
        ) -> Result<(), ModularError> {
            match body {
                Body::Prepared { data: 1 }
                | Body::Application { data: 1 }
                | Body::Finished { data: 1 } => Ok(()),
                Body::Prepared { .. } | Body::Application { .. } | Body::Finished { .. } => {
                    Err(ModularError::Wire)
                }
                _ => Ok(()),
            }
        }

        fn check_import_metadata(descriptor: &Never, _: &Never) -> Result<(), ModularError> {
            match *descriptor {}
        }
    }

    impl Application for Probe {
        fn admit(
            &self,
            _: &AppOperation<Self>,
            _: &AdmissionView<'_>,
        ) -> Result<AdmissionDemand, Code> {
            Ok(AdmissionDemand::default())
        }

        fn execute(
            &mut self,
            operation: &AppOperation<Self>,
            _: &mut ExecutionPermit<'_, '_>,
        ) -> Result<ApplicationOutput<u64, u64>, Diagnostic> {
            self.executions.set(self.executions.get() + 1);
            match operation {
                Operation::Prepare(_) | Operation::Application(_) => {
                    Ok(ApplicationOutput::Result(if self.invalid_output {
                        2
                    } else {
                        1
                    }))
                }
                Operation::Finish(_) => Ok(ApplicationOutput::Terminal(1)),
                _ => Err(Diagnostic::Internal),
            }
        }

        fn split_import<'a>(
            &'a self,
            descriptor: &'a Never,
        ) -> Result<ImportSource<'a, Never>, Code> {
            match *descriptor {}
        }

        fn validate_import(
            &self,
            metadata: &Never,
            _: &BufferManifest,
            _: &[u8],
        ) -> Result<Never, Code> {
            match *metadata {}
        }
    }

    fn binding(index: u8) -> BufferBinding {
        BufferBinding {
            profile_digest: modular_owner::profile_digest().unwrap(),
            application_digest: wire::typed_digest(
                wire::PROFILE_DOMAIN,
                &wire::parse_value(Probe::descriptor()).unwrap(),
                None,
            )
            .unwrap(),
            run_id: format!("{index:08x}-1111-4111-8111-111111111111"),
            endpoint_id: format!("{index:08x}-2222-4222-8222-222222222222"),
            generation: format!("{index:08x}-3333-4333-8333-333333333333"),
        }
    }

    fn setup(
        index: u8,
        invalid_output: bool,
    ) -> (ObservedEndpoint<Probe>, Client<Probe>, Rc<Cell<usize>>) {
        let executions = Rc::new(Cell::new(0));
        let endpoint = ObservedEndpoint::new(
            binding(index),
            Probe {
                executions: Rc::clone(&executions),
                invalid_output,
            },
            vec!["a".repeat(64)],
        )
        .unwrap();
        (endpoint, Client::new(binding(index)).unwrap(), executions)
    }

    fn unframe(bytes: &[u8]) -> &[u8] {
        assert!(bytes.len() >= 4);
        assert_eq!(
            u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize,
            bytes.len() - 4
        );
        &bytes[4..]
    }

    fn committed(
        endpoint: &mut ObservedEndpoint<Probe>,
        client: &mut Client<Probe>,
        operation: AppOperation<Probe>,
    ) -> Vec<u8> {
        let input = client.begin(operation).unwrap().to_vec();
        let mut output = Vec::new();
        endpoint.exchange(&input, &mut output, |_| Ok(())).unwrap();
        let response = client.observe(unframe(&output)).unwrap();
        assert_eq!(response.outcome, Outcome::Committed);
        client.acknowledgement().unwrap()
    }

    fn prepared() -> (ObservedEndpoint<Probe>, Client<Probe>, Rc<Cell<usize>>) {
        let (mut endpoint, mut client, executions) = setup(1, false);
        let ack = committed(&mut endpoint, &mut client, Operation::Prepare(1));
        let mut output = Vec::new();
        endpoint.exchange(&ack, &mut output, |_| Ok(())).unwrap();
        client.observe_acknowledgement(unframe(&output)).unwrap();
        (endpoint, client, executions)
    }

    #[test]
    fn committed_lost_reply_replays_without_a_second_effect_or_notification() {
        let (mut endpoint, mut client, executions) = setup(1, false);
        let request = client.begin(Operation::Prepare(1)).unwrap().to_vec();
        let mut commits = 0;
        let mut notify = |event: Observation<'_, Probe>| {
            if let Observation::Committed { stamp, response } = event {
                assert_eq!(stamp.result_digest(), response.result_digest);
                assert_eq!(stamp.request_digest(), response.request_digest);
                assert_eq!(stamp.binding(), &binding(1));
                commits += 1;
            }
            Ok(())
        };
        let mut lost = Vec::new();
        endpoint.exchange(&request, &mut lost, &mut notify).unwrap();
        let mut replay = Vec::new();
        endpoint
            .exchange(&request, &mut replay, &mut notify)
            .unwrap();
        assert_eq!(lost, replay);
        assert_eq!(executions.get(), 1);
        assert_eq!(commits, 1);
        assert_eq!(
            client.observe(unframe(&replay)).unwrap().outcome,
            Outcome::Committed
        );
    }

    #[test]
    fn invalid_post_execution_output_never_becomes_a_committed_observation() {
        let (mut endpoint, mut client, executions) = setup(1, true);
        let request = client.begin(Operation::Prepare(1)).unwrap().to_vec();
        let mut observations = 0;
        let mut output = Vec::new();
        endpoint
            .exchange(&request, &mut output, |_| {
                observations += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(executions.get(), 1);
        assert_eq!(observations, 0);
        assert_eq!(
            client.observe(unframe(&output)).unwrap().outcome,
            Outcome::Indeterminate
        );
        assert!(endpoint.failed());
        assert!(endpoint.last_committed().is_none());
        assert!(endpoint.observe_eof().is_err());
    }

    #[test]
    fn terminal_requires_ack_transmission_and_actual_eof_in_addition_to_finish() {
        let (mut endpoint, mut client, _) = prepared();
        let ack = committed(&mut endpoint, &mut client, Operation::Finish(1));
        assert!(!endpoint.terminal_ack_sent);
        let mut output = Vec::new();
        let mut acknowledgements = 0;
        endpoint
            .exchange(&ack, &mut output, |event| {
                if let Observation::TerminalAckSent(stamp) = event {
                    assert_eq!(stamp.sequence(), 2);
                    acknowledgements += 1;
                }
                Ok(())
            })
            .unwrap();
        client.observe_acknowledgement(unframe(&output)).unwrap();
        assert!(!endpoint.channel_closed);
        assert_eq!(acknowledgements, 1);
        let closed = endpoint.observe_eof().unwrap();
        assert_eq!(closed.terminal().sequence(), 2);
        assert_eq!(closed.terminal().binding(), &binding(1));
        assert!(endpoint.observe_eof().is_err());
    }

    #[test]
    fn eof_after_finish_but_before_ack_remains_incomplete() {
        let (mut endpoint, mut client, _) = prepared();
        committed(&mut endpoint, &mut client, Operation::Finish(1));
        assert!(endpoint.observe_eof().is_err());
        assert!(endpoint.failed());
    }

    struct FailedWrite {
        remaining: usize,
        fail_flush: bool,
    }
    impl Write for FailedWrite {
        fn write(&mut self, input: &[u8]) -> io::Result<usize> {
            if self.remaining == 0 {
                return Err(io::Error::other("owned synthetic write failed"));
            }
            let count = self.remaining.min(input.len());
            self.remaining -= count;
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            if self.fail_flush {
                Err(io::Error::other("owned synthetic flush failed"))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn admitted_ack_with_failed_prefix_body_or_flush_never_closes_the_endpoint() {
        for (remaining, fail_flush) in [(0, false), (4, false), (usize::MAX, true)] {
            let (mut endpoint, mut client, _) = prepared();
            let ack = committed(&mut endpoint, &mut client, Operation::Finish(1));
            let mut writer = FailedWrite {
                remaining,
                fail_flush,
            };
            let mut notifications = 0;
            let failure = endpoint
                .exchange(&ack, &mut writer, |_| {
                    notifications += 1;
                    Ok(())
                })
                .unwrap_err();
            assert!(matches!(failure, ProtocolError::Write(_)));
            assert_eq!(notifications, 0);
            assert!(!endpoint.terminal_ack_sent);
            assert!(endpoint.last_committed().is_some());
            assert!(endpoint.observe_eof().is_err());
        }
    }

    #[test]
    fn repeated_lost_ack_response_does_not_repeat_the_terminal_notification() {
        let (mut endpoint, mut client, executions) = prepared();
        let ack = committed(&mut endpoint, &mut client, Operation::Finish(1));
        let mut acknowledgements = 0;
        let mut notify = |event: Observation<'_, Probe>| {
            if let Observation::TerminalAckSent(_) = event {
                acknowledgements += 1;
            }
            Ok(())
        };
        let mut lost = Vec::new();
        endpoint.exchange(&ack, &mut lost, &mut notify).unwrap();
        let mut replay = Vec::new();
        endpoint.exchange(&ack, &mut replay, &mut notify).unwrap();
        assert_eq!(lost, replay);
        assert_eq!(acknowledgements, 1);
        assert_eq!(executions.get(), 2);
        client.observe_acknowledgement(unframe(&replay)).unwrap();
        assert!(endpoint.observe_eof().is_ok());
    }

    #[test]
    fn callback_failure_preserves_commit_without_claiming_delivery_or_closure() {
        let (mut endpoint, mut client, executions) = setup(1, false);
        let request = client.begin(Operation::Prepare(1)).unwrap().to_vec();
        let mut output = Vec::new();
        let failure = endpoint
            .exchange(&request, &mut output, |_| Err(ModularError::Capacity))
            .unwrap_err();
        assert!(matches!(
            failure,
            ProtocolError::Notification(ModularError::Capacity)
        ));
        assert_eq!(executions.get(), 1);
        assert!(output.is_empty());
        assert!(endpoint.last_committed().is_some());
        assert!(endpoint.observe_eof().is_err());
    }

    #[test]
    fn a_foreign_binding_cannot_execute_on_a_separately_constructed_owner() {
        let (mut first, mut client, first_executions) = setup(1, false);
        let (mut second, _, second_executions) = setup(2, false);
        let request = client.begin(Operation::Prepare(1)).unwrap().to_vec();
        assert!(second
            .exchange(&request, &mut Vec::new(), |_| Ok(()))
            .is_err());
        assert_eq!(second_executions.get(), 0);
        first
            .exchange(&request, &mut Vec::new(), |_| Ok(()))
            .unwrap();
        assert_eq!(first_executions.get(), 1);
        assert_ne!(first.binding(), second.binding());
    }
}

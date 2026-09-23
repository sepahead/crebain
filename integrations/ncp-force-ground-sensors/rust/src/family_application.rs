//! Two fixed SDK roles sharing one owner-private live native family.

use std::cell::RefCell;
use std::rc::Rc;

use ncp_local::modular_buffer::BufferManifest;
use ncp_local::modular_owner::{
    AdmissionDemand, AdmissionView, AppBody, AppOperation, Application, ApplicationOutput,
    Contract, ExecutionContext, ExecutionPermit, ImportSource,
};
use ncp_local::modular_wire::{Body, Code, Diagnostic, ModularError, Operation, OperationName};
use serde::{de::DeserializeOwned, Serialize};

use crate::application::{self, SensorApplication};
use crate::contract::{self, Commitment};
use crate::engine::{EngineBatch, EngineError, EnginePort, EnginePrepared};
use crate::family_contract as family;
use crate::family_engine::{FamilyEngine, NativeRestored};
use crate::family_protocol::{ClosedEndpoint, CommittedStamp as ObservedStamp, Observation};
use crate::family_types::*;
use crate::types::{AdvanceTick, AdvanceTickCaptureReservation, Never, Prepare, SensorResult};

fn converted<T: Serialize, U: DeserializeOwned>(input: &T) -> Result<U, ModularError> {
    serde_json::from_value(serde_json::to_value(input).map_err(|_| ModularError::Wire)?)
        .map_err(|_| ModularError::Wire)
}

fn receipt(stamp: &ObservedStamp) -> CommittedStamp {
    CommittedStamp {
        binding: stamp.binding().clone(),
        sequence: stamp.sequence(),
        request_digest: stamp.request_digest().into(),
        result_digest: stamp.result_digest().into(),
    }
}

#[derive(Default)]
struct BranchRecord {
    reservation: Option<ReservationReference>,
    restored: Option<NativeRestored>,
    restored_committed: bool,
    evaluation: Option<EvaluationResult>,
    evaluation_commit: Option<CommittedStamp>,
    terminal: Option<CommittedStamp>,
    ack_sent: bool,
    closed: bool,
}

struct FamilyState<E: FamilyEngine> {
    engine: E,
    plan: FamilyPlan,
    source: String,
    digest: String,
    constructed: Vec<bool>,
    identity: Option<EnginePrepared>,
    prepared: bool,
    checkpoint: Option<CheckpointReference>,
    decision: Option<DecisionCommitted>,
    selected_execution: Option<CommittedStamp>,
    canonical_final: Option<CanonicalFinalState>,
    branches: Vec<BranchRecord>,
    next_branch: usize,
    active: Option<usize>,
    released: bool,
    finished: bool,
    failed: bool,
}

/// The host retains this controller; peers receive only their fixed NCP channels.
pub struct FamilyController<E: FamilyEngine>(Rc<RefCell<FamilyState<E>>>);

impl<E: FamilyEngine> Clone for FamilyController<E> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}

impl<E: FamilyEngine> FamilyController<E> {
    /// Admit the complete constructor plan before constructing any endpoint application.
    pub fn new(plan: FamilyPlan, source: String, engine: E) -> Result<Self, ModularError> {
        family::validate_plan(&plan)?;
        let digest = family::plan_digest(&plan, &source)?;
        let branches = (0..plan.branches.len())
            .map(|_| BranchRecord::default())
            .collect();
        let constructed = vec![false; plan.branches.len() + 1];
        Ok(Self(Rc::new(RefCell::new(FamilyState {
            engine,
            plan,
            source,
            digest,
            constructed,
            identity: None,
            prepared: false,
            checkpoint: None,
            decision: None,
            selected_execution: None,
            canonical_final: None,
            branches,
            next_branch: 0,
            active: None,
            released: false,
            finished: false,
            failed: false,
        }))))
    }

    /// Construct the one canonical application. The SDK owner separately binds its channel.
    pub fn canonical(&self) -> Result<CanonicalApplication<E>, ModularError> {
        let mut state = self.0.try_borrow_mut().map_err(|_| ModularError::Retired)?;
        if state.constructed[0] {
            return Err(ModularError::Binding);
        }
        state.constructed[0] = true;
        let source = state.source.clone();
        Ok(CanonicalApplication {
            sensors: SensorApplication::new(
                FamilySensorPort {
                    family: self.clone(),
                    slot: 0,
                },
                source,
            )?,
            family: self.clone(),
        })
    }

    /// Construct one predeclared evaluation application, never a dynamically selected role.
    pub fn evaluation(&self, slot: usize) -> Result<EvaluationApplication<E>, ModularError> {
        let mut state = self.0.try_borrow_mut().map_err(|_| ModularError::Retired)?;
        if slot == 0 || slot > state.branches.len() {
            return Err(ModularError::Binding);
        }
        if state.constructed[slot] {
            return Err(ModularError::Binding);
        }
        state.constructed[slot] = true;
        Ok(EvaluationApplication {
            sensors: SensorApplication::new(
                FamilySensorPort {
                    family: self.clone(),
                    slot,
                },
                state.source.clone(),
            )?,
            family: self.clone(),
            slot,
        })
    }

    /// Consume a fact emitted by the actual canonical SDK owner.
    pub fn observe_canonical(
        &self,
        event: Observation<'_, CanonicalApplication<E>>,
    ) -> Result<(), ModularError> {
        let Observation::Committed { stamp, response } = event else {
            return Ok(());
        };
        let mut state = self.0.try_borrow_mut().map_err(|_| ModularError::Retired)?;
        if state.failed || stamp.binding() != &state.plan.canonical_binding {
            return Err(ModularError::Binding);
        }
        match &response.body {
            Body::Prepared { data } | Body::Application { data } => {
                if state.engine.canonical_committed(stamp, data).is_err() {
                    state.failed = true;
                    return Err(ModularError::Retired);
                }
                match data {
                    CanonicalResult::FamilyPrepared { .. } => state.prepared = true,
                    CanonicalResult::Checkpointed { reference, .. } => {
                        state.checkpoint = Some((**reference).clone())
                    }
                    CanonicalResult::DecisionCommitted { .. } => {
                        state.decision = Some(converted(data)?)
                    }
                    CanonicalResult::FamilyAdvanced {
                        body,
                        canonical_final_state,
                        ..
                    } if body.tick == state.plan.body.planned_ticks => {
                        state.selected_execution = Some(receipt(stamp));
                        state.canonical_final = canonical_final_state.as_deref().cloned();
                    }
                    CanonicalResult::BranchReserved { reference, .. } => {
                        let index = state.next_branch;
                        let branch = state.branches.get_mut(index).ok_or(ModularError::Binding)?;
                        branch.reservation = Some((**reference).clone());
                        state.active = Some(index + 1);
                    }
                    CanonicalResult::CheckpointReleased { .. } => state.released = true,
                    CanonicalResult::FamilyAdvanced { .. } => {}
                }
            }
            Body::Finished { .. } => state.finished = true,
            _ => {}
        }
        Ok(())
    }

    /// Consume only actual SDK facts for this predeclared evaluation endpoint.
    pub fn observe_evaluation(
        &self,
        slot: usize,
        event: Observation<'_, EvaluationApplication<E>>,
    ) -> Result<(), ModularError> {
        let mut state = self.0.try_borrow_mut().map_err(|_| ModularError::Retired)?;
        if state.failed || state.active != Some(slot) {
            return Err(ModularError::Binding);
        }
        let observed = match event {
            Observation::Committed { stamp, .. } | Observation::TerminalAckSent(stamp) => stamp,
        };
        if observed.binding() != &state.plan.branches[slot - 1].binding {
            return Err(ModularError::Binding);
        }
        let result = (|| -> Result<(), EngineError> {
            match event {
                Observation::Committed { stamp, response } => match &response.body {
                    Body::Prepared { data } | Body::Application { data } => {
                        state.engine.evaluation_committed(slot, stamp, data)?;
                        match data {
                            EvaluationResultUnion::Restored { .. } => {
                                state.branches[slot - 1].restored_committed = true
                            }
                            EvaluationResultUnion::PressureWindowEvaluated { .. } => {
                                state.branches[slot - 1].evaluation_commit = Some(receipt(stamp));
                            }
                            EvaluationResultUnion::FamilyAdvanced { .. } => {}
                        }
                        Ok(())
                    }
                    Body::Finished { .. } => {
                        state.engine.terminal_committed(stamp)?;
                        state.branches[slot - 1].terminal = Some(receipt(stamp));
                        Ok(())
                    }
                    _ => Ok(()),
                },
                Observation::TerminalAckSent(stamp) => {
                    if state.branches[slot - 1].terminal.as_ref() != Some(&receipt(stamp)) {
                        return Err(EngineError);
                    }
                    state.engine.terminal_ack_sent(stamp)?;
                    state.branches[slot - 1].ack_sent = true;
                    Ok(())
                }
            }
        })();
        result.map_err(|_: EngineError| {
            state.failed = true;
            ModularError::Retired
        })
    }

    /// Record closure minted by the same actual SDK endpoint after successful ACK and EOF.
    pub fn close_evaluation(
        &self,
        slot: usize,
        endpoint: ClosedEndpoint,
    ) -> Result<(), ModularError> {
        let mut state = self.0.try_borrow_mut().map_err(|_| ModularError::Retired)?;
        if state.failed || state.active != Some(slot) {
            return Err(ModularError::Binding);
        }
        let branch = &state.branches[slot - 1];
        if !branch.ack_sent || branch.terminal.as_ref() != Some(&receipt(endpoint.terminal())) {
            return Err(ModularError::Binding);
        }
        if state.engine.channel_closed(endpoint.terminal()).is_err() {
            state.failed = true;
            return Err(ModularError::Retired);
        }
        state.branches[slot - 1].closed = true;
        state.next_branch += 1;
        state.active = None;
        Ok(())
    }

    /// Retire the selected family after host failure without promoting pending endpoints.
    pub fn retire(&self) -> Result<(), EngineError> {
        let mut state = self.0.try_borrow_mut().map_err(|_| EngineError)?;
        if !state.finished {
            state.failed = true;
        }
        state.engine.retire()
    }
}

struct FamilySensorPort<E: FamilyEngine> {
    family: FamilyController<E>,
    slot: usize,
}
impl<E: FamilyEngine> EnginePort for FamilySensorPort<E> {
    fn prepare(&mut self, _: &str, _: &str, _: &Prepare) -> Result<EnginePrepared, EngineError> {
        Err(EngineError)
    }
    fn advance(
        &mut self,
        _: &AdvanceTick,
        _: Option<&str>,
        _: &str,
    ) -> Result<EngineBatch, EngineError> {
        Err(EngineError)
    }
    fn advance_bound(
        &mut self,
        command: &AdvanceTick,
        _: Option<&str>,
        _: &str,
        request: &str,
    ) -> Result<EngineBatch, EngineError> {
        self.family
            .0
            .try_borrow_mut()
            .map_err(|_| EngineError)?
            .engine
            .advance(self.slot, command, request)
    }
    fn read_chunk(
        &mut self,
        tick: u64,
        batch: &str,
        sensor: &str,
        offset: usize,
        count: usize,
    ) -> Result<Vec<u8>, EngineError> {
        self.family
            .0
            .try_borrow_mut()
            .map_err(|_| EngineError)?
            .engine
            .read_chunk(self.slot, tick, batch, sensor, offset, count)
    }
    fn release_lease(&mut self, tick: u64, batch: &str) -> Result<(), EngineError> {
        let mut state = self.family.0.try_borrow_mut().map_err(|_| EngineError)?;
        let final_state = state.engine.release_lease(self.slot, tick, batch)?;
        if self.slot == 0 {
            state.canonical_final = final_state;
        } else if final_state.is_some() {
            return Err(EngineError);
        }
        Ok(())
    }
    fn retire(&mut self) -> Result<(), EngineError> {
        self.family.retire()
    }
}

/// Canonical-only typed NCP application. Its peer cannot select an evaluation role.
pub struct CanonicalApplication<E: FamilyEngine> {
    family: FamilyController<E>,
    sensors: SensorApplication<FamilySensorPort<E>>,
}
/// Evaluation-only typed NCP application bound to one frozen slot.
pub struct EvaluationApplication<E: FamilyEngine> {
    family: FamilyController<E>,
    sensors: SensorApplication<FamilySensorPort<E>>,
    slot: usize,
}

fn allows(operation: OperationName) -> bool {
    matches!(
        operation,
        OperationName::Prepare
            | OperationName::Application
            | OperationName::BufferRead
            | OperationName::BufferRelease
            | OperationName::Finish
            | OperationName::Abort
    )
}

fn canonical_advance(command: &CanonicalCommand) -> Option<AdvanceTick> {
    let CanonicalCommand::AdvanceTick {
        tick,
        previous_batch_digest,
        action,
        capture_reservation,
    } = command
    else {
        return None;
    };
    Some(AdvanceTick {
        kind: "advance_tick".into(),
        tick: *tick,
        previous_batch_digest: previous_batch_digest.clone(),
        action: (**action).clone(),
        capture_reservation: AdvanceTickCaptureReservation {
            kind: capture_reservation.kind.clone(),
        },
    })
}
fn evaluation_advance(command: &EvaluationCommand) -> Option<AdvanceTick> {
    let EvaluationCommand::AdvanceTick {
        tick,
        previous_batch_digest,
        action,
        capture_reservation,
    } = command
    else {
        return None;
    };
    Some(AdvanceTick {
        kind: "advance_tick".into(),
        tick: *tick,
        previous_batch_digest: previous_batch_digest.clone(),
        action: (**action).clone(),
        capture_reservation: AdvanceTickCaptureReservation {
            kind: capture_reservation.kind.clone(),
        },
    })
}

fn check_advanced<E: FamilyEngine>(
    command: AdvanceTick,
    data: &FamilyAdvanced,
    context: &ExecutionContext,
    canonical: bool,
) -> Result<(), ModularError> {
    family::validate("FamilyAdvanced", data)?;
    if canonical != data.ancestry.is_none()
        || data
            .ancestry
            .as_ref()
            .is_some_and(|ancestry| &ancestry.execution_binding != context.binding())
        || (!canonical && data.canonical_final_state.is_some())
        || data.canonical_final_state.as_ref().is_some_and(|state| {
            state.body_tick != command.tick
                || state.native_batch_sha256 != data.body.batch.engine_batch_sha256
        })
    {
        return Err(ModularError::Binding);
    }
    let body = Body::Application {
        data: converted::<_, SensorResult>(&data.body)?,
    };
    SensorApplication::<FamilySensorPort<E>>::check_response(
        &Operation::Application(command),
        &body,
        context,
    )
}

impl<E: FamilyEngine> Contract for CanonicalApplication<E> {
    type Prepare = CanonicalPrepare;
    type Command = CanonicalCommand;
    type ImportDescriptor = Never;
    type ImportMetadata = Never;
    type Finish = CanonicalFinish;
    type Result = CanonicalResult;
    type Imported = Never;
    type Terminal = CanonicalTerminal;
    fn descriptor() -> &'static [u8] {
        family::DESCRIPTOR
    }
    fn allows(operation: OperationName) -> bool {
        allows(operation)
    }
    fn check_input(operation: &AppOperation<Self>) -> Result<(), ModularError> {
        match operation {
            Operation::Prepare(p) => family::validate_plan(&p.plan),
            Operation::Application(c) => family::validate("CanonicalCommand", c),
            Operation::Finish(f) => family::validate("CanonicalFinish", f),
            _ => Ok(()),
        }
    }
    fn check_response(
        operation: &AppOperation<Self>,
        body: &AppBody<Self>,
        context: &ExecutionContext,
    ) -> Result<(), ModularError> {
        match body {
            Body::Prepared { data } | Body::Application { data } => {
                family::validate("CanonicalResult", data)?;
                family::result_bound(data)?;
            }
            Body::Finished { data } => {
                family::validate("CanonicalTerminal", data)?;
                family::result_bound(data)?;
            }
            _ => return Ok(()),
        }
        match (operation, body) {
            (
                Operation::Prepare(p),
                Body::Prepared {
                    data:
                        CanonicalResult::FamilyPrepared {
                            family_plan_digest,
                            body,
                            endpoint_count,
                            native_owner_count,
                        },
                },
            ) => {
                let expected = application::plan_digest(
                    &p.plan.body,
                    &p.plan.canonical_binding.run_id,
                    &body.source_identity,
                )?;
                if &p.plan.canonical_binding != context.binding()
                    || *family_plan_digest != family::plan_digest(&p.plan, &body.source_identity)?
                    || body.plan_digest != expected
                    || body.sensor_catalog != application::catalog(&p.plan.body, &expected)?
                    || *endpoint_count != p.plan.limits.endpoint_count
                    || *native_owner_count != 1
                {
                    return Err(ModularError::Binding);
                }
            }
            (
                Operation::Application(command),
                Body::Application {
                    data: CanonicalResult::FamilyAdvanced { .. },
                },
            ) if canonical_advance(command).is_some() => {
                let advance = canonical_advance(command).ok_or(ModularError::Wire)?;
                if let Body::Application { data } = body {
                    check_advanced::<E>(advance, &converted(data)?, context, true)?;
                }
            }
            (
                Operation::Application(CanonicalCommand::Checkpoint {
                    tick,
                    expected_batch_digest,
                }),
                Body::Application {
                    data:
                        CanonicalResult::Checkpointed {
                            reference,
                            accepted_sensor_batch_digest,
                            ..
                        },
                },
            ) => {
                if reference.tick != *tick
                    || &reference.parent_binding != context.binding()
                    || accepted_sensor_batch_digest != expected_batch_digest
                {
                    return Err(ModularError::Binding);
                }
            }
            (
                Operation::Application(CanonicalCommand::CommitDecision {
                    checkpoint,
                    forecast_commitment_digest,
                    selected_case_id,
                }),
                Body::Application {
                    data:
                        CanonicalResult::DecisionCommitted {
                            checkpoint: actual,
                            forecast_commitment_digest: forecast,
                            selected_case_id: selected,
                            ..
                        },
                },
            ) => {
                if checkpoint != actual
                    || forecast != forecast_commitment_digest
                    || selected != selected_case_id
                {
                    return Err(ModularError::Binding);
                }
            }
            (
                Operation::Application(CanonicalCommand::ReserveBranch {
                    checkpoint,
                    case_id,
                    ..
                }),
                Body::Application {
                    data: CanonicalResult::BranchReserved { reference, .. },
                },
            ) => {
                if &reference.checkpoint != checkpoint.as_ref()
                    || reference.case_id != *case_id
                    || reference.reserving_request_digest != context.request_digest()
                {
                    return Err(ModularError::Binding);
                }
            }
            (
                Operation::Application(CanonicalCommand::ReleaseCheckpoint { checkpoint, .. }),
                Body::Application {
                    data: CanonicalResult::CheckpointReleased { reference, .. },
                },
            ) => {
                if checkpoint != reference {
                    return Err(ModularError::Binding);
                }
            }
            (Operation::Finish(f), Body::Finished { data }) => {
                if data.family_plan_digest != f.family_plan_digest
                    || data.last_batch_digest != f.body.last_batch_digest
                    || data.branch_terminals != f.expected_branch_terminals
                    || data.canonical_final_state.body_tick != f.body.completed_ticks
                {
                    return Err(ModularError::Binding);
                }
            }
            _ => return Err(ModularError::Wire),
        }
        Ok(())
    }
    fn check_import_metadata(descriptor: &Never, _: &Never) -> Result<(), ModularError> {
        match *descriptor {}
    }
}

impl<E: FamilyEngine> Contract for EvaluationApplication<E> {
    type Prepare = EvaluationPrepare;
    type Command = EvaluationCommand;
    type ImportDescriptor = Never;
    type ImportMetadata = Never;
    type Finish = EvaluationFinish;
    type Result = EvaluationResultUnion;
    type Imported = Never;
    type Terminal = EvaluationTerminal;
    fn descriptor() -> &'static [u8] {
        family::DESCRIPTOR
    }
    fn allows(operation: OperationName) -> bool {
        allows(operation)
    }
    fn check_input(operation: &AppOperation<Self>) -> Result<(), ModularError> {
        match operation {
            Operation::Prepare(p) => family::validate("EvaluationPrepare", p),
            Operation::Application(c) => family::validate("EvaluationCommand", c),
            Operation::Finish(f) => family::validate("EvaluationFinish", f),
            _ => Ok(()),
        }
    }
    fn check_response(
        operation: &AppOperation<Self>,
        body: &AppBody<Self>,
        context: &ExecutionContext,
    ) -> Result<(), ModularError> {
        match body {
            Body::Prepared { data } | Body::Application { data } => {
                family::validate("EvaluationResultUnion", data)?;
                family::result_bound(data)?;
            }
            Body::Finished { data } => {
                family::validate("EvaluationTerminal", data)?;
                family::result_bound(data)?;
            }
            _ => return Ok(()),
        }
        match (operation, body) {
            (
                Operation::Prepare(p),
                Body::Prepared {
                    data:
                        EvaluationResultUnion::Restored {
                            ancestry,
                            family_plan_digest,
                            sensor_catalog,
                            ..
                        },
                },
            ) => {
                if &ancestry.execution_binding != context.binding()
                    || ancestry.execution_binding != p.reservation.branch_binding
                    || ancestry.origin != p.reservation.checkpoint
                    || ancestry.case_id != p.reservation.case_id
                    || *family_plan_digest != p.expected_family_plan_digest
                    || sensor_catalog.catalog_digest
                        != contract::commit(Commitment::Catalog, sensor_catalog)?
                {
                    return Err(ModularError::Binding);
                }
            }
            (
                Operation::Application(command),
                Body::Application {
                    data: EvaluationResultUnion::FamilyAdvanced { .. },
                },
            ) if evaluation_advance(command).is_some() => {
                let advance = evaluation_advance(command).ok_or(ModularError::Wire)?;
                if let Body::Application { data } = body {
                    check_advanced::<E>(advance, &converted(data)?, context, false)?;
                }
            }
            (
                Operation::Application(EvaluationCommand::EvaluatePressureWindow {
                    expected_batch_digest,
                    expected_target_function_digest,
                }),
                Body::Application {
                    data:
                        EvaluationResultUnion::PressureWindowEvaluated {
                            ancestry,
                            target,
                            final_sensor_batch_digest,
                            ..
                        },
                },
            ) => {
                if &ancestry.execution_binding != context.binding()
                    || final_sensor_batch_digest != expected_batch_digest
                    || target.target_function_digest != *expected_target_function_digest
                {
                    return Err(ModularError::Binding);
                }
            }
            (Operation::Finish(f), Body::Finished { data }) => {
                if &data.ancestry.execution_binding != context.binding()
                    || data.last_batch_digest != f.body.last_batch_digest
                    || data.evaluation_result_digest != f.evaluation_result_digest
                {
                    return Err(ModularError::Binding);
                }
            }
            _ => return Err(ModularError::Wire),
        }
        Ok(())
    }
    fn check_import_metadata(descriptor: &Never, _: &Never) -> Result<(), ModularError> {
        match *descriptor {}
    }
}

fn empty_buffers(view: &AdmissionView<'_>) -> Result<(), Code> {
    if view.buffers.live_slots == 0
        && view.buffers.incomplete_slots == 0
        && view.buffers.reserved_bytes == 0
    {
        Ok(())
    } else {
        Err(Code::State)
    }
}

fn continuation_matches(
    command: &AdvanceTick,
    landmark: u64,
    target: &crate::types::SetTarget,
) -> bool {
    if command.tick == landmark + 1 {
        converted::<_, crate::types::SetTarget>(&command.action).as_ref() == Ok(target)
    } else {
        matches!(command.action, crate::types::Action::Hold { .. })
    }
}

impl<E: FamilyEngine> Application for CanonicalApplication<E> {
    fn admit(
        &self,
        operation: &AppOperation<Self>,
        view: &AdmissionView<'_>,
    ) -> Result<AdmissionDemand, Code> {
        let state = self.family.0.try_borrow().map_err(|_| Code::State)?;
        if state.failed || state.finished {
            return Err(Code::State);
        }
        let demand = AdmissionDemand::default();
        match operation {
            Operation::Prepare(p) => {
                if p.plan != state.plan || state.prepared || self.sensors.current().is_some() {
                    return Err(Code::State);
                }
            }
            Operation::Application(command) => {
                if !state.prepared {
                    return Err(Code::State);
                }
                if let Some(advance) = canonical_advance(command) {
                    if state.active.is_some()
                        || advance.tick > state.plan.landmark_tick && state.decision.is_none()
                    {
                        return Err(Code::State);
                    }
                    if advance.tick > state.plan.landmark_tick
                        && state.decision.as_ref().is_none_or(|decision| {
                            !continuation_matches(
                                &advance,
                                state.plan.landmark_tick,
                                &decision.selected_target,
                            )
                        })
                    {
                        return Err(Code::State);
                    }
                    return self.sensors.admit(&Operation::Application(advance), view);
                }
                empty_buffers(view)?;
                let (tick, _, batch) = self.sensors.current().ok_or(Code::State)?;
                match command {
                    CanonicalCommand::Checkpoint {
                        tick: expected,
                        expected_batch_digest,
                    } => {
                        if tick != *expected
                            || tick != state.plan.landmark_tick
                            || batch != Some(expected_batch_digest)
                            || state.checkpoint.is_some()
                        {
                            return Err(Code::State);
                        }
                    }
                    CanonicalCommand::CommitDecision {
                        checkpoint,
                        selected_case_id,
                        ..
                    } => {
                        if state.checkpoint.as_ref() != Some(checkpoint.as_ref())
                            || state.decision.is_some()
                            || !state.plan.branches.iter().any(|branch| {
                                branch.case_id == *selected_case_id
                                    && branch.purpose == BranchPlanPurpose::Label
                            })
                        {
                            return Err(Code::State);
                        }
                    }
                    CanonicalCommand::ReserveBranch {
                        checkpoint,
                        case_id,
                        expected_selected_execution_result_digest,
                    } => {
                        if state.checkpoint.as_ref() != Some(checkpoint.as_ref())
                            || state.active.is_some()
                            || state
                                .plan
                                .branches
                                .get(state.next_branch)
                                .is_none_or(|branch| branch.case_id != *case_id)
                            || state.selected_execution.as_ref().is_none_or(|stamp| {
                                stamp.result_digest != *expected_selected_execution_result_digest
                            })
                            || tick != state.plan.body.planned_ticks
                            || state.released
                        {
                            return Err(Code::State);
                        }
                    }
                    CanonicalCommand::ReleaseCheckpoint {
                        checkpoint,
                        expected_last_branch_terminal_result_digest,
                    } => {
                        if state.checkpoint.as_ref() != Some(checkpoint.as_ref())
                            || state.released
                            || state.active.is_some()
                            || state.branches.iter().any(|branch| !branch.closed)
                            || state
                                .branches
                                .last()
                                .and_then(|branch| branch.terminal.as_ref())
                                .is_none_or(|terminal| {
                                    terminal.result_digest
                                        != *expected_last_branch_terminal_result_digest
                                })
                        {
                            return Err(Code::State);
                        }
                    }
                    CanonicalCommand::AdvanceTick { .. } => return Err(Code::State),
                }
            }
            Operation::Finish(f) => {
                if !state.released
                    || f.family_plan_digest != state.digest
                    || state.active.is_some()
                    || state.branches.iter().any(|branch| !branch.closed)
                    || state
                        .branches
                        .iter()
                        .map(|branch| branch.terminal.as_ref())
                        .ne(f.expected_branch_terminals.iter().map(Some))
                {
                    return Err(Code::State);
                }
                return self.sensors.admit(&Operation::Finish(f.body.clone()), view);
            }
            Operation::BufferRead(_) | Operation::BufferRelease(_) | Operation::Abort(_) => {}
            _ => return Err(Code::Role),
        }
        Ok(demand)
    }
    fn execute(
        &mut self,
        operation: &AppOperation<Self>,
        permit: &mut ExecutionPermit<'_, '_>,
    ) -> Result<ApplicationOutput<CanonicalResult, CanonicalTerminal>, Diagnostic> {
        let result = self.execute_family(operation, permit);
        if result.is_err() {
            let _cleanup = self.family.retire();
        }
        result
    }
    fn split_import<'a>(&'a self, descriptor: &'a Never) -> Result<ImportSource<'a, Never>, Code> {
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

impl<E: FamilyEngine> CanonicalApplication<E> {
    fn execute_family(
        &mut self,
        operation: &AppOperation<Self>,
        permit: &mut ExecutionPermit<'_, '_>,
    ) -> Result<ApplicationOutput<CanonicalResult, CanonicalTerminal>, Diagnostic> {
        let invalid = |_| Diagnostic::InvalidOutput;
        match operation {
            Operation::Prepare(_) => {
                let (plan, digest, identity) = {
                    let mut state = self
                        .family
                        .0
                        .try_borrow_mut()
                        .map_err(|_| Diagnostic::Internal)?;
                    if permit.context().binding() != &state.plan.canonical_binding {
                        return Err(Diagnostic::InvalidOutput);
                    }
                    let identity = state.engine.prepare().map_err(|_| Diagnostic::Backend)?;
                    state.identity = Some(identity.clone());
                    (state.plan.clone(), state.digest.clone(), identity)
                };
                let body = self
                    .sensors
                    .initialize_native(
                        &plan.body,
                        identity,
                        &plan.canonical_binding.run_id,
                        0,
                        None,
                    )
                    .map_err(invalid)?;
                Ok(ApplicationOutput::Result(CanonicalResult::FamilyPrepared {
                    family_plan_digest: digest,
                    body: Box::new(body),
                    endpoint_count: plan.limits.endpoint_count,
                    native_owner_count: 1,
                }))
            }
            Operation::Application(command) => {
                if let Some(advance) = canonical_advance(command) {
                    let output = self
                        .sensors
                        .execute(&Operation::Application(advance), permit)?;
                    let ApplicationOutput::Result(body) = output else {
                        return Err(Diagnostic::InvalidOutput);
                    };
                    let state = self
                        .family
                        .0
                        .try_borrow()
                        .map_err(|_| Diagnostic::Internal)?;
                    return Ok(ApplicationOutput::Result(CanonicalResult::FamilyAdvanced {
                        body: Box::new(converted(&body).map_err(invalid)?),
                        ancestry: None,
                        canonical_final_state: state.canonical_final.clone().map(Box::new),
                    }));
                }
                let mut state = self
                    .family
                    .0
                    .try_borrow_mut()
                    .map_err(|_| Diagnostic::Internal)?;
                let result = match command {
                    CanonicalCommand::Checkpoint {
                        expected_batch_digest,
                        ..
                    } => converted(
                        &state
                            .engine
                            .checkpoint(expected_batch_digest)
                            .map_err(|_| Diagnostic::Backend)?,
                    )
                    .map_err(invalid)?,
                    CanonicalCommand::CommitDecision {
                        checkpoint,
                        forecast_commitment_digest,
                        selected_case_id,
                    } => converted(
                        &state
                            .engine
                            .select(checkpoint, selected_case_id, forecast_commitment_digest)
                            .map_err(|_| Diagnostic::Backend)?,
                    )
                    .map_err(invalid)?,
                    CanonicalCommand::ReserveBranch {
                        checkpoint,
                        case_id,
                        expected_selected_execution_result_digest,
                    } => {
                        let reference = state
                            .engine
                            .reserve(
                                checkpoint,
                                case_id,
                                expected_selected_execution_result_digest,
                                permit.context().request_digest(),
                            )
                            .map_err(|_| Diagnostic::Backend)?;
                        CanonicalResult::BranchReserved {
                            reference: Box::new(reference),
                            family_plan_digest: state.digest.clone(),
                        }
                    }
                    CanonicalCommand::ReleaseCheckpoint {
                        checkpoint,
                        expected_last_branch_terminal_result_digest,
                    } => {
                        state
                            .engine
                            .release_checkpoint(
                                checkpoint,
                                expected_last_branch_terminal_result_digest,
                            )
                            .map_err(|_| Diagnostic::Backend)?;
                        CanonicalResult::CheckpointReleased {
                            reference: checkpoint.clone(),
                            native_release: "confirmed".into(),
                        }
                    }
                    CanonicalCommand::AdvanceTick { .. } => return Err(Diagnostic::Internal),
                };
                Ok(ApplicationOutput::Result(result))
            }
            Operation::Finish(f) => {
                let mut state = self
                    .family
                    .0
                    .try_borrow_mut()
                    .map_err(|_| Diagnostic::Internal)?;
                let final_state = state
                    .engine
                    .finish_canonical(&f.expected_branch_terminals)
                    .map_err(|_| Diagnostic::Backend)?;
                if Some(&final_state) != state.canonical_final.as_ref() {
                    return Err(Diagnostic::InvalidOutput);
                }
                Ok(ApplicationOutput::Terminal(CanonicalTerminal {
                    family_id: state.plan.family_id.clone(),
                    family_plan_digest: state.digest.clone(),
                    last_batch_digest: f.body.last_batch_digest.clone(),
                    branch_terminals: f.expected_branch_terminals.clone(),
                    checkpoint_release: "confirmed".into(),
                    native_family_retirement: "confirmed".into(),
                    bun_process_retirement: "confirmed".into(),
                    sdk_host_process_retirement: "pending".into(),
                    scientific_validation: false,
                    canonical_final_state: final_state,
                    canonical_state_recheck: "confirmed".into(),
                }))
            }
            Operation::Abort(_) => {
                self.family.retire().map_err(|_| Diagnostic::Backend)?;
                Ok(ApplicationOutput::Aborted)
            }
            _ => Err(Diagnostic::Internal),
        }
    }
}

impl<E: FamilyEngine> Application for EvaluationApplication<E> {
    fn admit(
        &self,
        operation: &AppOperation<Self>,
        view: &AdmissionView<'_>,
    ) -> Result<AdmissionDemand, Code> {
        let state = self.family.0.try_borrow().map_err(|_| Code::State)?;
        if state.failed || state.finished || state.active != Some(self.slot) {
            return Err(Code::State);
        }
        let branch = &state.branches[self.slot - 1];
        match operation {
            Operation::Prepare(p) => {
                if branch.reservation.as_ref() != Some(&p.reservation)
                    || branch.restored.is_some()
                    || p.expected_family_plan_digest != state.digest
                {
                    return Err(Code::State);
                }
            }
            Operation::Application(command) => {
                if !branch.restored_committed || branch.evaluation.is_some() {
                    return Err(Code::State);
                }
                if let Some(advance) = evaluation_advance(command) {
                    if !continuation_matches(
                        &advance,
                        state.plan.landmark_tick,
                        &state.plan.branches[self.slot - 1].target,
                    ) {
                        return Err(Code::State);
                    }
                    return self.sensors.admit(&Operation::Application(advance), view);
                }
                empty_buffers(view)?;
                let EvaluationCommand::EvaluatePressureWindow {
                    expected_batch_digest,
                    expected_target_function_digest,
                } = command
                else {
                    return Err(Code::Role);
                };
                let (tick, _, batch) = self.sensors.current().ok_or(Code::State)?;
                if tick != state.plan.body.planned_ticks
                    || batch != Some(expected_batch_digest)
                    || *expected_target_function_digest
                        != state.plan.evaluation.target_function_digest
                {
                    return Err(Code::State);
                }
            }
            Operation::Finish(f) => {
                if branch
                    .evaluation_commit
                    .as_ref()
                    .is_none_or(|stamp| stamp.result_digest != f.evaluation_result_digest)
                {
                    return Err(Code::State);
                }
                return self.sensors.admit(&Operation::Finish(f.body.clone()), view);
            }
            Operation::BufferRead(_) | Operation::BufferRelease(_) | Operation::Abort(_) => {}
            _ => return Err(Code::Role),
        }
        Ok(AdmissionDemand::default())
    }
    fn execute(
        &mut self,
        operation: &AppOperation<Self>,
        permit: &mut ExecutionPermit<'_, '_>,
    ) -> Result<ApplicationOutput<EvaluationResultUnion, EvaluationTerminal>, Diagnostic> {
        let result = self.execute_family(operation, permit);
        if result.is_err() {
            let _cleanup = self.family.retire();
        }
        result
    }
    fn split_import<'a>(&'a self, descriptor: &'a Never) -> Result<ImportSource<'a, Never>, Code> {
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

impl<E: FamilyEngine> EvaluationApplication<E> {
    fn execute_family(
        &mut self,
        operation: &AppOperation<Self>,
        permit: &mut ExecutionPermit<'_, '_>,
    ) -> Result<ApplicationOutput<EvaluationResultUnion, EvaluationTerminal>, Diagnostic> {
        let invalid = |_| Diagnostic::InvalidOutput;
        match operation {
            Operation::Prepare(p) => {
                let (plan, identity, restored, digest) = {
                    let mut state = self
                        .family
                        .0
                        .try_borrow_mut()
                        .map_err(|_| Diagnostic::Internal)?;
                    if permit.context().binding() != &state.plan.branches[self.slot - 1].binding {
                        return Err(Diagnostic::InvalidOutput);
                    }
                    let restored = state
                        .engine
                        .restore(&p.reservation, &p.expected_family_plan_digest)
                        .map_err(|_| Diagnostic::Backend)?;
                    state.branches[self.slot - 1].restored = Some(restored.clone());
                    let mut identity = state.identity.clone().ok_or(Diagnostic::Internal)?;
                    identity.engine_owner_id = restored.ancestry.native_owner_id.clone();
                    (state.plan.clone(), identity, restored, state.digest.clone())
                };
                let prepared = self
                    .sensors
                    .initialize_native(
                        &plan.body,
                        identity,
                        &plan.canonical_binding.run_id,
                        plan.landmark_tick,
                        Some(restored.ancestry.origin_native_batch_sha256.clone()),
                    )
                    .map_err(invalid)?;
                Ok(ApplicationOutput::Result(EvaluationResultUnion::Restored {
                    family_plan_digest: digest,
                    sensor_catalog: Box::new(prepared.sensor_catalog),
                    initial_observation: "inherited_checkpoint".into(),
                    ancestry: Box::new(restored.ancestry),
                    cpu_state_sha256: restored.cpu_state_sha256,
                    render_input_sha256: restored.render_input_sha256,
                    pixels: restored.pixels,
                }))
            }
            Operation::Application(command) => {
                if let Some(advance) = evaluation_advance(command) {
                    let output = self
                        .sensors
                        .execute(&Operation::Application(advance), permit)?;
                    let ApplicationOutput::Result(body) = output else {
                        return Err(Diagnostic::InvalidOutput);
                    };
                    let state = self
                        .family
                        .0
                        .try_borrow()
                        .map_err(|_| Diagnostic::Internal)?;
                    let ancestry = state.branches[self.slot - 1]
                        .restored
                        .as_ref()
                        .ok_or(Diagnostic::Internal)?
                        .ancestry
                        .clone();
                    return Ok(ApplicationOutput::Result(
                        EvaluationResultUnion::FamilyAdvanced {
                            body: Box::new(converted(&body).map_err(invalid)?),
                            ancestry: Some(Box::new(ancestry)),
                            canonical_final_state: None,
                        },
                    ));
                }
                let EvaluationCommand::EvaluatePressureWindow {
                    expected_batch_digest,
                    expected_target_function_digest,
                } = command
                else {
                    return Err(Diagnostic::Internal);
                };
                let mut state = self
                    .family
                    .0
                    .try_borrow_mut()
                    .map_err(|_| Diagnostic::Internal)?;
                let evaluated = state
                    .engine
                    .evaluate(
                        self.slot,
                        expected_batch_digest,
                        expected_target_function_digest,
                    )
                    .map_err(|_| Diagnostic::Backend)?;
                state.branches[self.slot - 1].evaluation = Some(evaluated.clone());
                Ok(ApplicationOutput::Result(
                    converted(&evaluated).map_err(invalid)?,
                ))
            }
            Operation::Finish(f) => {
                let mut state = self
                    .family
                    .0
                    .try_borrow_mut()
                    .map_err(|_| Diagnostic::Internal)?;
                state
                    .engine
                    .finish_branch(self.slot, &f.evaluation_result_digest)
                    .map_err(|_| Diagnostic::Backend)?;
                let branch = &state.branches[self.slot - 1];
                let ancestry = branch
                    .restored
                    .as_ref()
                    .ok_or(Diagnostic::Internal)?
                    .ancestry
                    .clone();
                Ok(ApplicationOutput::Terminal(EvaluationTerminal {
                    family_id: state.plan.family_id.clone(),
                    case_id: state.plan.branches[self.slot - 1].case_id.clone(),
                    ancestry,
                    last_batch_digest: f.body.last_batch_digest.clone(),
                    evaluation_result_digest: f.evaluation_result_digest.clone(),
                    native_owner_retirement: "confirmed".into(),
                    graphics_retirement: "confirmed".into(),
                    shared_family_process_retirement: "pending".into(),
                    promised_sensor_output: "complete".into(),
                    scientific_validation: false,
                }))
            }
            Operation::Abort(_) => {
                self.family.retire().map_err(|_| Diagnostic::Backend)?;
                Ok(ApplicationOutput::Aborted)
            }
            _ => Err(Diagnostic::Internal),
        }
    }
}

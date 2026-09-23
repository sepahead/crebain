//! One public owner, one original arena, and explicit complete-batch draining.

use ncp_local::modular_buffer::{BufferManifest, OutputSpec};
use ncp_local::modular_owner::{
    AdmissionDemand, AdmissionView, AppBody, AppOperation, Application, ApplicationOutput,
    Contract, ExecutionContext, ExecutionPermit, ImportSource,
};
use ncp_local::modular_wire::{
    self as wire, Body, Code, Diagnostic, ModularError, Operation, OperationName,
};
use sha2::{Digest, Sha256};

use crate::admission::{self as a, source_info};
use crate::contract::{self, Commitment};
use crate::engine::{self, EngineBatch, EnginePort, EnginePrepared};
use crate::types::*;

struct Retained {
    batch: Batch,
    exported: Vec<bool>,
}
struct Active {
    prepare: Prepare,
    identity: EnginePrepared,
    prepared: Prepared,
    tick: u64,
    actions: u64,
    accepted: Vec<AppliedRow>,
    previous_native: Option<String>,
    last_released: Option<String>,
    arena: Vec<u8>,
    offsets: Vec<usize>,
    retained: Option<Retained>,
    source_failed: bool,
}

/// Closed installed city application. External errors retire; no source or effect is retried.
pub struct CityApplication<E: EnginePort> {
    engine: E,
    source: String,
    run: String,
    active: Option<Active>,
    failed: bool,
}
impl<E: EnginePort> CityApplication<E> {
    /// Bind one engine to its trusted immutable source and current NCP run.
    pub fn new(engine: E, source: String, run: String) -> Result<Self, ModularError> {
        if !wire::valid_digest(&source) || !contract::valid_uuid(&run) {
            return Err(ModularError::Binding);
        }
        Ok(Self {
            engine,
            source,
            run,
            active: None,
            failed: false,
        })
    }
    fn execute_inner(
        &mut self,
        op: &AppOperation<Self>,
        permit: &mut ExecutionPermit<'_, '_>,
    ) -> Result<ApplicationOutput<CityResult, Terminal>, Diagnostic> {
        match op {
            Operation::Prepare(p) => {
                if permit.context().binding().run_id != self.run {
                    return Err(Diagnostic::InvalidOutput);
                }
                let bounds = a::resources(p).map_err(|_| Diagnostic::Internal)?;
                let bytes = bounds["application_original_bytes"]
                    .as_u64()
                    .ok_or(Diagnostic::Internal)? as usize;
                let mut arena = Vec::new();
                arena
                    .try_reserve_exact(bytes)
                    .map_err(|_| Diagnostic::Backend)?;
                arena.resize(bytes, 0);
                let mut offset = 0;
                let offsets = p
                    .sources
                    .iter()
                    .map(|s| {
                        let start = offset;
                        offset += source_info(s).maximum_bytes;
                        start
                    })
                    .collect();
                let identity = self
                    .engine
                    .prepare(&self.run, &self.source, p)
                    .map_err(|_| Diagnostic::Backend)?;
                let expected_backing = [
                    bytes,
                    16384 + 256 * p.world.entity_ids.len() + 4096 * p.sources.len(),
                    4096 + 32768 * p.world.entity_ids.len(),
                ];
                if identity.backing_bytes != expected_backing
                    || !contract::valid_uuid(&identity.owner_id)
                    || !wire::valid_digest(&identity.native_plan_sha256)
                    || !wire::valid_digest(&identity.scene_sha256)
                {
                    return Err(Diagnostic::InvalidOutput);
                }
                let prepared = Prepared {
                    kind: "prepared".into(),
                    plan_digest: a::plan_digest(p, &self.run, &self.source).map_err(invalid)?,
                    roster_digest: a::roster_digest(p).map_err(invalid)?,
                    scene_sha256: identity.scene_sha256.clone(),
                    source_catalog_digest: a::catalog_digest(p).map_err(invalid)?,
                    resource_plan_digest: p.resource_plan_digest.clone(),
                    source_identity: self.source.clone(),
                    engine_owner_id: identity.owner_id.clone(),
                    native_plan_sha256: identity.native_plan_sha256.clone(),
                };
                self.active = Some(Active {
                    prepare: p.clone(),
                    identity,
                    prepared: prepared.clone(),
                    tick: 0,
                    actions: 0,
                    accepted: Vec::new(),
                    previous_native: None,
                    last_released: None,
                    arena,
                    offsets,
                    retained: None,
                    source_failed: false,
                });
                Ok(ApplicationOutput::Result(CityResult::Prepared(Box::new(
                    prepared,
                ))))
            }
            Operation::Application(CityCommand::Advance(c)) => {
                let active = self.active.as_mut().ok_or(Diagnostic::Internal)?;
                let additions =
                    a::validate_rows(&active.prepare, c, &active.accepted, active.actions)
                        .map_err(invalid)?;
                let native = self
                    .engine
                    .advance(c, active.previous_native.as_deref())
                    .map_err(|_| Diagnostic::Backend)?;
                validate_native(active, c, &native)?;
                for (index, slot) in native.slots.iter().enumerate() {
                    let SourceOutcome::Produced(slot) = slot else {
                        continue;
                    };
                    let source = source_info(&active.prepare.sources[index]);
                    let length = slot.byte_length as usize;
                    let start = active.offsets[index];
                    let mut offset = 0;
                    let mut hash = Sha256::new();
                    while offset < length {
                        let count = (length - offset).min(32768);
                        let bytes = self
                            .engine
                            .read_chunk(
                                &native.native_batch_sha256,
                                &slot.request_id,
                                &slot.original_payload_sha256,
                                offset,
                                count,
                            )
                            .map_err(|_| Diagnostic::Backend)?;
                        if bytes.len() != count || !a::payload_valid(source.semantic, &bytes) {
                            return Err(Diagnostic::InvalidOutput);
                        }
                        let destination = active
                            .arena
                            .get_mut(start + offset..start + offset + count)
                            .ok_or(Diagnostic::InvalidOutput)?;
                        destination.copy_from_slice(&bytes);
                        hash.update(&bytes);
                        offset += count;
                    }
                    if format!("{:x}", hash.finalize()) != slot.original_payload_sha256 {
                        return Err(Diagnostic::InvalidOutput);
                    }
                }
                self.engine
                    .release(&native.native_batch_sha256)
                    .map_err(|_| Diagnostic::Backend)?;
                if native.source_failed {
                    self.engine.retire().map_err(|_| Diagnostic::Backend)?;
                }
                let mut batch = Batch {
                    plan_digest: active.prepared.plan_digest.clone(),
                    roster_digest: active.prepared.roster_digest.clone(),
                    scene_sha256: active.identity.scene_sha256.clone(),
                    source_catalog_digest: active.prepared.source_catalog_digest.clone(),
                    tick: c.tick,
                    previous_batch_digest: active.last_released.clone(),
                    control: native.control,
                    slots: native.slots,
                    batch_digest: String::new(),
                };
                batch.batch_digest =
                    contract::commit(Commitment::Batch, &batch).map_err(invalid)?;
                active.tick = c.tick;
                active.actions += additions;
                active.accepted = batch.control.rows.clone();
                active.previous_native = Some(native.native_batch_sha256);
                active.source_failed = native.source_failed;
                active.retained = Some(Retained {
                    exported: vec![false; batch.slots.len()],
                    batch: batch.clone(),
                });
                let result = if native.source_failed {
                    CityResult::AdvanceFailed(Box::new(AdvanceFailed {
                        kind: "advance_failed".into(),
                        batch,
                        native_retirement: "confirmed".into(),
                        physical_advance_allowed: false,
                        successful_finish_allowed: false,
                    }))
                } else {
                    CityResult::Advanced(Box::new(Advanced {
                        kind: "advanced".into(),
                        batch,
                    }))
                };
                Ok(ApplicationOutput::Result(result))
            }
            Operation::Application(CityCommand::ExportSource(c)) => {
                let active = self.active.as_mut().ok_or(Diagnostic::Internal)?;
                let retained = active.retained.as_mut().ok_or(Diagnostic::Internal)?;
                let (index, source) = produced(&retained.batch, c).ok_or(Diagnostic::Internal)?;
                let start = active.offsets[index];
                let bytes = active
                    .arena
                    .get(start..start + source.byte_length as usize)
                    .ok_or(Diagnostic::Internal)?;
                for (offset, chunk) in bytes.chunks(32768).enumerate() {
                    permit
                        .write_output(0, offset * 32768, chunk)
                        .map_err(|_| Diagnostic::Internal)?;
                }
                let manifest = permit.seal_output(0).map_err(|_| Diagnostic::Internal)?;
                if manifest.payload_sha256 != source.original_payload_sha256 {
                    return Err(Diagnostic::InvalidOutput);
                }
                let mut typed = SourceManifest {
                    schema: "crebain.force-city-source-manifest.v1".into(),
                    request_id: source.request_id.clone(),
                    source_id: source.source_id.clone(),
                    entity_index: source.entity_index,
                    plan_digest: retained.batch.plan_digest.clone(),
                    scene_sha256: retained.batch.scene_sha256.clone(),
                    source_catalog_digest: retained.batch.source_catalog_digest.clone(),
                    source_config_digest: source.source_config_digest.clone(),
                    batch_digest: retained.batch.batch_digest.clone(),
                    source_body_tick: source.source_body_tick,
                    available_after_body_tick: source.available_after_body_tick,
                    source_production_digest: source.source_production_digest.clone(),
                    original_payload_sha256: source.original_payload_sha256.clone(),
                    byte_manifest_digest: manifest.manifest_digest.clone(),
                    tensor: source.tensor.clone(),
                    manifest_digest: String::new(),
                };
                typed.manifest_digest =
                    contract::commit(Commitment::Manifest, &typed).map_err(invalid)?;
                retained.exported[index] = true;
                Ok(ApplicationOutput::Result(CityResult::Exported(Box::new(
                    Exported {
                        kind: "source_exported".into(),
                        typed_manifest: typed,
                        byte_manifest: manifest,
                    },
                ))))
            }
            Operation::Application(CityCommand::ReleaseBatch(c)) => {
                let active = self.active.as_mut().ok_or(Diagnostic::Internal)?;
                active.retained = None;
                active.arena.fill(0);
                active.last_released = Some(c.batch_digest.clone());
                Ok(ApplicationOutput::Result(CityResult::BatchReleased(
                    Box::new(BatchReleased {
                        kind: "batch_released".into(),
                        plan_digest: c.plan_digest.clone(),
                        batch_digest: c.batch_digest.clone(),
                        tick: c.tick,
                    }),
                )))
            }
            Operation::Finish(f) => {
                self.engine.retire().map_err(|_| Diagnostic::Backend)?;
                Ok(ApplicationOutput::Terminal(Terminal {
                    plan_digest: f.plan_digest.clone(),
                    completed_ticks: f.completed_ticks,
                    last_released_batch_digest: f.last_released_batch_digest.clone(),
                    native_retirement: "confirmed".into(),
                    promised_source_output: "complete".into(),
                    scientific_validation: false,
                }))
            }
            Operation::Abort(_) => {
                self.engine.retire().map_err(|_| Diagnostic::Backend)?;
                Ok(ApplicationOutput::Aborted)
            }
            _ => Err(Diagnostic::Internal),
        }
    }
}
fn invalid(_: ModularError) -> Diagnostic {
    Diagnostic::InvalidOutput
}

fn produced<'a>(batch: &'a Batch, c: &ExportSource) -> Option<(usize, &'a Produced)> {
    if batch.plan_digest != c.plan_digest
        || batch.batch_digest != c.batch_digest
        || batch.tick != c.source_body_tick
    {
        return None;
    }
    batch
        .slots
        .iter()
        .enumerate()
        .find_map(|(index, slot)| match slot {
            SourceOutcome::Produced(p)
                if p.request_id == c.request_id
                    && p.source_id == c.source_id
                    && p.entity_index == c.entity_index
                    && p.source_production_digest == c.source_production_digest
                    && p.original_payload_sha256 == c.original_payload_sha256 =>
            {
                Some((index, p.as_ref()))
            }
            _ => None,
        })
}
fn validate_native(active: &Active, c: &Advance, n: &EngineBatch) -> Result<(), Diagnostic> {
    if n.owner_id != active.identity.owner_id
        || n.native_plan_sha256 != active.identity.native_plan_sha256
        || n.scene_sha256 != active.identity.scene_sha256
        || n.tick != c.tick
        || n.previous_native_batch_sha256 != active.previous_native
        || !wire::valid_digest(&n.native_batch_sha256)
        || n.slots.len() != active.prepare.sources.len()
    {
        return Err(Diagnostic::InvalidOutput);
    }
    contract::validate("ControlReceipt", &n.control).map_err(invalid)?;
    if n.control.tick != c.tick || n.control.rows.len() != c.rows.len() {
        return Err(Diagnostic::InvalidOutput);
    }
    for (index, (actual, requested)) in n.control.rows.iter().zip(&c.rows).enumerate() {
        if actual.0 != index as u64 {
            return Err(Diagnostic::InvalidOutput);
        }
        match requested {
            ControlRow::SetRow((_, _, armed, _)) if actual.2 == "set" && actual.3 == *armed => {}
            ControlRow::HoldRow((_, _, digest))
                if actual.2 == "hold"
                    && actual.1 == *digest
                    && active
                        .accepted
                        .get(index)
                        .is_some_and(|old| old.3 == actual.3) => {}
            _ => return Err(Diagnostic::InvalidOutput),
        }
    }
    let mut failure: Option<&str> = None;
    for kind in ["pressure", "rgb", "thermal"] {
        for (source, slot) in active.prepare.sources.iter().zip(&n.slots) {
            let s = source_info(source);
            if s.kind != kind {
                continue;
            }
            contract::validate("SourceOutcome", slot).map_err(invalid)?;
            let (request, id, entity) = match slot {
                SourceOutcome::Produced(x) => (&x.request_id, &x.source_id, x.entity_index),
                SourceOutcome::NotDue(x) => (&x.request_id, &x.source_id, x.entity_index),
                SourceOutcome::Failed(x) => (&x.request_id, &x.source_id, x.entity_index),
                SourceOutcome::Absent(x) => (&x.request_id, &x.source_id, x.entity_index),
            };
            if request != s.request || id != s.source || entity != s.entity as u64 {
                return Err(Diagnostic::InvalidOutput);
            }
            if !c.tick.is_multiple_of(s.period) {
                let next = c.tick + s.period - c.tick % s.period;
                let next = (next <= active.prepare.world.horizon_ticks).then_some(next);
                if !matches!(slot,SourceOutcome::NotDue(x) if x.next_due_tick==next) {
                    return Err(Diagnostic::InvalidOutput);
                }
            } else if let Some(cause) = failure {
                if !matches!(slot,SourceOutcome::Absent(x) if x.due_at_tick==c.tick&&x.causal_failed_request_id==cause)
                {
                    return Err(Diagnostic::InvalidOutput);
                }
            } else {
                match slot {
                    SourceOutcome::Produced(x)
                        if x.source_body_tick == c.tick
                            && x.available_after_body_tick == c.tick
                            && x.byte_length == a::expected_bytes(source, c.tick) as u64
                            && x.tensor == a::expected_tensor(source, c.tick) => {}
                    SourceOutcome::Failed(x)
                        if s.kind != "pressure" && x.attempted_at_tick == c.tick =>
                    {
                        failure = Some(&x.request_id)
                    }
                    _ => return Err(Diagnostic::InvalidOutput),
                }
            }
        }
    }
    if n.source_failed != failure.is_some() {
        return Err(Diagnostic::InvalidOutput);
    }
    Ok(())
}

impl<E: EnginePort> Contract for CityApplication<E> {
    type Prepare = Prepare;
    type Command = CityCommand;
    type ImportDescriptor = Never;
    type ImportMetadata = Never;
    type Finish = Finish;
    type Result = CityResult;
    type Imported = Never;
    type Terminal = Terminal;
    fn descriptor() -> &'static [u8] {
        contract::DESCRIPTOR
    }
    fn allows(op: OperationName) -> bool {
        matches!(
            op,
            OperationName::Prepare
                | OperationName::Application
                | OperationName::BufferRead
                | OperationName::BufferRelease
                | OperationName::Finish
                | OperationName::Abort
        )
    }
    fn check_input(op: &AppOperation<Self>) -> Result<(), ModularError> {
        match op {
            Operation::Prepare(p) => a::validate_prepare(p),
            Operation::Application(c) => contract::validate("Command", c),
            Operation::Finish(f) => contract::validate("Finish", f),
            _ => Ok(()),
        }
    }
    fn check_response(
        op: &AppOperation<Self>,
        body: &AppBody<Self>,
        ctx: &ExecutionContext,
    ) -> Result<(), ModularError> {
        match body {
            Body::Prepared { data } | Body::Application { data } => {
                contract::validate("Result", data)?;
                a::encoded_bound(data, a::RESULT_BYTES)?;
            }
            Body::Finished { data } => contract::validate("Terminal", data)?,
            _ => return Ok(()),
        }
        let valid = match (op, body) {
            (
                Operation::Prepare(p),
                Body::Prepared {
                    data: CityResult::Prepared(r),
                },
            ) => {
                r.plan_digest == a::plan_digest(p, &ctx.binding().run_id, &r.source_identity)?
                    && r.roster_digest == a::roster_digest(p)?
                    && r.source_catalog_digest == a::catalog_digest(p)?
                    && r.resource_plan_digest == p.resource_plan_digest
            }
            (
                Operation::Application(CityCommand::Advance(c)),
                Body::Application {
                    data: CityResult::Advanced(r),
                },
            ) => check_public_batch(c, &r.batch, false)?,
            (
                Operation::Application(CityCommand::Advance(c)),
                Body::Application {
                    data: CityResult::AdvanceFailed(r),
                },
            ) => check_public_batch(c, &r.batch, true)?,
            (
                Operation::Application(CityCommand::ExportSource(c)),
                Body::Application {
                    data: CityResult::Exported(r),
                },
            ) => {
                let t = &r.typed_manifest;
                let b = &r.byte_manifest;
                b.verify(ctx.binding()).map_err(|_| ModularError::Wire)?;
                let (kind, length) = match &t.tensor {
                    Tensor::RgbaTensor(x) => ("rgba8", x.shape[0] * x.shape[1] * 4),
                    Tensor::RadianceTensor(x) => ("radiance", x.shape[0] * x.shape[1] * 4),
                    Tensor::PressureTensor(x) => ("pressure", x.shape[0] * 8),
                };
                t.request_id == c.request_id
                    && t.source_id == c.source_id
                    && t.entity_index == c.entity_index
                    && t.plan_digest == c.plan_digest
                    && t.batch_digest == c.batch_digest
                    && t.source_body_tick == c.source_body_tick
                    && t.available_after_body_tick == c.source_body_tick
                    && t.source_production_digest == c.source_production_digest
                    && t.original_payload_sha256 == c.original_payload_sha256
                    && t.original_payload_sha256 == b.payload_sha256
                    && t.byte_manifest_digest == b.manifest_digest
                    && t.manifest_digest == contract::commit(Commitment::Manifest, t)?
                    && b.semantic_digest == contract::semantic(kind)?
                    && b.byte_length as u64 == length
                    && b.creating_request_digest == ctx.request_digest()
                    && b.causal_predecessor.as_deref() == ctx.predecessor()
                    && b.imported_manifest_digest.is_none()
            }
            (
                Operation::Application(CityCommand::ReleaseBatch(c)),
                Body::Application {
                    data: CityResult::BatchReleased(r),
                },
            ) => {
                r.plan_digest == c.plan_digest
                    && r.batch_digest == c.batch_digest
                    && r.tick == c.tick
            }
            (Operation::Finish(f), Body::Finished { data: r }) => {
                r.plan_digest == f.plan_digest
                    && r.completed_ticks == f.completed_ticks
                    && r.last_released_batch_digest == f.last_released_batch_digest
            }
            _ => false,
        };
        if valid {
            Ok(())
        } else {
            Err(ModularError::Wire)
        }
    }
    fn check_import_metadata(d: &Never, _: &Never) -> Result<(), ModularError> {
        match *d {}
    }
}
fn check_public_batch(c: &Advance, b: &Batch, failed: bool) -> Result<bool, ModularError> {
    Ok(b.plan_digest == c.plan_digest
        && b.roster_digest == c.roster_digest
        && b.tick == c.tick
        && b.control.tick == c.tick
        && b.previous_batch_digest == c.previous_batch_digest
        && b.control.rows.len() == c.rows.len()
        && b.control
            .rows
            .iter()
            .enumerate()
            .all(|(i, row)| row.0 == i as u64)
        && b.batch_digest == contract::commit(Commitment::Batch, b)?
        && failed
            == b.slots
                .iter()
                .any(|s| matches!(s, SourceOutcome::Failed(_)))
        && (failed
            || b.slots
                .iter()
                .all(|s| matches!(s, SourceOutcome::Produced(_) | SourceOutcome::NotDue(_)))))
}
impl<E: EnginePort> Application for CityApplication<E> {
    fn admit(
        &self,
        op: &AppOperation<Self>,
        view: &AdmissionView<'_>,
    ) -> Result<AdmissionDemand, Code> {
        if self.failed {
            return Err(Code::State);
        }
        let mut demand = AdmissionDemand::default();
        let empty = view.buffers.live_slots == 0
            && view.buffers.incomplete_slots == 0
            && view.buffers.reserved_bytes == 0;
        match op {
            Operation::Prepare(p) => {
                if self.active.is_some() {
                    return Err(Code::State);
                }
                engine::preflight(
                    &engine::prepare_command(&self.run, &self.source, p)
                        .map_err(|_| Code::Capacity)?,
                )
                .map_err(|_| Code::Capacity)?;
            }
            Operation::Application(CityCommand::Advance(c)) => {
                let x = self.active.as_ref().ok_or(Code::State)?;
                if x.source_failed || x.retained.is_some() || !empty {
                    return Err(Code::State);
                }
                if c.tick != x.tick + 1
                    || c.tick > x.prepare.world.horizon_ticks
                    || c.plan_digest != x.prepared.plan_digest
                    || c.roster_digest != x.prepared.roster_digest
                    || c.previous_batch_digest != x.last_released
                {
                    return Err(Code::InvalidInput);
                }
                a::validate_rows(&x.prepare, c, &x.accepted, x.actions)
                    .map_err(|_| Code::InvalidInput)?;
                engine::preflight(
                    &engine::advance_command(c, x.previous_native.as_deref())
                        .map_err(|_| Code::Capacity)?,
                )
                .map_err(|_| Code::Capacity)?;
            }
            Operation::Application(CityCommand::ExportSource(c)) => {
                let x = self.active.as_ref().ok_or(Code::State)?;
                let r = x.retained.as_ref().ok_or(Code::State)?;
                let (i, s) = produced(&r.batch, c).ok_or(Code::InvalidInput)?;
                if r.exported[i] {
                    return Err(Code::State);
                }
                demand.outputs.push(OutputSpec {
                    semantic_digest: contract::semantic(
                        source_info(&x.prepare.sources[i]).semantic,
                    )
                    .map_err(|_| Code::InvalidInput)?,
                    byte_length: s.byte_length as usize,
                });
            }
            Operation::Application(CityCommand::ReleaseBatch(c)) => {
                let x = self.active.as_ref().ok_or(Code::State)?;
                let r = x.retained.as_ref().ok_or(Code::State)?;
                if !empty
                    || c.plan_digest != r.batch.plan_digest
                    || c.batch_digest != r.batch.batch_digest
                    || c.tick != r.batch.tick
                    || r.batch
                        .slots
                        .iter()
                        .enumerate()
                        .any(|(i, s)| matches!(s, SourceOutcome::Produced(_)) && !r.exported[i])
                {
                    return Err(Code::State);
                }
            }
            Operation::Finish(f) => {
                let x = self.active.as_ref().ok_or(Code::State)?;
                if !empty
                    || x.source_failed
                    || x.retained.is_some()
                    || x.tick != x.prepare.world.horizon_ticks
                    || f.plan_digest != x.prepared.plan_digest
                    || f.completed_ticks != x.tick
                    || Some(&f.last_released_batch_digest) != x.last_released.as_ref()
                {
                    return Err(Code::State);
                }
            }
            Operation::BufferRead(_) | Operation::BufferRelease(_) | Operation::Abort(_) => {}
            _ => return Err(Code::Role),
        }
        Ok(demand)
    }
    fn execute(
        &mut self,
        op: &AppOperation<Self>,
        permit: &mut ExecutionPermit<'_, '_>,
    ) -> Result<ApplicationOutput<CityResult, Terminal>, Diagnostic> {
        let result = self.execute_inner(op, permit);
        if result.is_err() {
            self.failed = true;
            if self.engine.retire().is_err() {
                eprintln!("City operation failed; separate native retirement remains unresolved");
            }
        }
        result
    }
    fn split_import<'a>(&'a self, d: &'a Never) -> Result<ImportSource<'a, Never>, Code> {
        match *d {}
    }
    fn validate_import(&self, m: &Never, _: &BufferManifest, _: &[u8]) -> Result<Never, Code> {
        match *m {}
    }
}

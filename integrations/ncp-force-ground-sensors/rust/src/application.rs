//! Pure admission followed by one retained native observation copied into reserved tickets.

use ncp_local::modular_buffer::{BufferManifest, OutputSpec};
use ncp_local::modular_owner::{
    AdmissionDemand, AdmissionView, AppBody, AppOperation, Application, ApplicationOutput,
    Contract, ExecutionContext, ExecutionPermit, ImportSource,
};
use ncp_local::modular_wire::{
    self as wire, Body, Code, Diagnostic, ModularError, Operation, OperationName,
};
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeSet;

use crate::contract::{self, Commitment};
use crate::engine::{EnginePort, EnginePrepared};
use crate::types::*;

/// One statically installed application and its project-owned engine port.
pub struct SensorApplication<E: EnginePort> {
    engine: E,
    source_identity: String,
    active: Option<Active>,
    failed: bool,
}

struct Active {
    prepare: Prepare,
    plan_digest: String,
    catalog: SensorCatalog,
    identity: EnginePrepared,
    tick: u64,
    batch_digest: Option<String>,
    engine_batch: Option<String>,
    accepted_action: Option<String>,
}

/// A due tensor and its exact integer storage extent.
#[derive(Clone, Debug)]
pub struct Due {
    /// Catalog identifier.
    pub sensor_id: String,
    /// Installed modality tag.
    pub kind: &'static str,
    /// Exact little-endian byte count.
    pub bytes: usize,
    /// Closed tensor descriptor.
    pub tensor: Tensor,
}

fn checked_bytes(values: &[u64]) -> Result<usize, ModularError> {
    let total = values
        .iter()
        .try_fold(1_u64, |a, b| a.checked_mul(*b))
        .ok_or(ModularError::Wire)?;
    let bytes = usize::try_from(total).map_err(|_| ModularError::Wire)?;
    if bytes == 0 || bytes > 8 * 1024 * 1024 {
        Err(ModularError::Wire)
    } else {
        Ok(bytes)
    }
}

/// Compute the due roster without touching engine state.
pub fn due(prepare: &Prepare, tick: u64) -> Result<Vec<Due>, ModularError> {
    let scene = &prepare.specification.scene;
    if tick == 0
        || tick > prepare.planned_ticks
        || prepare.planned_ticks > 7200
        || scene.rgb_cameras.len() > 4
        || scene.thermal_cameras.len() > 4
        || scene.microphones.len() > 4
        || scene
            .rgb_cameras
            .iter()
            .chain(&scene.thermal_cameras)
            .any(|camera| !(1..=120).contains(&camera.period_ticks))
    {
        return Err(ModularError::Wire);
    }
    let mut result = Vec::with_capacity(12);
    for camera in &prepare.specification.scene.rgb_cameras {
        if tick.is_multiple_of(camera.period_ticks) {
            result.push(Due {
                sensor_id: format!("rgb:{}", camera.id),
                kind: "rgba8",
                bytes: checked_bytes(&[camera.height, camera.width, 4])?,
                tensor: Tensor::Rgba8 {
                    dtype: "u8".into(),
                    shape: [camera.height, camera.width, 4],
                    layout: "c_contiguous".into(),
                    row_origin: "bottom-left".into(),
                    encoding: "rgba8-srgb".into(),
                },
            });
        }
    }
    for camera in &prepare.specification.scene.thermal_cameras {
        if tick.is_multiple_of(camera.period_ticks) {
            result.push(Due {
                sensor_id: format!("thermal:{}", camera.id),
                kind: "radiance",
                bytes: checked_bytes(&[camera.height, camera.width, 4])?,
                tensor: Tensor::Radiance {
                    dtype: "f32le".into(),
                    shape: [camera.height, camera.width],
                    layout: "c_contiguous".into(),
                    row_origin: "bottom-left".into(),
                    unit: "W/(m2 sr)".into(),
                },
            });
        }
    }
    let start = (tick - 1).checked_mul(16_000).ok_or(ModularError::Wire)? / 120;
    let end = tick.checked_mul(16_000).ok_or(ModularError::Wire)? / 120;
    for microphone in &prepare.specification.scene.microphones {
        result.push(Due {
            sensor_id: format!("pressure:{}", microphone.id),
            kind: "pressure",
            bytes: checked_bytes(&[end - start, 8])?,
            tensor: Tensor::Pressure {
                dtype: "f64le".into(),
                shape: [end - start],
                layout: "c_contiguous".into(),
                sample_start: start,
                sample_end: end,
                sample_rate_hz: 16_000,
                unit: "pascal".into(),
            },
        });
    }
    Ok(result)
}

fn sorted<'a>(ids: impl Iterator<Item = &'a str>) -> bool {
    let mut previous = None;
    for id in ids {
        if previous.is_some_and(|p| p >= id) {
            return false;
        }
        previous = Some(id);
    }
    true
}

/// Apply source-owned semantic bounds beyond the closed JSON shape.
pub fn validate_prepare(prepare: &Prepare) -> Result<(), ModularError> {
    contract::validate("Prepare", prepare)?;
    let spec = &prepare.specification;
    let scene = &spec.scene;
    let cameras = scene.rgb_cameras.iter().chain(&scene.thermal_cameras);
    if prepare.composition_digest != contract::composition_digest()?
        || !sorted(scene.materials.iter().map(|v| v.id.as_str()))
        || !sorted(scene.rgb_cameras.iter().map(|v| v.id.as_str()))
        || !sorted(scene.thermal_cameras.iter().map(|v| v.id.as_str()))
        || !sorted(scene.microphones.iter().map(|v| v.id.as_str()))
        || cameras.into_iter().any(|camera| {
            camera
                .position
                .iter()
                .zip(camera.target)
                .all(|(a, b)| a.get() == b.get())
        })
        || scene
            .thermal_cameras
            .iter()
            .any(|c| c.width > 320 || c.height > 320)
        || spec.acoustic.reference_distance_m.get() > spec.acoustic.maximum_range_m.get()
    {
        return Err(ModularError::Wire);
    }
    Ok(())
}

fn action_ok(prepare: &Prepare, action: &Action, last: Option<&str>) -> bool {
    match action {
        Action::Hold {
            accepted_action_request_digest,
        } => last == Some(accepted_action_request_digest),
        Action::SetTarget {
            heading_rad,
            altitude_m,
            ..
        } => {
            let delta =
                heading_rad.get() - prepare.specification.controller.reference_heading_rad.get();
            delta.sin().atan2(delta.cos()).abs() <= 0.2
                && (altitude_m.get() - prepare.specification.controller.reference_altitude_m.get())
                    .abs()
                    <= 0.5
        }
    }
}

fn plan_digest(prepare: &Prepare, run_id: &str, source: &str) -> Result<String, ModularError> {
    contract::commit(
        Commitment::Plan,
        &json!({
            "specification":prepare.specification,"planned_ticks":prepare.planned_ticks,
            "composition_digest":prepare.composition_digest,"engine_run_id":format!("ncp-{run_id}"),"source_identity":source
        }),
    )
}

fn encoded_bound<T: Serialize>(value: &T, maximum: usize) -> Result<(), ModularError> {
    if serde_json::to_vec(value)
        .map_err(|_| ModularError::Wire)?
        .len()
        > maximum
    {
        Err(ModularError::Capacity)
    } else {
        Ok(())
    }
}

fn tensor_bytes(tensor: &Tensor, tick: u64) -> Result<usize, ModularError> {
    match tensor {
        Tensor::Rgba8 { shape, .. } => checked_bytes(shape),
        Tensor::Radiance { shape, .. } => checked_bytes(&[shape[0], shape[1], 4]),
        Tensor::Pressure {
            shape,
            sample_start,
            sample_end,
            ..
        } => {
            if *sample_start != (tick - 1) * 16_000 / 120
                || *sample_end != tick * 16_000 / 120
                || shape[0] != sample_end - sample_start
            {
                return Err(ModularError::Wire);
            }
            checked_bytes(&[shape[0], 8])
        }
    }
}

fn catalog(prepare: &Prepare, plan: &str) -> Result<SensorCatalog, ModularError> {
    let mut entries = Vec::with_capacity(12);
    for c in &prepare.specification.scene.rgb_cameras {
        entries.push(CatalogEntry::Rgba8 {
            sensor_id: format!("rgb:{}", c.id),
            source_id: c.id.clone(),
            sensor_contract_digest: contract::semantic("rgba8")?,
            configuration: c.clone(),
        });
    }
    for c in &prepare.specification.scene.thermal_cameras {
        entries.push(CatalogEntry::Radiance {
            sensor_id: format!("thermal:{}", c.id),
            source_id: c.id.clone(),
            sensor_contract_digest: contract::semantic("radiance")?,
            configuration: c.clone(),
        });
    }
    for c in &prepare.specification.scene.microphones {
        entries.push(CatalogEntry::Pressure {
            sensor_id: format!("pressure:{}", c.id),
            source_id: c.id.clone(),
            sensor_contract_digest: contract::semantic("pressure")?,
            configuration: PressureConfiguration {
                position: c.position,
                acoustic: prepare.specification.acoustic.clone(),
            },
        });
    }
    let mut catalog = SensorCatalog {
        schema: "crebain.sensor-catalog.v1".into(),
        plan_digest: plan.into(),
        entries,
        catalog_digest: String::new(),
    };
    catalog.catalog_digest = contract::commit(Commitment::Catalog, &catalog)?;
    Ok(catalog)
}

fn entry_id(entry: &CatalogEntry) -> &str {
    match entry {
        CatalogEntry::Rgba8 { sensor_id, .. }
        | CatalogEntry::Radiance { sensor_id, .. }
        | CatalogEntry::Pressure { sensor_id, .. } => sensor_id,
    }
}
fn next_due(entry: &CatalogEntry, tick: u64, horizon: u64) -> Option<u64> {
    let period = match entry {
        CatalogEntry::Rgba8 { configuration, .. }
        | CatalogEntry::Radiance { configuration, .. } => configuration.period_ticks,
        CatalogEntry::Pressure { .. } => 1,
    };
    let next = (tick / period + 1) * period;
    (next <= horizon).then_some(next)
}

impl<E: EnginePort> SensorApplication<E> {
    /// Construct from trusted host source identity and an already selected engine port.
    pub fn new(engine: E, source_identity: String) -> Result<Self, ModularError> {
        if !wire::valid_digest(&source_identity) {
            return Err(ModularError::Binding);
        }
        Ok(Self {
            engine,
            source_identity,
            active: None,
            failed: false,
        })
    }

    /// Retire the project owner after channel termination, including unknown suffixes.
    pub fn retire(&mut self) -> Result<(), Diagnostic> {
        self.failed = true;
        self.engine.retire().map_err(|_| Diagnostic::Backend)
    }

    fn execute_inner(
        &mut self,
        op: &AppOperation<Self>,
        permit: &mut ExecutionPermit<'_, '_>,
    ) -> Result<ApplicationOutput<SensorResult, Terminal>, Diagnostic> {
        let invalid = |_| Diagnostic::InvalidOutput;
        match op {
            Operation::Prepare(prepare) => {
                let context = permit.context();
                let identity = self
                    .engine
                    .prepare(&context.binding().run_id, &self.source_identity, prepare)
                    .map_err(|_| Diagnostic::Backend)?;
                let plan = plan_digest(prepare, &context.binding().run_id, &self.source_identity)
                    .map_err(invalid)?;
                let catalog = catalog(prepare, &plan).map_err(invalid)?;
                let output = SensorResult::Prepared {
                    plan_digest: plan.clone(),
                    sensor_catalog: catalog.clone(),
                    initial_observation: "not_acquired".into(),
                    source_identity: self.source_identity.clone(),
                    engine_owner_id: identity.engine_owner_id.clone(),
                    scene_sha256: identity.scene_sha256.clone(),
                };
                self.active = Some(Active {
                    prepare: prepare.clone(),
                    plan_digest: plan,
                    catalog,
                    identity,
                    tick: 0,
                    batch_digest: None,
                    engine_batch: None,
                    accepted_action: None,
                });
                Ok(ApplicationOutput::Result(output))
            }
            Operation::Application(command) => {
                let active = self.active.as_mut().ok_or(Diagnostic::Internal)?;
                let roster = due(&active.prepare, command.tick).map_err(invalid)?;
                let accepted = match &command.action {
                    Action::SetTarget { .. } => permit.context().request_digest().to_owned(),
                    Action::Hold {
                        accepted_action_request_digest,
                    } => accepted_action_request_digest.clone(),
                };
                let native = self
                    .engine
                    .advance(command, active.engine_batch.as_deref(), &accepted)
                    .map_err(|_| Diagnostic::Backend)?;
                if native.engine_owner_id != active.identity.engine_owner_id
                    || native.scene_sha256 != active.identity.scene_sha256
                    || native.source_identity != self.source_identity
                    || native.body_tick != command.tick
                    || native.previous_engine_batch_sha256 != active.engine_batch
                    || !wire::valid_digest(&native.engine_batch_sha256)
                    || native.payloads.len() != roster.len()
                {
                    return Err(Diagnostic::InvalidOutput);
                }
                let mut slots = Vec::with_capacity(active.catalog.entries.len());
                let mut output_slot = 0;
                for entry in &active.catalog.entries {
                    let id = entry_id(entry);
                    let Some(expected) = roster.get(output_slot).filter(|row| row.sensor_id == id)
                    else {
                        slots.push(SensorSlot::NotDue {
                            sensor_id: id.into(),
                            next_due_tick: next_due(
                                entry,
                                command.tick,
                                active.prepare.planned_ticks,
                            ),
                        });
                        continue;
                    };
                    let payload = &native.payloads[output_slot];
                    if payload.sensor_id != expected.sensor_id
                        || payload.kind != expected.kind
                        || payload.byte_length != expected.bytes as u64
                    {
                        return Err(Diagnostic::InvalidOutput);
                    }
                    let mut offset = 0;
                    while offset < expected.bytes {
                        let count = (expected.bytes - offset).min(32_768);
                        let bytes = self
                            .engine
                            .read_chunk(
                                command.tick,
                                &native.engine_batch_sha256,
                                id,
                                offset,
                                count,
                            )
                            .map_err(|_| Diagnostic::Backend)?;
                        if bytes.len() != count || !payload_valid(expected.kind, &bytes) {
                            return Err(Diagnostic::InvalidOutput);
                        }
                        permit
                            .write_output(output_slot, offset, &bytes)
                            .map_err(|_| Diagnostic::Internal)?;
                        offset += bytes.len();
                    }
                    let byte_manifest = permit
                        .seal_output(output_slot)
                        .map_err(|_| Diagnostic::Internal)?;
                    if byte_manifest.payload_sha256 != payload.payload_sha256 {
                        return Err(Diagnostic::InvalidOutput);
                    }
                    let mut typed_manifest = SensorManifest {
                        schema: "crebain.sensor-manifest.v1".into(),
                        sensor_contract_digest: contract::semantic(expected.kind)
                            .map_err(invalid)?,
                        sensor_id: id.into(),
                        byte_manifest_digest: byte_manifest.manifest_digest.clone(),
                        engine_batch_sha256: native.engine_batch_sha256.clone(),
                        source_body_tick: command.tick,
                        available_after_body_tick: command.tick,
                        tensor: expected.tensor.clone(),
                        manifest_digest: String::new(),
                    };
                    typed_manifest.manifest_digest =
                        contract::commit(Commitment::Manifest, &typed_manifest).map_err(invalid)?;
                    slots.push(SensorSlot::Due {
                        sensor_id: id.into(),
                        typed_manifest: Box::new(typed_manifest),
                        byte_manifest: Box::new(byte_manifest),
                    });
                    output_slot += 1;
                }
                if output_slot != roster.len() {
                    return Err(Diagnostic::InvalidOutput);
                }
                let mut batch = SensorBatch {
                    schema: "crebain.sensor-batch.v1".into(),
                    plan_digest: active.plan_digest.clone(),
                    engine_owner_id: native.engine_owner_id,
                    engine_batch_sha256: native.engine_batch_sha256,
                    source_identity: native.source_identity,
                    scene_sha256: native.scene_sha256,
                    body_tick: command.tick,
                    previous_batch_digest: active.batch_digest.clone(),
                    slots,
                    batch_digest: String::new(),
                };
                batch.batch_digest =
                    contract::commit(Commitment::Batch, &batch).map_err(invalid)?;
                self.engine
                    .release_lease(command.tick, &batch.engine_batch_sha256)
                    .map_err(|_| Diagnostic::Backend)?;
                active.tick = command.tick;
                active.batch_digest = Some(batch.batch_digest.clone());
                active.engine_batch = Some(batch.engine_batch_sha256.clone());
                active.accepted_action = Some(accepted.clone());
                Ok(ApplicationOutput::Result(SensorResult::Advanced {
                    tick: command.tick,
                    accepted_action_request_digest: accepted,
                    batch,
                }))
            }
            Operation::Finish(finish) => {
                self.engine.retire().map_err(|_| Diagnostic::Backend)?;
                let active = self.active.as_ref().ok_or(Diagnostic::Internal)?;
                Ok(ApplicationOutput::Terminal(Terminal {
                    plan_digest: finish.plan_digest.clone(),
                    planned_ticks: active.prepare.planned_ticks,
                    completed_ticks: active.tick,
                    last_batch_digest: finish.last_batch_digest.clone(),
                    engine_retirement: "confirmed".into(),
                    promised_sensor_output: "complete".into(),
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

/// Validate complete aligned sensor chunks without interpreting privileged engine outcomes.
pub fn payload_valid(kind: &str, bytes: &[u8]) -> bool {
    match kind {
        "rgba8" => true,
        "radiance" => {
            bytes.len().is_multiple_of(4)
                && bytes.chunks_exact(4).all(|b| {
                    let n = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                    n.is_finite() && (0.0..=10_000.0).contains(&n)
                })
        }
        "pressure" => {
            bytes.len().is_multiple_of(8)
                && bytes.chunks_exact(8).all(|b| {
                    f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]).is_finite()
                })
        }
        _ => false,
    }
}

impl<E: EnginePort> Contract for SensorApplication<E> {
    type Prepare = Prepare;
    type Command = AdvanceTick;
    type ImportDescriptor = Never;
    type ImportMetadata = Never;
    type Finish = Finish;
    type Result = SensorResult;
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
            Operation::Prepare(p) => validate_prepare(p),
            Operation::Application(c) => contract::validate("Command", c),
            Operation::Finish(f) => contract::validate("Finish", f),
            _ => Ok(()),
        }
    }
    fn check_response(
        op: &AppOperation<Self>,
        body: &AppBody<Self>,
        context: &ExecutionContext,
    ) -> Result<(), ModularError> {
        match (op, body) {
            (
                Operation::Prepare(p),
                Body::Prepared {
                    data:
                        SensorResult::Prepared {
                            plan_digest: plan,
                            sensor_catalog,
                            source_identity,
                            ..
                        },
                },
            ) => {
                if let Body::Prepared { data } = body {
                    contract::validate("Result", data)?;
                    encoded_bound(data, 32_768)?;
                }
                encoded_bound(sensor_catalog, 16_384)?;
                let expected = plan_digest(p, &context.binding().run_id, source_identity)?;
                if *plan != expected || *sensor_catalog != catalog(p, &expected)? {
                    return Err(ModularError::Wire);
                }
            }
            (
                Operation::Application(c),
                Body::Application {
                    data:
                        SensorResult::Advanced {
                            tick,
                            accepted_action_request_digest,
                            batch,
                        },
                },
            ) => {
                if let Body::Application { data } = body {
                    contract::validate("Result", data)?;
                    encoded_bound(data, 32_768)?;
                }
                let expected = match &c.action {
                    Action::SetTarget { .. } => context.request_digest(),
                    Action::Hold {
                        accepted_action_request_digest,
                    } => accepted_action_request_digest,
                };
                if *tick != c.tick
                    || batch.body_tick != c.tick
                    || batch.previous_batch_digest != c.previous_batch_digest
                    || accepted_action_request_digest != expected
                    || batch.batch_digest != contract::commit(Commitment::Batch, batch)?
                {
                    return Err(ModularError::Wire);
                }
                let mut sensor_ids = BTreeSet::new();
                let mut buffer_ids = BTreeSet::new();
                let mut total_bytes = 0_usize;
                let mut total_chunks = 0_usize;
                for slot in &batch.slots {
                    let id = match slot {
                        SensorSlot::Due { sensor_id, .. }
                        | SensorSlot::NotDue { sensor_id, .. } => sensor_id,
                    };
                    if !sensor_ids.insert(id) {
                        return Err(ModularError::Wire);
                    }
                    if let SensorSlot::Due {
                        sensor_id,
                        typed_manifest: t,
                        byte_manifest: b,
                    } = slot
                    {
                        encoded_bound(t, 2_048)?;
                        encoded_bound(b, 1_200)?;
                        b.verify(context.binding())
                            .map_err(|_| ModularError::Wire)?;
                        let kind = match &t.tensor {
                            Tensor::Rgba8 { .. } => "rgba8",
                            Tensor::Radiance { .. } => "radiance",
                            Tensor::Pressure { .. } => "pressure",
                        };
                        let prefix = match kind {
                            "rgba8" => "rgb:",
                            "radiance" => "thermal:",
                            _ => "pressure:",
                        };
                        if !sensor_id.starts_with(prefix)
                            || !buffer_ids.insert(b.buffer_id)
                            || b.byte_length != tensor_bytes(&t.tensor, c.tick)?
                        {
                            return Err(ModularError::Wire);
                        }
                        total_bytes = total_bytes
                            .checked_add(b.byte_length)
                            .ok_or(ModularError::Capacity)?;
                        total_chunks = total_chunks
                            .checked_add(b.chunk_count)
                            .ok_or(ModularError::Capacity)?;
                        if t.sensor_id != *sensor_id
                            || t.byte_manifest_digest != b.manifest_digest
                            || t.engine_batch_sha256 != batch.engine_batch_sha256
                            || t.source_body_tick != c.tick
                            || t.available_after_body_tick != c.tick
                            || t.manifest_digest != contract::commit(Commitment::Manifest, t)?
                            || t.sensor_contract_digest != contract::semantic(kind)?
                            || b.semantic_digest != t.sensor_contract_digest
                            || b.creating_request_digest != context.request_digest()
                            || b.causal_predecessor.as_deref() != context.predecessor()
                            || b.imported_manifest_digest.is_some()
                        {
                            return Err(ModularError::Wire);
                        }
                    } else if let SensorSlot::NotDue {
                        next_due_tick: Some(next),
                        ..
                    } = slot
                    {
                        if *next <= c.tick {
                            return Err(ModularError::Wire);
                        }
                    }
                }
                if total_bytes == 0
                    || total_bytes > 27_857_088
                    || total_chunks == 0
                    || total_chunks > 856
                {
                    return Err(ModularError::Capacity);
                }
            }
            (Operation::Finish(f), Body::Finished { data }) => {
                contract::validate("Terminal", data)?;
                if data.plan_digest != f.plan_digest
                    || data.completed_ticks != f.completed_ticks
                    || data.planned_ticks != f.completed_ticks
                    || data.last_batch_digest != f.last_batch_digest
                {
                    return Err(ModularError::Wire);
                }
            }
            (_, Body::Prepared { .. } | Body::Application { .. } | Body::Finished { .. }) => {
                return Err(ModularError::Wire)
            }
            _ => {}
        }
        Ok(())
    }
    fn check_import_metadata(descriptor: &Never, _: &Never) -> Result<(), ModularError> {
        match *descriptor {}
    }
}

impl<E: EnginePort> Application for SensorApplication<E> {
    fn admit(
        &self,
        op: &AppOperation<Self>,
        view: &AdmissionView<'_>,
    ) -> Result<AdmissionDemand, Code> {
        if self.failed {
            return Err(Code::State);
        }
        let mut demand = AdmissionDemand::default();
        match op {
            Operation::Prepare(_) => {
                if self.active.is_some() {
                    return Err(Code::State);
                }
            }
            Operation::Application(c) => {
                let a = self.active.as_ref().ok_or(Code::State)?;
                if c.tick != a.tick + 1
                    || c.tick > a.prepare.planned_ticks
                    || c.previous_batch_digest != a.batch_digest
                    || !action_ok(&a.prepare, &c.action, a.accepted_action.as_deref())
                {
                    return Err(Code::InvalidInput);
                }
                if view.buffers.live_slots != 0
                    || view.buffers.incomplete_slots != 0
                    || view.buffers.reserved_bytes != 0
                {
                    return Err(Code::State);
                }
                demand.outputs = due(&a.prepare, c.tick)
                    .map_err(|_| Code::InvalidInput)?
                    .iter()
                    .map(|row| {
                        Ok(OutputSpec {
                            semantic_digest: contract::semantic(row.kind)
                                .map_err(|_| Code::InvalidInput)?,
                            byte_length: row.bytes,
                        })
                    })
                    .collect::<Result<Vec<_>, Code>>()?;
            }
            Operation::Finish(f) => {
                let a = self.active.as_ref().ok_or(Code::State)?;
                if f.plan_digest != a.plan_digest
                    || f.completed_ticks != a.tick
                    || a.tick != a.prepare.planned_ticks
                    || Some(&f.last_batch_digest) != a.batch_digest.as_ref()
                    || view.buffers.live_slots != 0
                    || view.buffers.incomplete_slots != 0
                    || view.buffers.reserved_bytes != 0
                {
                    return Err(Code::State);
                }
            }
            Operation::Abort(_) | Operation::BufferRead(_) | Operation::BufferRelease(_) => {}
            _ => return Err(Code::Role),
        }
        Ok(demand)
    }
    fn execute(
        &mut self,
        op: &AppOperation<Self>,
        permit: &mut ExecutionPermit<'_, '_>,
    ) -> Result<ApplicationOutput<SensorResult, Terminal>, Diagnostic> {
        let result = self.execute_inner(op, permit);
        if result.is_err() {
            self.failed = true;
            let _cleanup = self.engine.retire();
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

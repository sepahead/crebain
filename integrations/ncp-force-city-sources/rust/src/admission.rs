//! Pure complete-plan, source, and whole-roster admission.

use std::collections::BTreeSet;

use ncp_local::modular_wire::ModularError;
use serde::Serialize;
use serde_json::{json, Value};

use crate::contract::{self, Commitment};
use crate::types::*;

/// Largest admitted original-byte arena, independently owned at native and application layers.
pub const ORIGINAL_BYTES: usize = 27_857_088;
/// Complete application result bound, before the fixed NCP envelope.
pub const RESULT_BYTES: usize = 49_152;

/// Borrowed source identity and cadence, selected from one closed variant.
pub struct SourceInfo<'a> {
    /// Ordered request identity.
    pub request: &'a str,
    /// Exclusive native production identity.
    pub source: &'a str,
    /// Prepared recipient index.
    pub entity: usize,
    /// Native modality.
    pub kind: &'static str,
    /// Original payload semantic.
    pub semantic: &'static str,
    /// Publication cadence in 120-Hz ticks.
    pub period: u64,
    /// Maximum original byte extent.
    pub maximum_bytes: usize,
}

/// Read fixed source quantities after closed-schema validation.
pub fn source_info(source: &SourceRequest) -> SourceInfo<'_> {
    match source {
        SourceRequest::RGBRequest(s) => SourceInfo {
            request: &s.request_id,
            source: &s.source_id,
            entity: s.entity_index as usize,
            kind: "rgb",
            semantic: "rgba8",
            period: s.publication_period_ticks,
            maximum_bytes: (4 * s.width * s.height) as usize,
        },
        SourceRequest::ThermalRequest(s) => SourceInfo {
            request: &s.request_id,
            source: &s.source_id,
            entity: s.entity_index as usize,
            kind: "thermal",
            semantic: "radiance",
            period: s.publication_period_ticks,
            maximum_bytes: (4 * s.width * s.height) as usize,
        },
        SourceRequest::PressureRequest(s) => SourceInfo {
            request: &s.request_id,
            source: &s.source_id,
            entity: s.entity_index as usize,
            kind: "pressure",
            semantic: "pressure",
            period: s.publication_period_ticks,
            maximum_bytes: 134 * 8,
        },
    }
}

/// Derive the required native and application logical reservations from admitted quantities.
pub fn resources(p: &Prepare) -> Result<Value, ModularError> {
    contract::validate("Prepare", p)?;
    let n = p.world.entity_ids.len();
    let mut original = 0_usize;
    let mut rgb = 0_usize;
    let mut thermal = 0_usize;
    let mut thermal_scratch = 0_usize;
    let mut microphones = 0_usize;
    for source in &p.sources {
        let s = source_info(source);
        original = original
            .checked_add(s.maximum_bytes)
            .ok_or(ModularError::Capacity)?;
        match s.kind {
            "rgb" => rgb += s.maximum_bytes,
            "thermal" => {
                thermal += 4 * s.maximum_bytes;
                thermal_scratch = thermal_scratch.max(4 * s.maximum_bytes);
            }
            _ => microphones += 1,
        }
    }
    if original > ORIGINAL_BYTES {
        return Err(ModularError::Capacity);
    }
    let history = p.acoustic.as_ref().map_or(0, |a| {
        8 * n * ((a.maximum_range_m.get() / a.sound_speed_mps.get() * 16000.0).ceil() as usize + 2)
    });
    Ok(json!({"schema":"crebain.force-city-resource-plan.v1",
        "native_original_bytes":original,"application_original_bytes":original,
        "native_receipt_bytes":16384+256*n+4096*p.sources.len(),
        "native_control_bytes":4096+32768*n,"acoustic_history_bytes":history,
        "acoustic_block_bytes":134*8*microphones,"rgb_readback_bytes":rgb,
        "thermal_readback_bytes":thermal_scratch,"render_target_color_bytes":rgb+thermal,
        "source_graphics_retention_bytes":p.sources.iter().filter(|s|source_info(s).kind!="pressure").map(|s|source_info(s).maximum_bytes).max().unwrap_or(0),
        "maximum_public_live_payload_bytes":original,"maximum_public_live_buffers":p.sources.len(),
        "private_frame_bytes":65536,"private_value_nodes":16384,"private_depth":24,
        "chunk_bytes":32768,"application_result_bytes":RESULT_BYTES,
        "opaque_runtime_memory_bound":false}))
}

/// Recompute the derived reservation identity; a supplied digest grants no reservation.
pub fn resource_digest(p: &Prepare) -> Result<String, ModularError> {
    contract::commit(Commitment::Resources, &resources(p)?)
}

/// Bind the frozen ordered entity mapping.
pub fn roster_digest(p: &Prepare) -> Result<String, ModularError> {
    contract::commit(Commitment::Roster, &p.world.entity_ids)
}

/// Bind all selected source configurations and shared models.
pub fn catalog_digest(p: &Prepare) -> Result<String, ModularError> {
    contract::commit(
        Commitment::Catalog,
        &json!({"sources":p.sources,"acoustic":p.acoustic,"thermal":p.thermal,"frame":p.world.frame}),
    )
}

/// Join complete preparation to the trusted source and current NCP run.
pub fn plan_digest(p: &Prepare, run: &str, source: &str) -> Result<String, ModularError> {
    contract::commit(
        Commitment::Plan,
        &json!({"prepare":p,"run_id":run,"source_identity":source}),
    )
}

/// Reject complete plan inconsistencies before resource or engine mutation.
pub fn validate_prepare(p: &Prepare) -> Result<(), ModularError> {
    contract::validate("Prepare", p)?;
    let n = p.world.entity_ids.len();
    // Every control tuple is below 96 encoded bytes. Each produced/absent source
    // is below 1,024 bytes, including 64-byte IDs and all digest fields.
    // The 4,096-byte header allowance includes the sole possible failed source's
    // 256-byte diagnostic at its sixfold JSON escape bound. No whole world is
    // repeated per entity. Admission reserves this before native construction.
    if 4096 + 96 * n + 1024 * p.sources.len() > RESULT_BYTES {
        return Err(ModularError::Capacity);
    }
    let ordered = |values: Vec<&str>| values.windows(2).all(|pair| pair[0] < pair[1]);
    if p.composition_digest != contract::composition_digest()?
        || p.world.initial_positions.len() != n
        || p.world.controller_references.len() != n
        || p.world.action_budget < n as u64
        || p.world.initial_positions.iter().any(|p| p[1].get() <= 0.05)
        || !ordered(p.world.entity_ids.iter().map(String::as_str).collect())
        || !ordered(p.scene.materials.iter().map(|s| s.id.as_str()).collect())
        || !ordered(p.scene.solids.iter().map(|s| s.id.as_str()).collect())
        || p.scene
            .solids
            .iter()
            .any(|s| s.material_index as usize >= p.scene.materials.len())
    {
        return Err(ModularError::Wire);
    }
    let mut identities = BTreeSet::new();
    let mut last = "";
    let mut counts = [0; 3];
    for source in &p.sources {
        let s = source_info(source);
        if s.entity >= n || s.request <= last || !identities.insert(s.source) {
            return Err(ModularError::Wire);
        }
        last = s.request;
        match source {
            SourceRequest::RGBRequest(s) => {
                counts[0] += 1;
                if s.position
                    .iter()
                    .zip(s.target)
                    .all(|(a, b)| a.get() == b.get())
                {
                    return Err(ModularError::Wire);
                }
            }
            SourceRequest::ThermalRequest(s) => {
                counts[1] += 1;
                if s.position
                    .iter()
                    .zip(s.target)
                    .all(|(a, b)| a.get() == b.get())
                {
                    return Err(ModularError::Wire);
                }
            }
            SourceRequest::PressureRequest(_) => counts[2] += 1,
        }
    }
    if counts.iter().any(|n| *n > 4)
        || (counts[2] > 0) != p.acoustic.is_some()
        || (counts[1] > 0) != p.thermal.is_some()
        || p.acoustic
            .as_ref()
            .is_some_and(|a| a.reference_distance_m.get() > a.maximum_range_m.get())
        || p.resource_plan_digest != resource_digest(p)?
    {
        return Err(ModularError::Wire);
    }
    Ok(())
}

/// Validate every current action, including the final row, before the effect boundary.
pub fn validate_rows(
    p: &Prepare,
    c: &Advance,
    accepted: &[AppliedRow],
    used_actions: u64,
) -> Result<u64, ModularError> {
    contract::validate("Advance", c)?;
    if c.rows.len() != p.world.entity_ids.len() {
        return Err(ModularError::Wire);
    }
    let mut additional = 0;
    for (index, row) in c.rows.iter().enumerate() {
        match row {
            ControlRow::SetRow((entity, kind, _, target)) => {
                if *entity != index as u64 || kind != "set" {
                    return Err(ModularError::Wire);
                }
                let reference = &p.world.controller_references[index];
                let heading = target[2].get() - reference[1].get();
                if heading.sin().atan2(heading.cos()).abs() > 0.2
                    || (target[3].get() - reference[0].get()).abs() > 0.5
                {
                    return Err(ModularError::Wire);
                }
                additional += 1;
            }
            ControlRow::HoldRow((entity, kind, digest)) => {
                if *entity != index as u64
                    || kind != "hold"
                    || accepted.get(index).is_none_or(|prior| prior.1 != *digest)
                {
                    return Err(ModularError::Wire);
                }
            }
        }
    }
    if used_actions
        .checked_add(additional)
        .is_none_or(|total| total > p.world.action_budget)
    {
        return Err(ModularError::Capacity);
    }
    Ok(additional)
}

/// Actual tick-specific original tensor, independent of renderer metadata.
pub fn expected_tensor(source: &SourceRequest, tick: u64) -> Tensor {
    match source {
        SourceRequest::RGBRequest(s) => Tensor::RgbaTensor(Box::new(RgbaTensor {
            kind: "rgba8".into(),
            dtype: "u8".into(),
            shape: [s.height, s.width, 4],
            layout: "c_contiguous".into(),
            row_origin: "bottom-left".into(),
            encoding: "rgba8-srgb".into(),
        })),
        SourceRequest::ThermalRequest(s) => Tensor::RadianceTensor(Box::new(RadianceTensor {
            kind: "radiance".into(),
            dtype: "f32le".into(),
            shape: [s.height, s.width],
            layout: "c_contiguous".into(),
            row_origin: "bottom-left".into(),
            unit: "W/(m2 sr)".into(),
        })),
        SourceRequest::PressureRequest(_) => {
            let start = (tick - 1) * 16000 / 120;
            let end = tick * 16000 / 120;
            Tensor::PressureTensor(Box::new(PressureTensor {
                kind: "pressure".into(),
                dtype: "f64le".into(),
                shape: [end - start],
                layout: "c_contiguous".into(),
                sample_start: start,
                sample_end: end,
                sample_rate_hz: 16000,
                unit: "pascal".into(),
            }))
        }
    }
}

/// Complete current payload length after tick and source admission.
pub fn expected_bytes(source: &SourceRequest, tick: u64) -> usize {
    if matches!(source, SourceRequest::PressureRequest(_)) {
        (((tick * 16000 / 120) - ((tick - 1) * 16000 / 120)) * 8) as usize
    } else {
        source_info(source).maximum_bytes
    }
}

/// Bound a typed result before it can be committed into the core response.
pub fn encoded_bound(value: &impl Serialize, maximum: usize) -> Result<(), ModularError> {
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

/// Validate actual payload values without converting truth state into a sensor.
pub fn payload_valid(kind: &str, bytes: &[u8]) -> bool {
    match kind {
        "rgba8" => true,
        "radiance" => {
            bytes.len().is_multiple_of(4)
                && bytes.chunks_exact(4).all(|b| {
                    let n = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                    n.is_finite() && (0.0..=10000.0).contains(&n)
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

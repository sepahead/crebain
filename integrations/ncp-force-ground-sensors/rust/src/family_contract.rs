//! Closed optional family schema and constructor admission. Digests grant no native authority.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use ncp_local::modular_owner;
use ncp_local::modular_wire::{self as wire, ModularError};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::application;
use crate::contract;
use crate::family_types::FamilyPlan;

/// Exact optional family descriptor, shared by two constructor-selected typed roles.
pub const DESCRIPTOR: &[u8] =
    include_bytes!("../../contracts/family.application.descriptor.v1.json");
/// Generated closed family schema, including unchanged sensor types.
pub const SCHEMA: &[u8] = include_bytes!("../../contracts/family.application.schema.v1.json");
/// Fixed live-family composition; it introduces no mandatory external observer.
pub const COMPOSITION: &[u8] = include_bytes!("../../contracts/family.composition.v1.json");
/// Exact source-owned pressure-window arithmetic descriptor.
pub const TARGET: &[u8] = include_bytes!("../../contracts/pressure-window-rms.semantic.v1.json");
static DEFINITIONS: OnceLock<Result<Value, ModularError>> = OnceLock::new();

/// Validate an exact named installed family DTO.
pub fn validate<T: Serialize>(name: &str, value: &T) -> Result<(), ModularError> {
    let definitions = DEFINITIONS.get_or_init(|| wire::parse_value(SCHEMA));
    contract::validate_definitions(name, value, definitions.as_ref().map_err(|error| *error)?)
}

/// The installed family's application identity, not an endpoint execution identity.
pub fn application_digest() -> Result<String, ModularError> {
    wire::typed_digest(wire::PROFILE_DOMAIN, &wire::parse_value(DESCRIPTOR)?, None)
}

/// The source-owned optional composition identity.
pub fn composition_digest() -> Result<String, ModularError> {
    wire::typed_digest(wire::PROFILE_DOMAIN, &wire::parse_value(COMPOSITION)?, None)
}

/// SHA-256 of sorted compact UTF-8 target JSON, matching the numerical owner contract.
pub fn target_digest() -> Result<String, ModularError> {
    let value = wire::parse_value(TARGET)?;
    let bytes = serde_json::to_vec(&value).map_err(|_| ModularError::Wire)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

/// Commit the complete constructor-frozen plan and admitted source identity.
pub fn plan_digest(plan: &FamilyPlan, source: &str) -> Result<String, ModularError> {
    if !wire::valid_digest(source) {
        return Err(ModularError::Binding);
    }
    wire::typed_digest(
        wire::PROFILE_DOMAIN,
        &json!({"schema":"crebain.live-checkpoint-family-plan-commitment.v1", "plan":plan, "source_identity":source}),
        None,
    )
}

/// Validate all fixed endpoints and cross-field limits before any native construction.
pub fn validate_plan(plan: &FamilyPlan) -> Result<(), ModularError> {
    validate("FamilyPlan", plan)?;
    application::validate_prepare_for(&plan.body, &composition_digest()?)?;
    let profile = modular_owner::profile_digest()?;
    let application = application_digest()?;
    let horizon = plan.body.planned_ticks;
    let cameras: Vec<_> = plan
        .body
        .specification
        .scene
        .rgb_cameras
        .iter()
        .chain(&plan.body.specification.scene.thermal_cameras)
        .collect();
    let target = &plan.evaluation;
    let mut run_ids = BTreeSet::new();
    let mut endpoint_ids = BTreeSet::new();
    let mut generations = BTreeSet::new();
    for binding in std::iter::once(&plan.canonical_binding)
        .chain(plan.branches.iter().map(|branch| &branch.binding))
    {
        binding.validate().map_err(|_| ModularError::Binding)?;
        if binding.profile_digest != profile
            || binding.application_digest != application
            || !run_ids.insert(&binding.run_id)
            || !endpoint_ids.insert(&binding.endpoint_id)
            || !generations.insert(&binding.generation)
        {
            return Err(ModularError::Binding);
        }
    }
    let mut cases = BTreeSet::new();
    if plan.limits.endpoint_count as usize != plan.branches.len() + 1
        || plan.landmark_tick >= horizon
        || cameras.is_empty()
        || cameras.iter().any(|camera| {
            !plan.landmark_tick.is_multiple_of(camera.period_ticks)
                || !horizon.is_multiple_of(camera.period_ticks)
        })
        || target.first_tick <= plan.landmark_tick
        || target.last_tick != horizon
        || target.first_tick + 2 != horizon
        || target.last_tick * 16_000 / 120 - (target.first_tick - 1) * 16_000 / 120 != 400
        || target.target_function_digest != target_digest()?
        || !plan
            .body
            .specification
            .scene
            .microphones
            .iter()
            .any(|microphone| format!("pressure:{}", microphone.id) == target.sensor_id)
        || plan.branches.iter().enumerate().any(|(index, branch)| {
            branch.slot as usize != index + 1 || !cases.insert(&branch.case_id)
        })
    {
        return Err(ModularError::Wire);
    }
    Ok(())
}

/// Bound an application result independently of the full core frame ceiling.
pub fn result_bound<T: Serialize>(value: &T) -> Result<(), ModularError> {
    if serde_json::to_vec(value)
        .map_err(|_| ModularError::Wire)?
        .len()
        > 32_768
    {
        Err(ModularError::Capacity)
    } else {
        Ok(())
    }
}

#![allow(dead_code)]
use crebain_ncp_force_city_sources::{admission, contract, types::*};
use ncp_local::{modular_buffer::BufferBinding, modular_owner, modular_wire};
use serde_json::{json, Value};

pub const RUN: &str = "11111111-1111-4111-8111-111111111111";
pub const SOURCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub fn binding() -> BufferBinding {
    BufferBinding {
        profile_digest: modular_owner::profile_digest().unwrap(),
        application_digest: modular_wire::typed_digest(
            modular_wire::PROFILE_DOMAIN,
            &modular_wire::parse_value(contract::DESCRIPTOR).unwrap(),
            None,
        )
        .unwrap(),
        run_id: RUN.into(),
        endpoint_id: "22222222-2222-4222-8222-222222222222".into(),
        generation: "33333333-3333-4333-8333-333333333333".into(),
    }
}
pub fn plan(n: usize, sources: usize, solids: usize, long_ids: bool) -> Prepare {
    let id = |prefix: &str, i: usize| {
        let short = format!("{prefix}{i:03}");
        if long_ids {
            format!("{short}{}", "x".repeat(64 - short.len()))
        } else {
            short
        }
    };
    let requests: Vec<Value> = (0..sources)
        .map(|i| {
            let kind = match i / 4 {
                0 => "rgb",
                1 => "thermal",
                _ => "pressure",
            };
            let mut value = json!({"request_id":id("r",i),"source_id":id("s",i),"entity_index":n-1,
            "scope":"entity_requested_world_fixed","position":[0.0,50.0,0.0],
            "publication_period_ticks":1,"kind":kind});
            let fields = value.as_object_mut().unwrap();
            if kind == "pressure" {
                fields.insert("sample_rate_hz".into(), json!(16000));
                fields.insert(
                    "observation_model".into(),
                    json!("crebain.discrete-direct-acoustic.v1"),
                );
            } else {
                let size = if kind == "rgb" { 1280 } else { 320 };
                for (k, v) in [
                    ("target", json!([1.0, 50.0, 0.0])),
                    ("width", json!(size)),
                    ("height", json!(size)),
                    ("fov_degrees", json!(90.0)),
                    (
                        "rendering_mode",
                        json!(if kind == "rgb" {
                            "mesh_and_authored_gaussians"
                        } else {
                            "bolometric_mesh"
                        }),
                    ),
                ] {
                    fields.insert(k.into(), v);
                }
            }
            value
        })
        .collect();
    let mut value = json!({"schema":"crebain.force-city-prepare.v1","composition_digest":contract::composition_digest().unwrap(),
        "resource_plan_digest":"0".repeat(64),"world":{"profile":"crebain.rapier-force-city.v1",
        "engine_model":"rapier-0.19.3-observed-no-gyro-v1","frame":"three-y-up-z-forward-m","horizon_ticks":7200,"action_budget":4096,
        "entity_ids":(0..n).map(|i|id("d",i)).collect::<Vec<_>>(),
        "initial_positions":(0..n).map(|i|[12.0*(i%16)as f64-90.0,50.0+(i%3)as f64,12.0*(i/16)as f64-90.0]).collect::<Vec<_>>(),
        "controller_references":(0..n).map(|i|[50.0+(i%3)as f64,0.0]).collect::<Vec<_>>()},
        "scene":{"id":id("scene",0),"materials":[{"id":id("m",0),"linearRgb":[0.5,0.5,0.5],"gaussianOpacity":0.5,"temperatureK":300.0,"emissivity":0.8}],
        "solids":(0..solids).map(|i|json!({"id":id("b",i),"center":[12.0*(i%8)as f64-42.0,2.0,12.0*(i/8)as f64-42.0],"half_extents":[2.0,2.0,2.0],"yaw":0.0,"friction":0.7,"restitution":0.0,"material_index":0})).collect::<Vec<_>>()},"sources":requests});
    if sources > 8 {
        value["acoustic"] = json!({"profile":"crebain.discrete-direct-acoustic.v1","sampleRateHz":16000,"soundSpeedMps":300.0,"maximumRangeM":128.0,"referenceDistanceM":1.0,"referencePressurePa":0.01,"bladeCount":2,"blockedGain":0.2,"noiseStdPa":0.0,"seed":42});
    }
    if sources > 4 {
        value["thermal"] = json!({"profile":"crebain.lumped-gray-thermal.v1","ambientK":293.0,"initialK":293.0,"capacityJPerK":100.0,"areaM2":0.1,"convectionWPerM2K":10.0,"emissivity":0.8,"motorEfficiency":0.8});
    }
    let mut p: Prepare = serde_json::from_value(value).unwrap();
    p.resource_plan_digest = admission::resource_digest(&p).unwrap();
    p
}
pub fn advance(p: &Prepare, tick: u64, previous: Option<String>) -> Advance {
    serde_json::from_value(json!({"kind":"advance","plan_digest":admission::plan_digest(p,RUN,SOURCE).unwrap(),
        "roster_digest":admission::roster_digest(p).unwrap(),"tick":tick,"previous_batch_digest":previous,
        "rows":p.world.controller_references.iter().enumerate().map(|(i,r)|json!([i,"set",true,[0.03,-0.03,r[1].get(),r[0].get()]])).collect::<Vec<_>>()})).unwrap()
}

//! Closed typed family bridge over the existing bounded owner-created process channel.

use std::path::Path;
use std::time::{Duration, Instant};

use ncp_local::modular_buffer::decode_chunk;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::engine::{bridge_value, EngineBatch, EngineError, EnginePrepared, EngineProcess};
use crate::family_contract;
use crate::family_engine::{FamilyEngine, NativeRestored};
use crate::family_protocol::CommittedStamp as ObservedStamp;
use crate::family_types::*;
use crate::types::AdvanceTick;

#[derive(Serialize)]
#[serde(tag = "kind")]
enum Request<'a> {
    #[serde(rename = "construct")]
    Construct {
        plan: &'a FamilyPlan,
        family_plan_digest: &'a str,
        source_identity: &'a str,
    },
    #[serde(rename = "prepare")]
    Prepare,
    #[serde(rename = "advance")]
    Advance {
        slot: usize,
        command: &'a AdvanceTick,
        request_digest: &'a str,
    },
    #[serde(rename = "read_chunk")]
    ReadChunk {
        slot: usize,
        tick: u64,
        engine_batch_sha256: &'a str,
        sensor_id: &'a str,
        offset: usize,
        count: usize,
    },
    #[serde(rename = "release_lease")]
    ReleaseLease {
        slot: usize,
        tick: u64,
        engine_batch_sha256: &'a str,
    },
    #[serde(rename = "checkpoint")]
    Checkpoint { expected_batch_digest: &'a str },
    #[serde(rename = "select")]
    Select {
        checkpoint: &'a CheckpointReference,
        case_id: &'a str,
        forecast: &'a str,
    },
    #[serde(rename = "reserve")]
    Reserve {
        checkpoint: &'a CheckpointReference,
        case_id: &'a str,
        selected: &'a str,
        request: &'a str,
    },
    #[serde(rename = "restore")]
    Restore {
        reservation: &'a ReservationReference,
        family_plan_digest: &'a str,
    },
    #[serde(rename = "evaluate")]
    Evaluate {
        slot: usize,
        batch: &'a str,
        target: &'a str,
    },
    #[serde(rename = "finish_branch")]
    FinishBranch { slot: usize, evaluation: &'a str },
    #[serde(rename = "release_checkpoint")]
    ReleaseCheckpoint {
        checkpoint: &'a CheckpointReference,
        terminal: &'a str,
    },
    #[serde(rename = "finish_canonical")]
    FinishCanonical { terminals: &'a [CommittedStamp] },
    #[serde(rename = "observe_canonical")]
    ObserveCanonical {
        stamp: &'a CommittedStamp,
        result: &'a CanonicalResult,
    },
    #[serde(rename = "observe_evaluation")]
    ObserveEvaluation {
        slot: usize,
        stamp: &'a CommittedStamp,
        result: &'a EvaluationResultUnion,
    },
    #[serde(rename = "observe_terminal")]
    ObserveTerminal { stamp: &'a CommittedStamp },
    #[serde(rename = "observe_ack")]
    ObserveAck { stamp: &'a CommittedStamp },
    #[serde(rename = "observe_eof")]
    ObserveEof { stamp: &'a CommittedStamp },
    #[serde(rename = "retire")]
    Retire,
}

#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Response {
    #[serde(rename = "constructed")]
    Constructed,
    #[serde(rename = "prepared")]
    Prepared {
        engine_owner_id: String,
        scene_sha256: String,
    },
    #[serde(rename = "advanced")]
    Advanced { batch: EngineBatch },
    #[serde(rename = "chunk")]
    Chunk {
        tick: u64,
        engine_batch_sha256: String,
        sensor_id: String,
        offset: usize,
        bytes_base64: String,
        chunk_sha256: String,
    },
    #[serde(rename = "released")]
    Released {
        tick: u64,
        engine_batch_sha256: String,
        canonical_final_state: Option<Box<CanonicalFinalState>>,
    },
    #[serde(rename = "checkpointed")]
    Checkpointed { result: Box<Checkpointed> },
    #[serde(rename = "selected")]
    Selected { result: Box<DecisionCommitted> },
    #[serde(rename = "reserved")]
    Reserved {
        reference: Box<ReservationReference>,
    },
    #[serde(rename = "restored")]
    Restored { result: Box<NativeRestored> },
    #[serde(rename = "evaluated")]
    Evaluated { result: Box<EvaluationResult> },
    #[serde(rename = "branch_finished")]
    BranchFinished,
    #[serde(rename = "checkpoint_released")]
    CheckpointReleased,
    #[serde(rename = "family_finished")]
    FamilyFinished { state: Box<CanonicalFinalState> },
    #[serde(rename = "observed")]
    Observed,
    #[serde(rename = "retired")]
    Retired { cleanup_confirmed: bool },
    #[serde(rename = "failed")]
    Failed {
        reason: String,
        cleanup_confirmed: bool,
    },
}

fn stamp(value: &ObservedStamp) -> CommittedStamp {
    CommittedStamp {
        binding: value.binding().clone(),
        sequence: value.sequence(),
        request_digest: value.request_digest().into(),
        result_digest: value.result_digest().into(),
    }
}

fn unwrap_floats(value: Value) -> Result<Value, EngineError> {
    match value {
        Value::Object(mut fields) if fields.contains_key("f64") => {
            if fields.len() != 1 {
                return Err(EngineError);
            }
            let Value::String(bits) = fields.remove("f64").ok_or(EngineError)? else {
                return Err(EngineError);
            };
            if bits.len() != 16
                || !bits
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(EngineError);
            }
            let bits = u64::from_str_radix(&bits, 16).map_err(|_| EngineError)?;
            let number = serde_json::Number::from_f64(f64::from_bits(bits)).ok_or(EngineError)?;
            Ok(Value::Number(number))
        }
        Value::Object(fields) => Ok(Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| Ok((key, unwrap_floats(value)?)))
                .collect::<Result<_, EngineError>>()?,
        )),
        Value::Array(values) => Ok(Value::Array(
            values
                .into_iter()
                .map(unwrap_floats)
                .collect::<Result<_, _>>()?,
        )),
        other => Ok(other),
    }
}

/// One selected Bun family process; all endpoints use the same absolute execution deadline.
pub struct FamilyProcess {
    process: EngineProcess,
    deadline: Instant,
    transfer_deadline: Option<Instant>,
    cleanup_deadline: Option<Instant>,
    retired: bool,
    failed: bool,
}

impl FamilyProcess {
    /// Admit the complete frozen plan, then start only the selected local executable and source.
    pub fn spawn(
        bun: &Path,
        node: &Path,
        bridge: &Path,
        plan: &FamilyPlan,
        source: &str,
    ) -> Result<Self, EngineError> {
        family_contract::validate_plan(plan).map_err(|_| EngineError)?;
        let digest = family_contract::plan_digest(plan, source).map_err(|_| EngineError)?;
        let deadline = Instant::now() + Duration::from_secs(plan.limits.total_wall_seconds);
        let process = EngineProcess::spawn(bun, Some(node), bridge, plan.family_id.clone())?;
        let mut result = Self {
            process,
            deadline,
            transfer_deadline: None,
            cleanup_deadline: None,
            retired: false,
            failed: false,
        };
        if !matches!(
            result.request(
                Request::Construct {
                    plan,
                    family_plan_digest: &digest,
                    source_identity: source
                },
                60
            )?,
            Response::Constructed
        ) {
            result.fail();
            return Err(EngineError);
        }
        Ok(result)
    }

    fn fail(&mut self) {
        self.failed = true;
        self.process.fail_private();
    }

    fn request(&mut self, command: Request<'_>, seconds: u64) -> Result<Response, EngineError> {
        self.request_until(
            command,
            self.deadline
                .min(Instant::now() + Duration::from_secs(seconds)),
        )
    }

    fn request_until(
        &mut self,
        command: Request<'_>,
        deadline: Instant,
    ) -> Result<Response, EngineError> {
        if self.retired || self.failed || Instant::now() >= deadline {
            self.fail();
            return Err(EngineError);
        }
        let result = (|| {
            let body = self.process.exchange_body(
                "crebain.family-engine-request.v1",
                "crebain.family-engine-response.v1",
                bridge_value(&command)?,
                deadline,
            )?;
            let response: Response =
                serde_json::from_value(unwrap_floats(body)?).map_err(|_| EngineError)?;
            if let Response::Failed {
                reason,
                cleanup_confirmed,
            } = response
            {
                let _retained_failure_facts = (reason, cleanup_confirmed);
                return Err(EngineError);
            }
            Ok(response)
        })();
        if result.is_err() {
            self.fail();
        }
        result
    }

    fn observed(&mut self, command: Request<'_>) -> Result<(), EngineError> {
        if matches!(self.request(command, 60)?, Response::Observed) {
            Ok(())
        } else {
            self.fail();
            Err(EngineError)
        }
    }
}

impl FamilyEngine for FamilyProcess {
    fn prepare(&mut self) -> Result<EnginePrepared, EngineError> {
        match self.request(Request::Prepare, 60)? {
            Response::Prepared {
                engine_owner_id,
                scene_sha256,
            } => Ok(EnginePrepared {
                engine_owner_id,
                scene_sha256,
            }),
            _ => {
                self.fail();
                Err(EngineError)
            }
        }
    }
    fn advance(
        &mut self,
        slot: usize,
        command: &AdvanceTick,
        request: &str,
    ) -> Result<EngineBatch, EngineError> {
        let deadline = self.deadline.min(Instant::now() + Duration::from_secs(60));
        self.transfer_deadline = Some(deadline);
        match self.request_until(
            Request::Advance {
                slot,
                command,
                request_digest: request,
            },
            deadline,
        )? {
            Response::Advanced { batch } => Ok(batch),
            _ => {
                self.fail();
                Err(EngineError)
            }
        }
    }
    fn read_chunk(
        &mut self,
        slot: usize,
        tick: u64,
        batch: &str,
        sensor: &str,
        offset: usize,
        count: usize,
    ) -> Result<Vec<u8>, EngineError> {
        let deadline = self.transfer_deadline.ok_or(EngineError)?;
        let response = self.request_until(
            Request::ReadChunk {
                slot,
                tick,
                engine_batch_sha256: batch,
                sensor_id: sensor,
                offset,
                count,
            },
            deadline,
        )?;
        let Response::Chunk {
            tick: actual_tick,
            engine_batch_sha256,
            sensor_id,
            offset: actual_offset,
            bytes_base64,
            chunk_sha256,
        } = response
        else {
            self.fail();
            return Err(EngineError);
        };
        let bytes = decode_chunk(&bytes_base64).map_err(|_| EngineError)?;
        if actual_tick != tick
            || engine_batch_sha256 != batch
            || sensor_id != sensor
            || actual_offset != offset
            || bytes.len() != count
            || format!("{:x}", Sha256::digest(&bytes)) != chunk_sha256
        {
            self.fail();
            return Err(EngineError);
        }
        Ok(bytes)
    }
    fn release_lease(
        &mut self,
        slot: usize,
        tick: u64,
        batch: &str,
    ) -> Result<Option<CanonicalFinalState>, EngineError> {
        let deadline = self.transfer_deadline.ok_or(EngineError)?;
        match self.request_until(
            Request::ReleaseLease {
                slot,
                tick,
                engine_batch_sha256: batch,
            },
            deadline,
        )? {
            Response::Released {
                tick: actual_tick,
                engine_batch_sha256,
                canonical_final_state,
            } if actual_tick == tick && engine_batch_sha256 == batch => {
                self.transfer_deadline = None;
                Ok(canonical_final_state.map(|state| *state))
            }
            _ => {
                self.fail();
                Err(EngineError)
            }
        }
    }
    fn checkpoint(&mut self, batch: &str) -> Result<Checkpointed, EngineError> {
        match self.request(
            Request::Checkpoint {
                expected_batch_digest: batch,
            },
            60,
        )? {
            Response::Checkpointed { result } => Ok(*result),
            _ => {
                self.fail();
                Err(EngineError)
            }
        }
    }
    fn select(
        &mut self,
        checkpoint: &CheckpointReference,
        case_id: &str,
        forecast: &str,
    ) -> Result<DecisionCommitted, EngineError> {
        match self.request(
            Request::Select {
                checkpoint,
                case_id,
                forecast,
            },
            60,
        )? {
            Response::Selected { result } => Ok(*result),
            _ => {
                self.fail();
                Err(EngineError)
            }
        }
    }
    fn reserve(
        &mut self,
        checkpoint: &CheckpointReference,
        case_id: &str,
        selected: &str,
        request: &str,
    ) -> Result<ReservationReference, EngineError> {
        match self.request(
            Request::Reserve {
                checkpoint,
                case_id,
                selected,
                request,
            },
            60,
        )? {
            Response::Reserved { reference } => Ok(*reference),
            _ => {
                self.fail();
                Err(EngineError)
            }
        }
    }
    fn restore(
        &mut self,
        reservation: &ReservationReference,
        plan: &str,
    ) -> Result<NativeRestored, EngineError> {
        match self.request(
            Request::Restore {
                reservation,
                family_plan_digest: plan,
            },
            60,
        )? {
            Response::Restored { result } => Ok(*result),
            _ => {
                self.fail();
                Err(EngineError)
            }
        }
    }
    fn evaluate(
        &mut self,
        slot: usize,
        batch: &str,
        target: &str,
    ) -> Result<EvaluationResult, EngineError> {
        match self.request(
            Request::Evaluate {
                slot,
                batch,
                target,
            },
            60,
        )? {
            Response::Evaluated { result } => Ok(*result),
            _ => {
                self.fail();
                Err(EngineError)
            }
        }
    }
    fn finish_branch(&mut self, slot: usize, evaluation: &str) -> Result<(), EngineError> {
        if matches!(
            self.request(Request::FinishBranch { slot, evaluation }, 45)?,
            Response::BranchFinished
        ) {
            Ok(())
        } else {
            self.fail();
            Err(EngineError)
        }
    }
    fn release_checkpoint(
        &mut self,
        checkpoint: &CheckpointReference,
        terminal: &str,
    ) -> Result<(), EngineError> {
        if matches!(
            self.request(
                Request::ReleaseCheckpoint {
                    checkpoint,
                    terminal
                },
                60
            )?,
            Response::CheckpointReleased
        ) {
            Ok(())
        } else {
            self.fail();
            Err(EngineError)
        }
    }
    fn finish_canonical(
        &mut self,
        terminals: &[CommittedStamp],
    ) -> Result<CanonicalFinalState, EngineError> {
        let deadline = self.deadline.min(Instant::now() + Duration::from_secs(45));
        let Response::FamilyFinished { state } =
            self.request_until(Request::FinishCanonical { terminals }, deadline)?
        else {
            self.fail();
            return Err(EngineError);
        };
        if self.process.close_and_wait(deadline).is_err() {
            self.fail();
            return Err(EngineError);
        }
        self.retired = true;
        Ok(*state)
    }
    fn canonical_committed(
        &mut self,
        observed: &ObservedStamp,
        result: &CanonicalResult,
    ) -> Result<(), EngineError> {
        self.observed(Request::ObserveCanonical {
            stamp: &stamp(observed),
            result,
        })
    }
    fn evaluation_committed(
        &mut self,
        slot: usize,
        observed: &ObservedStamp,
        result: &EvaluationResultUnion,
    ) -> Result<(), EngineError> {
        self.observed(Request::ObserveEvaluation {
            slot,
            stamp: &stamp(observed),
            result,
        })
    }
    fn terminal_committed(&mut self, observed: &ObservedStamp) -> Result<(), EngineError> {
        self.observed(Request::ObserveTerminal {
            stamp: &stamp(observed),
        })
    }
    fn terminal_ack_sent(&mut self, observed: &ObservedStamp) -> Result<(), EngineError> {
        self.observed(Request::ObserveAck {
            stamp: &stamp(observed),
        })
    }
    fn channel_closed(&mut self, observed: &ObservedStamp) -> Result<(), EngineError> {
        self.observed(Request::ObserveEof {
            stamp: &stamp(observed),
        })
    }
    fn retire(&mut self) -> Result<(), EngineError> {
        if self.retired {
            return if self.failed {
                Err(EngineError)
            } else {
                Ok(())
            };
        }
        let deadline = *self
            .cleanup_deadline
            .get_or_insert_with(|| Instant::now() + Duration::from_secs(45));
        let confirmed = !self.failed
            && matches!(
                self.request_until(Request::Retire, deadline),
                Ok(Response::Retired {
                    cleanup_confirmed: true
                })
            );
        let exited = self.process.close_and_wait(deadline).is_ok();
        self.retired = exited;
        if !confirmed || !exited {
            self.failed = true;
            return Err(EngineError);
        }
        Ok(())
    }
}

impl Drop for FamilyProcess {
    fn drop(&mut self) {
        let _retirement = self.retire();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn binary64_bridge_preserves_zero_sign_and_rejects_nonfinite_or_ambiguous_words() {
        for value in [0.0_f64, -0.0, 1.0, -1.0, f64::MAX, f64::MIN_POSITIVE] {
            let encoded = bridge_value(&value).unwrap();
            let recovered = unwrap_floats(encoded).unwrap().as_f64().unwrap();
            assert_eq!(value.to_bits(), recovered.to_bits());
        }
        for bad in [
            json!({"f64":"7ff0000000000000"}),
            json!({"f64":"7ff8000000000000"}),
            json!({"f64":"BFF0000000000000"}),
            json!({"f64":"0000000000000000","extra":0}),
            json!({"f64":0}),
        ] {
            assert!(unwrap_floats(bad).is_err());
        }
    }
}

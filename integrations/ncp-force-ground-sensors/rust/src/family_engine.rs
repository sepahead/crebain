//! Closed native-family operations; implementations cannot add peer-selected methods.

use crate::engine::{EngineBatch, EngineError, EnginePrepared};
use crate::family_protocol::CommittedStamp;
use crate::family_types::{
    BranchAncestry, CanonicalFinalState, CanonicalResult, CheckpointReference, Checkpointed,
    DecisionCommitted, EvaluationResult, EvaluationResultUnion, PixelIdentity,
    ReservationReference,
};
use crate::types::AdvanceTick;
use serde::{Deserialize, Serialize};

/// Native reconstruction facts, before an SDK preparation has committed.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NativeRestored {
    /// Origin authority and fresh execution identities.
    pub ancestry: BranchAncestry,
    /// Exact complete CPU-state bytes at the retained landmark.
    pub cpu_state_sha256: String,
    /// Reconstructed immutable render input.
    pub render_input_sha256: String,
    /// Exact current static pixels compared by the originating native owner.
    pub pixels: Vec<PixelIdentity>,
}

/// The sole trusted family engine port. No operation imports checkpoint authority.
pub trait FamilyEngine {
    /// Construct the canonical native owner for the already frozen family plan.
    fn prepare(&mut self) -> Result<EnginePrepared, EngineError>;
    /// Execute one typed body step under its actual SDK execution request.
    fn advance(
        &mut self,
        slot: usize,
        command: &AdvanceTick,
        request: &str,
    ) -> Result<EngineBatch, EngineError>;
    /// Copy a bounded original native sensor chunk from the retained lease.
    fn read_chunk(
        &mut self,
        slot: usize,
        tick: u64,
        batch: &str,
        sensor: &str,
        offset: usize,
        count: usize,
    ) -> Result<Vec<u8>, EngineError>;
    /// Release the lease; the canonical final step also audits its full state.
    fn release_lease(
        &mut self,
        slot: usize,
        tick: u64,
        batch: &str,
    ) -> Result<Option<CanonicalFinalState>, EngineError>;
    /// Retain the actual originating native checkpoint object.
    fn checkpoint(&mut self, batch: &str) -> Result<Checkpointed, EngineError>;
    /// Bind an external forecast commitment and the actual collection action.
    fn select(
        &mut self,
        checkpoint: &CheckpointReference,
        case_id: &str,
        forecast: &str,
    ) -> Result<DecisionCommitted, EngineError>;
    /// Reserve the next frozen branch only after selected execution commits.
    fn reserve(
        &mut self,
        checkpoint: &CheckpointReference,
        case_id: &str,
        selected: &str,
        request: &str,
    ) -> Result<ReservationReference, EngineError>;
    /// Fork using the original retained native handle, never a deserialized substitute.
    fn restore(
        &mut self,
        reservation: &ReservationReference,
        plan: &str,
    ) -> Result<NativeRestored, EngineError>;
    /// Evaluate only the frozen original pressure bytes and source-owned function.
    fn evaluate(
        &mut self,
        slot: usize,
        batch: &str,
        target: &str,
    ) -> Result<EvaluationResult, EngineError>;
    /// Retire the active native child; its SDK endpoint remains pending.
    fn finish_branch(&mut self, slot: usize, evaluation: &str) -> Result<(), EngineError>;
    /// Release the origin checkpoint after all actual branch closure facts.
    fn release_checkpoint(
        &mut self,
        checkpoint: &CheckpointReference,
        terminal: &str,
    ) -> Result<(), EngineError>;
    /// Recheck the full canonical state, retire native owners, and wait for Bun exit.
    fn finish_canonical(
        &mut self,
        terminals: &[crate::family_types::CommittedStamp],
    ) -> Result<CanonicalFinalState, EngineError>;
    /// Record a new actual canonical COMMITTED result, not a callback's intent.
    fn canonical_committed(
        &mut self,
        stamp: &CommittedStamp,
        result: &CanonicalResult,
    ) -> Result<(), EngineError>;
    /// Record a new actual evaluation COMMITTED result.
    fn evaluation_committed(
        &mut self,
        slot: usize,
        stamp: &CommittedStamp,
        result: &EvaluationResultUnion,
    ) -> Result<(), EngineError>;
    /// Record actual branch terminal commitment after native retirement.
    fn terminal_committed(&mut self, stamp: &CommittedStamp) -> Result<(), EngineError>;
    /// Record successful transmission of the exact terminal ACK response.
    fn terminal_ack_sent(&mut self, stamp: &CommittedStamp) -> Result<(), EngineError>;
    /// Record clean EOF after an ACK with no SDK result or buffer still owed.
    fn channel_closed(&mut self, stamp: &CommittedStamp) -> Result<(), EngineError>;
    /// Retire the entire selected family after failure; unknown effects remain failures.
    fn retire(&mut self) -> Result<(), EngineError>;
}

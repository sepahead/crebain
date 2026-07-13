//! Inert exact-profile lookup for caller-proposed safe-action policy rows.
//!
//! The profile artifact, not this module, owns the meaning and precedence of a
//! situation code. This module validates only a bounded, unambiguous mapping
//! from those opaque codes to a closed candidate-intent vocabulary. It does not
//! classify vehicle health, supply a default action, read a clock, transition
//! lifecycle, convert an intent into an FCU operation, or perform I/O.

use std::fmt;
use std::num::NonZeroU8;

use crate::contract::ProfileIdentity;

/// Maximum number of rows in one candidate safe-action policy.
///
/// The bound is the complete nonzero `u8` situation-code space. It is a
/// computational envelope, not an operational or vehicle limit.
pub const MAX_SAFE_ACTION_POLICY_ROWS_V1: usize = u8::MAX as usize;

/// Error returned when an opaque profile situation code is zero.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SafeActionSituationCodeErrorV1;

impl fmt::Display for SafeActionSituationCodeErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("safe-action situation code must be nonzero")
    }
}

impl std::error::Error for SafeActionSituationCodeErrorV1 {}

/// Opaque nonzero code for one already-classified profile situation.
///
/// The code does not prove that a situation was derived from authenticated,
/// coherent, fresh, or current vehicle state. Its meaning belongs to the exact
/// profile artifact carried separately by [`SafeActionSituationCandidateV1`].
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct SafeActionSituationCodeV1(NonZeroU8);

impl SafeActionSituationCodeV1 {
    /// Creates a nonzero opaque profile situation code.
    ///
    /// # Errors
    ///
    /// Returns [`SafeActionSituationCodeErrorV1`] when `value` is zero.
    pub fn new(value: u8) -> Result<Self, SafeActionSituationCodeErrorV1> {
        NonZeroU8::new(value)
            .map(Self)
            .ok_or(SafeActionSituationCodeErrorV1)
    }

    /// Returns the uninterpreted profile-owned code.
    #[must_use]
    pub const fn get(self) -> u8 {
        self.0.get()
    }
}

/// Closed candidate vocabulary for a future profile-selected safe action.
///
/// These values are not ingress actions or adapter commands. In particular,
/// [`Self::RequestProfileDefinedPhysicalHold`] is not zero velocity and is not a universal
/// physical fallback. Selection still requires a reviewed profile, an
/// authoritative situation classifier, apply-time gates, and a typed adapter
/// transaction in later components.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafeActionIntentV1 {
    /// Candidate intent to stop producing plant output.
    InhibitPlantOutput,
    /// Candidate intent for the exact profile's physical hold behavior.
    RequestProfileDefinedPhysicalHold,
    /// Candidate intent for the exact profile's controlled-land transaction.
    RequestControlledLand,
    /// Candidate intent for the exact profile's return-to-launch transaction.
    RequestReturnToLaunch,
    /// Candidate intent for a guarded ground-disarm transaction.
    RequestGroundDisarmTransaction,
}

/// One unapproved mapping row proposed for an exact profile.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SafeActionPolicyRowProposalV1 {
    situation_code: SafeActionSituationCodeV1,
    intent: SafeActionIntentV1,
}

impl SafeActionPolicyRowProposalV1 {
    /// Creates one proposed situation-to-intent row without approving it.
    #[must_use]
    pub const fn new(
        situation_code: SafeActionSituationCodeV1,
        intent: SafeActionIntentV1,
    ) -> Self {
        Self {
            situation_code,
            intent,
        }
    }

    /// Returns the opaque situation code.
    #[must_use]
    pub const fn situation_code(self) -> SafeActionSituationCodeV1 {
        self.situation_code
    }

    /// Returns the proposed candidate intent.
    #[must_use]
    pub const fn intent(self) -> SafeActionIntentV1 {
        self.intent
    }
}

/// Error returned when a proposed policy table is structurally invalid.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafeActionPolicyConfigurationErrorV1 {
    /// The proposal contained no rows and therefore has no selectable action.
    EmptyTable,
    /// The proposal exceeded the finite situation-code space.
    TooManyRows {
        /// Maximum admitted row count.
        maximum: usize,
        /// Submitted row count.
        received: usize,
    },
    /// More than one row mapped the same situation, making selection ambiguous.
    DuplicateSituation {
        /// Repeated opaque situation code.
        situation_code: SafeActionSituationCodeV1,
    },
}

impl fmt::Display for SafeActionPolicyConfigurationErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyTable => formatter.write_str("safe-action policy table must not be empty"),
            Self::TooManyRows { maximum, received } => write!(
                formatter,
                "safe-action policy has {received} rows; maximum is {maximum}"
            ),
            Self::DuplicateSituation { situation_code } => write!(
                formatter,
                "safe-action situation code {} has more than one proposed intent",
                situation_code.get()
            ),
        }
    }
}

impl std::error::Error for SafeActionPolicyConfigurationErrorV1 {}

/// Bounded, immutable, exact-profile-bound candidate policy.
///
/// Construction copies a borrowed proposal into one owned fixed-size table and
/// rejects missing-table and ambiguity mechanics without allocation. It does
/// not prove that the profile defines those codes, that the rows came from its
/// artifact, or that any selected intent is operationally safe. Two different
/// candidate tables can still assert the same profile identity; later approval
/// must content-bind the canonical table to the reviewed profile artifact.
///
/// The type deliberately has no default policy:
///
/// ```compile_fail
/// use crebain_plant_authority::SafeActionPolicyCandidateV1;
///
/// let _policy = SafeActionPolicyCandidateV1::default();
/// ```
#[derive(Debug)]
pub struct SafeActionPolicyCandidateV1 {
    profile: ProfileIdentity,
    intents: [Option<SafeActionIntentV1>; MAX_SAFE_ACTION_POLICY_ROWS_V1],
    row_count: usize,
}

impl SafeActionPolicyCandidateV1 {
    /// Validates a finite, nonempty, unambiguous borrowed proposal and binds it
    /// to one exact structural profile identity.
    ///
    /// # Errors
    ///
    /// Returns [`SafeActionPolicyConfigurationErrorV1`] for an empty table,
    /// more than [`MAX_SAFE_ACTION_POLICY_ROWS_V1`] rows, or the first duplicate
    /// code in proposal order.
    pub fn try_from_rows(
        profile: ProfileIdentity,
        rows: &[SafeActionPolicyRowProposalV1],
    ) -> Result<Self, SafeActionPolicyConfigurationErrorV1> {
        if rows.len() > MAX_SAFE_ACTION_POLICY_ROWS_V1 {
            return Err(SafeActionPolicyConfigurationErrorV1::TooManyRows {
                maximum: MAX_SAFE_ACTION_POLICY_ROWS_V1,
                received: rows.len(),
            });
        }
        if rows.is_empty() {
            return Err(SafeActionPolicyConfigurationErrorV1::EmptyTable);
        }
        let mut intents = [None; MAX_SAFE_ACTION_POLICY_ROWS_V1];
        for row in rows {
            let index = usize::from(row.situation_code.get() - 1);
            if intents[index].is_some() {
                return Err(SafeActionPolicyConfigurationErrorV1::DuplicateSituation {
                    situation_code: row.situation_code,
                });
            }
            intents[index] = Some(row.intent);
        }
        Ok(Self {
            profile,
            intents,
            row_count: rows.len(),
        })
    }

    /// Returns the exact structural profile identity bound to this candidate.
    #[must_use]
    pub const fn profile(&self) -> ProfileIdentity {
        self.profile
    }

    /// Returns the finite number of uniquely mapped situation codes.
    #[must_use]
    pub const fn row_count(&self) -> usize {
        self.row_count
    }

    /// Looks up one already-classified candidate situation without a fallback.
    ///
    /// This method does not inspect vehicle state, read time, resolve trigger
    /// precedence, or establish health, freshness, safety, eligibility, or
    /// authorization. Exact-profile mismatch is rejected before code lookup.
    ///
    /// # Errors
    ///
    /// Returns [`SafeActionSelectionErrorV1::ProfileMismatch`] when the
    /// candidate situation names another exact profile, or
    /// [`SafeActionSelectionErrorV1::MissingSituation`] when the table has no
    /// exact row. Missing rows never imply Hold or any other default.
    pub fn select(
        &self,
        situation: SafeActionSituationCandidateV1,
    ) -> Result<SafeActionSelectionCandidateV1<'_>, SafeActionSelectionErrorV1> {
        if situation.profile != self.profile {
            return Err(SafeActionSelectionErrorV1::ProfileMismatch {
                policy_profile: self.profile,
                situation_profile: situation.profile,
            });
        }
        let index = usize::from(situation.code.get() - 1);
        let intent = self.intents[index].ok_or(SafeActionSelectionErrorV1::MissingSituation {
            situation_code: situation.code,
        })?;
        Ok(SafeActionSelectionCandidateV1 {
            policy: self,
            situation,
            intent,
        })
    }
}

/// Untrusted already-classified situation bound to one exact profile identity.
///
/// This type deliberately cannot be replaced by a bare code at lookup:
///
/// ```compile_fail
/// use crebain_plant_authority::{
///     SafeActionPolicyCandidateV1, SafeActionSituationCodeV1,
/// };
///
/// fn select_bare_code(
///     policy: &SafeActionPolicyCandidateV1,
///     code: SafeActionSituationCodeV1,
/// ) {
///     let _ = policy.select(code);
/// }
/// ```
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SafeActionSituationCandidateV1 {
    profile: ProfileIdentity,
    code: SafeActionSituationCodeV1,
}

impl SafeActionSituationCandidateV1 {
    /// Binds an untrusted opaque situation code to one exact profile.
    #[must_use]
    pub const fn new(profile: ProfileIdentity, code: SafeActionSituationCodeV1) -> Self {
        Self { profile, code }
    }

    /// Returns the exact structural profile identity asserted by the caller.
    #[must_use]
    pub const fn profile(self) -> ProfileIdentity {
        self.profile
    }

    /// Returns the opaque profile-owned situation code.
    #[must_use]
    pub const fn code(self) -> SafeActionSituationCodeV1 {
        self.code
    }
}

/// Fail-closed reason that no candidate intent was selected.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafeActionSelectionErrorV1 {
    /// Situation and policy are bound to different exact profile identities.
    ProfileMismatch {
        /// Profile identity bound to the candidate policy.
        policy_profile: ProfileIdentity,
        /// Profile identity asserted by the situation candidate.
        situation_profile: ProfileIdentity,
    },
    /// No row exists for the exact opaque situation code.
    MissingSituation {
        /// Unmapped opaque situation code.
        situation_code: SafeActionSituationCodeV1,
    },
}

impl fmt::Display for SafeActionSelectionErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProfileMismatch { .. } => {
                formatter.write_str("safe-action policy profile does not match situation profile")
            }
            Self::MissingSituation { situation_code } => write!(
                formatter,
                "safe-action policy has no row for situation code {}",
                situation_code.get()
            ),
        }
    }
}

impl std::error::Error for SafeActionSelectionErrorV1 {}

/// One inert candidate selection retaining its exact policy and situation.
///
/// It cannot be cloned, directly constructed, decomposed, or converted into an
/// untrusted ingress action:
///
/// ```compile_fail
/// use crebain_plant_authority::SafeActionSelectionCandidateV1;
///
/// fn duplicate(selection: SafeActionSelectionCandidateV1<'_>) {
///     let _copy = selection.clone();
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::{ProposedActionV1, SafeActionSelectionCandidateV1};
///
/// fn turn_into_ingress(selection: SafeActionSelectionCandidateV1<'_>) -> ProposedActionV1 {
///     selection.into()
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::{SafeActionIntentV1, SafeActionSelectionCandidateV1};
///
/// fn implicit_intent(selection: SafeActionSelectionCandidateV1<'_>) -> SafeActionIntentV1 {
///     selection.into()
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::{
///     SafeActionIntentV1, SafeActionPolicyCandidateV1,
///     SafeActionSelectionCandidateV1, SafeActionSituationCandidateV1,
/// };
///
/// fn construct<'a>(
///     policy: &'a SafeActionPolicyCandidateV1,
///     situation: SafeActionSituationCandidateV1,
///     intent: SafeActionIntentV1,
/// ) -> SafeActionSelectionCandidateV1<'a> {
///     SafeActionSelectionCandidateV1 { policy, situation, intent }
/// }
/// ```
#[derive(Debug)]
pub struct SafeActionSelectionCandidateV1<'policy> {
    policy: &'policy SafeActionPolicyCandidateV1,
    situation: SafeActionSituationCandidateV1,
    intent: SafeActionIntentV1,
}

impl<'policy> SafeActionSelectionCandidateV1<'policy> {
    /// Returns the exact immutable candidate policy borrowed by the selection.
    #[must_use]
    pub const fn policy(&self) -> &'policy SafeActionPolicyCandidateV1 {
        self.policy
    }

    /// Returns the exact caller-proposed situation retained by the selection.
    #[must_use]
    pub const fn situation(&self) -> SafeActionSituationCandidateV1 {
        self.situation
    }

    /// Returns the closed candidate intent selected by exact row lookup.
    #[must_use]
    pub const fn intent(&self) -> SafeActionIntentV1 {
        self.intent
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::CandidateProfileKind;

    fn profile(kind: CandidateProfileKind, byte: u8) -> ProfileIdentity {
        ProfileIdentity::new(kind, [byte; 32]).expect("test profile digest is nonzero")
    }

    fn code(value: u8) -> SafeActionSituationCodeV1 {
        SafeActionSituationCodeV1::new(value).expect("test situation code is nonzero")
    }

    fn row(value: u8, intent: SafeActionIntentV1) -> SafeActionPolicyRowProposalV1 {
        SafeActionPolicyRowProposalV1::new(code(value), intent)
    }

    #[test]
    fn situation_code_should_reject_zero() {
        assert_eq!(
            SafeActionSituationCodeV1::new(0),
            Err(SafeActionSituationCodeErrorV1)
        );
    }

    #[test]
    fn policy_should_reject_an_empty_table() {
        let result = SafeActionPolicyCandidateV1::try_from_rows(
            profile(CandidateProfileKind::DraftL1SitlLocalNed, 1),
            &[],
        );

        assert!(matches!(
            result,
            Err(SafeActionPolicyConfigurationErrorV1::EmptyTable)
        ));
    }

    #[test]
    fn policy_should_reject_more_rows_than_the_code_space() {
        let rows: Vec<_> = (0..=u8::MAX)
            .map(|value| {
                row(
                    value.saturating_add(1),
                    SafeActionIntentV1::InhibitPlantOutput,
                )
            })
            .collect();
        let result = SafeActionPolicyCandidateV1::try_from_rows(
            profile(CandidateProfileKind::DraftL1SitlLocalNed, 1),
            &rows,
        );

        assert!(matches!(
            result,
            Err(SafeActionPolicyConfigurationErrorV1::TooManyRows {
                maximum: MAX_SAFE_ACTION_POLICY_ROWS_V1,
                received: 256,
            })
        ));
    }

    #[test]
    fn policy_should_reject_the_first_duplicate_in_proposal_order() {
        let result = SafeActionPolicyCandidateV1::try_from_rows(
            profile(CandidateProfileKind::DraftL1SitlLocalNed, 1),
            &[
                row(9, SafeActionIntentV1::RequestControlledLand),
                row(2, SafeActionIntentV1::RequestProfileDefinedPhysicalHold),
                row(9, SafeActionIntentV1::RequestReturnToLaunch),
                row(2, SafeActionIntentV1::InhibitPlantOutput),
            ],
        );

        assert!(matches!(
            result,
            Err(
                SafeActionPolicyConfigurationErrorV1::DuplicateSituation {
                    situation_code,
                }
            ) if situation_code == code(9)
        ));
    }

    #[test]
    fn selection_should_reject_exact_profile_mismatch_before_lookup() {
        let digest = [7; 32];
        let policy_profile =
            ProfileIdentity::new(CandidateProfileKind::DraftL1SitlLocalNed, digest)
                .expect("test profile digest is nonzero");
        let situation_profile =
            ProfileIdentity::new(CandidateProfileKind::DraftL1SitlLocalEnu, digest)
                .expect("test profile digest is nonzero");
        let policy = SafeActionPolicyCandidateV1::try_from_rows(
            policy_profile,
            &[row(1, SafeActionIntentV1::InhibitPlantOutput)],
        )
        .expect("test policy is structurally valid");

        assert!(matches!(
            policy.select(SafeActionSituationCandidateV1::new(
                situation_profile,
                code(99),
            )),
            Err(SafeActionSelectionErrorV1::ProfileMismatch {
                policy_profile: selected_policy,
                situation_profile: selected_situation,
            }) if selected_policy == policy_profile && selected_situation == situation_profile
        ));
    }

    #[test]
    fn selection_should_reject_same_kind_with_different_profile_digest() {
        let policy_profile = profile(CandidateProfileKind::DraftL1SitlLocalNed, 7);
        let situation_profile = profile(CandidateProfileKind::DraftL1SitlLocalNed, 8);
        let policy = SafeActionPolicyCandidateV1::try_from_rows(
            policy_profile,
            &[row(1, SafeActionIntentV1::InhibitPlantOutput)],
        )
        .expect("test policy is structurally valid");

        assert!(matches!(
            policy.select(SafeActionSituationCandidateV1::new(
                situation_profile,
                code(1),
            )),
            Err(SafeActionSelectionErrorV1::ProfileMismatch {
                policy_profile: selected_policy,
                situation_profile: selected_situation,
            }) if selected_policy == policy_profile && selected_situation == situation_profile
        ));
    }

    #[test]
    fn selection_should_reject_missing_code_without_a_default() {
        let profile = profile(CandidateProfileKind::DraftL1SitlLocalNed, 1);
        let policy = SafeActionPolicyCandidateV1::try_from_rows(
            profile,
            &[row(
                1,
                SafeActionIntentV1::RequestProfileDefinedPhysicalHold,
            )],
        )
        .expect("test policy is structurally valid");

        assert!(matches!(
            policy.select(SafeActionSituationCandidateV1::new(profile, code(2))),
            Err(SafeActionSelectionErrorV1::MissingSituation {
                situation_code,
            }) if situation_code == code(2)
        ));
    }

    #[test]
    fn selection_should_map_every_closed_intent_independent_of_row_order() {
        let profile = profile(CandidateProfileKind::DraftL1SitlLocalNed, 1);
        let intents = [
            SafeActionIntentV1::InhibitPlantOutput,
            SafeActionIntentV1::RequestProfileDefinedPhysicalHold,
            SafeActionIntentV1::RequestControlledLand,
            SafeActionIntentV1::RequestReturnToLaunch,
            SafeActionIntentV1::RequestGroundDisarmTransaction,
        ];
        let rows: Vec<_> = intents
            .iter()
            .copied()
            .enumerate()
            .rev()
            .map(|(index, intent)| {
                let code_value = u8::try_from(index + 1).expect("closed intent count fits in u8");
                row(code_value, intent)
            })
            .collect();
        let policy = SafeActionPolicyCandidateV1::try_from_rows(profile, &rows)
            .expect("test policy is structurally valid");

        let selected: Vec<_> = intents
            .iter()
            .enumerate()
            .map(|(index, expected)| {
                let code_value = u8::try_from(index + 1).expect("closed intent count fits in u8");
                policy
                    .select(SafeActionSituationCandidateV1::new(
                        profile,
                        code(code_value),
                    ))
                    .map(|selection| selection.intent() == *expected)
            })
            .collect();

        assert!(selected.into_iter().all(|result| result == Ok(true)));
    }

    #[test]
    fn policy_should_copy_borrowed_rows_and_accept_code_space_edges() {
        let profile = profile(CandidateProfileKind::DraftL1SitlLocalNed, 1);
        let mut rows = [
            row(1, SafeActionIntentV1::RequestControlledLand),
            row(u8::MAX, SafeActionIntentV1::RequestReturnToLaunch),
        ];
        let policy = SafeActionPolicyCandidateV1::try_from_rows(profile, &rows)
            .expect("test policy is structurally valid");
        rows[0] = row(1, SafeActionIntentV1::InhibitPlantOutput);
        assert_eq!(rows[0].intent(), SafeActionIntentV1::InhibitPlantOutput);

        let first = policy
            .select(SafeActionSituationCandidateV1::new(profile, code(1)))
            .map(|selection| selection.intent());
        let last = policy
            .select(SafeActionSituationCandidateV1::new(profile, code(u8::MAX)))
            .map(|selection| selection.intent());

        assert!(
            first == Ok(SafeActionIntentV1::RequestControlledLand)
                && last == Ok(SafeActionIntentV1::RequestReturnToLaunch)
        );
    }

    #[test]
    fn selection_should_retain_exact_policy_and_situation() {
        let profile = profile(CandidateProfileKind::DraftL1SitlLocalNed, 1);
        let situation = SafeActionSituationCandidateV1::new(profile, code(4));
        let policy = SafeActionPolicyCandidateV1::try_from_rows(
            profile,
            &[row(4, SafeActionIntentV1::RequestReturnToLaunch)],
        )
        .expect("test policy is structurally valid");
        let selection = policy
            .select(situation)
            .expect("exact profile and row should select");

        assert!(
            std::ptr::eq(
                std::ptr::from_ref(selection.policy()),
                std::ptr::from_ref(&policy),
            ) && selection.situation() == situation
                && selection.intent() == SafeActionIntentV1::RequestReturnToLaunch
                && selection.policy().row_count() == 1
        );
    }
}

//! Profile-neutral velocity-axis conventions for the inactive plant foundation.
//!
//! This module performs only exact axis permutation and sign changes between
//! established local conventions (ENU/NED) or established body conventions
//! (FLU/FRD) for one unchanged physical frame instance. A local conversion is
//! valid only for the same tangent origin and datum; a body conversion is valid
//! only for the same rigid-body reference point. This value does not carry or
//! prove that identity. It does not select a deployment profile, rotate between
//! local and body frames, apply attitude, translate points, transform
//! covariance, parse a payload, or grant command authority.

use std::fmt;

use crate::contract::{Axis, VelocityFrame};

/// Finite velocity components in metres per second with an explicit frame.
///
/// This type is intentionally not a command candidate and carries no speed,
/// profile, session, freshness, authorization, or lifecycle proof. It exists
/// only to make frame-convention transformations explicit and testable. Every
/// signed zero is canonicalized to positive zero. The caller must separately
/// prove that a conversion retains the same physical frame instance, origin,
/// datum, and body reference point; this type carries no such identity.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FiniteFramedVelocityMpsV1 {
    frame: VelocityFrame,
    components: [f64; 3],
}

impl FiniteFramedVelocityMpsV1 {
    /// Creates a finite, explicitly framed velocity vector.
    ///
    /// # Errors
    ///
    /// Returns [`FrameConventionError::NonFinite`] for the first NaN or
    /// infinite component in X/Y/Z order.
    pub fn new(frame: VelocityFrame, components: [f64; 3]) -> Result<Self, FrameConventionError> {
        for (index, component) in components.iter().enumerate() {
            if !component.is_finite() {
                let axis = match index {
                    0 => Axis::X,
                    1 => Axis::Y,
                    _ => Axis::Z,
                };
                return Err(FrameConventionError::NonFinite { axis });
            }
        }
        Ok(Self::from_finite_components(frame, components))
    }

    /// Returns the explicit frame carried with the components.
    #[must_use]
    pub const fn frame(self) -> VelocityFrame {
        self.frame
    }

    /// Returns the finite components in metres per second.
    #[must_use]
    pub const fn components(self) -> [f64; 3] {
        self.components
    }

    fn from_finite_components(frame: VelocityFrame, components: [f64; 3]) -> Self {
        Self {
            frame,
            components: components.map(canonical_zero),
        }
    }

    /// Applies an exact axis-convention transform within one frame family.
    ///
    /// ENU↔NED maps `[x, y, z]` to `[y, x, -z]`. FLU↔FRD maps
    /// `[x, y, z]` to `[x, -y, -z]`. Identity transforms preserve the value.
    /// These are axis-convention changes for the same physical frame instance,
    /// not transforms between unrelated origins, datums, or body points.
    /// Local↔body conversion is rejected because it requires authoritative
    /// vehicle attitude that this inert kernel neither owns nor accepts.
    ///
    /// # Errors
    ///
    /// Returns [`FrameConventionError::AttitudeRequired`] for every local/body
    /// cross-family pair.
    pub fn transform_axis_convention(
        self,
        target: VelocityFrame,
    ) -> Result<Self, FrameConventionError> {
        use VelocityFrame::{BodyFlu, BodyFrd, LocalEnu, LocalNed};

        let source = self.frame;
        match (source, target) {
            (LocalEnu, LocalEnu)
            | (LocalNed, LocalNed)
            | (BodyFlu, BodyFlu)
            | (BodyFrd, BodyFrd) => Ok(self),
            (LocalEnu, LocalNed) | (LocalNed, LocalEnu) => {
                let [x, y, z] = self.components;
                Ok(Self::from_finite_components(target, [y, x, -z]))
            }
            (BodyFlu, BodyFrd) | (BodyFrd, BodyFlu) => {
                let [x, y, z] = self.components;
                Ok(Self::from_finite_components(target, [x, -y, -z]))
            }
            (LocalEnu | LocalNed, BodyFlu | BodyFrd) | (BodyFlu | BodyFrd, LocalEnu | LocalNed) => {
                Err(FrameConventionError::AttitudeRequired { source, target })
            }
        }
    }
}

fn canonical_zero(value: f64) -> f64 {
    if value.abs().to_bits() == 0 {
        0.0
    } else {
        value
    }
}

/// Fail-closed reason for rejecting a frame-convention operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FrameConventionError {
    /// An input component was NaN or infinite.
    NonFinite {
        /// First invalid component in X/Y/Z order.
        axis: Axis,
    },
    /// The requested transform crosses local and body frame families.
    AttitudeRequired {
        /// Declared source frame.
        source: VelocityFrame,
        /// Requested target frame.
        target: VelocityFrame,
    },
}

impl fmt::Display for FrameConventionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFinite { axis } => {
                write!(
                    formatter,
                    "frame-convention component {axis:?} is not finite"
                )
            }
            Self::AttitudeRequired { source, target } => write!(
                formatter,
                "frame transform from {source:?} to {target:?} requires vehicle attitude"
            ),
        }
    }
}

impl std::error::Error for FrameConventionError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn finite(frame: VelocityFrame, components: [f64; 3]) -> FiniteFramedVelocityMpsV1 {
        FiniteFramedVelocityMpsV1::new(frame, components)
            .expect("test vector should contain only finite components")
    }

    fn assert_components_exact(actual: [f64; 3], expected: [f64; 3]) {
        assert_eq!(actual.map(f64::to_bits), expected.map(f64::to_bits));
    }

    #[test]
    fn exact_local_and_body_convention_maps_are_involutions() {
        let cases = [
            (
                VelocityFrame::LocalEnu,
                VelocityFrame::LocalNed,
                [2.0, -3.0, 5.0],
                [-3.0, 2.0, -5.0],
            ),
            (
                VelocityFrame::LocalNed,
                VelocityFrame::LocalEnu,
                [2.0, -3.0, 5.0],
                [-3.0, 2.0, -5.0],
            ),
            (
                VelocityFrame::BodyFlu,
                VelocityFrame::BodyFrd,
                [2.0, -3.0, 5.0],
                [2.0, 3.0, -5.0],
            ),
            (
                VelocityFrame::BodyFrd,
                VelocityFrame::BodyFlu,
                [2.0, -3.0, 5.0],
                [2.0, 3.0, -5.0],
            ),
        ];

        for (source, target, input, expected) in cases {
            let transformed = finite(source, input)
                .transform_axis_convention(target)
                .expect("same-family convention transform should succeed");
            assert_eq!(transformed.frame(), target);
            assert_components_exact(transformed.components(), expected);
            assert_components_exact(
                transformed
                    .transform_axis_convention(source)
                    .expect("reverse convention transform should succeed")
                    .components(),
                input,
            );
        }
    }

    #[test]
    fn identity_transforms_preserve_all_closed_frames() {
        for frame in [
            VelocityFrame::LocalEnu,
            VelocityFrame::LocalNed,
            VelocityFrame::BodyFlu,
            VelocityFrame::BodyFrd,
        ] {
            let input = finite(frame, [1.25, -2.5, 3.75]);
            assert_eq!(
                input
                    .transform_axis_convention(frame)
                    .expect("identity transform should succeed"),
                input
            );
        }
    }

    #[test]
    fn exact_transforms_preserve_squared_magnitude_over_integer_grid() {
        let permitted_pairs = [
            (VelocityFrame::LocalEnu, VelocityFrame::LocalNed),
            (VelocityFrame::LocalNed, VelocityFrame::LocalEnu),
            (VelocityFrame::BodyFlu, VelocityFrame::BodyFrd),
            (VelocityFrame::BodyFrd, VelocityFrame::BodyFlu),
        ];

        for (source, target) in permitted_pairs {
            for x in -3..=3 {
                for y in -3..=3 {
                    for z in -3..=3 {
                        let input = [f64::from(x), f64::from(y), f64::from(z)];
                        let transformed = finite(source, input)
                            .transform_axis_convention(target)
                            .expect("same-family convention transform should succeed");
                        let output = transformed.components();
                        let input_norm_squared =
                            input.iter().map(|value| value * value).sum::<f64>();
                        let output_norm_squared =
                            output.iter().map(|value| value * value).sum::<f64>();
                        assert_eq!(output_norm_squared.to_bits(), input_norm_squared.to_bits());
                        assert_components_exact(
                            transformed
                                .transform_axis_convention(source)
                                .expect("round trip should succeed")
                                .components(),
                            input,
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn every_local_body_pair_requires_attitude() {
        let local_frames = [VelocityFrame::LocalEnu, VelocityFrame::LocalNed];
        let body_frames = [VelocityFrame::BodyFlu, VelocityFrame::BodyFrd];

        for local in local_frames {
            for body in body_frames {
                for (source, target) in [(local, body), (body, local)] {
                    assert_eq!(
                        finite(source, [1.0, 2.0, 3.0]).transform_axis_convention(target),
                        Err(FrameConventionError::AttitudeRequired { source, target })
                    );
                }
            }
        }
    }

    #[test]
    fn constructor_rejects_nan_and_infinity_on_every_axis() {
        for (index, axis) in [(0, Axis::X), (1, Axis::Y), (2, Axis::Z)] {
            for rejected in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                let mut components = [1.0, 2.0, 3.0];
                components[index] = rejected;
                assert_eq!(
                    FiniteFramedVelocityMpsV1::new(VelocityFrame::LocalEnu, components),
                    Err(FrameConventionError::NonFinite { axis })
                );
            }
        }
    }

    #[test]
    fn constructor_and_transforms_canonicalize_signed_zero() {
        let input = finite(VelocityFrame::LocalEnu, [-0.0, 0.0, -0.0]);
        assert_components_exact(input.components(), [0.0; 3]);
        assert_components_exact(
            input
                .transform_axis_convention(VelocityFrame::LocalNed)
                .expect("same-family transform should succeed")
                .components(),
            [0.0; 3],
        );

        let body = finite(VelocityFrame::BodyFlu, [0.0; 3])
            .transform_axis_convention(VelocityFrame::BodyFrd)
            .expect("same-family transform should succeed");
        assert_components_exact(body.components(), [0.0; 3]);
    }
}

//! Closed CREBAIN-owned sensor application; construction and installed gates are distinct.
#![deny(missing_docs)]

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub mod application;
pub mod contract;
pub mod engine;
pub mod types;

/// A finite continuous binary64 value that preserves the sign of zero.
#[derive(Clone, Copy, Debug)]
pub struct Finite64(f64);

impl Finite64 {
    /// Admit a finite scalar without normalizing its bits.
    pub fn new(value: f64) -> Result<Self, &'static str> {
        if value.is_finite() {
            Ok(Self(value))
        } else {
            Err("non-finite scalar")
        }
    }

    /// Read the admitted scalar.
    pub fn get(self) -> f64 {
        self.0
    }
}

impl PartialEq for Finite64 {
    fn eq(&self, other: &Self) -> bool {
        self.0.to_bits() == other.0.to_bits()
    }
}

impl Serialize for Finite64 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_f64(self.0)
    }
}

impl<'de> Deserialize<'de> for Finite64 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(f64::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

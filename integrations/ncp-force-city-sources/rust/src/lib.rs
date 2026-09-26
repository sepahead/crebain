//! Closed force-city source application and actual native engine boundary.
#![deny(missing_docs)]

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub mod admission;
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
        struct ContinuousVisitor;

        impl serde::de::Visitor<'_> for ContinuousVisitor {
            type Value = Finite64;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a finite continuous binary64 token")
            }

            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                Finite64::new(value).map_err(E::custom)
            }
        }

        // Integer and boolean visits retain the default rejection. Coercion would
        // disagree with the independent Python continuous-field decoder.
        deserializer.deserialize_any(ContinuousVisitor)
    }
}

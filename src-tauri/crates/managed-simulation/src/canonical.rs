use std::collections::HashSet;

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub(crate) const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PORTABLE_JSON_FLOAT_ABS: f64 = 1.0e300;
const MAX_JSON_DEPTH: usize = 32;
const MAX_JSON_NODES: usize = 20_000;

#[derive(Debug, Error)]
pub(crate) enum CanonicalJsonError {
    #[error("strict JSON decoding failed")]
    Decode,
    #[error("JSON value is outside the portable domain")]
    Domain,
    #[error("canonical JSON encoding failed")]
    Encode,
}

struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictValueVisitor)
    }
}

struct StrictValueVisitor;

impl<'de> Visitor<'de> for StrictValueVisitor {
    type Value = StrictValue;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("one strict JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if !valid_i64(value) {
            return Err(E::custom("integer exceeds the portable exact range"));
        }
        Ok(StrictValue(Value::Number(Number::from(value))))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if !valid_u64(value) {
            return Err(E::custom("integer exceeds the portable exact range"));
        }
        Ok(StrictValue(Value::Number(Number::from(value))))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if !valid_f64(value) {
            return Err(E::custom("number is outside the portable finite range"));
        }
        Number::from_f64(value)
            .map(Value::Number)
            .map(StrictValue)
            .ok_or_else(|| E::custom("number is not JSON representable"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        validate_string(value).map_err(E::custom)?;
        Ok(StrictValue(Value::String(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        validate_string(&value).map_err(E::custom)?;
        Ok(StrictValue(Value::String(value)))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(StrictValue(value)) = sequence.next_element::<StrictValue>()? {
            values.push(value);
            if values.len() > MAX_JSON_NODES {
                return Err(de::Error::custom("JSON sequence exceeds the node bound"));
            }
        }
        Ok(StrictValue(Value::Array(values)))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        let mut seen = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            validate_string(&key).map_err(de::Error::custom)?;
            if !seen.insert(key.clone()) {
                return Err(de::Error::custom("JSON object contains a duplicate member"));
            }
            let StrictValue(value) = map.next_value::<StrictValue>()?;
            values.insert(key, value);
            if values.len() > MAX_JSON_NODES {
                return Err(de::Error::custom("JSON object exceeds the node bound"));
            }
        }
        Ok(StrictValue(Value::Object(values)))
    }
}

fn validate_string(value: &str) -> Result<(), &'static str> {
    if value.chars().any(|character| {
        let codepoint = character as u32;
        character == '\u{fffd}'
            || (0xfdd0..=0xfdef).contains(&codepoint)
            || (codepoint & 0xffff == 0xfffe)
            || (codepoint & 0xffff == 0xffff)
            || (codepoint < 0x20 && !matches!(character, '\t' | '\n' | '\r'))
            || (0x7f..=0x9f).contains(&codepoint)
    }) {
        return Err("string contains a nonportable Unicode scalar");
    }
    Ok(())
}

fn valid_i64(value: i64) -> bool {
    value.unsigned_abs() <= MAX_SAFE_JSON_INTEGER
}

fn valid_u64(value: u64) -> bool {
    value <= MAX_SAFE_JSON_INTEGER
}

fn valid_f64(value: f64) -> bool {
    value.is_finite()
        && value.abs() <= MAX_PORTABLE_JSON_FLOAT_ABS
        && !(value == 0.0 && value.is_sign_negative())
}

pub(crate) fn validate_number(number: &Number) -> Result<(), CanonicalJsonError> {
    let valid = if number.is_i64() {
        number.as_i64().is_some_and(valid_i64)
    } else if number.is_u64() {
        number.as_u64().is_some_and(valid_u64)
    } else if number.is_f64() {
        number.as_f64().is_some_and(valid_f64)
    } else {
        false
    };
    if valid {
        Ok(())
    } else {
        Err(CanonicalJsonError::Domain)
    }
}

fn validate_structure(root: &Value) -> Result<(), CanonicalJsonError> {
    let mut stack = vec![(root, 1_usize)];
    let mut nodes = 0_usize;
    while let Some((value, depth)) = stack.pop() {
        account_node(&mut nodes, depth)?;
        match value {
            Value::Null | Value::Bool(_) => {}
            Value::Number(number) => validate_number(number)?,
            Value::String(value) => {
                validate_string(value).map_err(|_| CanonicalJsonError::Domain)?
            }
            Value::Array(values) => {
                stack.extend(values.iter().map(|value| (value, depth + 1)));
            }
            Value::Object(values) => {
                let child_depth = depth.checked_add(1).ok_or(CanonicalJsonError::Domain)?;
                for (key, value) in values {
                    validate_string(key).map_err(|_| CanonicalJsonError::Domain)?;
                    account_node(&mut nodes, child_depth)?;
                    stack.push((value, child_depth));
                }
            }
        }
    }
    Ok(())
}

fn account_node(nodes: &mut usize, depth: usize) -> Result<(), CanonicalJsonError> {
    *nodes = nodes.checked_add(1).ok_or(CanonicalJsonError::Domain)?;
    if *nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH {
        return Err(CanonicalJsonError::Domain);
    }
    Ok(())
}

pub(crate) fn strict_json(payload: &[u8]) -> Result<Value, CanonicalJsonError> {
    let mut deserializer = serde_json::Deserializer::from_slice(payload);
    let StrictValue(value) =
        StrictValue::deserialize(&mut deserializer).map_err(|_| CanonicalJsonError::Decode)?;
    deserializer.end().map_err(|_| CanonicalJsonError::Decode)?;
    validate_structure(&value)?;
    Ok(value)
}

pub(crate) fn to_value<T: Serialize>(value: &T) -> Result<Value, CanonicalJsonError> {
    let value = serde_json::to_value(value).map_err(|_| CanonicalJsonError::Encode)?;
    validate_structure(&value)?;
    Ok(value)
}

pub(crate) fn canonical_json(value: &Value) -> Result<Vec<u8>, CanonicalJsonError> {
    validate_structure(value)?;
    let mut output = Vec::new();
    encode_value(value, &mut output)?;
    Ok(output)
}

fn encode_value(value: &Value, output: &mut Vec<u8>) -> Result<(), CanonicalJsonError> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(false) => output.extend_from_slice(b"false"),
        Value::Bool(true) => output.extend_from_slice(b"true"),
        Value::Number(number) => output.extend_from_slice(number.to_string().as_bytes()),
        Value::String(value) => {
            let encoded = serde_json::to_string(value).map_err(|_| CanonicalJsonError::Encode)?;
            output.extend_from_slice(encoded.as_bytes());
        }
        Value::Array(values) => {
            output.push(b'[');
            for (index, child) in values.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                encode_value(child, output)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            output.push(b'{');
            let mut keys: Vec<&String> = values.keys().collect();
            keys.sort_unstable();
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                let encoded_key =
                    serde_json::to_string(key).map_err(|_| CanonicalJsonError::Encode)?;
                output.extend_from_slice(encoded_key.as_bytes());
                output.push(b':');
                let child = values.get(*key).ok_or(CanonicalJsonError::Encode)?;
                encode_value(child, output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

pub(crate) fn sha256_domain(domain: &str, payloads: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    digest.update(domain.as_bytes());
    digest.update([0]);
    for payload in payloads {
        digest.update((payload.len() as u64).to_be_bytes());
        digest.update(payload);
    }
    lower_hex(digest.finalize().as_slice())
}

pub(crate) fn sha256_bytes(payload: &[u8]) -> String {
    lower_hex(Sha256::digest(payload).as_slice())
}

fn lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct FiniteFloatCorpus {
        schema_version: String,
        canonicalizer: String,
        cases: Vec<FiniteFloatCase>,
        randomized: RandomizedFiniteFloatCorpus,
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct FiniteFloatCase {
        id: String,
        binary64_be_hex: String,
        portable: bool,
        canonical_json: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RandomizedFiniteFloatCorpus {
        algorithm: String,
        seed_hex: String,
        sample_count: usize,
        accepted_count: usize,
        transcript: String,
        transcript_sha256: String,
    }

    #[derive(Serialize)]
    struct InternalResponseVector {
        simulated_position_m: Vec<f64>,
    }

    #[test]
    fn strict_json_rejects_duplicate_members() {
        let result = strict_json(br#"{"a":1,"a":2}"#);

        assert!(matches!(result, Err(CanonicalJsonError::Decode)));
    }

    #[test]
    fn canonical_json_orders_object_members() {
        let value = strict_json(br#"{"z":1,"a":[true,null]}"#).expect("valid fixture");

        assert_eq!(
            canonical_json(&value).expect("canonical fixture"),
            br#"{"a":[true,null],"z":1}"#
        );
    }

    fn object_at_node_boundary(extra_array_children: usize) -> Value {
        let mut values = Map::new();
        for index in 0..9_999 {
            values.insert(format!("key-{index:04}"), Value::Bool(false));
        }
        values.insert(
            "key-0000".to_string(),
            Value::Array(vec![Value::Null; extra_array_children]),
        );
        Value::Object(values)
    }

    #[test]
    fn canonical_json_counts_object_keys_and_values_at_the_host_boundary() {
        let exact_limit = object_at_node_boundary(1);

        assert!(canonical_json(&exact_limit).is_ok());
    }

    #[test]
    fn canonical_json_rejects_one_node_beyond_the_host_boundary() {
        let over_limit = object_at_node_boundary(2);

        assert!(matches!(
            canonical_json(&over_limit),
            Err(CanonicalJsonError::Domain)
        ));
    }

    #[test]
    fn strict_json_rejects_negative_zero() {
        let result = strict_json(br#"{"value":-0.0}"#);

        assert!(matches!(result, Err(CanonicalJsonError::Decode)));
    }

    #[test]
    fn internal_response_vector_rejects_negative_zero() {
        let response = InternalResponseVector {
            simulated_position_m: vec![-0.0, 1.0, 2.0],
        };

        assert!(matches!(
            to_value(&response),
            Err(CanonicalJsonError::Domain)
        ));

        let positive_zero = InternalResponseVector {
            simulated_position_m: vec![0.0, 1.0, 2.0],
        };
        assert!(to_value(&positive_zero).is_ok());
    }

    #[test]
    fn internal_numbers_reject_nonportable_integer_and_float_values() {
        let values = [
            Value::Number(Number::from(MAX_SAFE_JSON_INTEGER + 1)),
            Value::Number(Number::from(-9_007_199_254_740_992_i64)),
            Value::Number(Number::from_f64(f64::MAX).expect("finite f64 is representable")),
        ];

        for value in values {
            assert!(matches!(
                canonical_json(&value),
                Err(CanonicalJsonError::Domain)
            ));
        }
        assert!(matches!(
            to_value(&(MAX_SAFE_JSON_INTEGER + 1)),
            Err(CanonicalJsonError::Domain)
        ));
    }

    #[test]
    fn rust_matches_the_engram_python_finite_float_corpus() {
        let corpus_value = strict_json(include_bytes!(
            "../../../../integrations/engram/managed-simulation/contracts/engram.managed-runtime-finite-float.v1.json"
        ))
        .expect("finite-float corpus is strict JSON");
        let corpus: FiniteFloatCorpus =
            serde_json::from_value(corpus_value).expect("finite-float corpus is typed");
        assert_eq!(
            corpus.schema_version,
            "engram.managed-runtime-finite-float.v1"
        );
        assert_eq!(corpus.canonicalizer, "engram.managed-runtime-json.v1");

        for case in corpus.cases {
            let bits = u64::from_str_radix(&case.binary64_be_hex, 16)
                .unwrap_or_else(|_| panic!("{} has valid binary64 bits", case.id));
            let value = f64::from_bits(bits);
            assert!(value.is_finite(), "{} must remain a finite case", case.id);
            let direct = canonical_json(&Value::Number(
                Number::from_f64(value)
                    .unwrap_or_else(|| panic!("{} is JSON-number representable", case.id)),
            ));
            let serialized = to_value(&value).and_then(|value| canonical_json(&value));

            if case.portable {
                let expected = case
                    .canonical_json
                    .unwrap_or_else(|| panic!("{} has canonical bytes", case.id));
                let direct =
                    direct.unwrap_or_else(|error| panic!("{} direct Number: {error}", case.id));
                let serialized = serialized
                    .unwrap_or_else(|error| panic!("{} serialized f64: {error}", case.id));
                assert_eq!(
                    direct,
                    expected.as_bytes(),
                    "direct Number mismatch for {}",
                    case.id
                );
                assert_eq!(
                    serialized,
                    expected.as_bytes(),
                    "serialized f64 mismatch for {}",
                    case.id
                );
            } else {
                assert!(
                    matches!(direct, Err(CanonicalJsonError::Domain)),
                    "direct Number unexpectedly admitted {}",
                    case.id
                );
                assert!(
                    matches!(serialized, Err(CanonicalJsonError::Domain)),
                    "serialized f64 unexpectedly admitted {}",
                    case.id
                );
            }
        }

        let randomized = corpus.randomized;
        assert_eq!(randomized.algorithm, "splitmix64-v1");
        assert_eq!(
            randomized.transcript,
            r"lowercase-binary64-hex:canonical-json-or-rejected\n"
        );
        assert!((1..=100_000).contains(&randomized.sample_count));
        let mut state = u64::from_str_radix(&randomized.seed_hex, 16)
            .expect("randomized corpus has one binary64 seed");
        let mut transcript = String::new();
        let mut accepted = 0usize;
        for _ in 0..randomized.sample_count {
            state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut bits = state;
            bits = (bits ^ (bits >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            bits = (bits ^ (bits >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            bits ^= bits >> 31;
            let value = f64::from_bits(bits);
            let rendered = Number::from_f64(value)
                .ok_or(CanonicalJsonError::Domain)
                .and_then(|number| canonical_json(&Value::Number(number)));
            let rendered = match rendered {
                Ok(payload) => {
                    accepted += 1;
                    String::from_utf8(payload).expect("canonical float is ASCII")
                }
                Err(CanonicalJsonError::Domain) => "rejected".to_owned(),
                Err(error) => panic!("randomized canonicalization failed unexpectedly: {error}"),
            };
            transcript.push_str(&format!("{bits:016x}:{rendered}\n"));
        }
        assert_eq!(accepted, randomized.accepted_count);
        assert_eq!(
            sha256_bytes(transcript.as_bytes()),
            randomized.transcript_sha256
        );
    }
}

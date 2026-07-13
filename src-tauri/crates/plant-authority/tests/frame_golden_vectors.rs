use std::fs;
use std::path::Path;

use crebain_plant_authority::{FiniteFramedVelocityMpsV1, FrameConventionError, VelocityFrame};

const HEADER: &str = "case_id\tfrom_frame\tto_frame\tunits\tvector_case\tinput_x\tinput_y\tinput_z\texpected_x\texpected_y\texpected_z";
const ROUTES: [(&str, &str); 8] = [
    ("local_enu", "local_enu"),
    ("local_enu", "local_ned"),
    ("local_ned", "local_enu"),
    ("local_ned", "local_ned"),
    ("body_flu", "body_flu"),
    ("body_flu", "body_frd"),
    ("body_frd", "body_flu"),
    ("body_frd", "body_frd"),
];
const VECTOR_CASES: [&str; 4] = ["basis_x", "basis_y", "basis_z", "asymmetric_signed"];

fn corpus_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/baselines/plant-frame-golden-v1.tsv")
}

fn parse_frame(value: &str) -> VelocityFrame {
    match value {
        "local_enu" => VelocityFrame::LocalEnu,
        "local_ned" => VelocityFrame::LocalNed,
        "body_flu" => VelocityFrame::BodyFlu,
        "body_frd" => VelocityFrame::BodyFrd,
        _ => panic!("unknown frame label in golden corpus: {value}"),
    }
}

fn parse_component(value: &str) -> Result<f64, String> {
    let unsigned = value.strip_prefix('-').unwrap_or(value);
    let mut parts = unsigned.split('.');
    let integer = parts.next().unwrap_or_default();
    let fraction = parts.next();

    if parts.next().is_some()
        || integer.is_empty()
        || integer.len() > 3
        || !integer.bytes().all(|byte| byte.is_ascii_digit())
        || (integer.len() > 1 && integer.starts_with('0'))
    {
        return Err(format!("'{value}' is not a canonical plain decimal"));
    }
    if let Some(fraction) = fraction {
        if fraction.is_empty()
            || fraction.len() > 6
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
            || fraction.ends_with('0')
        {
            return Err(format!("'{value}' has a noncanonical fractional part"));
        }
    }

    let parsed = value
        .parse::<f64>()
        .map_err(|error| format!("invalid corpus component '{value}': {error}"))?;
    if !parsed.is_finite() {
        return Err(format!("corpus component '{value}' is not finite"));
    }
    if parsed == 0.0 && parsed.is_sign_negative() {
        return Err(format!("corpus component '{value}' is negative zero"));
    }
    if parsed.to_string() != value {
        return Err(format!(
            "'{value}' is not the shortest round-trip decimal for its value"
        ));
    }
    Ok(parsed)
}

fn parse_components(fields: &[&str]) -> Result<[f64; 3], String> {
    if fields.len() != 3 {
        return Err(format!(
            "component slice contains {} values instead of three",
            fields.len()
        ));
    }
    Ok([
        parse_component(fields[0])?,
        parse_component(fields[1])?,
        parse_component(fields[2])?,
    ])
}

fn assert_components_exact(actual: [f64; 3], expected: [f64; 3]) {
    assert_eq!(actual.map(f64::to_bits), expected.map(f64::to_bits));
}

#[test]
fn rust_kernel_should_match_every_shared_golden_vector() {
    let corpus_file = corpus_path();
    let corpus = fs::read_to_string(&corpus_file)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", corpus_file.display()));
    assert!(corpus.ends_with('\n'), "corpus must end with one LF");
    assert!(!corpus.contains('\r'), "corpus must use LF line endings");

    let mut lines = corpus.lines();
    assert_eq!(lines.next(), Some(HEADER));
    let rows = lines.collect::<Vec<_>>();
    assert_eq!(rows.len(), ROUTES.len() * VECTOR_CASES.len());

    for (index, row) in rows.iter().enumerate() {
        let fields = row.split('\t').collect::<Vec<_>>();
        assert_eq!(fields.len(), 11, "row {} must have 11 fields", index + 2);

        let route = ROUTES[index / VECTOR_CASES.len()];
        let vector_case = VECTOR_CASES[index % VECTOR_CASES.len()];
        assert_eq!((fields[1], fields[2]), route);
        assert_eq!(fields[3], "m/s");
        assert_eq!(fields[4], vector_case);
        assert_eq!(
            fields[0],
            format!("{}__to__{}__{vector_case}", route.0, route.1)
        );

        let source = parse_frame(fields[1]);
        let target = parse_frame(fields[2]);
        let input = parse_components(&fields[5..8])
            .unwrap_or_else(|error| panic!("invalid golden input: {error}"));
        let expected = parse_components(&fields[8..11])
            .unwrap_or_else(|error| panic!("invalid golden output: {error}"));
        let transformed = FiniteFramedVelocityMpsV1::new(source, input)
            .expect("golden input must be finite")
            .transform_axis_convention(target)
            .expect("golden route must be an allowed axis convention");

        assert_eq!(transformed.frame(), target);
        assert_components_exact(transformed.components(), expected);
        assert_components_exact(
            transformed
                .transform_axis_convention(source)
                .expect("golden route must round-trip")
                .components(),
            input,
        );
    }
}

#[test]
fn corpus_number_parser_should_reject_many_to_one_lexemes() {
    for valid in [
        "0",
        "1",
        "-1",
        "1.5",
        "-2.25",
        "0.000001",
        "999.999999",
        "-999.999999",
    ] {
        assert!(
            parse_component(valid).is_ok(),
            "'{valid}' must be canonical"
        );
    }

    for invalid in [
        "-0",
        "-0.0",
        "+1",
        "01",
        "1.0",
        "1e0",
        "1000",
        "0.0000001",
        "1.5000000000000001",
    ] {
        assert!(
            parse_component(invalid).is_err(),
            "'{invalid}' must be rejected"
        );
    }

    let underflow_alias = format!("0.{}1", "0".repeat(400));
    assert!(parse_component(&underflow_alias).is_err());
}

#[test]
fn shared_convention_should_reject_every_local_body_pair_without_attitude() {
    let local_frames = [VelocityFrame::LocalEnu, VelocityFrame::LocalNed];
    let body_frames = [VelocityFrame::BodyFlu, VelocityFrame::BodyFrd];

    for local in local_frames {
        for body in body_frames {
            for (source, target) in [(local, body), (body, local)] {
                let velocity = FiniteFramedVelocityMpsV1::new(source, [1.0, -2.0, 3.0])
                    .expect("test vector must be finite");
                assert_eq!(
                    velocity.transform_axis_convention(target),
                    Err(FrameConventionError::AttitudeRequired { source, target })
                );
            }
        }
    }
}

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer};

pub(crate) const CURRENT_SCENE_VERSION: &str = "1.0.0";

const MAX_SCENE_CAMERAS: usize = 64;
const MAX_SCENE_DRONES: usize = 256;
const MAX_SCENE_ASSETS: usize = 128;
const MAX_SCENE_DETECTIONS: usize = 10_000;
const MAX_CAMERA_PATROL_POINTS: usize = 4_096;
const MAX_ROUTE_WAYPOINTS: usize = 256;
const MAX_NAME_BYTES: usize = 256;
const MAX_SOURCE_BYTES: usize = 2_048;
const MAX_CAMERA_RENDER_PIXELS: u64 = 16_777_216;
const MAX_VECTOR_COMPONENT: f64 = 1_000_000.0;
const MAX_ROUTE_ALTITUDE_M: f64 = 4_500.0;
const MIN_CAMERA_PAN_DEGREES: f64 = -180.0;
const MAX_CAMERA_PAN_DEGREES: f64 = 180.0;
const MIN_CAMERA_TILT_DEGREES: f64 = -85.0;
const MAX_CAMERA_TILT_DEGREES: f64 = 85.0;
const MIN_CAMERA_FOV_DEGREES: f64 = 5.0;
const MAX_CAMERA_FOV_DEGREES: f64 = 120.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneDocument {
    version: String,
    timestamp: f64,
    name: String,
    #[serde(default, deserialize_with = "deserialize_present")]
    description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    splat_scene: Option<SplatSceneDocument>,
    #[serde(default)]
    assets: Vec<SceneAssetDocument>,
    cameras: Vec<CameraDocument>,
    #[serde(default, deserialize_with = "deserialize_present")]
    active_camera_id: Option<String>,
    drones: Vec<DroneDocument>,
    recent_detections: Vec<DetectionDocument>,
    settings: ViewerSettingsDocument,
    view_camera: ViewCameraDocument,
    #[serde(default, deserialize_with = "deserialize_present")]
    metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
struct Vector3Document {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
struct QuaternionDocument {
    x: f64,
    y: f64,
    z: f64,
    w: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CameraDocument {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    position: Vector3Document,
    rotation: Vector3Document,
    fov: f64,
    near: f64,
    far: f64,
    is_active: bool,
    resolution: [u32; 2],
    #[serde(default, deserialize_with = "deserialize_present")]
    pan: Option<f64>,
    #[serde(default, deserialize_with = "deserialize_present")]
    tilt: Option<f64>,
    #[serde(default, deserialize_with = "deserialize_present")]
    zoom: Option<f64>,
    #[serde(default, deserialize_with = "deserialize_present")]
    patrol_points: Option<Vec<Vector3Document>>,
    #[serde(default, deserialize_with = "deserialize_present")]
    patrol_speed: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DroneDocument {
    id: String,
    #[serde(default, deserialize_with = "deserialize_present")]
    name: Option<String>,
    #[serde(rename = "type")]
    kind: String,
    position: Vector3Document,
    orientation: QuaternionDocument,
    velocity: Vector3Document,
    angular_velocity: Vector3Document,
    armed: bool,
    battery: f64,
    #[serde(default, deserialize_with = "deserialize_present")]
    target_altitude: Option<f64>,
    #[serde(default, deserialize_with = "deserialize_present")]
    target_position: Option<Vector3Document>,
    #[serde(default, deserialize_with = "deserialize_present")]
    flight_mode: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    waypoints: Option<Vec<Vector3Document>>,
    #[serde(default, deserialize_with = "deserialize_present")]
    route_mode: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    route_active: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_present")]
    route_current_waypoint_index: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetectionDocument {
    id: String,
    camera_id: String,
    class: String,
    confidence: f64,
    bbox: [f64; 4],
    timestamp: f64,
    threat_level: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplatSceneDocument {
    url: String,
    #[serde(default, deserialize_with = "deserialize_present")]
    local_path: Option<String>,
    position: Vector3Document,
    rotation: Vector3Document,
    scale: Vector3Document,
}

#[derive(Debug, Deserialize)]
struct SceneAssetDocument {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    source: String,
    position: Vector3Document,
    rotation: Vector3Document,
    scale: Vector3Document,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewerSettingsDocument {
    detection_enabled: bool,
    show_detection_panel: bool,
    show_performance_panel: bool,
    render_quality: String,
    physics_enabled: bool,
    sensor_simulation_enabled: bool,
}

#[derive(Debug, Deserialize)]
struct ViewCameraDocument {
    position: Vector3Document,
    target: Vector3Document,
}

/// Accept an omitted optional field, but reject an explicit JSON `null`.
///
/// The frontend contract uses `undefined` for absence. Without this helper,
/// Serde also maps `null` to `None`, which would let the backend persist a
/// document that the frontend cannot deserialize.
fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn scene_error(path: &str, reason: &str) -> String {
    format!("Invalid scene JSON at {path}: {reason}")
}

fn is_bounded_name(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= MAX_NAME_BYTES
        && !value.chars().any(char::is_control)
}

fn validate_vector(value: Vector3Document, path: &str) -> Result<(), String> {
    if [value.x, value.y, value.z]
        .into_iter()
        .all(|component| component.is_finite() && component.abs() <= MAX_VECTOR_COMPONENT)
    {
        Ok(())
    } else {
        Err(scene_error(path, "components must be finite and bounded"))
    }
}

fn validate_positive_scale(value: Vector3Document, path: &str) -> Result<(), String> {
    validate_vector(value, path)?;
    if value.x > 0.0 && value.y > 0.0 && value.z > 0.0 {
        Ok(())
    } else {
        Err(scene_error(path, "scale components must be positive"))
    }
}

fn validate_route_position(
    value: Vector3Document,
    maximum_altitude: f64,
    path: &str,
) -> Result<(), String> {
    validate_vector(value, path)?;
    if value.y >= 0.0 && value.y <= maximum_altitude {
        Ok(())
    } else {
        Err(scene_error(path, "altitude is outside the drone profile"))
    }
}

fn drone_maximum_altitude(kind: &str) -> Option<f64> {
    match kind {
        "maverick" => Some(500.0),
        "shahed" => Some(4_000.0),
        "fpv_racer" => Some(200.0),
        "recon_hex" => Some(3_000.0),
        "switchblade" => Some(4_500.0),
        _ => None,
    }
}

fn has_ambiguous_source_character(value: &str) -> bool {
    value
        .chars()
        .any(|character| character <= '\u{1f}' || character == '\u{7f}' || character == '\\')
}

fn is_reloadable_scene_source(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_SOURCE_BYTES
        || value.trim() != value
        || value.starts_with("//")
        || has_ambiguous_source_character(value)
    {
        return false;
    }
    if (value.starts_with('/') && !value.starts_with("//"))
        || value.starts_with("./")
        || value.starts_with("../")
    {
        return true;
    }

    let has_network_prefix = |prefix: &str| {
        value
            .get(..prefix.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
            && value
                .get(prefix.len()..)
                .is_some_and(|remainder| !remainder.is_empty() && !remainder.starts_with('/'))
    };
    if !has_network_prefix("https://") && !has_network_prefix("http://") {
        return false;
    }

    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
        ),
        _ => false,
    }
}

fn source_path(value: &str) -> &str {
    value.split(['?', '#']).next().unwrap_or(value)
}

fn is_reloadable_splat_source(value: &str) -> bool {
    if !is_reloadable_scene_source(value) {
        return false;
    }
    let path = source_path(value).to_ascii_lowercase();
    [".spz", ".ply", ".splat", ".ksplat"]
        .iter()
        .any(|extension| path.ends_with(extension))
}

fn is_reloadable_glb_source(value: &str) -> bool {
    is_reloadable_scene_source(value) && source_path(value).to_ascii_lowercase().ends_with(".glb")
}

fn validate_camera(camera: &CameraDocument, index: usize) -> Result<u64, String> {
    let path = format!("cameras[{index}]");
    if !is_bounded_name(&camera.id) || !is_bounded_name(&camera.name) {
        return Err(scene_error(
            &path,
            "id and name must be non-empty and bounded",
        ));
    }
    if !matches!(camera.kind.as_str(), "static" | "ptz" | "patrol") {
        return Err(scene_error(
            &format!("{path}.type"),
            "unsupported camera type",
        ));
    }
    validate_vector(camera.position, &format!("{path}.position"))?;
    validate_vector(camera.rotation, &format!("{path}.rotation"))?;
    if !camera.fov.is_finite() || camera.fov <= 0.0 || camera.fov >= 180.0 {
        return Err(scene_error(&format!("{path}.fov"), "must be in (0, 180)"));
    }
    if !camera.near.is_finite()
        || !camera.far.is_finite()
        || camera.near <= 0.0
        || camera.far <= camera.near
    {
        return Err(scene_error(
            &path,
            "near and far clipping planes are invalid",
        ));
    }
    if camera.resolution[0] == 0
        || camera.resolution[1] == 0
        || camera.resolution[0] > 4_096
        || camera.resolution[1] > 4_096
    {
        return Err(scene_error(
            &format!("{path}.resolution"),
            "dimensions are invalid",
        ));
    }
    if camera.pan.is_some_and(|pan| {
        !pan.is_finite() || !(MIN_CAMERA_PAN_DEGREES..=MAX_CAMERA_PAN_DEGREES).contains(&pan)
    }) {
        return Err(scene_error(
            &format!("{path}.pan"),
            "must be in [-180, 180]",
        ));
    }
    if camera.tilt.is_some_and(|tilt| {
        !tilt.is_finite() || !(MIN_CAMERA_TILT_DEGREES..=MAX_CAMERA_TILT_DEGREES).contains(&tilt)
    }) {
        return Err(scene_error(&format!("{path}.tilt"), "must be in [-85, 85]"));
    }
    if camera.zoom.is_some_and(|zoom| {
        !zoom.is_finite() || !(MIN_CAMERA_FOV_DEGREES..=MAX_CAMERA_FOV_DEGREES).contains(&zoom)
    }) {
        return Err(scene_error(&format!("{path}.zoom"), "must be in [5, 120]"));
    }
    if let Some(points) = &camera.patrol_points {
        if points.len() > MAX_CAMERA_PATROL_POINTS {
            return Err(scene_error(
                &format!("{path}.patrolPoints"),
                "too many points",
            ));
        }
        for (point_index, point) in points.iter().copied().enumerate() {
            validate_vector(point, &format!("{path}.patrolPoints[{point_index}]"))?;
        }
    }
    if camera
        .patrol_speed
        .is_some_and(|speed| !speed.is_finite() || !(0.0..=1.0).contains(&speed))
    {
        return Err(scene_error(
            &format!("{path}.patrolSpeed"),
            "must be in [0, 1]",
        ));
    }
    let _ = camera.is_active;
    Ok(u64::from(camera.resolution[0]) * u64::from(camera.resolution[1]))
}

fn validate_drone(drone: &DroneDocument, index: usize) -> Result<(), String> {
    let path = format!("drones[{index}]");
    if !is_bounded_name(&drone.id)
        || drone
            .name
            .as_deref()
            .is_some_and(|name| !is_bounded_name(name))
    {
        return Err(scene_error(&path, "id and optional name must be bounded"));
    }
    let Some(maximum_altitude) = drone_maximum_altitude(&drone.kind) else {
        return Err(scene_error(&format!("{path}.type"), "unknown drone type"));
    };
    validate_vector(drone.position, &format!("{path}.position"))?;
    validate_vector(drone.velocity, &format!("{path}.velocity"))?;
    validate_vector(drone.angular_velocity, &format!("{path}.angularVelocity"))?;

    let quaternion = drone.orientation;
    let norm_squared = quaternion.x * quaternion.x
        + quaternion.y * quaternion.y
        + quaternion.z * quaternion.z
        + quaternion.w * quaternion.w;
    if !norm_squared.is_finite() || (norm_squared.sqrt() - 1.0).abs() > 0.01 {
        return Err(scene_error(
            &format!("{path}.orientation"),
            "must be normalized",
        ));
    }
    if !drone.battery.is_finite() || !(0.0..=100.0).contains(&drone.battery) {
        return Err(scene_error(
            &format!("{path}.battery"),
            "must be in [0, 100]",
        ));
    }
    if drone.target_altitude.is_some_and(|altitude| {
        !altitude.is_finite() || !(0.0..=maximum_altitude).contains(&altitude)
    }) {
        return Err(scene_error(
            &format!("{path}.targetAltitude"),
            "outside the drone profile",
        ));
    }
    if let Some(position) = drone.target_position {
        validate_route_position(
            position,
            maximum_altitude,
            &format!("{path}.targetPosition"),
        )?;
    }
    if drone.flight_mode.as_deref().is_some_and(|mode| {
        !matches!(
            mode,
            "manual" | "stabilized" | "altitude_hold" | "position_hold" | "waypoint"
        )
    }) {
        return Err(scene_error(
            &format!("{path}.flightMode"),
            "unsupported mode",
        ));
    }
    if drone
        .route_mode
        .as_deref()
        .is_some_and(|mode| !matches!(mode, "none" | "once" | "patrol"))
    {
        return Err(scene_error(
            &format!("{path}.routeMode"),
            "unsupported mode",
        ));
    }
    let waypoints = drone.waypoints.as_deref().unwrap_or_default();
    if waypoints.len() > MAX_ROUTE_WAYPOINTS {
        return Err(scene_error(
            &format!("{path}.waypoints"),
            "too many waypoints",
        ));
    }
    for (waypoint_index, waypoint) in waypoints.iter().copied().enumerate() {
        validate_route_position(
            waypoint,
            maximum_altitude.min(MAX_ROUTE_ALTITUDE_M),
            &format!("{path}.waypoints[{waypoint_index}]"),
        )?;
    }
    if let Some(current) = drone.route_current_waypoint_index {
        let valid = if waypoints.is_empty() {
            current == 0
        } else {
            current < waypoints.len()
        };
        if !valid {
            return Err(scene_error(
                &format!("{path}.routeCurrentWaypointIndex"),
                "outside the route",
            ));
        }
    }
    if drone.route_active == Some(true)
        && (waypoints.is_empty() || drone.route_mode.as_deref() == Some("none"))
    {
        return Err(scene_error(
            &format!("{path}.routeActive"),
            "route cannot be active",
        ));
    }
    if drone.route_mode.as_deref() == Some("none") && !waypoints.is_empty() {
        return Err(scene_error(
            &format!("{path}.routeMode"),
            "none route has waypoints",
        ));
    }
    let _ = drone.armed;
    Ok(())
}

fn validate_detection(
    detection: &DetectionDocument,
    index: usize,
    camera_ids: &HashSet<&str>,
) -> Result<(), String> {
    let path = format!("recentDetections[{index}]");
    if !is_bounded_name(&detection.id) || !is_bounded_name(&detection.camera_id) {
        return Err(scene_error(&path, "identifiers must be bounded"));
    }
    if !matches!(
        detection.class.as_str(),
        "drone" | "bird" | "aircraft" | "helicopter" | "unknown"
    ) {
        return Err(scene_error(
            &format!("{path}.class"),
            "unsupported detection class",
        ));
    }
    if !camera_ids.contains(detection.camera_id.as_str()) {
        return Err(scene_error(
            &format!("{path}.cameraId"),
            "camera does not exist",
        ));
    }
    if !detection.confidence.is_finite() || !(0.0..=1.0).contains(&detection.confidence) {
        return Err(scene_error(
            &format!("{path}.confidence"),
            "must be in [0, 1]",
        ));
    }
    if !detection.bbox.iter().all(|coordinate| {
        coordinate.is_finite() && (0.0..=MAX_VECTOR_COMPONENT).contains(coordinate)
    }) || detection.bbox[2] <= detection.bbox[0]
        || detection.bbox[3] <= detection.bbox[1]
    {
        return Err(scene_error(
            &format!("{path}.bbox"),
            "bounding box is invalid",
        ));
    }
    if !detection.timestamp.is_finite() || detection.timestamp < 0.0 {
        return Err(scene_error(
            &format!("{path}.timestamp"),
            "must be nonnegative",
        ));
    }
    if !detection.threat_level.is_finite()
        || detection.threat_level.fract() != 0.0
        || !(0.0..=4.0).contains(&detection.threat_level)
    {
        return Err(scene_error(
            &format!("{path}.threatLevel"),
            "must be an integer in [0, 4]",
        ));
    }
    Ok(())
}

fn validate_asset(asset: &SceneAssetDocument, index: usize) -> Result<(), String> {
    let path = format!("assets[{index}]");
    if !is_bounded_name(&asset.id) || !is_bounded_name(&asset.name) || asset.kind != "glb" {
        return Err(scene_error(&path, "identity or type is invalid"));
    }
    if !is_reloadable_glb_source(&asset.source) {
        return Err(scene_error(
            &format!("{path}.source"),
            "GLB source is not reloadable",
        ));
    }
    validate_vector(asset.position, &format!("{path}.position"))?;
    validate_vector(asset.rotation, &format!("{path}.rotation"))?;
    validate_positive_scale(asset.scale, &format!("{path}.scale"))
}

fn validate_splat(splat: &SplatSceneDocument) -> Result<(), String> {
    if !is_reloadable_splat_source(&splat.url) {
        return Err(scene_error(
            "splatScene.url",
            "splat source is not reloadable",
        ));
    }
    validate_vector(splat.position, "splatScene.position")?;
    validate_vector(splat.rotation, "splatScene.rotation")?;
    validate_positive_scale(splat.scale, "splatScene.scale")?;
    let _ = splat.local_path.as_deref();
    Ok(())
}

fn validate_scene_document(document: &SceneDocument) -> Result<(), String> {
    if document.version != CURRENT_SCENE_VERSION {
        return Err(scene_error("version", "does not match the current version"));
    }
    if !document.timestamp.is_finite() || document.timestamp < 0.0 {
        return Err(scene_error("timestamp", "must be finite and nonnegative"));
    }
    if !is_bounded_name(&document.name) {
        return Err(scene_error("name", "must be non-empty and bounded"));
    }
    let _ = document.description.as_deref();
    let _ = document.metadata.as_ref().map(serde_json::Map::len);
    if document.cameras.len() > MAX_SCENE_CAMERAS
        || document.drones.len() > MAX_SCENE_DRONES
        || document.assets.len() > MAX_SCENE_ASSETS
        || document.recent_detections.len() > MAX_SCENE_DETECTIONS
    {
        return Err(scene_error(
            "root",
            "a collection exceeds its element limit",
        ));
    }

    let mut all_ids = HashSet::new();
    let mut camera_ids = HashSet::new();
    let mut render_pixels = 0_u64;
    for (index, camera) in document.cameras.iter().enumerate() {
        render_pixels = render_pixels
            .checked_add(validate_camera(camera, index)?)
            .ok_or_else(|| scene_error("cameras", "render pixel total overflowed"))?;
        if render_pixels > MAX_CAMERA_RENDER_PIXELS {
            return Err(scene_error("cameras", "render pixel budget exceeded"));
        }
        if !all_ids.insert(camera.id.as_str()) {
            return Err(scene_error("cameras", "duplicate scene identifier"));
        }
        camera_ids.insert(camera.id.as_str());
    }
    for (index, drone) in document.drones.iter().enumerate() {
        validate_drone(drone, index)?;
        if !all_ids.insert(drone.id.as_str()) {
            return Err(scene_error("drones", "duplicate scene identifier"));
        }
    }
    for (index, asset) in document.assets.iter().enumerate() {
        validate_asset(asset, index)?;
        if !all_ids.insert(asset.id.as_str()) {
            return Err(scene_error("assets", "duplicate scene identifier"));
        }
    }
    if document
        .active_camera_id
        .as_deref()
        .is_some_and(|id| !camera_ids.contains(id))
    {
        return Err(scene_error("activeCameraId", "camera does not exist"));
    }
    let mut detection_ids = HashSet::new();
    for (index, detection) in document.recent_detections.iter().enumerate() {
        validate_detection(detection, index, &camera_ids)?;
        if !detection_ids.insert(detection.id.as_str()) {
            return Err(scene_error(
                "recentDetections",
                "duplicate detection identifier",
            ));
        }
    }
    if let Some(splat) = &document.splat_scene {
        validate_splat(splat)?;
    }

    let settings = &document.settings;
    if !matches!(
        settings.render_quality.as_str(),
        "low" | "medium" | "high" | "ultra"
    ) {
        return Err(scene_error("settings.renderQuality", "unsupported quality"));
    }
    let _ = (
        settings.detection_enabled,
        settings.show_detection_panel,
        settings.show_performance_panel,
        settings.physics_enabled,
        settings.sensor_simulation_enabled,
    );
    validate_vector(document.view_camera.position, "viewCamera.position")?;
    validate_vector(document.view_camera.target, "viewCamera.target")
}

fn validate_scene_json(value: &serde_json::Value) -> Result<(), String> {
    let document: SceneDocument = serde_json::from_value(value.clone())
        .map_err(|error| format!("Scene JSON does not match the current schema: {error}"))?;
    validate_scene_document(&document)
}

fn current_timestamp_millis() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

/// Migrate declared legacy input, then validate the complete current contract.
pub(crate) fn migrate_scene_json(
    mut value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Scene JSON must be an object".to_string())?;
    let legacy = match object.get("version") {
        Some(serde_json::Value::String(version)) if version == CURRENT_SCENE_VERSION => false,
        Some(serde_json::Value::String(version))
            if matches!(version.as_str(), "0.4.0" | "0.5.0") =>
        {
            true
        }
        Some(serde_json::Value::String(version)) => {
            return Err(format!("Unsupported scene version: {version}"));
        }
        Some(_) => return Err("Scene JSON version must be a string".to_string()),
        None => true,
    };

    if legacy {
        object.insert(
            "version".to_string(),
            serde_json::Value::String(CURRENT_SCENE_VERSION.to_string()),
        );
        if !object
            .get("timestamp")
            .is_some_and(serde_json::Value::is_number)
        {
            object.insert(
                "timestamp".to_string(),
                serde_json::Value::Number(current_timestamp_millis().into()),
            );
        }
        for key in ["cameras", "assets", "drones", "recentDetections"] {
            if !object.get(key).is_some_and(serde_json::Value::is_array) {
                object.insert(key.to_string(), serde_json::Value::Array(Vec::new()));
            }
        }
        if !object
            .get("settings")
            .is_some_and(serde_json::Value::is_object)
        {
            object.insert(
                "settings".to_string(),
                serde_json::json!({
                    "detectionEnabled": true,
                    "showDetectionPanel": true,
                    "showPerformancePanel": true,
                    "renderQuality": "high",
                    "physicsEnabled": true,
                    "sensorSimulationEnabled": true
                }),
            );
        }
        if !object
            .get("viewCamera")
            .is_some_and(serde_json::Value::is_object)
        {
            object.insert(
                "viewCamera".to_string(),
                serde_json::json!({
                    "position": { "x": 0, "y": 5, "z": 10 },
                    "target": { "x": 0, "y": 0, "z": 0 }
                }),
            );
        }
    }

    validate_scene_json(&value)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ContractCorpus {
        current: serde_json::Value,
        legacy: serde_json::Value,
        migrated_legacy: serde_json::Value,
        cases: Vec<ContractCase>,
    }

    #[derive(Deserialize)]
    struct ContractCase {
        name: String,
        source: String,
        accept: bool,
        #[serde(default)]
        canonical: Option<String>,
        #[serde(default)]
        mutation: Option<ContractMutation>,
    }

    #[derive(Deserialize)]
    struct ContractMutation {
        operation: String,
        path: Vec<serde_json::Value>,
        #[serde(default)]
        value: serde_json::Value,
        #[serde(default)]
        count: Option<usize>,
    }

    fn apply_contract_mutation(
        input: &mut serde_json::Value,
        case_name: &str,
        mutation: &ContractMutation,
    ) {
        let (leaf, parents) = mutation
            .path
            .split_last()
            .unwrap_or_else(|| panic!("empty mutation path for {case_name}"));
        let mut parent = input;
        for segment in parents {
            parent = if let Some(key) = segment.as_str() {
                parent
                    .as_object_mut()
                    .and_then(|object| object.get_mut(key))
                    .unwrap_or_else(|| panic!("invalid object path for {case_name}"))
            } else if let Some(index) = segment.as_u64() {
                let index = usize::try_from(index).expect("fixture index must fit usize");
                parent
                    .as_array_mut()
                    .and_then(|array| array.get_mut(index))
                    .unwrap_or_else(|| panic!("invalid array path for {case_name}"))
            } else {
                panic!("invalid path segment for {case_name}");
            };
        }

        let key = leaf
            .as_str()
            .unwrap_or_else(|| panic!("fixture leaf must be an object key for {case_name}"));
        let object = parent
            .as_object_mut()
            .unwrap_or_else(|| panic!("fixture parent must be an object for {case_name}"));
        match mutation.operation.as_str() {
            "remove" => {
                object
                    .remove(key)
                    .unwrap_or_else(|| panic!("missing removal target for {case_name}"));
            }
            "repeat" => {
                let value = mutation
                    .value
                    .as_str()
                    .unwrap_or_else(|| panic!("repeat value must be text for {case_name}"));
                let count = mutation
                    .count
                    .unwrap_or_else(|| panic!("repeat count is missing for {case_name}"));
                object.insert(
                    key.to_string(),
                    serde_json::Value::String(value.repeat(count)),
                );
            }
            "set" => {
                object.insert(key.to_string(), mutation.value.clone());
            }
            operation => panic!("unknown mutation {operation} for {case_name}"),
        }
    }

    fn valid_scene() -> serde_json::Value {
        serde_json::json!({
            "version": CURRENT_SCENE_VERSION,
            "timestamp": 1,
            "name": "Scene",
            "cameras": [],
            "assets": [],
            "drones": [],
            "recentDetections": [],
            "settings": {
                "detectionEnabled": true,
                "showDetectionPanel": true,
                "showPerformancePanel": true,
                "renderQuality": "high",
                "physicsEnabled": true,
                "sensorSimulationEnabled": true
            },
            "viewCamera": {
                "position": { "x": 0, "y": 5, "z": 10 },
                "target": { "x": 0, "y": 0, "z": 0 }
            }
        })
    }

    #[test]
    fn current_scene_requires_the_complete_schema() {
        let error = migrate_scene_json(serde_json::json!({
            "version": CURRENT_SCENE_VERSION,
            "name": "Incomplete"
        }))
        .unwrap_err();

        assert!(error.contains("current schema"));
    }

    #[test]
    fn valid_current_scene_is_not_rewritten() {
        let scene = valid_scene();
        assert_eq!(migrate_scene_json(scene.clone()).unwrap(), scene);
    }

    #[test]
    fn duplicate_cross_kind_identifiers_are_rejected() {
        let mut scene = valid_scene();
        scene["cameras"] = serde_json::json!([{
            "id": "shared",
            "name": "Camera",
            "type": "static",
            "position": { "x": 0, "y": 1, "z": 0 },
            "rotation": { "x": 0, "y": 0, "z": 0 },
            "fov": 60,
            "near": 0.1,
            "far": 100,
            "isActive": true,
            "resolution": [640, 360]
        }]);
        scene["assets"] = serde_json::json!([{
            "id": "shared",
            "name": "Asset",
            "type": "glb",
            "source": "./asset.glb",
            "position": { "x": 0, "y": 0, "z": 0 },
            "rotation": { "x": 0, "y": 0, "z": 0 },
            "scale": { "x": 1, "y": 1, "z": 1 }
        }]);

        assert!(migrate_scene_json(scene)
            .unwrap_err()
            .contains("duplicate scene identifier"));
    }

    #[test]
    fn duplicate_detection_identifiers_are_rejected() {
        let mut scene = valid_scene();
        let detection = serde_json::json!({
            "id": "duplicate-detection",
            "cameraId": "camera",
            "class": "drone",
            "confidence": 0.9,
            "bbox": [0, 0, 1, 1],
            "timestamp": 1,
            "threatLevel": 1
        });
        scene["cameras"] = serde_json::json!([{
            "id": "camera",
            "name": "Camera",
            "type": "static",
            "position": { "x": 0, "y": 1, "z": 0 },
            "rotation": { "x": 0, "y": 0, "z": 0 },
            "fov": 60,
            "near": 0.1,
            "far": 100,
            "isActive": true,
            "resolution": [640, 360]
        }]);
        scene["recentDetections"] = serde_json::json!([detection.clone(), detection]);

        assert!(migrate_scene_json(scene)
            .unwrap_err()
            .contains("duplicate detection identifier"));
    }

    #[test]
    fn unknown_drone_types_are_rejected_before_restore() {
        let mut scene = valid_scene();
        scene["drones"] = serde_json::json!([{
            "id": "drone",
            "type": "not-installed",
            "position": { "x": 0, "y": 1, "z": 0 },
            "orientation": { "x": 0, "y": 0, "z": 0, "w": 1 },
            "velocity": { "x": 0, "y": 0, "z": 0 },
            "angularVelocity": { "x": 0, "y": 0, "z": 0 },
            "armed": false,
            "battery": 100
        }]);

        assert!(migrate_scene_json(scene)
            .unwrap_err()
            .contains("unknown drone type"));
    }

    #[test]
    fn matches_the_shared_rust_and_typescript_contract_corpus() {
        let corpus: ContractCorpus = serde_json::from_str(include_str!(
            "../../src/state/__fixtures__/sceneContractCases.json"
        ))
        .expect("shared scene-contract corpus must parse");

        for contract_case in &corpus.cases {
            let mut input = match contract_case.source.as_str() {
                "current" => corpus.current.clone(),
                "legacy" => corpus.legacy.clone(),
                source => panic!("unknown source {source} for {}", contract_case.name),
            };
            if let Some(mutation) = &contract_case.mutation {
                apply_contract_mutation(&mut input, &contract_case.name, mutation);
            }

            let result = migrate_scene_json(input);
            if !contract_case.accept {
                assert!(
                    result.is_err(),
                    "{} unexpectedly passed",
                    contract_case.name
                );
                continue;
            }

            let result = result.unwrap_or_else(|error| {
                panic!("{} unexpectedly failed: {error}", contract_case.name)
            });
            if let Some(canonical) = &contract_case.canonical {
                assert_eq!(canonical, "migratedLegacy");
                assert_eq!(result, corpus.migrated_legacy, "{}", contract_case.name);
            }
        }
    }
}

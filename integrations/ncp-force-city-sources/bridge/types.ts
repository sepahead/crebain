// Closed city records generated from the installed schema.
export type Vec3 = [number, number, number]
export type Material = {
  id: string
  linearRgb: [number, number, number]
  gaussianOpacity: number
  temperatureK: number
  emissivity: number
}
export type Acoustic = {
  profile: 'crebain.discrete-direct-acoustic.v1'
  sampleRateHz: 16000
  soundSpeedMps: number
  maximumRangeM: number
  referenceDistanceM: number
  referencePressurePa: number
  bladeCount: 2
  blockedGain: number
  noiseStdPa: number
  seed: number
}
export type Thermal = {
  profile: 'crebain.lumped-gray-thermal.v1'
  ambientK: number
  initialK: number
  capacityJPerK: number
  areaM2: number
  convectionWPerM2K: number
  emissivity: number
  motorEfficiency: number
}
export type Tensor = RgbaTensor | RadianceTensor | PressureTensor
export type BufferBinding = {
  profile_digest: string
  application_digest: string
  run_id: string
  endpoint_id: string
  generation: string
}
export type BufferManifest = {
  schema: 'ncp.modular.buffer-manifest.v1'
  binding: BufferBinding
  buffer_id: number
  creating_request_digest: string
  causal_predecessor: string | null
  semantic_digest: string
  byte_length: number
  payload_sha256: string
  chunk_bytes: 32768
  chunk_count: number
  imported_manifest_digest: string | null
  manifest_digest: string
}
export type ControllerReference = [number, number]
export type Solid = {
  id: string
  center: Vec3
  half_extents: [number, number, number]
  yaw: number
  friction: number
  restitution: number
  material_index: number
}
export type World = {
  profile: 'crebain.rapier-force-city.v1'
  engine_model: 'rapier-0.19.3-observed-no-gyro-v1'
  frame: 'three-y-up-z-forward-m'
  horizon_ticks: number
  action_budget: number
  entity_ids: Array<string>
  initial_positions: Array<Vec3>
  controller_references: Array<ControllerReference>
}
export type Scene = { id: string; materials: Array<Material>; solids: Array<Solid> }
export type RGBRequest = {
  request_id: string
  source_id: string
  entity_index: number
  scope: 'entity_requested_world_fixed'
  position: Vec3
  publication_period_ticks: number
  kind: 'rgb'
  target: Vec3
  width: number
  height: number
  fov_degrees: number
  rendering_mode: 'mesh_and_authored_gaussians'
}
export type ThermalRequest = {
  request_id: string
  source_id: string
  entity_index: number
  scope: 'entity_requested_world_fixed'
  position: Vec3
  publication_period_ticks: number
  kind: 'thermal'
  target: Vec3
  width: number
  height: number
  fov_degrees: number
  rendering_mode: 'bolometric_mesh'
}
export type PressureRequest = {
  request_id: string
  source_id: string
  entity_index: number
  scope: 'entity_requested_world_fixed'
  position: Vec3
  publication_period_ticks: number
  kind: 'pressure'
  sample_rate_hz: 16000
  observation_model: 'crebain.discrete-direct-acoustic.v1'
}
export type SourceRequest = RGBRequest | ThermalRequest | PressureRequest
export type Prepare = {
  schema: 'crebain.force-city-prepare.v1'
  composition_digest: string
  resource_plan_digest: string
  world: World
  scene: Scene
  sources: Array<SourceRequest>
  acoustic?: Acoustic
  thermal?: Thermal
}
export type Target = [number, number, number, number]
export type SetRow = [number, 'set', boolean, Target]
export type HoldRow = [number, 'hold', string]
export type ControlRow = SetRow | HoldRow
export type Advance = {
  kind: 'advance'
  plan_digest: string
  roster_digest: string
  tick: number
  previous_batch_digest: string | null
  rows: Array<ControlRow>
}
export type ExportSource = {
  request_id: string
  source_id: string
  entity_index: number
  kind: 'export_source'
  plan_digest: string
  batch_digest: string
  source_body_tick: number
  source_production_digest: string
  original_payload_sha256: string
}
export type ReleaseBatch = {
  kind: 'release_batch'
  plan_digest: string
  batch_digest: string
  tick: number
}
export type Command = Advance | ExportSource | ReleaseBatch
export type NotDue = {
  request_id: string
  source_id: string
  entity_index: number
  status: 'not_due'
  next_due_tick: number | null
}
export type Produced = {
  request_id: string
  source_id: string
  entity_index: number
  status: 'produced'
  source_config_digest: string
  source_body_tick: number
  available_after_body_tick: number
  source_production_digest: string
  original_payload_sha256: string
  byte_length: number
  tensor: Tensor
}
export type Failed = {
  request_id: string
  source_id: string
  entity_index: number
  status: 'failed'
  attempted_at_tick: number
  reason: 'acquisition_failed'
  diagnostic: string
}
export type Absent = {
  request_id: string
  source_id: string
  entity_index: number
  status: 'absent'
  due_at_tick: number
  reason: 'not_attempted_after_failure'
  causal_failed_request_id: string
}
export type SourceOutcome = NotDue | Produced | Failed | Absent
export type AppliedRow = [number, string, 'set' | 'hold', boolean]
export type ControlReceipt = {
  tick: number
  execution: 'known_completed'
  before_state_sha256: string
  after_state_sha256: string
  native_transition_sha256: string
  all_motor_assignments_completed: true
  rows: Array<AppliedRow>
}
export type Batch = {
  plan_digest: string
  roster_digest: string
  scene_sha256: string
  source_catalog_digest: string
  tick: number
  previous_batch_digest: string | null
  control: ControlReceipt
  slots: Array<SourceOutcome>
  batch_digest: string
}
export type Prepared = {
  kind: 'prepared'
  plan_digest: string
  roster_digest: string
  scene_sha256: string
  source_catalog_digest: string
  resource_plan_digest: string
  source_identity: string
  engine_owner_id: string
  native_plan_sha256: string
}
export type Advanced = { kind: 'advanced'; batch: Batch }
export type AdvanceFailed = {
  kind: 'advance_failed'
  batch: Batch
  native_retirement: 'confirmed'
  physical_advance_allowed: false
  successful_finish_allowed: false
}
export type SourceManifest = {
  request_id: string
  source_id: string
  entity_index: number
  schema: 'crebain.force-city-source-manifest.v1'
  plan_digest: string
  scene_sha256: string
  source_catalog_digest: string
  source_config_digest: string
  batch_digest: string
  source_body_tick: number
  available_after_body_tick: number
  source_production_digest: string
  original_payload_sha256: string
  byte_manifest_digest: string
  tensor: Tensor
  manifest_digest: string
}
export type Exported = {
  kind: 'source_exported'
  typed_manifest: SourceManifest
  byte_manifest: BufferManifest
}
export type BatchReleased = {
  kind: 'batch_released'
  plan_digest: string
  batch_digest: string
  tick: number
}
export type Result = Prepared | Advanced | AdvanceFailed | Exported | BatchReleased
export type Finish = {
  plan_digest: string
  completed_ticks: number
  last_released_batch_digest: string
}
export type Terminal = {
  plan_digest: string
  completed_ticks: number
  last_released_batch_digest: string
  native_retirement: 'confirmed'
  promised_source_output: 'complete'
  scientific_validation: false
}
export type ImportDescriptor = never
export type ImportMetadata = never
export type Imported = never
export type RgbaTensor = {
  kind: 'rgba8'
  dtype: 'u8'
  shape: [number, number, 4]
  layout: 'c_contiguous'
  row_origin: 'bottom-left'
  encoding: 'rgba8-srgb'
}
export type RadianceTensor = {
  kind: 'radiance'
  dtype: 'f32le'
  shape: [number, number]
  layout: 'c_contiguous'
  row_origin: 'bottom-left'
  unit: 'W/(m2 sr)'
}
export type PressureTensor = {
  kind: 'pressure'
  dtype: 'f64le'
  shape: [number]
  layout: 'c_contiguous'
  sample_start: number
  sample_end: number
  sample_rate_hz: 16000
  unit: 'pascal'
}

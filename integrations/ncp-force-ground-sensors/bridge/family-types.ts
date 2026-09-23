// Generated from the owned family schema. Semantic and state bounds remain separate.
export type Vec3 = ReadonlyArray<number>
export type Camera = {
  readonly id: string
  readonly position: Vec3
  readonly target: Vec3
  readonly width: number
  readonly height: number
  readonly fovDegrees: number
  readonly periodTicks: number
}
export type Microphone = { readonly id: string; readonly position: Vec3 }
export type Material = {
  readonly id: string
  readonly linearRgb: ReadonlyArray<number>
  readonly gaussianOpacity: number
  readonly temperatureK: number
  readonly emissivity: number
}
export type Scene = {
  readonly profile: 'crebain.city-scene.v1'
  readonly id: string
  readonly frame: 'three-y-up-z-forward-m'
  readonly solids: ReadonlyArray<never>
  readonly materials: ReadonlyArray<Material>
  readonly rgbCameras: ReadonlyArray<Camera>
  readonly thermalCameras: ReadonlyArray<Camera>
  readonly microphones: ReadonlyArray<Microphone>
}
export type Acoustic = {
  readonly profile: 'crebain.discrete-direct-acoustic.v1'
  readonly sampleRateHz: 16000
  readonly soundSpeedMps: number
  readonly maximumRangeM: number
  readonly referenceDistanceM: number
  readonly referencePressurePa: number
  readonly bladeCount: 2
  readonly blockedGain: number
  readonly noiseStdPa: number
  readonly seed: number
}
export type Thermal = {
  readonly profile: 'crebain.lumped-gray-thermal.v1'
  readonly ambientK: number
  readonly initialK: number
  readonly capacityJPerK: number
  readonly areaM2: number
  readonly convectionWPerM2K: number
  readonly emissivity: number
  readonly motorEfficiency: number
}
export type Controller = {
  readonly engineModel: 'rapier-0.19.3-observed-no-gyro-v1'
  readonly referenceAltitudeM: number
  readonly referenceHeadingRad: number
}
export type Drone = { readonly id: string; readonly position: Vec3 }
export type Specification = {
  readonly profile: 'crebain.cpu-force-ground-environment.v1'
  readonly seed: number
  readonly drones: ReadonlyArray<Drone>
  readonly scene: Scene
  readonly acoustic: Acoustic
  readonly thermal: Thermal
  readonly controller: Controller
}
export type Prepare = {
  readonly specification: Specification
  readonly planned_ticks: number
  readonly composition_digest: string
}
export type SetTarget = {
  readonly kind: 'set_target'
  readonly armed: boolean
  readonly roll_rad: number
  readonly pitch_rad: number
  readonly heading_rad: number
  readonly altitude_m: number
}
export type Hold = { readonly kind: 'hold'; readonly accepted_action_request_digest: string }
export type Action = SetTarget | Hold
export type Command = {
  readonly kind: 'advance_tick'
  readonly tick: number
  readonly previous_batch_digest: string | null
  readonly action: Action
  readonly capture_reservation: { readonly kind: 'absent' }
}
export type Finish = {
  readonly plan_digest: string
  readonly completed_ticks: number
  readonly last_batch_digest: string
}
export type PressureConfiguration = { readonly position: Vec3; readonly acoustic: Acoustic }
export type CatalogEntry =
  | {
      readonly kind: 'rgba8'
      readonly sensor_id: string
      readonly source_id: string
      readonly sensor_contract_digest: string
      readonly configuration: Camera
    }
  | {
      readonly kind: 'radiance'
      readonly sensor_id: string
      readonly source_id: string
      readonly sensor_contract_digest: string
      readonly configuration: Camera
    }
  | {
      readonly kind: 'pressure'
      readonly sensor_id: string
      readonly source_id: string
      readonly sensor_contract_digest: string
      readonly configuration: PressureConfiguration
    }
export type SensorCatalog = {
  readonly schema: 'crebain.sensor-catalog.v1'
  readonly plan_digest: string
  readonly entries: ReadonlyArray<CatalogEntry>
  readonly catalog_digest: string
}
export type Tensor =
  | {
      readonly kind: 'rgba8'
      readonly dtype: 'u8'
      readonly shape: readonly [number, number, 4]
      readonly layout: 'c_contiguous'
      readonly row_origin: 'bottom-left'
      readonly encoding: 'rgba8-srgb'
    }
  | {
      readonly kind: 'radiance'
      readonly dtype: 'f32le'
      readonly shape: ReadonlyArray<number>
      readonly layout: 'c_contiguous'
      readonly row_origin: 'bottom-left'
      readonly unit: 'W/(m2 sr)'
    }
  | {
      readonly kind: 'pressure'
      readonly dtype: 'f64le'
      readonly shape: ReadonlyArray<number>
      readonly layout: 'c_contiguous'
      readonly sample_start: number
      readonly sample_end: number
      readonly sample_rate_hz: 16000
      readonly unit: 'pascal'
    }
export type SensorManifest = {
  readonly schema: 'crebain.sensor-manifest.v1'
  readonly sensor_contract_digest: string
  readonly sensor_id: string
  readonly byte_manifest_digest: string
  readonly engine_batch_sha256: string
  readonly source_body_tick: number
  readonly available_after_body_tick: number
  readonly tensor: Tensor
  readonly manifest_digest: string
}
export type BufferBinding = {
  readonly profile_digest: string
  readonly application_digest: string
  readonly run_id: string
  readonly endpoint_id: string
  readonly generation: string
}
export type BufferManifest = {
  readonly schema: 'ncp.modular.buffer-manifest.v1'
  readonly binding: BufferBinding
  readonly buffer_id: number
  readonly creating_request_digest: string
  readonly causal_predecessor: string | null
  readonly semantic_digest: string
  readonly byte_length: number
  readonly payload_sha256: string
  readonly chunk_bytes: 32768
  readonly chunk_count: number
  readonly imported_manifest_digest: string | null
  readonly manifest_digest: string
}
export type SensorSlot =
  | {
      readonly kind: 'due'
      readonly sensor_id: string
      readonly typed_manifest: SensorManifest
      readonly byte_manifest: BufferManifest
    }
  | { readonly kind: 'not_due'; readonly sensor_id: string; readonly next_due_tick: number | null }
export type SensorBatch = {
  readonly schema: 'crebain.sensor-batch.v1'
  readonly plan_digest: string
  readonly engine_owner_id: string
  readonly engine_batch_sha256: string
  readonly source_identity: string
  readonly scene_sha256: string
  readonly body_tick: number
  readonly previous_batch_digest: string | null
  readonly slots: ReadonlyArray<SensorSlot>
  readonly batch_digest: string
}
export type Prepared = {
  readonly kind: 'prepared'
  readonly plan_digest: string
  readonly sensor_catalog: SensorCatalog
  readonly initial_observation: 'not_acquired'
  readonly source_identity: string
  readonly engine_owner_id: string
  readonly scene_sha256: string
}
export type Advanced = {
  readonly kind: 'advanced'
  readonly tick: number
  readonly accepted_action_request_digest: string
  readonly batch: SensorBatch
}
export type Result = Prepared | Advanced
export type Terminal = {
  readonly plan_digest: string
  readonly planned_ticks: number
  readonly completed_ticks: number
  readonly last_batch_digest: string
  readonly engine_retirement: 'confirmed'
  readonly promised_sensor_output: 'complete'
  readonly scientific_validation: false
}
export type ImportDescriptor = never
export type ImportMetadata = never
export type Imported = never
export type Digest = string
export type Uuid = string
export type Token = string
export type CommittedStamp = {
  readonly binding: BufferBinding
  readonly sequence: number
  readonly request_digest: Digest
  readonly result_digest: Digest
}
export type CheckpointReference = {
  readonly family_id: Uuid
  readonly checkpoint_token: Uuid
  readonly parent_binding: BufferBinding
  readonly parent_native_owner_id: Uuid
  readonly tick: number
  readonly checkpoint_sha256: Digest
}
export type PressureWindow = {
  readonly kind: 'scaled_compensated_pressure_rms400_v1'
  readonly sensor_id: string
  readonly first_tick: number
  readonly last_tick: number
  readonly sample_count: 400
  readonly unit: 'pascal'
  readonly target_function_digest: Digest
}
export type BranchPlan = {
  readonly slot: number
  readonly case_id: Token
  readonly purpose: 'label' | 'same_action_control'
  readonly binding: BufferBinding
  readonly target: SetTarget
}
export type FamilyLimits = {
  readonly total_wall_seconds: number
  readonly endpoint_count: number
  readonly max_active_native_owners: 2
  readonly public_checkpoint_slots: 1
  readonly temporary_checkpoint_slots: 1
  readonly evaluation_window_bytes: 3200
}
export type FamilyPlan = {
  readonly family_id: Uuid
  readonly canonical_binding: BufferBinding
  readonly body: Prepare
  readonly landmark_tick: number
  readonly branches: ReadonlyArray<BranchPlan>
  readonly evaluation: PressureWindow
  readonly limits: FamilyLimits
}
export type CanonicalPrepare = { readonly plan: FamilyPlan }
export type CheckpointCommand = {
  readonly kind: 'checkpoint'
  readonly tick: number
  readonly expected_batch_digest: Digest
}
export type CommitDecisionCommand = {
  readonly kind: 'commit_decision'
  readonly checkpoint: CheckpointReference
  readonly forecast_commitment_digest: Digest
  readonly selected_case_id: Token
}
export type ReserveBranchCommand = {
  readonly kind: 'reserve_branch'
  readonly checkpoint: CheckpointReference
  readonly case_id: Token
  readonly expected_selected_execution_result_digest: Digest
}
export type ReleaseCheckpointCommand = {
  readonly kind: 'release_checkpoint'
  readonly checkpoint: CheckpointReference
  readonly expected_last_branch_terminal_result_digest: Digest
}
export type CanonicalCommand =
  | Command
  | CheckpointCommand
  | CommitDecisionCommand
  | ReserveBranchCommand
  | ReleaseCheckpointCommand
export type ReservationReference = {
  readonly family_id: Uuid
  readonly reservation_token: Uuid
  readonly case_id: Token
  readonly branch_binding: BufferBinding
  readonly checkpoint: CheckpointReference
  readonly reserving_request_digest: Digest
}
export type EvaluationPrepare = {
  readonly reservation: ReservationReference
  readonly expected_family_plan_digest: Digest
}
export type EvaluateCommand = {
  readonly kind: 'evaluate_pressure_window'
  readonly expected_batch_digest: Digest
  readonly expected_target_function_digest: Digest
}
export type EvaluationCommand = Command | EvaluateCommand
export type BranchAncestry = {
  readonly family_id: Uuid
  readonly case_id: Token
  readonly origin: CheckpointReference
  readonly origin_plan_digest: Digest
  readonly origin_engine_run_id: string
  readonly origin_native_batch_sha256: Digest
  readonly origin_sensor_batch_digest: Digest
  readonly action_history_position: number
  readonly selection: CommittedStamp
  readonly selected_execution: CommittedStamp
  readonly execution_binding: BufferBinding
  readonly native_owner_id: Uuid
  readonly graphics_generation: Uuid
  readonly reconstruction: 'exact-cpu-and-current-static-pixels'
}
export type PixelIdentity = { readonly sensor_id: string; readonly payload_sha256: Digest }
export type Checkpointed = {
  readonly kind: 'checkpointed'
  readonly reference: CheckpointReference
  readonly cpu_state_sha256: Digest
  readonly graphics_plan_sha256: Digest
  readonly render_input_sha256: Digest
  readonly pixels: ReadonlyArray<PixelIdentity>
  readonly accepted_native_batch_sha256: Digest
  readonly accepted_sensor_batch_digest: Digest
  readonly accepted_action_position: number
}
export type DecisionCommitted = {
  readonly kind: 'decision_committed'
  readonly checkpoint: CheckpointReference
  readonly forecast_commitment_digest: Digest
  readonly selected_case_id: Token
  readonly selected_target: SetTarget
}
export type BranchReserved = {
  readonly kind: 'branch_reserved'
  readonly reference: ReservationReference
  readonly family_plan_digest: Digest
}
export type CheckpointReleased = {
  readonly kind: 'checkpoint_released'
  readonly reference: CheckpointReference
  readonly native_release: 'confirmed'
}
export type FamilyPrepared = {
  readonly kind: 'family_prepared'
  readonly family_plan_digest: Digest
  readonly body: Prepared
  readonly endpoint_count: number
  readonly native_owner_count: 1
}
export type Restored = {
  readonly kind: 'restored'
  readonly family_plan_digest: Digest
  readonly sensor_catalog: SensorCatalog
  readonly initial_observation: 'inherited_checkpoint'
  readonly ancestry: BranchAncestry
  readonly cpu_state_sha256: Digest
  readonly render_input_sha256: Digest
  readonly pixels: ReadonlyArray<PixelIdentity>
}
export type FamilyAdvanced = {
  readonly kind: 'family_advanced'
  readonly body: Advanced
  readonly ancestry: BranchAncestry | null
  readonly canonical_final_state: CanonicalFinalState | null
}
export type PressureSegment = {
  readonly source_body_tick: number
  readonly available_after_body_tick: number
  readonly sample_start: number
  readonly sample_end: number
  readonly typed_manifest_digest: Digest
  readonly byte_manifest_digest: Digest
  readonly payload_sha256: Digest
  readonly byte_length: number
}
export type EvaluationResult = {
  readonly kind: 'pressure_window_evaluated'
  readonly ancestry: BranchAncestry
  readonly target: PressureWindow
  readonly segments: ReadonlyArray<PressureSegment>
  readonly window_payload_sha256: Digest
  readonly value_pa: number
  readonly final_cpu_state_sha256: Digest
  readonly final_native_batch_sha256: Digest
  readonly final_sensor_batch_digest: Digest
  readonly accepted_action_request_digest: Digest
  readonly scientific_validation: false
}
export type CanonicalResult =
  | FamilyPrepared
  | FamilyAdvanced
  | Checkpointed
  | DecisionCommitted
  | BranchReserved
  | CheckpointReleased
export type EvaluationResultUnion = Restored | FamilyAdvanced | EvaluationResult
export type CanonicalFinish = {
  readonly body: Finish
  readonly family_plan_digest: Digest
  readonly expected_branch_terminals: ReadonlyArray<CommittedStamp>
}
export type EvaluationFinish = { readonly body: Finish; readonly evaluation_result_digest: Digest }
export type EvaluationTerminal = {
  readonly family_id: Uuid
  readonly case_id: Token
  readonly ancestry: BranchAncestry
  readonly last_batch_digest: Digest
  readonly evaluation_result_digest: Digest
  readonly native_owner_retirement: 'confirmed'
  readonly graphics_retirement: 'confirmed'
  readonly shared_family_process_retirement: 'pending'
  readonly promised_sensor_output: 'complete'
  readonly scientific_validation: false
}
export type CanonicalTerminal = {
  readonly family_id: Uuid
  readonly family_plan_digest: Digest
  readonly last_batch_digest: Digest
  readonly branch_terminals: ReadonlyArray<CommittedStamp>
  readonly checkpoint_release: 'confirmed'
  readonly native_family_retirement: 'confirmed'
  readonly bun_process_retirement: 'confirmed'
  readonly sdk_host_process_retirement: 'pending'
  readonly scientific_validation: false
  readonly canonical_final_state: CanonicalFinalState
  readonly canonical_state_recheck: 'confirmed'
}
export type CanonicalFinalState = {
  readonly body_tick: number
  readonly native_batch_sha256: Digest
  readonly cpu_state_sha256: Digest
  readonly render_input_sha256: Digest
  readonly pixels: ReadonlyArray<PixelIdentity>
}

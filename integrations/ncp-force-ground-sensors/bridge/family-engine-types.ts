// Generated private DTOs after exact Float64 decoding; the selected bridge schema owns admission.
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
export type Action = SetTarget | Hold
export type Advanced = {
  readonly kind: 'advanced'
  readonly tick: number
  readonly accepted_action_request_digest: string
  readonly batch: SensorBatch
}
export type Batch = {
  readonly engine_owner_id: string
  readonly source_identity: string
  readonly scene_sha256: string
  readonly body_tick: number
  readonly engine_batch_sha256: string
  readonly previous_engine_batch_sha256: string | null
  readonly payloads: ReadonlyArray<Payload>
}
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
export type BranchPlan = {
  readonly slot: number
  readonly case_id: Token
  readonly purpose: 'label' | 'same_action_control'
  readonly binding: BufferBinding
  readonly target: SetTarget
}
export type BranchReserved = {
  readonly kind: 'branch_reserved'
  readonly reference: ReservationReference
  readonly family_plan_digest: Digest
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
export type Camera = {
  readonly id: string
  readonly position: Vec3
  readonly target: Vec3
  readonly width: number
  readonly height: number
  readonly fovDegrees: number
  readonly periodTicks: number
}
export type CanonicalFinalState = {
  readonly body_tick: number
  readonly native_batch_sha256: Digest
  readonly cpu_state_sha256: Digest
  readonly render_input_sha256: Digest
  readonly pixels: ReadonlyArray<PixelIdentity>
}
export type CanonicalResult =
  | FamilyPrepared
  | FamilyAdvanced
  | Checkpointed
  | DecisionCommitted
  | BranchReserved
  | CheckpointReleased
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
export type CheckpointReference = {
  readonly family_id: Uuid
  readonly checkpoint_token: Uuid
  readonly parent_binding: BufferBinding
  readonly parent_native_owner_id: Uuid
  readonly tick: number
  readonly checkpoint_sha256: Digest
}
export type CheckpointReleased = {
  readonly kind: 'checkpoint_released'
  readonly reference: CheckpointReference
  readonly native_release: 'confirmed'
}
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
export type Command = {
  readonly kind: 'advance_tick'
  readonly tick: number
  readonly previous_batch_digest: string | null
  readonly action: Action
  readonly capture_reservation: { readonly kind: 'absent' }
}
export type CommittedStamp = {
  readonly binding: BufferBinding
  readonly sequence: number
  readonly request_digest: Digest
  readonly result_digest: Digest
}
export type Controller = {
  readonly engineModel: 'rapier-0.19.3-observed-no-gyro-v1'
  readonly referenceAltitudeM: number
  readonly referenceHeadingRad: number
}
export type DecisionCommitted = {
  readonly kind: 'decision_committed'
  readonly checkpoint: CheckpointReference
  readonly forecast_commitment_digest: Digest
  readonly selected_case_id: Token
  readonly selected_target: SetTarget
}
export type Digest = string
export type Drone = { readonly id: string; readonly position: Vec3 }
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
export type EvaluationResultUnion = Restored | FamilyAdvanced | EvaluationResult
export type FamilyAdvanced = {
  readonly kind: 'family_advanced'
  readonly body: Advanced
  readonly ancestry: BranchAncestry | null
  readonly canonical_final_state: CanonicalFinalState | null
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
export type FamilyPrepared = {
  readonly kind: 'family_prepared'
  readonly family_plan_digest: Digest
  readonly body: Prepared
  readonly endpoint_count: number
  readonly native_owner_count: 1
}
export type Hold = { readonly kind: 'hold'; readonly accepted_action_request_digest: string }
export type Material = {
  readonly id: string
  readonly linearRgb: ReadonlyArray<number>
  readonly gaussianOpacity: number
  readonly temperatureK: number
  readonly emissivity: number
}
export type Microphone = { readonly id: string; readonly position: Vec3 }
export type NativeRestored = {
  readonly ancestry: BranchAncestry
  readonly cpu_state_sha256: Digest
  readonly render_input_sha256: Digest
  readonly pixels: ReadonlyArray<PixelIdentity>
}
export type Payload = {
  readonly sensor_id: string
  readonly kind: 'rgba8' | 'radiance' | 'pressure'
  readonly byte_length: number
  readonly payload_sha256: string
}
export type PixelIdentity = { readonly sensor_id: string; readonly payload_sha256: Digest }
export type Prepare = {
  readonly specification: Specification
  readonly planned_ticks: number
  readonly composition_digest: string
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
export type PressureConfiguration = { readonly position: Vec3; readonly acoustic: Acoustic }
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
export type PressureWindow = {
  readonly kind: 'scaled_compensated_pressure_rms400_v1'
  readonly sensor_id: string
  readonly first_tick: number
  readonly last_tick: number
  readonly sample_count: 400
  readonly unit: 'pascal'
  readonly target_function_digest: Digest
}
export type PrivateBody =
  | { readonly kind: 'constructed' }
  | { readonly kind: 'prepared'; readonly engine_owner_id: string; readonly scene_sha256: string }
  | { readonly kind: 'advanced'; readonly batch: Batch }
  | {
      readonly kind: 'chunk'
      readonly tick: number
      readonly engine_batch_sha256: string
      readonly sensor_id: string
      readonly offset: number
      readonly bytes_base64: string
      readonly chunk_sha256: string
    }
  | {
      readonly kind: 'released'
      readonly tick: number
      readonly engine_batch_sha256: Digest
      readonly canonical_final_state: CanonicalFinalState | null
    }
  | { readonly kind: 'checkpointed'; readonly result: Checkpointed }
  | { readonly kind: 'selected'; readonly result: DecisionCommitted }
  | { readonly kind: 'reserved'; readonly reference: ReservationReference }
  | { readonly kind: 'restored'; readonly result: NativeRestored }
  | { readonly kind: 'evaluated'; readonly result: EvaluationResult }
  | { readonly kind: 'branch_finished' }
  | { readonly kind: 'checkpoint_released' }
  | { readonly kind: 'family_finished'; readonly state: CanonicalFinalState }
  | { readonly kind: 'observed' }
  | { readonly kind: 'retired'; readonly cleanup_confirmed: true }
  | {
      readonly kind: 'failed'
      readonly reason: 'invalid_request' | 'engine' | 'io'
      readonly cleanup_confirmed: boolean
    }
export type PrivateCommand =
  | {
      readonly kind: 'construct'
      readonly plan: FamilyPlan
      readonly family_plan_digest: Digest
      readonly source_identity: Digest
    }
  | { readonly kind: 'prepare' }
  | {
      readonly kind: 'advance'
      readonly slot: number
      readonly command: Command
      readonly request_digest: Digest
    }
  | {
      readonly kind: 'read_chunk'
      readonly slot: number
      readonly tick: number
      readonly engine_batch_sha256: Digest
      readonly sensor_id: string
      readonly offset: number
      readonly count: number
    }
  | {
      readonly kind: 'release_lease'
      readonly slot: number
      readonly tick: number
      readonly engine_batch_sha256: Digest
    }
  | { readonly kind: 'checkpoint'; readonly expected_batch_digest: Digest }
  | {
      readonly kind: 'select'
      readonly checkpoint: CheckpointReference
      readonly case_id: Token
      readonly forecast: Digest
    }
  | {
      readonly kind: 'reserve'
      readonly checkpoint: CheckpointReference
      readonly case_id: Token
      readonly selected: Digest
      readonly request: Digest
    }
  | {
      readonly kind: 'restore'
      readonly reservation: ReservationReference
      readonly family_plan_digest: Digest
    }
  | {
      readonly kind: 'evaluate'
      readonly slot: number
      readonly batch: Digest
      readonly target: Digest
    }
  | { readonly kind: 'finish_branch'; readonly slot: number; readonly evaluation: Digest }
  | {
      readonly kind: 'release_checkpoint'
      readonly checkpoint: CheckpointReference
      readonly terminal: Digest
    }
  | { readonly kind: 'finish_canonical'; readonly terminals: ReadonlyArray<CommittedStamp> }
  | {
      readonly kind: 'observe_canonical'
      readonly stamp: CommittedStamp
      readonly result: CanonicalResult
    }
  | {
      readonly kind: 'observe_evaluation'
      readonly slot: number
      readonly stamp: CommittedStamp
      readonly result: EvaluationResultUnion
    }
  | { readonly kind: 'observe_terminal'; readonly stamp: CommittedStamp }
  | { readonly kind: 'observe_ack'; readonly stamp: CommittedStamp }
  | { readonly kind: 'observe_eof'; readonly stamp: CommittedStamp }
  | { readonly kind: 'retire' }
export type Request = {
  readonly schema: 'crebain.family-engine-request.v1'
  readonly generation: Uuid
  readonly sequence: number
  readonly command: PrivateCommand
}
export type ReservationReference = {
  readonly family_id: Uuid
  readonly reservation_token: Uuid
  readonly case_id: Token
  readonly branch_binding: BufferBinding
  readonly checkpoint: CheckpointReference
  readonly reserving_request_digest: Digest
}
export type Response = {
  readonly schema: 'crebain.family-engine-response.v1'
  readonly generation: Uuid
  readonly sequence: number
  readonly body: PrivateBody
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
export type SensorCatalog = {
  readonly schema: 'crebain.sensor-catalog.v1'
  readonly plan_digest: string
  readonly entries: ReadonlyArray<CatalogEntry>
  readonly catalog_digest: string
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
export type SensorSlot =
  | {
      readonly kind: 'due'
      readonly sensor_id: string
      readonly typed_manifest: SensorManifest
      readonly byte_manifest: BufferManifest
    }
  | { readonly kind: 'not_due'; readonly sensor_id: string; readonly next_due_tick: number | null }
export type SetTarget = {
  readonly kind: 'set_target'
  readonly armed: boolean
  readonly roll_rad: number
  readonly pitch_rad: number
  readonly heading_rad: number
  readonly altitude_m: number
}
export type Specification = {
  readonly profile: 'crebain.cpu-force-ground-environment.v1'
  readonly seed: number
  readonly drones: ReadonlyArray<Drone>
  readonly scene: Scene
  readonly acoustic: Acoustic
  readonly thermal: Thermal
  readonly controller: Controller
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
export type Token = string
export type Uuid = string
export type Vec3 = ReadonlyArray<number>

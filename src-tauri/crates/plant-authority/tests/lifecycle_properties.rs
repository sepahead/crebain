use std::num::NonZeroU64;

use crebain_plant_authority::{
    GuardedEvent, LifecycleError, LifecycleEvent, LifecycleMachine, PlantState, RuntimeGeneration,
};

fn generation(value: u64) -> RuntimeGeneration {
    RuntimeGeneration::new(NonZeroU64::new(value).expect("test generation is nonzero"))
}

fn apply(machine: &mut LifecycleMachine, event: LifecycleEvent) {
    machine
        .apply(GuardedEvent {
            generation: machine.generation(),
            event,
        })
        .expect("test transition should be allowed");
}

#[test]
fn nominal_lifecycle_should_reach_active_only_through_authorized_hold() {
    let mut machine = LifecycleMachine::new(generation(7));
    for event in [
        LifecycleEvent::BootCompleted,
        LifecycleEvent::StandbyRequested,
        LifecycleEvent::PreflightRequested,
        LifecycleEvent::AuthorizationGranted,
        LifecycleEvent::ActivationRequested,
    ] {
        apply(&mut machine, event);
    }

    assert_eq!(machine.state(), PlantState::Active);
}

#[test]
fn stale_generation_should_never_change_state() {
    let mut machine = LifecycleMachine::new(generation(9));
    apply(&mut machine, LifecycleEvent::BootCompleted);
    let before = machine.state();

    let result = machine.apply(GuardedEvent {
        generation: generation(8),
        event: LifecycleEvent::StandbyRequested,
    });

    assert!(
        matches!(result, Err(LifecycleError::StaleGeneration { .. })) && machine.state() == before,
        "a stale event changed lifecycle state: result={result:?}, state={:?}",
        machine.state()
    );
}

#[test]
fn revocation_should_rotate_generation_and_invalidate_queued_work() {
    let mut machine = LifecycleMachine::new(generation(11));
    apply(&mut machine, LifecycleEvent::BootCompleted);
    apply(&mut machine, LifecycleEvent::StandbyRequested);
    let old_generation = machine.generation();
    apply(&mut machine, LifecycleEvent::AuthorityRevoked);

    let stale_result = machine.apply(GuardedEvent {
        generation: old_generation,
        event: LifecycleEvent::StandbyRequested,
    });

    assert!(
        machine.state() == PlantState::NoAuthority
            && machine.generation() != old_generation
            && matches!(stale_result, Err(LifecycleError::StaleGeneration { .. }))
    );
}

#[test]
fn every_nonterminal_state_should_accept_emergency_and_shutdown() {
    let states_and_paths: &[(PlantState, &[LifecycleEvent])] = &[
        (PlantState::Boot, &[]),
        (PlantState::NoAuthority, &[LifecycleEvent::BootCompleted]),
        (
            PlantState::Standby,
            &[
                LifecycleEvent::BootCompleted,
                LifecycleEvent::StandbyRequested,
            ],
        ),
        (
            PlantState::Preflight,
            &[
                LifecycleEvent::BootCompleted,
                LifecycleEvent::StandbyRequested,
                LifecycleEvent::PreflightRequested,
            ],
        ),
        (
            PlantState::AuthorizedHold,
            &[
                LifecycleEvent::BootCompleted,
                LifecycleEvent::StandbyRequested,
                LifecycleEvent::PreflightRequested,
                LifecycleEvent::AuthorizationGranted,
            ],
        ),
        (
            PlantState::Active,
            &[
                LifecycleEvent::BootCompleted,
                LifecycleEvent::StandbyRequested,
                LifecycleEvent::PreflightRequested,
                LifecycleEvent::AuthorizationGranted,
                LifecycleEvent::ActivationRequested,
            ],
        ),
        (
            PlantState::Degraded,
            &[
                LifecycleEvent::BootCompleted,
                LifecycleEvent::StandbyRequested,
                LifecycleEvent::PreflightRequested,
                LifecycleEvent::AuthorizationGranted,
                LifecycleEvent::HealthDegraded,
            ],
        ),
        (PlantState::Emergency, &[LifecycleEvent::EmergencyLatched]),
    ];

    for (expected_state, path) in states_and_paths {
        let mut machine = LifecycleMachine::new(generation(13));
        for event in *path {
            apply(&mut machine, *event);
        }
        assert_eq!(&machine.state(), expected_state);
        apply(&mut machine, LifecycleEvent::EmergencyLatched);
        assert_eq!(machine.state(), PlantState::Emergency);
        apply(&mut machine, LifecycleEvent::ShutdownRequested);
        assert_eq!(machine.state(), PlantState::Shutdown);
    }
}

#[test]
fn shutdown_should_be_terminal_for_all_events() {
    let all_events = [
        LifecycleEvent::BootCompleted,
        LifecycleEvent::StandbyRequested,
        LifecycleEvent::PreflightRequested,
        LifecycleEvent::AuthorizationGranted,
        LifecycleEvent::ActivationRequested,
        LifecycleEvent::HealthDegraded,
        LifecycleEvent::DegradationCleared,
        LifecycleEvent::AuthorityRevoked,
        LifecycleEvent::EmergencyLatched,
        LifecycleEvent::ShutdownRequested,
    ];
    let mut machine = LifecycleMachine::new(generation(15));
    apply(&mut machine, LifecycleEvent::ShutdownRequested);
    let terminal_generation = machine.generation();

    let all_rejected = all_events.into_iter().all(|event| {
        matches!(
            machine.apply(GuardedEvent {
                generation: machine.generation(),
                event,
            }),
            Err(LifecycleError::InvalidTransition {
                state: PlantState::Shutdown,
                ..
            })
        ) && machine.state() == PlantState::Shutdown
            && machine.generation() == terminal_generation
    });

    assert!(all_rejected);
}

#[test]
fn maximum_generation_shutdown_should_remain_terminal_without_wrapping() {
    let maximum = RuntimeGeneration::new(NonZeroU64::MAX);
    let mut machine = LifecycleMachine::new(maximum);

    let transition = machine
        .apply(GuardedEvent {
            generation: maximum,
            event: LifecycleEvent::ShutdownRequested,
        })
        .expect("terminal shutdown does not require a reusable generation");
    let rejected = machine.apply(GuardedEvent {
        generation: maximum,
        event: LifecycleEvent::BootCompleted,
    });

    assert!(
        transition.to == PlantState::Shutdown
            && transition.next_generation == maximum
            && machine.state() == PlantState::Shutdown
            && machine.generation() == maximum
            && matches!(
                rejected,
                Err(LifecycleError::InvalidTransition {
                    state: PlantState::Shutdown,
                    next_generation,
                    ..
                }) if next_generation == maximum
            )
    );
}

#[test]
fn representable_shutdown_should_rotate_generation_once() {
    let initial = generation(16);
    let mut machine = LifecycleMachine::new(initial);

    let transition = machine
        .apply(GuardedEvent {
            generation: initial,
            event: LifecycleEvent::ShutdownRequested,
        })
        .expect("representable shutdown generation should rotate");

    assert!(
        transition.to == PlantState::Shutdown
            && transition.admitted_generation == initial
            && transition.next_generation != initial
            && machine.generation() == transition.next_generation
    );
}

#[test]
fn invalid_active_event_should_fail_closed_and_rotate_generation() {
    let mut machine = LifecycleMachine::new(generation(17));
    for event in [
        LifecycleEvent::BootCompleted,
        LifecycleEvent::StandbyRequested,
        LifecycleEvent::PreflightRequested,
        LifecycleEvent::AuthorizationGranted,
        LifecycleEvent::ActivationRequested,
    ] {
        apply(&mut machine, event);
    }
    let active_generation = machine.generation();

    let result = machine.apply(GuardedEvent {
        generation: active_generation,
        event: LifecycleEvent::BootCompleted,
    });

    assert!(
        matches!(
            result,
            Err(LifecycleError::InvalidTransition {
                state: PlantState::Active,
                fail_closed_state: PlantState::NoAuthority,
                ..
            })
        ) && machine.state() == PlantState::NoAuthority
            && machine.generation() != active_generation
    );
}

#[test]
fn generation_exhaustion_should_latch_emergency_without_reusing_an_old_value() {
    let maximum = RuntimeGeneration::new(NonZeroU64::MAX);
    let mut machine = LifecycleMachine::new(maximum);
    apply(&mut machine, LifecycleEvent::BootCompleted);
    apply(&mut machine, LifecycleEvent::StandbyRequested);

    let result = machine.apply(GuardedEvent {
        generation: maximum,
        event: LifecycleEvent::AuthorityRevoked,
    });

    assert!(
        matches!(result, Err(LifecycleError::GenerationExhausted { .. }))
            && machine.state() == PlantState::Emergency
            && machine.generation() == maximum
    );
}

#[test]
fn active_health_degradation_should_enter_degraded_without_rotating_generation() {
    let mut machine = LifecycleMachine::new(generation(19));
    for event in [
        LifecycleEvent::BootCompleted,
        LifecycleEvent::StandbyRequested,
        LifecycleEvent::PreflightRequested,
        LifecycleEvent::AuthorizationGranted,
        LifecycleEvent::ActivationRequested,
    ] {
        apply(&mut machine, event);
    }
    let active_generation = machine.generation();

    let transition = machine
        .apply(GuardedEvent {
            generation: active_generation,
            event: LifecycleEvent::HealthDegraded,
        })
        .expect("health degradation is a guarded transition");

    assert!(
        transition.from == PlantState::Active
            && transition.to == PlantState::Degraded
            && machine.generation() == active_generation
    );
}

#[test]
fn clearing_degradation_should_require_fresh_generation_and_no_authority() {
    let mut machine = LifecycleMachine::new(generation(21));
    for event in [
        LifecycleEvent::BootCompleted,
        LifecycleEvent::StandbyRequested,
        LifecycleEvent::PreflightRequested,
        LifecycleEvent::AuthorizationGranted,
        LifecycleEvent::HealthDegraded,
    ] {
        apply(&mut machine, event);
    }
    let degraded_generation = machine.generation();

    let transition = machine
        .apply(GuardedEvent {
            generation: degraded_generation,
            event: LifecycleEvent::DegradationCleared,
        })
        .expect("clearing degradation fails closed to no authority");

    assert!(
        transition.to == PlantState::NoAuthority
            && transition.next_generation != degraded_generation
            && machine.state() == PlantState::NoAuthority
    );
}

#[test]
fn clearing_degradation_at_maximum_generation_should_latch_emergency() {
    let maximum = RuntimeGeneration::new(NonZeroU64::MAX);
    let mut machine = LifecycleMachine::new(maximum);
    for event in [
        LifecycleEvent::BootCompleted,
        LifecycleEvent::StandbyRequested,
        LifecycleEvent::PreflightRequested,
        LifecycleEvent::AuthorizationGranted,
        LifecycleEvent::HealthDegraded,
    ] {
        apply(&mut machine, event);
    }

    let result = machine.apply(GuardedEvent {
        generation: maximum,
        event: LifecycleEvent::DegradationCleared,
    });

    assert!(
        matches!(result, Err(LifecycleError::GenerationExhausted { .. }))
            && machine.state() == PlantState::Emergency
            && machine.generation() == maximum
    );
}

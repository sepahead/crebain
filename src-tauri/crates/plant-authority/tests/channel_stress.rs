use std::collections::HashSet;
use std::num::{NonZeroU64, NonZeroUsize};
use std::sync::{Arc, Barrier};

use crebain_plant_authority::{
    bounded_queue, latest_value, ChannelConfigurationError, ChannelError, FullPolicy,
    KernelChannels, RuntimeGeneration, SafetyCause, SafetyLatch, SafetyNotice,
};

const PRODUCERS: usize = 8;
const VALUES_PER_PRODUCER: u64 = 5_000;
const TOTAL_SUBMISSIONS: u64 = 40_000;

#[test]
fn latest_value_channel_should_remain_capacity_one_under_concurrent_load() {
    let (sender, receiver) = latest_value();
    let barrier = Arc::new(Barrier::new(PRODUCERS));
    let handles: Vec<_> = (0..PRODUCERS)
        .map(|producer| {
            let sender = sender.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                for value in 0..VALUES_PER_PRODUCER {
                    sender
                        .replace((producer, value))
                        .expect("receiver remains alive during stress test");
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().expect("producer should not panic");
    }

    let snapshot = receiver
        .take_latest()
        .expect("latest state should remain healthy")
        .expect("newest value should remain");
    assert!(
        snapshot.sequence == TOTAL_SUBMISSIONS
            && snapshot.overwritten == TOTAL_SUBMISSIONS - 1
            && !receiver
                .has_value()
                .expect("latest state should remain healthy"),
        "unexpected latest snapshot: {snapshot:?}"
    );
}

#[test]
fn lifecycle_queue_should_reject_new_work_without_losing_retained_order() {
    let capacity = NonZeroUsize::new(4).expect("test capacity is nonzero");
    let (sender, receiver) =
        bounded_queue(capacity, FullPolicy::RejectNew).expect("test capacity is accepted");
    for value in 0..capacity.get() {
        sender
            .try_send(value)
            .expect("queue has room for declared capacity");
    }

    let rejected = sender.try_send(99);
    let mut retained = Vec::new();
    while let Some((value, _)) = receiver
        .try_receive()
        .expect("queue state should remain healthy")
    {
        retained.push(value);
    }

    assert!(matches!(rejected, Err(ChannelError::Full(99))) && retained == vec![0, 1, 2, 3]);
}

#[test]
fn evidence_queue_should_bound_memory_and_report_every_oldest_drop() {
    let capacity = NonZeroUsize::new(8).expect("test capacity is nonzero");
    let (sender, receiver) =
        bounded_queue(capacity, FullPolicy::DropOldest).expect("test capacity is accepted");
    for value in 0..100_u64 {
        sender
            .try_send(value)
            .expect("drop-oldest queue remains open");
    }

    let mut retained = Vec::new();
    let mut accounting = None;
    while let Some((value, observed)) = receiver
        .try_receive()
        .expect("queue state should remain healthy")
    {
        retained.push(value);
        accounting = Some(observed);
    }

    assert!(
        retained == (92..100).collect::<Vec<_>>()
            && accounting.is_some_and(|value| value.dropped_oldest == 92)
    );
}

#[test]
fn safety_latch_should_preserve_one_first_cause_under_concurrent_load() {
    let latch = Arc::new(SafetyLatch::new());
    let generation = RuntimeGeneration::new(NonZeroU64::MIN);
    let causes = [
        SafetyCause::LifecycleQueueSaturated,
        SafetyCause::InternalInvariant,
        SafetyCause::ShutdownRequested,
    ];
    let handles: Vec<_> = (0..24)
        .map(|index| {
            let latch = Arc::clone(&latch);
            std::thread::spawn(move || {
                latch
                    .latch(SafetyNotice {
                        generation,
                        cause: causes[index % causes.len()],
                    })
                    .expect("latch state should remain healthy")
            })
        })
        .collect();
    let observed: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().expect("latch worker should not panic"))
        .collect();
    let retained = latch
        .get()
        .expect("latch state should remain healthy")
        .expect("one cause should be retained");

    assert!(observed.into_iter().all(|notice| notice == retained));
}

#[test]
fn kernel_channel_set_should_assign_explicit_policy_to_every_path() {
    let lifecycle_capacity = NonZeroUsize::new(2).expect("test capacity is nonzero");
    let evidence_capacity = NonZeroUsize::new(3).expect("test capacity is nonzero");
    let channels = KernelChannels::<u8, u16, u32, u64>::new(lifecycle_capacity, evidence_capacity)
        .expect("test capacities are accepted");

    assert!(
        channels.lifecycle.sender.capacity() == lifecycle_capacity
            && channels.evidence.sender.capacity() == evidence_capacity
            && !channels
                .latest_command
                .receiver
                .has_value()
                .expect("command state is healthy")
            && !channels
                .latest_health
                .receiver
                .has_value()
                .expect("health state is healthy")
            && !channels
                .latest_adapter_output
                .receiver
                .has_value()
                .expect("output state is healthy")
            && !channels
                .safety
                .is_latched()
                .expect("latch state is healthy")
    );
}

#[test]
fn pathological_queue_capacity_should_be_rejected_without_allocation() {
    let result = bounded_queue::<u8>(NonZeroUsize::MAX, FullPolicy::RejectNew);

    assert!(matches!(
        result,
        Err(ChannelConfigurationError::CapacityTooLarge {
            requested: usize::MAX,
            ..
        })
    ));
}

#[test]
fn closed_latest_channel_should_return_submitted_value_ownership() {
    let (sender, receiver) = latest_value();
    drop(receiver);

    let result = sender.replace(String::from("retained-by-caller"));

    assert!(matches!(
        result,
        Err(ChannelError::Closed(value)) if value == "retained-by-caller"
    ));
}

#[test]
fn closed_bounded_channel_should_return_submitted_value_ownership() {
    let (sender, receiver) =
        bounded_queue(NonZeroUsize::MIN, FullPolicy::RejectNew).expect("test capacity is accepted");
    drop(receiver);

    let result = sender.try_send(String::from("retained-by-caller"));

    assert!(matches!(
        result,
        Err(ChannelError::Closed(value)) if value == "retained-by-caller"
    ));
}

#[test]
fn concurrent_drop_oldest_should_conserve_retained_and_accounted_values() {
    const SENDERS: usize = 8;
    const VALUES_PER_SENDER: usize = 1_000;
    const TOTAL: usize = SENDERS * VALUES_PER_SENDER;
    let capacity = NonZeroUsize::new(64).expect("test capacity is nonzero");
    let (sender, receiver) =
        bounded_queue(capacity, FullPolicy::DropOldest).expect("test capacity is accepted");
    let handles: Vec<_> = (0..SENDERS)
        .map(|producer| {
            let sender = sender.clone();
            std::thread::spawn(move || {
                for sequence in 0..VALUES_PER_SENDER {
                    sender
                        .try_send((producer, sequence))
                        .expect("drop-oldest sender remains healthy");
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().expect("producer should not panic");
    }

    let mut retained = HashSet::new();
    let mut dropped = 0_u64;
    while let Some((value, accounting)) = receiver
        .try_receive()
        .expect("queue state should remain healthy")
    {
        retained.insert(value);
        dropped = accounting.dropped_oldest;
    }

    assert!(
        retained.len() == capacity.get()
            && usize::try_from(dropped).is_ok_and(|count| count + retained.len() == TOTAL)
    );
}

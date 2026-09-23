//! Private single-threaded startup capsule. No listening socket or descriptor duplication.

use std::collections::BTreeSet;
use std::io;
use std::mem::{self, MaybeUninit};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn identity(fd: RawFd) -> io::Result<(libc::dev_t, libc::ino_t, i32)> {
    // SAFETY: fcntl reads only the supplied scalar FD. The startup roster cannot race
    // with another owner, signal handler, descriptor allocator, or closing thread.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut status = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: status is a correctly sized, aligned writable libc::stat. No reference
    // reads its contents before fstat reports that the operating system filled it.
    if unsafe { libc::fstat(fd, status.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful fstat initialized the complete stat value above.
    let status = unsafe { status.assume_init() };
    if status.st_mode & libc::S_IFMT != libc::S_IFSOCK || status.st_ino == 0 {
        return Err(invalid("direct socket with stable local identity required"));
    }
    let mut kind: libc::c_int = 0;
    let mut length = mem::size_of::<libc::c_int>() as libc::socklen_t;
    // SAFETY: kind and length are live correctly aligned scalar outputs; the supplied
    // byte extent is exactly sizeof(c_int), and getsockopt cannot write past that limit.
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            std::ptr::from_mut(&mut kind).cast(),
            &mut length,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if length as usize != mem::size_of::<libc::c_int>() || kind != libc::SOCK_STREAM {
        return Err(invalid("Unix stream service endpoint required"));
    }
    for peer in [false, true] {
        let mut address = MaybeUninit::<libc::sockaddr_storage>::zeroed();
        let mut length = mem::size_of::<libc::sockaddr_storage>() as libc::socklen_t;
        // SAFETY: address has enough aligned storage for any platform socket address.
        // Both functions honor the input capacity and return the actual byte extent.
        let result = unsafe {
            if peer {
                libc::getpeername(fd, address.as_mut_ptr().cast(), &mut length)
            } else {
                libc::getsockname(fd, address.as_mut_ptr().cast(), &mut length)
            }
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: zero initialization makes the whole integer-only sockaddr_storage
        // valid, including bytes outside the returned address. Read only its family.
        let address = unsafe { address.assume_init() };
        if length as usize > mem::size_of::<libc::sockaddr_storage>()
            || (length as usize)
                < mem::offset_of!(libc::sockaddr_storage, ss_family)
                    + mem::size_of::<libc::sa_family_t>()
            || address.ss_family as i32 != libc::AF_UNIX
        {
            return Err(invalid("connected local and peer Unix addresses required"));
        }
    }
    Ok((status.st_dev, status.st_ino, flags))
}

fn close_on_exec(fd: &OwnedFd, flags: i32) -> io::Result<()> {
    // SAFETY: fd is now exclusively owned by this capsule. The scalar fcntl operation
    // changes descriptor flags only; it does not duplicate, replace, or close the FD.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn take_with(
    roster: &[RawFd],
    mut set_flags: impl FnMut(&OwnedFd, i32, usize) -> io::Result<()>,
) -> io::Result<Vec<UnixStream>> {
    if !(2..=16).contains(&roster.len())
        || roster.iter().any(|fd| *fd < 3)
        || roster.iter().copied().collect::<BTreeSet<_>>().len() != roster.len()
    {
        return Err(invalid(
            "bounded unique inherited service descriptors required",
        ));
    }
    let mut identities = BTreeSet::new();
    let mut inspected = Vec::with_capacity(roster.len());
    // This entire phase is read-only. A rejection leaves every inherited FD untouched.
    for fd in roster {
        let (device, inode, flags) = identity(*fd)?;
        if !identities.insert((device, inode)) {
            return Err(invalid("aliased inherited service endpoints"));
        }
        inspected.push((*fd, flags));
    }
    let mut owned = Vec::with_capacity(inspected.len());
    for (index, (fd, flags)) in inspected.into_iter().enumerate() {
        // SAFETY: the trusted launcher exclusively transferred this live descriptor
        // at exec. The full read-only roster has unique numbers and kernel identities.
        // Startup is single-threaded with no handlers or helpers that close/reassign FDs.
        // No Rust owner exists for any roster entry; each enters this loop exactly once.
        let descriptor = unsafe { OwnedFd::from_raw_fd(fd) };
        set_flags(&descriptor, flags, index)?;
        owned.push(UnixStream::from(descriptor));
    }
    Ok(owned)
}

/// Used only by the sibling binary's pre-thread startup call. It is not a library API.
pub(super) fn take_at_startup(roster: &[RawFd]) -> io::Result<Vec<UnixStream>> {
    take_with(roster, |fd, flags, _| close_on_exec(fd, flags))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::IntoRawFd;
    use std::process::Command;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn pair() -> (RawFd, UnixStream) {
        let (selected, peer) = UnixStream::pair().unwrap();
        (selected.into_raw_fd(), peer)
    }
    fn reclaim(fd: RawFd) {
        // SAFETY: tests call this only for their unique still-unconsumed into_raw_fd value.
        drop(unsafe { OwnedFd::from_raw_fd(fd) });
    }

    #[test]
    fn positive_distinct_connected_streams_receive_cloexec_and_own_their_lifetime() {
        let _serial = TEST_LOCK.lock().unwrap();
        let (a, _peer_a) = pair();
        let (b, _peer_b) = pair();
        let adopted = take_at_startup(&[a, b]).unwrap();
        for fd in [a, b] {
            assert_ne!(identity(fd).unwrap().2 & libc::FD_CLOEXEC, 0);
        }
        drop(adopted);
        for fd in [a, b] {
            assert!(identity(fd).is_err());
        }
    }

    #[test]
    fn numeric_alias_and_kernel_alias_reject_without_consuming_any_descriptor() {
        let _serial = TEST_LOCK.lock().unwrap();
        let (selected, _peer) = UnixStream::pair().unwrap();
        let duplicate = selected.try_clone().unwrap().into_raw_fd();
        let original = selected.into_raw_fd();
        assert!(take_at_startup(&[original, original]).is_err());
        assert!(take_at_startup(&[original, duplicate]).is_err());
        assert!(identity(original).is_ok());
        assert!(identity(duplicate).is_ok());
        reclaim(original);
        reclaim(duplicate);
    }

    #[test]
    fn out_of_range_rosters_and_later_invalid_fd_leave_prior_descriptors_untouched() {
        let _serial = TEST_LOCK.lock().unwrap();
        let (a, _peer_a) = pair();
        let (b, _peer_b) = pair();
        for roster in [
            vec![a],
            vec![a, -1],
            vec![a, 0],
            vec![a, i32::MAX],
            vec![a; 17],
        ] {
            assert!(take_at_startup(&roster).is_err());
            assert!(identity(a).is_ok());
            assert!(identity(b).is_ok());
        }
        reclaim(a);
        reclaim(b);
    }

    #[test]
    fn partial_flag_failure_closes_only_consumed_entries() {
        let _serial = TEST_LOCK.lock().unwrap();
        let pairs: Vec<_> = (0..3).map(|_| pair()).collect();
        let roster: Vec<_> = pairs.iter().map(|(fd, _)| *fd).collect();
        let error = take_with(&roster, |fd, flags, index| {
            if index == 1 {
                Err(io::Error::other("injected CLOEXEC failure"))
            } else {
                close_on_exec(fd, flags)
            }
        })
        .err()
        .unwrap();
        assert_eq!(error.to_string(), "injected CLOEXEC failure");
        assert!(identity(roster[0]).is_err());
        assert!(identity(roster[1]).is_err());
        assert!(identity(roster[2]).is_ok());
        reclaim(roster[2]);
    }

    #[test]
    fn actual_child_inheritance_probe() {
        let Ok(encoded) = std::env::var("CREBAIN_FAMILY_FD_TEST") else {
            return;
        };
        let mut fields = encoded.split(':');
        let present = fields.next().unwrap() == "present";
        for entry in fields {
            let numbers: Vec<_> = entry
                .split(',')
                .map(|item| item.parse::<i128>().unwrap())
                .collect();
            let observed = identity(numbers[0] as RawFd).ok();
            let joined = observed.is_some_and(|(device, inode, _)| {
                device as i128 == numbers[1] && inode as i128 == numbers[2]
            });
            assert_eq!(joined, present);
        }
    }

    fn child_probe(roster: &[RawFd], present: bool) {
        let mut value = if present {
            "present".to_owned()
        } else {
            "absent".to_owned()
        };
        for fd in roster {
            let (device, inode, _) = identity(*fd).unwrap();
            value.push_str(&format!(":{fd},{device},{inode}"));
        }
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "inherited::tests::actual_child_inheritance_probe",
                "--nocapture",
            ])
            .env("CREBAIN_FAMILY_FD_TEST", value)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }

    #[test]
    fn actual_child_detects_unprotected_fds_and_cannot_inherit_adopted_service_fds() {
        let _serial = TEST_LOCK.lock().unwrap();
        let (a, _peer_a) = pair();
        let (b, _peer_b) = pair();
        for fd in [a, b] {
            let flags = identity(fd).unwrap().2;
            // SAFETY: these descriptors are uniquely test-owned and remain open.
            assert_eq!(
                unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) },
                0
            );
        }
        child_probe(&[a, b], true);
        let adopted = take_at_startup(&[a, b]).unwrap();
        child_probe(&[a, b], false);
        drop(adopted);
    }

    #[test]
    fn files_datagrams_and_listeners_reject_while_a_fresh_pair_passes() {
        let _serial = TEST_LOCK.lock().unwrap();
        let (a, _peer) = pair();
        let file = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
        let datagram = std::os::unix::net::UnixDatagram::unbound().unwrap();
        let directory = std::path::Path::new("/tmp")
            .canonicalize()
            .unwrap()
            .join(format!("crebain-family-fd-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("socket");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        for rejected in [file.as_raw_fd(), datagram.as_raw_fd(), listener.as_raw_fd()] {
            assert!(take_at_startup(&[a, rejected]).is_err());
            assert!(identity(a).is_ok());
            // SAFETY: each rejected descriptor is still owned by its original wrapper.
            assert!(unsafe { libc::fcntl(rejected, libc::F_GETFD) } >= 0);
        }
        let (b, _other_peer) = pair();
        drop(take_at_startup(&[a, b]).unwrap());
        drop(listener);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn pipe_and_unconnected_stream_reject_before_ownership_transfer() {
        let _serial = TEST_LOCK.lock().unwrap();
        let (a, _peer) = pair();
        let mut pipe = [-1; 2];
        // SAFETY: pipe points to two writable c_int entries; successful pipe creates
        // two fresh, uniquely test-owned descriptors, which the test closes once.
        assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
        // SAFETY: socket creates one fresh test-owned unconnected stream descriptor.
        let socket = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
        assert!(socket >= 3);
        for rejected in [pipe[0], pipe[1], socket] {
            assert!(take_at_startup(&[a, rejected]).is_err());
            assert!(identity(a).is_ok());
            // SAFETY: the rejected descriptor remains exclusively test-owned.
            assert!(unsafe { libc::fcntl(rejected, libc::F_GETFD) } >= 0);
        }
        for fd in [a, pipe[0], pipe[1], socket] {
            reclaim(fd);
        }
    }
}

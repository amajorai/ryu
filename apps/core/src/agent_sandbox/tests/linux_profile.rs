use super::*;

/// Fork, run `body` in the child (single-threaded, so namespaces work),
/// and return its exit status.
#[cfg(target_os = "linux")]
fn in_forked_child(body: impl FnOnce() -> i32) -> i32 {
    // SAFETY: the child only runs `body` and exits; glibc resets its
    // allocator locks across fork.
    match unsafe { libc::fork() } {
        -1 => panic!("fork failed"),
        0 => {
            let code = body();
            // SAFETY: leave without running the test harness's destructors.
            unsafe { libc::_exit(code) }
        }
        child => {
            let mut status = 0;
            // SAFETY: waiting on our own child.
            unsafe { libc::waitpid(child, &mut status, 0) };
            if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else {
                -1
            }
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn linux_profile_hides_credentials_and_cuts_network_but_relays_the_gateway() {
    use std::io::{Read, Write};
    let scratch = tempfile::tempdir().unwrap();
    let probe = scratch.path().join("probe");
    std::fs::create_dir_all(&probe).unwrap();
    let supported = in_forked_child(|| {
        let plan = RunnerPlan {
            masks: vec![probe.clone()],
            isolate_network: true,
            ..RunnerPlan::default()
        };
        i32::from(linux::enter(&plan).is_err())
    });
    if supported != 0 {
        eprintln!("skipping: unprivileged user namespaces unavailable on this host");
        return;
    }

    let secrets = scratch.path().join(".ssh");
    std::fs::create_dir_all(&secrets).unwrap();
    std::fs::write(secrets.join("id_ed25519"), b"PRIVATE KEY").unwrap();
    let token = scratch.path().join("node-auth.token");
    std::fs::write(&token, b"core-token").unwrap();

    // The "gateway" (relayed) and some other local service (not relayed).
    let gateway = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let gateway_port = gateway.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in gateway.incoming().flatten() {
            let mut stream = stream;
            let mut buffer = [0_u8; 4];
            if stream.read_exact(&mut buffer).is_ok() {
                let _ = stream.write_all(b"pong");
            }
        }
    });
    let other = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let other_port = other.local_addr().unwrap().port();

    let relay = scratch.path().join("relay");
    std::fs::create_dir_all(&relay).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime
        .block_on(ensure_loopback_relay(&relay, gateway_port))
        .unwrap();

    let plan = RunnerPlan {
        masks: vec![secrets.clone(), token.clone()],
        isolate_network: true,
        loopback_ports: vec![gateway_port],
        relay_dir: Some(relay.clone()),
        ..RunnerPlan::default()
    };
    let code = in_forked_child(|| {
        if linux::enter(&plan).is_err() {
            return 10;
        }
        if std::fs::read(secrets.join("id_ed25519")).is_ok() {
            return 11;
        }
        if std::fs::read(&token)
            .map(|bytes| !bytes.is_empty())
            .unwrap_or(true)
        {
            return 12;
        }
        if std::fs::write(secrets.join("authorized_keys"), b"x").is_ok() {
            return 13;
        }
        if std::net::TcpStream::connect(("127.0.0.1", other_port)).is_ok() {
            return 14;
        }
        if std::net::TcpStream::connect(("1.1.1.1", 443)).is_ok() {
            return 15;
        }
        let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", gateway_port)) else {
            return 16;
        };
        let mut reply = [0_u8; 4];
        if stream.write_all(b"ping").is_err() || stream.read_exact(&mut reply).is_err() {
            return 17;
        }
        if &reply != b"pong" {
            return 18;
        }
        0
    });
    drop(other);
    assert_eq!(code, 0, "sandboxed child failed check {code}");
    assert_eq!(
        std::fs::read(secrets.join("id_ed25519")).unwrap(),
        b"PRIVATE KEY",
        "masks never reach the host"
    );
}

/// A credential store hidden as a folder stays hidden after the host
/// atomically replaces a file in it (an OAuth refresh rewriting
/// `auth.json`), which a single-file mask would not survive on Linux.
#[cfg(target_os = "linux")]
#[test]
fn linux_folder_masks_survive_an_atomic_rename_on_the_host() {
    let scratch = tempfile::tempdir().unwrap();
    let store = scratch.path().join("pi-agent");
    std::fs::create_dir_all(&store).unwrap();
    std::fs::write(store.join("auth.json"), b"old-token").unwrap();
    let supported = in_forked_child(|| {
        let plan = RunnerPlan {
            masks: vec![store.clone()],
            ..RunnerPlan::default()
        };
        i32::from(linux::enter(&plan).is_err())
    });
    if supported != 0 {
        eprintln!("skipping: unprivileged user namespaces unavailable on this host");
        return;
    }

    let mut ready = [0_i32; 2];
    let mut go = [0_i32; 2];
    // SAFETY: pipe writes two valid descriptors into each array.
    assert_eq!(unsafe { libc::pipe(ready.as_mut_ptr()) }, 0);
    assert_eq!(unsafe { libc::pipe(go.as_mut_ptr()) }, 0);
    let plan = RunnerPlan {
        masks: vec![store.clone()],
        ..RunnerPlan::default()
    };
    // SAFETY: the child only enters its namespace, talks over the pipes
    // and exits; glibc resets its allocator locks across fork.
    match unsafe { libc::fork() } {
        -1 => panic!("fork failed"),
        0 => {
            let code = (|| {
                if linux::enter(&plan).is_err() {
                    return 10;
                }
                let mut byte = [1_u8];
                // SAFETY: valid pipe descriptors and a one-byte buffer.
                unsafe {
                    libc::write(ready[1], byte.as_ptr().cast(), 1);
                    libc::read(go[0], byte.as_mut_ptr().cast(), 1);
                }
                match std::fs::read(store.join("auth.json")) {
                    Ok(_) => 11,
                    Err(_) => 0,
                }
            })();
            // SAFETY: leave without running the test harness's destructors.
            unsafe { libc::_exit(code) }
        }
        child => {
            let mut byte = [0_u8];
            // SAFETY: valid pipe descriptor and a one-byte buffer.
            unsafe { libc::read(ready[0], byte.as_mut_ptr().cast(), 1) };
            let fresh = store.join("auth.json.tmp");
            std::fs::write(&fresh, b"new-token").unwrap();
            std::fs::rename(&fresh, store.join("auth.json")).unwrap();
            // SAFETY: as above.
            unsafe { libc::write(go[1], byte.as_ptr().cast(), 1) };
            let mut status = 0;
            // SAFETY: waiting on our own child.
            unsafe { libc::waitpid(child, &mut status, 0) };
            for fd in ready.into_iter().chain(go) {
                // SAFETY: closing descriptors this test opened.
                unsafe { libc::close(fd) };
            }
            assert!(libc::WIFEXITED(status));
            assert_eq!(
                libc::WEXITSTATUS(status),
                0,
                "the replaced auth.json must stay hidden"
            );
        }
    }
}

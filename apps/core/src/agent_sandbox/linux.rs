//! Namespace setup for the untrusted-workspace profile. Runs in the
//! single-threaded runner process before `exec`.

use std::ffi::CString;
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use anyhow::{bail, Context, Result};

use super::{relay_socket, RunnerPlan};

fn os_error(what: &str) -> anyhow::Error {
    anyhow::Error::new(std::io::Error::last_os_error()).context(what.to_owned())
}

fn c_path(path: &Path) -> Result<CString> {
    CString::new(path.as_os_str().as_bytes()).context("path contains a NUL byte")
}

/// Map the caller's uid/gid into the user namespace just entered.
fn write_id_maps(uid: libc::uid_t, gid: libc::gid_t) -> Result<()> {
    match std::fs::write("/proc/self/setgroups", "deny") {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("denying setgroups in the agent namespace"),
    }
    std::fs::write("/proc/self/uid_map", format!("{uid} {uid} 1"))
        .context("writing the agent namespace uid map")?;
    std::fs::write("/proc/self/gid_map", format!("{gid} {gid} 1"))
        .context("writing the agent namespace gid map")?;
    Ok(())
}

fn unshare(flags: libc::c_int, what: &str) -> Result<()> {
    // SAFETY: unshare only changes this process's namespace membership.
    if unsafe { libc::unshare(flags) } != 0 {
        return Err(os_error(what));
    }
    Ok(())
}

/// Cover `path` with an empty read-only directory or an empty file.
fn mask(path: &Path) -> Result<()> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).with_context(|| format!("inspecting {}", path.display())),
    };
    let target = c_path(path)?;
    let result = if metadata.is_dir() {
        let fstype = CString::new("tmpfs").expect("static string");
        let options = CString::new("size=4k,nr_inodes=4,mode=0500").expect("static string");
        // SAFETY: every pointer is a valid NUL-terminated string that
        // outlives the call.
        unsafe {
            libc::mount(
                fstype.as_ptr(),
                target.as_ptr(),
                fstype.as_ptr(),
                libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
                options.as_ptr().cast(),
            )
        }
    } else {
        let source = CString::new("/dev/null").expect("static string");
        // SAFETY: as above; a bind mount takes no fstype or data.
        unsafe {
            libc::mount(
                source.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                libc::MS_BIND,
                std::ptr::null(),
            )
        }
    };
    if result != 0 {
        return Err(os_error(&format!("hiding {}", path.display())));
    }
    Ok(())
}

/// Bring up `lo` in the new network namespace (it starts down).
fn loopback_up() -> Result<()> {
    // SAFETY: plain socket/ioctl calls on a zero-initialised ifreq whose
    // name is a NUL-terminated "lo".
    unsafe {
        let fd = libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0);
        if fd < 0 {
            return Err(os_error("opening a socket to configure loopback"));
        }
        let mut request: libc::ifreq = std::mem::zeroed();
        for (slot, byte) in request.ifr_name.iter_mut().zip(b"lo\0") {
            *slot = *byte as libc::c_char;
        }
        let mut status = libc::ioctl(fd, libc::SIOCGIFFLAGS, &mut request);
        if status == 0 {
            request.ifr_ifru.ifru_flags |= (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_short;
            status = libc::ioctl(fd, libc::SIOCSIFFLAGS, &request);
        }
        let error = (status != 0).then(|| os_error("bringing up loopback"));
        libc::close(fd);
        error.map_or(Ok(()), Err)
    }
}

fn pump(mut from: impl Read, mut to: impl Write, shutdown: impl FnOnce()) {
    let _ = std::io::copy(&mut from, &mut to);
    shutdown();
}

/// Fork a process that listens on `127.0.0.1:port` inside the namespace
/// and relays each connection to Core's socket for that port. It dies with
/// the agent (`PR_SET_PDEATHSIG`).
fn spawn_forwarder(port: u16, relay_dir: &Path) -> Result<()> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))
        .with_context(|| format!("listening on loopback port {port} in the agent namespace"))?;
    let socket = relay_socket(relay_dir, port);
    // SAFETY: getpid has no preconditions.
    let parent = unsafe { libc::getpid() };
    // SAFETY: the runner is single-threaded, so the child is a full copy.
    match unsafe { libc::fork() } {
        -1 => Err(os_error("forking the loopback forwarder")),
        0 => {
            // SAFETY: prctl/getppid/open/dup2 have no memory preconditions.
            unsafe {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                if libc::getppid() != parent {
                    libc::_exit(0);
                }
                let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
                if null >= 0 {
                    libc::dup2(null, 0);
                    libc::dup2(null, 1);
                }
            }
            for inbound in listener.incoming().flatten() {
                let socket = socket.clone();
                std::thread::spawn(move || {
                    let Ok(outbound) = std::os::unix::net::UnixStream::connect(&socket) else {
                        return;
                    };
                    let (Ok(inbound_read), Ok(outbound_read)) =
                        (inbound.try_clone(), outbound.try_clone())
                    else {
                        return;
                    };
                    let upstream_out = outbound.try_clone();
                    let downstream_in = inbound.try_clone();
                    let upstream = std::thread::spawn(move || {
                        pump(inbound_read, outbound, move || {
                            if let Ok(stream) = upstream_out {
                                let _ = stream.shutdown(std::net::Shutdown::Write);
                            }
                        });
                    });
                    pump(outbound_read, inbound, move || {
                        if let Ok(stream) = downstream_in {
                            let _ = stream.shutdown(std::net::Shutdown::Write);
                        }
                    });
                    let _ = upstream.join();
                });
            }
            // SAFETY: terminate the forwarder without running the parent's
            // atexit handlers.
            unsafe { libc::_exit(0) }
        }
        _ => Ok(()),
    }
}

/// Enter the untrusted-workspace namespaces for `plan`.
pub(super) fn enter(plan: &RunnerPlan) -> Result<()> {
    // SAFETY: getuid/getgid have no preconditions.
    let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
    let mut flags = libc::CLONE_NEWUSER | libc::CLONE_NEWNS;
    if plan.isolate_network {
        flags |= libc::CLONE_NEWNET;
    }
    unshare(flags, "creating the agent namespaces")?;
    write_id_maps(uid, gid)?;
    let root = c"/";
    // SAFETY: remount the whole tree private so no mount below leaks back
    // to the host namespace.
    if unsafe {
        libc::mount(
            std::ptr::null(),
            root.as_ptr(),
            std::ptr::null(),
            libc::MS_REC | libc::MS_PRIVATE,
            std::ptr::null(),
        )
    } != 0
    {
        return Err(os_error("making the agent mount namespace private"));
    }
    for path in &plan.masks {
        mask(path)?;
    }
    if plan.isolate_network {
        loopback_up()?;
        if !plan.loopback_ports.is_empty() {
            let Some(relay_dir) = plan.relay_dir.as_deref() else {
                bail!("relayed loopback ports need a relay directory")
            };
            for port in &plan.loopback_ports {
                spawn_forwarder(*port, relay_dir)?;
            }
        }
    }
    // A second user namespace copies the mount table into a less
    // privileged owner, which locks every mount above: the agent cannot
    // unmount a mask to see what it covers, even holding namespace caps.
    unshare(
        libc::CLONE_NEWUSER | libc::CLONE_NEWNS,
        "locking the agent mounts",
    )?;
    write_id_maps(uid, gid)?;
    // SAFETY: prctl(PR_SET_NO_NEW_PRIVS) has no memory preconditions.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(os_error("enabling no_new_privs for the agent"));
    }
    Ok(())
}

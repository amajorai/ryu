//! Bounded remote `git` commands and repository cloning.

use super::*;

/// Shaped `POST /api/git/pull` and `POST /api/git/sync` result.
#[derive(Debug, serde::Serialize)]
pub struct GitRemoteOutcome {
    pub success: bool,
    pub pulled: bool,
    pub pushed: bool,
    pub commit: Option<String>,
}

pub(super) fn remote_git_failed(operation: &str, output: &std::process::Output) -> String {
    let details = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(400)
        .collect::<String>();
    if details.is_empty() {
        format!("git {operation} failed")
    } else {
        format!("git {operation} failed: {details}")
    }
}

pub(super) const REMOTE_GIT_TIMEOUT: Duration = Duration::from_secs(120);

/// Run a remote Git mutation without giving Git an interactive credential or
/// terminal path. A blocking `Command::output` cannot be cancelled when the
/// HTTP client disconnects, so remote actions use a supervised child with a
/// bounded lifetime and kill it on timeout.
pub(crate) fn run_remote_git_command(cwd: &str, args: &[&str]) -> Result<Output, String> {
    let ssh_command = std::env::var("GIT_SSH_COMMAND")
        .map(|value| format!("{value} -o BatchMode=yes"))
        .unwrap_or_else(|_| "ssh -o BatchMode=yes".to_string());
    let mut child = git_without_hooks(args)
        .current_dir(cwd)
        .no_window()
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", ssh_command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start git: {error}"))?;
    // Drain both pipes while Git runs. A pull prints its diffstat after the
    // fast-forward, so an undrained pipe would block Git once it fills and
    // turn a completed pull into a reported timeout.
    let stdout = spawn_capped_pipe_reader(child.stdout.take());
    let stderr = spawn_capped_pipe_reader(child.stderr.take());
    // On the timeout and error paths the readers are left detached rather
    // than joined: a lingering Git helper (such as ssh) can hold the pipe
    // open after Git is killed, and joining would defeat the deadline. Each
    // reader ends on its own once the last writer closes.
    let deadline = Instant::now() + REMOTE_GIT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(Output {
                    status,
                    stdout: join_pipe_reader(stdout),
                    stderr: join_pipe_reader(stderr),
                });
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out after 120 seconds".to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("could not inspect git process: {error}"));
            }
        }
    }
}

/// Bytes kept from each remote Git pipe. The reader keeps draining (and
/// discarding) past this so Git never blocks on a full pipe.
pub(super) const REMOTE_GIT_OUTPUT_CAP: usize = 1024 * 1024;

pub(super) fn spawn_capped_pipe_reader<R>(pipe: Option<R>) -> Option<thread::JoinHandle<Vec<u8>>>
where
    R: std::io::Read + Send + 'static,
{
    let mut pipe = pipe?;
    Some(thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    let room = REMOTE_GIT_OUTPUT_CAP.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        kept
    }))
}

pub(super) fn join_pipe_reader(reader: Option<thread::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
}

/// Clone one repository into a new directory without exposing an incomplete
/// checkout as a project. The caller validates the source URL and destination
/// boundary; this function owns the bounded, non-interactive Git invocation.
///
/// The temporary directory is created by this process and renamed into place
/// only after `git clone` succeeds. A failed clone therefore cannot leave a
/// half-populated project folder that the desktop might register on its next
/// refresh.
pub fn clone_repository(url: &str, destination: &Path) -> Result<(), String> {
    clone_repository_with_config(url, destination, &[])
}

/// [`clone_repository`] for a caller-supplied public HTTPS/SSH URL whose host
/// the caller already screened against local and cloud-metadata addresses.
///
/// Git would otherwise re-resolve the host on its own and follow the server's
/// HTTP redirect on the initial request, so a screened public host could still
/// send this node to a loopback or link-local service. This clone allows only
/// the `https` and `ssh` transports, follows no redirects, and, when
/// `pinned_resolve` is set (`host:port:addr[,addr]`, from the addresses the
/// caller approved), pins HTTPS name resolution to those addresses.
///
/// Pinning uses `http.curloptResolve`, which Git before 2.37 silently ignores,
/// so a pinned HTTPS clone fails closed on older (or unidentifiable) Git rather
/// than letting it re-resolve the host. SSH connections are not pinned: OpenSSH
/// resolves the host itself. That residual rebinding window is accepted because
/// an SSH client only reaches the target port with an SSH handshake, which
/// cannot issue an HTTP request to a loopback or metadata service.
pub fn clone_public_repository(
    url: &str,
    destination: &Path,
    pinned_resolve: Option<&str>,
) -> Result<(), String> {
    let mut config = vec![
        "http.followRedirects=false".to_string(),
        "protocol.allow=never".to_string(),
        "protocol.https.allow=always".to_string(),
        "protocol.ssh.allow=always".to_string(),
    ];
    let https = url
        .trim()
        .get(..8)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"));
    if let Some(entry) = pinned_resolve.filter(|_| https) {
        let version = installed_git_version();
        if !version.is_some_and(|version| version >= GIT_CURLOPT_RESOLVE_MIN) {
            let found = version.map_or_else(
                || "an unknown version".to_string(),
                |(major, minor)| format!("{major}.{minor}"),
            );
            return Err(format!(
                "cloning over HTTPS needs Git {}.{} or later on this node (found {found}); update Git and try again",
                GIT_CURLOPT_RESOLVE_MIN.0, GIT_CURLOPT_RESOLVE_MIN.1
            ));
        }
        config.push(format!("http.curloptResolve={entry}"));
    }
    clone_repository_with_config(url, destination, &config).map_err(|error| {
        let redirected = error.contains("redirect")
            || error.contains("returned error: 30")
            || error.contains("is this a git repository");
        if redirected {
            format!(
                "{error} (HTTP redirects are not followed; use the repository's current clone URL)"
            )
        } else {
            error
        }
    })
}

/// First Git release that honours `http.curloptResolve`.
pub(super) const GIT_CURLOPT_RESOLVE_MIN: (u32, u32) = (2, 37);

/// `(major, minor)` of the `git` on `PATH`, or `None` when it cannot be run or
/// its version string is not recognised.
pub(super) fn installed_git_version() -> Option<(u32, u32)> {
    let output = Command::new("git")
        .arg("--version")
        .no_window()
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_git_version(&String::from_utf8_lossy(&output.stdout))
}

/// Parse `git version 2.39.3 (Apple Git-146)` or `git version 2.45.1.windows.1`.
pub(super) fn parse_git_version(text: &str) -> Option<(u32, u32)> {
    let version = text
        .trim()
        .strip_prefix("git version ")?
        .split_whitespace()
        .next()?;
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts
        .next()?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()?;
    Some((major, minor))
}

pub(super) fn clone_repository_with_config(
    url: &str,
    destination: &Path,
    config: &[String],
) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("clone URL is required".to_string());
    }
    if !destination.is_absolute() {
        return Err("clone destination must be an absolute path".to_string());
    }
    match std::fs::symlink_metadata(destination) {
        Ok(_) => return Err("clone destination already exists".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("clone destination could not be inspected".to_string()),
    }

    let parent = destination
        .parent()
        .filter(|path| path.is_dir())
        .ok_or_else(|| "clone destination parent is not a directory".to_string())?;
    let parent_string = parent.to_string_lossy().into_owned();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut temporary_name = None;
    for attempt in 0..8 {
        let candidate = format!(".ryu-clone-{}-{nonce}-{attempt}", std::process::id());
        match std::fs::create_dir(parent.join(&candidate)) {
            Ok(()) => {
                temporary_name = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("could not create a temporary clone directory".to_string()),
        }
    }
    let temporary_name = temporary_name
        .ok_or_else(|| "could not reserve a temporary clone directory".to_string())?;
    let temporary_path = parent.join(&temporary_name);
    let cleanup = || {
        if std::fs::symlink_metadata(&temporary_path)
            .map(|metadata| metadata.file_type().is_dir())
            .unwrap_or(false)
        {
            let _ = std::fs::remove_dir_all(&temporary_path);
        }
    };

    let mut args = Vec::with_capacity(config.len() * 2 + 7);
    for entry in config {
        args.push("-c");
        args.push(entry.as_str());
    }
    args.extend([
        "clone",
        "--depth",
        "1",
        "--no-recurse-submodules",
        "--",
        url,
        &temporary_name,
    ]);
    let output = match run_remote_git_command(&parent_string, &args) {
        Ok(output) => output,
        Err(error) => {
            cleanup();
            return Err(format!("git clone {error}"));
        }
    };
    if !output.status.success() {
        let error = remote_git_failed("clone", &output);
        cleanup();
        return Err(error);
    }
    if !temporary_path.is_dir() {
        cleanup();
        return Err("git clone completed without creating a repository".to_string());
    }
    if std::fs::symlink_metadata(destination).is_ok() {
        cleanup();
        return Err("clone destination appeared while cloning".to_string());
    }
    if let Err(error) = std::fs::rename(&temporary_path, destination) {
        cleanup();
        return Err(format!("could not finalize cloned repository: {error}"));
    }
    Ok(())
}

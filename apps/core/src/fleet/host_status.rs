//! Host patch-status reporting for Ryu-provisioned (managed) Linux nodes.
//!
//! We never hold a managed node owner's SSH key, so patching is pull-based on
//! the node: unattended-upgrades patches Ubuntu, the root `ryu-update` timer
//! patches Ryu, and this module only OBSERVES the result. It runs as the
//! unprivileged Core service user inside the systemd sandbox written by
//! `infra/install.sh` (`ProtectSystem=strict` keeps every path below readable;
//! `ProcSubset=pid` hides `/proc/sys` and `/proc/stat`, so the kernel release
//! comes from `uname(2)` via `sysinfo`, and the boot time is derived from the
//! `sysinfo(2)` uptime: `sysinfo::System::boot_time()` reads `/proc/stat` and,
//! when it is hidden, returns the raw uptime as if it were an epoch).
//!
//! Every input is a world-readable host fact. Nothing here reads a secret, and
//! the only subprocess is `apt-check` with fixed arguments, a cleared
//! environment and a hard timeout. Failures degrade a field to `null`; a report
//! failure is logged and retried, never fatal.

use std::{
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

/// Steady-state cadence: the node's maintenance windows (apt ~02:00, Ryu
/// update ~03:00 plus security checks every six hours) move at most this fast.
const REPORT_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Give enrollment and the first reconciliation a head start after boot.
const STARTUP_DELAY: Duration = Duration::from_secs(30);
const NOT_ENROLLED_RETRY: Duration = Duration::from_secs(60);
const FAILURE_RETRY: Duration = Duration::from_secs(30 * 60);
const APT_CHECK_TIMEOUT: Duration = Duration::from_secs(90);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

const MAX_OS_RELEASE_BYTES: u64 = 16 * 1024;
const MAX_REBOOT_PKGS_BYTES: u64 = 16 * 1024;
const MAX_UPDATER_REPORT_BYTES: u64 = 4 * 1024;
const MAX_APT_CHECK_OUTPUT_BYTES: usize = 4 * 1024;
const MAX_REBOOT_PACKAGES: usize = 50;
const MAX_PACKAGE_NAME_CHARS: usize = 100;
/// 2000-01-01T00:00:00Z. A boot time before it is an uptime mistaken for an
/// epoch (or a broken clock), never a real boot, so it is reported as `null`.
const MIN_PLAUSIBLE_BOOT_EPOCH: i64 = 946_684_800;
const MAX_HOST_TEXT_CHARS: usize = 128;
const MAX_UPDATER_MESSAGE_CHARS: usize = 200;
/// The control plane's upper bound for either apt count.
const MAX_PENDING_UPDATES: u32 = 1_000_000;

/// Fixed host locations, injectable so tests read a temp directory instead.
#[derive(Debug, Clone)]
struct HostPaths {
    os_release: PathBuf,
    reboot_required: PathBuf,
    reboot_required_pkgs: PathBuf,
    apt_upgrade_stamp: PathBuf,
    unattended_upgrades_stamp: PathBuf,
    apt_check: PathBuf,
    updater_report: PathBuf,
}

impl HostPaths {
    fn system() -> Self {
        Self {
            os_release: PathBuf::from("/etc/os-release"),
            reboot_required: PathBuf::from("/var/run/reboot-required"),
            reboot_required_pkgs: PathBuf::from("/var/run/reboot-required.pkgs"),
            apt_upgrade_stamp: PathBuf::from("/var/lib/apt/periodic/upgrade-stamp"),
            unattended_upgrades_stamp: PathBuf::from(
                "/var/lib/apt/periodic/unattended-upgrades-stamp",
            ),
            apt_check: PathBuf::from("/usr/lib/update-notifier/apt-check"),
            // Contract C1: written by the root updater on every run.
            updater_report: PathBuf::from("/var/lib/ryu-update-report/status.json"),
        }
    }
}

/// The `ryu-update` run summary (contract C1), re-serialized after validation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterReport {
    checked_at: String,
    result: String,
    tag: Option<String>,
    installed_tag: Option<String>,
    signature: Option<String>,
    security_release: bool,
    message: String,
}

/// Body of `POST /api/control-plane/nodes/me/host-status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostStatus {
    core_version: String,
    os_pretty_name: Option<String>,
    kernel_running: Option<String>,
    booted_at: Option<String>,
    reboot_required: bool,
    reboot_required_packages: Vec<String>,
    last_apt_upgrade_at: Option<String>,
    pending_updates: Option<u32>,
    pending_security_updates: Option<u32>,
    updater: Option<UpdaterReport>,
}

fn rfc3339(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// One-line, printable, length-capped text, or `None` when nothing remains.
fn bounded_text(value: &str, max_chars: usize) -> Option<String> {
    let cleaned: String = value
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect();
    let cleaned = cleaned.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_owned())
}

/// Read at most `max_bytes`; a missing, unreadable or oversized file is `None`.
fn read_capped(path: &Path, max_bytes: u64) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    let mut buffer = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut buffer).ok()?;
    (buffer.len() as u64 <= max_bytes).then_some(buffer)
}

/// `PRETTY_NAME` from os-release(5), unquoting the shell-style value.
fn parse_os_release(text: &str) -> Option<String> {
    let raw = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("PRETTY_NAME="))?
        .trim();
    let unquoted = raw
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            raw.strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(raw);
    bounded_text(&unquoted.replace("\\\"", "\""), MAX_HOST_TEXT_CHARS)
}

/// Package names from `/var/run/reboot-required.pkgs`: one per line, deduped
/// in order, at most [`MAX_REBOOT_PACKAGES`] of [`MAX_PACKAGE_NAME_CHARS`].
fn parse_reboot_required_pkgs(text: &str) -> Vec<String> {
    let mut packages: Vec<String> = Vec::new();
    for line in text.lines() {
        if packages.len() == MAX_REBOOT_PACKAGES {
            break;
        }
        if let Some(name) = bounded_text(line, MAX_PACKAGE_NAME_CHARS) {
            if !packages.contains(&name) {
                packages.push(name);
            }
        }
    }
    packages
}

/// `apt-check` prints `<upgradable>;<security>` on stderr. Returns both counts.
fn parse_apt_check(stderr: &str) -> Option<(u32, u32)> {
    stderr.lines().rev().find_map(|line| {
        let (updates, security) = line.trim().split_once(';')?;
        let all_digits =
            |value: &str| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
        if !(all_digits(updates) && all_digits(security)) {
            return None;
        }
        Some((updates.parse().ok()?, security.parse().ok()?))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawUpdaterReport {
    version: u32,
    checked_at: String,
    result: String,
    tag: Option<String>,
    installed_tag: Option<String>,
    signature: Option<String>,
    security_release: bool,
    message: String,
}

fn is_stable_tag(tag: &str) -> bool {
    let Some(version) = tag.strip_prefix('v') else {
        return false;
    };
    let parts: Vec<&str> = version.split('.').collect();
    tag.len() <= 32
        && parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// Strictly validate the C1 status file. Any deviation (unknown key, wrong
/// version or enum, non-stable tag, oversized or multi-line message) rejects
/// the whole report rather than forwarding something the updater did not mean.
fn parse_updater_report(bytes: &[u8]) -> Option<UpdaterReport> {
    if bytes.len() as u64 > MAX_UPDATER_REPORT_BYTES {
        return None;
    }
    let raw: RawUpdaterReport = serde_json::from_slice(bytes).ok()?;
    if raw.version != 1 {
        return None;
    }
    let checked_at = DateTime::parse_from_rfc3339(&raw.checked_at)
        .ok()?
        .with_timezone(&Utc);
    if !matches!(
        raw.result.as_str(),
        "installed" | "current" | "deferred" | "failed" | "disabled"
    ) {
        return None;
    }
    if raw
        .signature
        .as_deref()
        .is_some_and(|signature| !matches!(signature, "verified" | "unsigned"))
    {
        return None;
    }
    for tag in [raw.tag.as_deref(), raw.installed_tag.as_deref()]
        .into_iter()
        .flatten()
    {
        if !is_stable_tag(tag) {
            return None;
        }
    }
    if raw.message.chars().count() > MAX_UPDATER_MESSAGE_CHARS
        || raw.message.chars().any(char::is_control)
    {
        return None;
    }
    Some(UpdaterReport {
        checked_at: rfc3339(checked_at),
        result: raw.result,
        tag: raw.tag,
        installed_tag: raw.installed_tag,
        signature: raw.signature,
        security_release: raw.security_release,
        message: raw.message.trim().to_owned(),
    })
}

fn modified_at(path: &Path) -> Option<String> {
    let modified: SystemTime = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(rfc3339(DateTime::<Utc>::from(modified)))
}

/// Boot epoch = wall clock minus uptime, when both are known and sane.
fn boot_epoch_from_uptime(now_epoch: i64, uptime_seconds: i64) -> Option<i64> {
    if uptime_seconds < 0 {
        return None;
    }
    now_epoch.checked_sub(uptime_seconds)
}

/// RFC 3339 for a boot epoch, or `None` when it predates
/// [`MIN_PLAUSIBLE_BOOT_EPOCH`] (or would lie in the future).
fn plausible_booted_at(boot_epoch: i64, now_epoch: i64) -> Option<String> {
    if !(MIN_PLAUSIBLE_BOOT_EPOCH..=now_epoch).contains(&boot_epoch) {
        return None;
    }
    DateTime::<Utc>::from_timestamp(boot_epoch, 0).map(rfc3339)
}

/// `sysinfo(2)` works inside the `ProcSubset=pid` sandbox; `/proc/stat` does not.
#[cfg(target_os = "linux")]
fn boot_epoch(now_epoch: i64) -> Option<i64> {
    // SAFETY: `sysinfo(2)` only writes into the zero-initialised struct we own.
    let mut info: libc::sysinfo = unsafe { std::mem::zeroed() };
    if unsafe { libc::sysinfo(&mut info) } != 0 {
        return None;
    }
    boot_epoch_from_uptime(now_epoch, i64::from(info.uptime))
}

#[cfg(not(target_os = "linux"))]
fn boot_epoch(_now_epoch: i64) -> Option<i64> {
    i64::try_from(sysinfo::System::boot_time()).ok()
}

fn booted_at() -> Option<String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    let now = i64::try_from(now).ok()?;
    plausible_booted_at(boot_epoch(now)?, now)
}

/// Everything except `apt-check`: small, capped, synchronous file reads.
fn collect_file_facts(paths: &HostPaths) -> HostStatus {
    let os_pretty_name = read_capped(&paths.os_release, MAX_OS_RELEASE_BYTES)
        .and_then(|bytes| parse_os_release(&String::from_utf8_lossy(&bytes)));
    let reboot_required = paths.reboot_required.exists();
    let reboot_required_packages = if reboot_required {
        read_capped(&paths.reboot_required_pkgs, MAX_REBOOT_PKGS_BYTES)
            .map(|bytes| parse_reboot_required_pkgs(&String::from_utf8_lossy(&bytes)))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let updater = read_capped(&paths.updater_report, MAX_UPDATER_REPORT_BYTES).and_then(|bytes| {
        let report = parse_updater_report(&bytes);
        if report.is_none() {
            tracing::debug!("fleet: ignoring a malformed ryu-update status report");
        }
        report
    });
    HostStatus {
        core_version: env!("CARGO_PKG_VERSION").to_owned(),
        os_pretty_name,
        kernel_running: sysinfo::System::kernel_version()
            .and_then(|release| bounded_text(&release, MAX_HOST_TEXT_CHARS)),
        booted_at: booted_at(),
        reboot_required,
        reboot_required_packages,
        last_apt_upgrade_at: modified_at(&paths.apt_upgrade_stamp)
            .or_else(|| modified_at(&paths.unattended_upgrades_stamp)),
        pending_updates: None,
        pending_security_updates: None,
        updater,
    }
}

/// Run Ubuntu's `apt-check` (fixed path, no arguments, cleared environment,
/// killed on timeout). Absent on non-Ubuntu hosts, which report `null`.
async fn run_apt_check(path: &Path) -> Option<(u32, u32)> {
    if !path.is_file() {
        return None;
    }
    let mut command = tokio::process::Command::new(path);
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let output = match tokio::time::timeout(APT_CHECK_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            tracing::debug!("fleet: apt-check could not run: {error}");
            return None;
        }
        Err(_) => {
            tracing::debug!("fleet: apt-check timed out");
            return None;
        }
    };
    let stderr = &output.stderr[..output.stderr.len().min(MAX_APT_CHECK_OUTPUT_BYTES)];
    parse_apt_check(&String::from_utf8_lossy(stderr))
}

async fn collect(paths: HostPaths) -> anyhow::Result<HostStatus> {
    let apt_check = paths.apt_check.clone();
    let mut status = tokio::task::spawn_blocking(move || collect_file_facts(&paths)).await?;
    if let Some((updates, security)) = run_apt_check(&apt_check).await {
        status.pending_updates = Some(updates.min(MAX_PENDING_UPDATES));
        status.pending_security_updates = Some(security.min(MAX_PENDING_UPDATES));
    }
    Ok(status)
}

async fn report_once(
    client: &reqwest::Client,
    identity: &super::FleetIdentity,
) -> anyhow::Result<()> {
    let status = collect(HostPaths::system()).await?;
    let response = client
        .post(format!(
            "{}/api/control-plane/nodes/me/host-status",
            identity.control_plane_url
        ))
        .bearer_auth(&identity.credential)
        .json(&status)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!("host-status report returned {}", response.status());
    }
    Ok(())
}

/// Report host patch state at startup (once enrolled) and every six hours.
/// Only Ryu-provisioned Linux nodes report; a BYOD machine never does.
pub(super) fn spawn_reporter(client: reqwest::Client) {
    if !cfg!(target_os = "linux") || !crate::sidecar::control_plane::is_managed_node() {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            let delay = match super::load_fleet_identity() {
                Err(error) => {
                    tracing::debug!("fleet: host-status report waits for enrollment: {error}");
                    NOT_ENROLLED_RETRY
                }
                Ok(identity) => match report_once(&client, &identity).await {
                    Ok(()) => REPORT_INTERVAL,
                    Err(error) => {
                        tracing::warn!("fleet: host-status report failed; retrying: {error}");
                        FAILURE_RETRY
                    }
                },
            };
            tokio::time::sleep(delay).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const VALID_REPORT: &str = r#"{"version":1,"checkedAt":"2026-10-24T03:12:00Z","result":"installed","tag":"v0.4.1","installedTag":"v0.4.1","signature":"verified","securityRelease":true,"message":"Installed v0.4.1"}"#;

    #[test]
    fn os_release_pretty_name_is_unquoted_and_bounded() {
        let text = "NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nID=ubuntu\n";
        assert_eq!(
            parse_os_release(text).as_deref(),
            Some("Ubuntu 24.04.1 LTS")
        );
        assert_eq!(
            parse_os_release("PRETTY_NAME=Debian").as_deref(),
            Some("Debian")
        );
        assert_eq!(
            parse_os_release("PRETTY_NAME='Fedora 40'").as_deref(),
            Some("Fedora 40")
        );
        assert_eq!(parse_os_release("NAME=Ubuntu\n"), None);
        assert_eq!(parse_os_release("PRETTY_NAME=\"\"\n"), None);
        let long = format!("PRETTY_NAME=\"{}\x07\"", "x".repeat(500));
        let parsed = parse_os_release(&long).unwrap();
        assert_eq!(parsed.chars().count(), MAX_HOST_TEXT_CHARS);
        assert!(!parsed.chars().any(char::is_control));
    }

    #[test]
    fn reboot_required_packages_are_deduped_and_capped() {
        assert_eq!(
            parse_reboot_required_pkgs("linux-base\n\nlinux-base\nlibc6\n"),
            vec!["linux-base".to_owned(), "libc6".to_owned()]
        );
        let many: String = (0..80).map(|index| format!("pkg-{index}\n")).collect();
        let packages = parse_reboot_required_pkgs(&many);
        assert_eq!(packages.len(), MAX_REBOOT_PACKAGES);
        assert_eq!(packages[0], "pkg-0");
        let long = parse_reboot_required_pkgs(&"a".repeat(400));
        assert_eq!(long[0].chars().count(), MAX_PACKAGE_NAME_CHARS);
    }

    #[test]
    fn apt_check_output_reads_the_last_count_pair() {
        assert_eq!(parse_apt_check("12;3"), Some((12, 3)));
        assert_eq!(parse_apt_check("W: some warning\n0;0\n"), Some((0, 0)));
        assert_eq!(parse_apt_check(""), None);
        assert_eq!(parse_apt_check("E: Error: BrokenCount > 0"), None);
        assert_eq!(parse_apt_check("1;x"), None);
        assert_eq!(parse_apt_check("-1;2"), None);
        assert_eq!(parse_apt_check("99999999999;1"), None);
    }

    #[test]
    fn updater_report_accepts_the_c1_contract() {
        let report = parse_updater_report(VALID_REPORT.as_bytes()).unwrap();
        assert_eq!(report.result, "installed");
        assert_eq!(report.installed_tag.as_deref(), Some("v0.4.1"));
        assert!(report.security_release);
        let disabled = r#"{"version":1,"checkedAt":"2026-10-24T03:12:00+00:00","result":"disabled","tag":null,"installedTag":null,"signature":null,"securityRelease":false,"message":""}"#;
        let disabled = parse_updater_report(disabled.as_bytes()).unwrap();
        assert_eq!(disabled.checked_at, "2026-10-24T03:12:00Z");
        assert_eq!(disabled.signature, None);
    }

    #[test]
    fn updater_report_rejects_malformed_or_oversized_input() {
        let replace = |from: &str, to: &str| VALID_REPORT.replace(from, to);
        for malformed in [
            String::from("not json"),
            String::from("{}"),
            replace("\"version\":1", "\"version\":2"),
            replace("\"result\":\"installed\"", "\"result\":\"pwned\""),
            replace("\"signature\":\"verified\"", "\"signature\":\"maybe\""),
            replace("\"tag\":\"v0.4.1\"", "\"tag\":\"v0.4.1-rc.1\""),
            replace("\"installedTag\":\"v0.4.1\"", "\"installedTag\":\"latest\""),
            replace(
                "\"checkedAt\":\"2026-10-24T03:12:00Z\"",
                "\"checkedAt\":\"yesterday\"",
            ),
            replace("\"securityRelease\":true", "\"securityRelease\":\"yes\""),
            replace("Installed v0.4.1", "line\\nbreak"),
            replace(
                "Installed v0.4.1",
                &"m".repeat(MAX_UPDATER_MESSAGE_CHARS + 1),
            ),
            replace("\"version\":1", "\"version\":1,\"extra\":true"),
        ] {
            assert_eq!(
                parse_updater_report(malformed.as_bytes()),
                None,
                "{malformed}"
            );
        }
        let padded = format!(
            "{VALID_REPORT}{}",
            " ".repeat(MAX_UPDATER_REPORT_BYTES as usize)
        );
        assert_eq!(parse_updater_report(padded.as_bytes()), None);
    }

    fn temp_paths(root: &Path) -> HostPaths {
        HostPaths {
            os_release: root.join("os-release"),
            reboot_required: root.join("reboot-required"),
            reboot_required_pkgs: root.join("reboot-required.pkgs"),
            apt_upgrade_stamp: root.join("upgrade-stamp"),
            unattended_upgrades_stamp: root.join("unattended-upgrades-stamp"),
            apt_check: root.join("apt-check"),
            updater_report: root.join("status.json"),
        }
    }

    #[test]
    fn boot_time_is_wall_clock_minus_uptime_and_never_an_uptime_epoch() {
        let now = 1_792_800_000; // 2026-10-24
        let three_days = 3 * 24 * 60 * 60;
        let boot = boot_epoch_from_uptime(now, three_days).unwrap();
        assert_eq!(boot, now - three_days);
        assert_eq!(
            plausible_booted_at(boot, now).as_deref(),
            Some("2026-10-21T00:00:00Z")
        );
        assert_eq!(boot_epoch_from_uptime(now, -1), None);
        // The sysinfo crate's `/proc/stat` fallback hands back the uptime
        // itself; that must never surface as a 1970 boot.
        assert_eq!(plausible_booted_at(three_days, now), None);
        assert_eq!(plausible_booted_at(0, now), None);
        assert_eq!(plausible_booted_at(now + 60, now), None);
    }

    #[test]
    fn live_boot_time_is_plausible() {
        if let Some(booted) = booted_at() {
            let booted = DateTime::parse_from_rfc3339(&booted).unwrap();
            assert!(booted.timestamp() >= MIN_PLAUSIBLE_BOOT_EPOCH);
            assert!(booted.with_timezone(&Utc) <= Utc::now());
        }
    }

    #[tokio::test]
    async fn absent_host_files_degrade_to_null() {
        let dir = tempdir().unwrap();
        let status = collect(temp_paths(dir.path())).await.unwrap();
        assert_eq!(status.os_pretty_name, None);
        assert!(!status.reboot_required);
        assert!(status.reboot_required_packages.is_empty());
        assert_eq!(status.last_apt_upgrade_at, None);
        assert_eq!(status.pending_security_updates, None);
        assert_eq!(status.updater, None);
        assert_eq!(status.core_version, env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn present_host_files_are_collected_and_serialized_in_camel_case() {
        let dir = tempdir().unwrap();
        let paths = temp_paths(dir.path());
        std::fs::write(&paths.os_release, "PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n").unwrap();
        std::fs::write(&paths.reboot_required, "*** System restart required ***\n").unwrap();
        std::fs::write(
            &paths.reboot_required_pkgs,
            "linux-image-6.8.0-48-generic\n",
        )
        .unwrap();
        std::fs::write(&paths.unattended_upgrades_stamp, "").unwrap();
        std::fs::write(&paths.updater_report, VALID_REPORT).unwrap();
        let status = collect(paths).await.unwrap();
        assert_eq!(status.os_pretty_name.as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert!(status.reboot_required);
        assert_eq!(
            status.reboot_required_packages,
            vec!["linux-image-6.8.0-48-generic"]
        );
        assert!(status.last_apt_upgrade_at.is_some());
        let wire = serde_json::to_value(&status).unwrap();
        assert_eq!(wire["rebootRequired"], true);
        assert_eq!(wire["updater"]["installedTag"], "v0.4.1");
        assert_eq!(wire["updater"]["securityRelease"], true);
        assert!(wire.get("pendingSecurityUpdates").is_some());
    }
}

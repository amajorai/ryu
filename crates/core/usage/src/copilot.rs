//! GitHub Copilot subscription usage. Copilot has no OAuth flow of its own to
//! reuse: the editor plugins and the `gh` CLI both leave a GitHub token on this
//! machine, so we read whichever we find and call
//! `GET https://api.github.com/copilot_internal/user` — the same endpoint the
//! official Copilot client calls (note `Authorization: token …`, not `Bearer`).
//!
//! Since June 2026 every Copilot plan bills by **AI credits**, so the meters
//! differ by plan and the endpoint says so in `quota_snapshots`:
//!
//! - **Paid**: the `premium_interactions` bucket is the credit pool → the
//!   "Credits" meter, with premium interactions beyond it as "Extra usage" once
//!   the user enabled additional spend. `chat`/`completions` come back as the
//!   `-1` "unlimited" sentinel and are suppressed rather than drawn as a
//!   misleading 0%.
//! - **Free**: no credit pool, but real `chat` and `completions` counts (in
//!   `quota_snapshots`, or `limited_user_quotas` against `monthly_quotas` on
//!   older responses).
//! - **Org-managed Business/Enterprise seats**: GitHub returns no per-seat quota
//!   at all, only a `token_based_billing` marker. That is a legitimate empty
//!   state, not a failure, so it is reported as [`UsageUnavailable::NoPlan`]
//!   rather than an `available` snapshot with no rows (which a client can't tell
//!   from a bug) or a loud error (which would drop the plan name). Today's
//!   desktop bar hides on every unavailable reason alike; the distinct reason is
//!   on the wire for a surface that wants to explain it. (openusage additionally
//!   falls back to org-wide billing totals, which needs org-owner/billing-manager
//!   rights and reports the whole organization rather than this user's share; a
//!   per-agent usage bar is the wrong surface for that number, so it's out.)
//!
//! Every bucket reports percent **remaining**; the meters show percent **used**.
//!
//! Reconstructed from the openusage reference implementation; verify against one
//! live response before trusting blindly.

use std::path::PathBuf;

use super::{
    clamp_percent, config_home, http_client, read_file, reason_for_status, retry_after_seconds,
    timestamp_to_rfc3339, title_case, UsageMeter, UsageSnapshot, UsageUnavailable, UsageValue,
    UsageValueKind, UsageWindow,
};

const USAGE_URL: &str = "https://api.github.com/copilot_internal/user";

/// The usage endpoint to call, with the same `#[cfg(test)]` loopback override
/// seam every reader in this crate uses.
#[cfg(not(test))]
fn usage_url() -> String {
    USAGE_URL.to_string()
}
#[cfg(test)]
fn usage_url() -> String {
    std::env::var("RYU_USAGE_COPILOT_URL").unwrap_or_else(|_| USAGE_URL.to_string())
}

/// Copilot's credit pool renews monthly.
const MONTHLY_WINDOW_SECS: i64 = 30 * 24 * 60 * 60;
/// GitHub's "unlimited" sentinel on an entitlement / remaining count.
const UNLIMITED_SENTINEL: f64 = -1.0;

/// Candidate token locations, prompt-free files first and the Keychain last (a
/// first Keychain read can raise an authorization dialog).
fn token_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Some(config) = config_home() else {
        return paths;
    };
    // Written by the VS Code / JetBrains / Neovim Copilot plugins.
    paths.push(config.join("github-copilot").join("apps.json"));
    paths.push(config.join("github-copilot").join("hosts.json"));
    // The `gh` CLI, when it keeps its token in a file rather than the keyring.
    paths.push(config.join("gh").join("hosts.yml"));
    paths
}

/// Find a GitHub token on this machine, or `None` when the user has signed into
/// neither an editor's Copilot plugin nor `gh`.
fn load_token() -> Option<String> {
    if let Some(token) = token_from_files() {
        return Some(token);
    }
    #[cfg(target_os = "macos")]
    {
        read_keychain()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// The prompt-free half of the scan: every on-disk candidate, in priority order.
/// Kept separate from [`load_token`] so it can be tested hermetically — the
/// Keychain half reads the *real* `gh:github.com` item, which a dev machine
/// legitimately has, so no test can assert "no token anywhere" through it.
fn token_from_files() -> Option<String> {
    for path in token_paths() {
        let Some(text) = read_file(&path) else {
            continue;
        };
        let token = if path.extension().is_some_and(|ext| ext == "yml") {
            token_from_hosts_yml(&text)
        } else {
            token_from_apps_json(&text)
        };
        if let Some(token) = token {
            return Some(token);
        }
    }
    None
}

/// `apps.json` / `hosts.json` map an opaque host key to an object carrying
/// `oauth_token`. The keys aren't stable across plugin versions, so take the
/// first entry that actually has a token rather than looking one up by name.
fn token_from_apps_json(text: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(text).ok()?;
    parsed
        .as_object()?
        .values()
        .filter_map(|entry| entry.get("oauth_token").and_then(serde_json::Value::as_str))
        .map(str::trim)
        .find(|token| !token.is_empty())
        .map(str::to_string)
}

/// `gh`'s `hosts.yml`. Scanned line-wise for `oauth_token:` rather than pulling in
/// a YAML dependency for one field — the file is machine-written and flat, and a
/// mis-parse here costs us nothing worse than falling through to the next
/// candidate.
fn token_from_hosts_yml(text: &str) -> Option<String> {
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("oauth_token:"))
        .map(|value| value.trim().trim_matches(['"', '\'']).trim())
        .find(|token| !token.is_empty())
        .map(str::to_string)
}

/// Read a managed Pi OAuth entry for Ryu's Copilot subscription provider.
///
/// Pi's Copilot login stores `{refresh: <GitHub OAuth token>, access: <Copilot
/// API token>}`: `access` is the ~30-minute `tid=…;exp=…` token minted for
/// `api.githubcopilot.com`, which `api.github.com/copilot_internal/user` rejects.
/// So the GitHub token in `refresh` comes first, and `access` is only accepted
/// when it is not a Copilot API token (an entry written by another tool).
fn token_from_ryu_entry(entry: &serde_json::Value) -> Option<String> {
    let field = |key: &str| {
        entry
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty())
    };
    ["refresh", "oauth_token", "accessToken", "access"]
        .iter()
        .filter_map(|key| field(key))
        .find(|token| !is_copilot_api_token(token))
        .map(str::to_string)
}

/// A Copilot API token (`tid=…;exp=…;…:sig`) from `copilot_internal/v2/token`,
/// as opposed to a GitHub OAuth token the usage endpoint accepts.
fn is_copilot_api_token(token: &str) -> bool {
    token.starts_with("tid=") || token.contains(";exp=")
}

/// The usage endpoint on the GitHub host that issued a managed Pi entry's token.
///
/// Pi records the GitHub Enterprise domain a Copilot login used in
/// `enterpriseUrl`, and its `refresh` token is an OAuth token from that host. It
/// must only go to that host's API (`api.<domain>`, where Pi itself mints Copilot
/// tokens), never to api.github.com. `None` means the domain cannot be parsed, so
/// the read is refused rather than guessing a host.
fn usage_url_for_ryu_entry(entry: &serde_json::Value) -> Option<String> {
    let enterprise = match entry.get("enterpriseUrl") {
        None | Some(serde_json::Value::Null) => return Some(usage_url()),
        Some(value) => value.as_str()?.trim(),
    };
    if enterprise.is_empty() {
        return Some(usage_url());
    }
    let host = enterprise_domain(enterprise)?;
    if host == "github.com" {
        return Some(usage_url());
    }
    Some(format!("https://api.{host}/copilot_internal/user"))
}

/// The hostname of a GitHub Enterprise domain as Pi normalizes it (a bare domain
/// or a URL). IP literals and inputs with no host are rejected.
fn enterprise_domain(input: &str) -> Option<String> {
    let url = if input.contains("://") {
        reqwest::Url::parse(input)
    } else {
        reqwest::Url::parse(&format!("https://{input}"))
    }
    .ok()?;
    url.domain()
        .map(|domain| domain.trim_end_matches('.').to_ascii_lowercase())
        .filter(|domain| !domain.is_empty())
}

/// Read the managed Pi auth file's Copilot entry.
fn load_ryu_entry() -> Option<serde_json::Value> {
    let path = super::host()?.ryu_pi_auth_path()?;
    let text = read_file(&path)?;
    let mut root = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    root.get_mut("github-copilot").map(serde_json::Value::take)
}

/// The `gh` CLI stores its token as a login-Keychain generic password (service
/// `gh:github.com`) when the system keyring is in use. Shell out to the signed
/// `security` tool, exactly as the Claude reader does.
#[cfg(target_os = "macos")]
fn read_keychain() -> Option<String> {
    const KEYCHAIN_SERVICE: &str = "gh:github.com";
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(super) async fn fetch(agent_id: &str) -> UsageSnapshot {
    let token = match tokio::task::spawn_blocking(load_token).await {
        Ok(Some(token)) => token,
        Ok(None) => {
            return UsageSnapshot::unavailable(agent_id, "copilot", UsageUnavailable::NotLoggedIn)
        }
        Err(_) => return UsageSnapshot::unavailable(agent_id, "copilot", UsageUnavailable::Error),
    };
    fetch_with_token(agent_id, token, usage_url()).await
}

pub(super) async fn fetch_ryu(agent_id: &str) -> UsageSnapshot {
    match tokio::task::spawn_blocking(load_ryu_entry).await {
        Ok(entry) => fetch_ryu_with_credential(agent_id, entry).await,
        Err(_) => UsageSnapshot::unavailable(agent_id, "copilot", UsageUnavailable::Error),
    }
}

pub(super) async fn fetch_ryu_with_credential(
    agent_id: &str,
    credential: Option<serde_json::Value>,
) -> UsageSnapshot {
    let Some(entry) = credential.as_ref() else {
        return UsageSnapshot::unavailable(agent_id, "copilot", UsageUnavailable::NotLoggedIn);
    };
    let Some(token) = token_from_ryu_entry(entry) else {
        return UsageSnapshot::unavailable(agent_id, "copilot", UsageUnavailable::NotLoggedIn);
    };
    let Some(url) = usage_url_for_ryu_entry(entry) else {
        return UsageSnapshot::unavailable(agent_id, "copilot", UsageUnavailable::Unsupported);
    };
    fetch_with_token(agent_id, token, url).await
}

async fn fetch_with_token(agent_id: &str, token: String, url: String) -> UsageSnapshot {
    let unavailable =
        |reason: UsageUnavailable| UsageSnapshot::unavailable(agent_id, "copilot", reason);

    let resp = http_client()
        .get(url)
        // `/copilot_internal/user` accepts the `token` scheme, not `Bearer`.
        .header("Authorization", format!("token {}", token.trim()))
        .header("Accept", "application/json")
        .header("Editor-Version", "vscode/1.96.2")
        .header("Editor-Plugin-Version", "copilot-chat/0.26.7")
        .header("X-Github-Api-Version", "2025-04-01")
        .header("User-Agent", "GitHubCopilotChat/0.26.7")
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    if !resp.status().is_success() {
        let reason = reason_for_status(resp.status());
        let retry_after = retry_after_seconds(resp.headers());
        let mut snapshot = unavailable(reason);
        snapshot.retry_after_seconds = retry_after;
        return snapshot;
    }
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return unavailable(UsageUnavailable::Error);
    };

    let plan = body.get("copilot_plan").and_then(format_plan);
    let resets_at = timestamp_to_rfc3339(body.get("quota_reset_date"))
        .or_else(|| timestamp_to_rfc3339(body.get("limited_user_reset_date")));

    let mut snapshot = UsageSnapshot::available(agent_id, "copilot", plan.clone());
    let snapshots = body.get("quota_snapshots");
    let premium = snapshots.and_then(|s| s.get("premium_interactions"));

    // The credit pool is the headline meter. Extra usage only means anything
    // relative to an included pool, so it is tied to that meter existing: an
    // org-managed placeholder can carry `overage_permitted: true` on a
    // zero-entitlement bucket, where rendering an overage figure would be noise.
    let credits = snapshot_window("Credits", premium, resets_at.clone());
    let has_credits = credits.is_some();
    if let Some(window) = credits {
        snapshot.windows.push(window);
    }
    if has_credits {
        if let Some(meter) = overage_meter(premium) {
            snapshot.meters.push(meter);
        }
    }
    for (label, key) in [("Chat", "chat"), ("Completions", "completions")] {
        if let Some(window) =
            snapshot_window(label, snapshots.and_then(|s| s.get(key)), resets_at.clone())
        {
            snapshot.windows.push(window);
        }
    }

    // Legacy free-tier shape (predates `quota_snapshots`): remaining counts
    // against monthly limits. Gated on nothing else having been produced —
    // otherwise a paid account (Credits present, chat/completions suppressed as
    // unlimited) that still carried `limited_user_quotas` would wrongly show
    // free-tier meters alongside Credits.
    if snapshot.windows.is_empty() {
        let limited = body.get("limited_user_quotas");
        let monthly = body.get("monthly_quotas");
        for (label, key) in [("Chat", "chat"), ("Completions", "completions")] {
            if let Some(window) = limited_window(
                label,
                limited.and_then(|l| l.get(key)),
                monthly.and_then(|m| m.get(key)),
                resets_at.clone(),
            ) {
                snapshot.windows.push(window);
            }
        }
    }

    // An org-managed seat exposes no per-seat quota — say so rather than showing
    // an empty-but-"available" snapshot the client can't distinguish from a bug.
    if snapshot.windows.is_empty() && snapshot.meters.is_empty() {
        let mut refusal = unavailable(UsageUnavailable::NoPlan);
        refusal.plan = plan;
        return refusal;
    }

    snapshot
}

/// One `quota_snapshots` bucket → a percent-**used** meter, or `None` to suppress.
///
/// Suppressed for: a missing bucket; an `unlimited` bucket or the `-1`
/// entitlement/remaining sentinel (paid chat & completions carry no real meter
/// under usage-based billing, so they're hidden rather than shown as a misleading
/// 0%); and a zero-entitlement placeholder (an org-managed seat, or Credits on a
/// free account, which has no allotment at all).
fn snapshot_window(
    label: &str,
    snapshot: Option<&serde_json::Value>,
    resets_at: Option<String>,
) -> Option<UsageWindow> {
    let snapshot = snapshot?;
    let entitlement = snapshot
        .get("entitlement")
        .and_then(serde_json::Value::as_f64);
    let remaining = snapshot
        .get("remaining")
        .and_then(serde_json::Value::as_f64);

    if snapshot
        .get("unlimited")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
        || entitlement == Some(UNLIMITED_SENTINEL)
        || remaining == Some(UNLIMITED_SENTINEL)
    {
        return None;
    }
    if entitlement == Some(0.0) {
        return None;
    }

    let used_percent = if let Some(percent_remaining) = snapshot
        .get("percent_remaining")
        .and_then(serde_json::Value::as_f64)
    {
        100.0 - percent_remaining
    } else {
        let entitlement = entitlement.filter(|e| *e > 0.0)?;
        100.0 - (remaining? / entitlement) * 100.0
    };

    Some(UsageWindow {
        label: label.to_string(),
        used_percent: clamp_percent(used_percent),
        resets_at,
        window_seconds: Some(MONTHLY_WINDOW_SECS),
        model: None,
    })
}

/// Premium interactions consumed beyond the included credit pool. Surfaced only
/// once the user enabled additional (overage) spend; a real zero is then shown,
/// because "0 over your pool" is a meaningful answer. When overage isn't enabled
/// the figure is genuinely N/A, so the row is omitted. The endpoint exposes no
/// spending cap here, so this is an unbounded count, not a percent meter.
fn overage_meter(snapshot: Option<&serde_json::Value>) -> Option<UsageMeter> {
    let snapshot = snapshot?;
    if snapshot
        .get("overage_permitted")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return None;
    }
    let overage = snapshot
        .get("overage_count")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0);
    Some(UsageMeter::new(
        "Extra usage",
        vec![UsageValue::new(
            overage,
            UsageValueKind::Count,
            Some("interactions"),
        )],
    ))
}

/// A legacy free-tier bucket: `remaining` against a monthly `total` → a
/// percent-used meter. `None` unless both a positive limit and a remaining count
/// are present — without a denominator there is no honest percentage.
fn limited_window(
    label: &str,
    remaining: Option<&serde_json::Value>,
    total: Option<&serde_json::Value>,
    resets_at: Option<String>,
) -> Option<UsageWindow> {
    let total = total
        .and_then(serde_json::Value::as_f64)
        .filter(|t| *t > 0.0)?;
    let remaining = remaining.and_then(serde_json::Value::as_f64)?;
    let used = (total - remaining).max(0.0);
    Some(UsageWindow {
        label: label.to_string(),
        used_percent: clamp_percent((used / total) * 100.0),
        resets_at,
        window_seconds: Some(MONTHLY_WINDOW_SECS),
        model: None,
    })
}

/// `"copilot_pro"` → `"Copilot Pro"`.
fn format_plan(value: &serde_json::Value) -> Option<String> {
    let raw = value.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(title_case(raw, &['_', '-', ' ']))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{spawn_loopback, spawn_loopback_with_headers};

    // HOME + RYU_USAGE_COPILOT_URL are process-global; serialize env-touching
    // tests so parallel runs don't clobber each other's fixtures.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A hermetic `~/.config` root (via `RYU_USAGE_CONFIG_HOME`, the test-only
    /// seam in [`config_home`]) so `token_paths()` resolves to our fixture and
    /// never to a real login on the dev machine.
    ///
    /// Deliberately NOT done by reassigning `HOME`: sibling readers' tests set
    /// `HOME` under their own module locks, and two modules racing on it makes
    /// the suite flaky.
    struct FakeConfigHome {
        _dir: tempfile::TempDir,
    }

    impl FakeConfigHome {
        fn with_apps_json(body: &str) -> Self {
            let root = Self::empty();
            let dir = config_home().unwrap().join("github-copilot");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("apps.json"), body).unwrap();
            root
        }

        fn empty() -> Self {
            let dir = tempfile::tempdir().unwrap();
            std::env::set_var("RYU_USAGE_CONFIG_HOME", dir.path());
            Self { _dir: dir }
        }
    }

    impl Drop for FakeConfigHome {
        fn drop(&mut self) {
            std::env::remove_var("RYU_USAGE_CONFIG_HOME");
            std::env::remove_var("RYU_USAGE_COPILOT_URL");
        }
    }

    // ── token discovery ──────────────────────────────────────────────────────

    #[test]
    fn token_from_apps_json_takes_the_first_entry_with_a_token() {
        let text =
            r#"{"github.com:none":{"user":"me"},"github.com:abc":{"oauth_token":"gho_live"}}"#;
        assert_eq!(token_from_apps_json(text).as_deref(), Some("gho_live"));
        // Blank tokens don't count, and junk yields None rather than panicking.
        assert!(token_from_apps_json(r#"{"h":{"oauth_token":"  "}}"#).is_none());
        assert!(token_from_apps_json("not json").is_none());
        assert!(token_from_apps_json("[]").is_none());
    }

    #[test]
    fn token_from_hosts_yml_reads_the_oauth_token_line() {
        let text =
            "github.com:\n    user: me\n    oauth_token: gho_from_gh\n    git_protocol: ssh\n";
        assert_eq!(token_from_hosts_yml(text).as_deref(), Some("gho_from_gh"));
        // Quoted values and blank tokens.
        assert_eq!(
            token_from_hosts_yml("  oauth_token: \"gho_quoted\"\n").as_deref(),
            Some("gho_quoted")
        );
        assert!(token_from_hosts_yml("  oauth_token:\n").is_none());
        assert!(token_from_hosts_yml("user: me\n").is_none());
    }

    #[test]
    fn token_paths_prefers_editor_files_over_gh() {
        let _g = lock();
        let _config = FakeConfigHome::empty();
        let paths = token_paths();
        let names: Vec<String> = paths
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["apps.json", "hosts.json", "hosts.yml"]);
    }

    // ── mapping ──────────────────────────────────────────────────────────────

    #[test]
    fn snapshot_window_converts_percent_remaining_to_used() {
        let bucket = serde_json::json!({ "entitlement": 300, "percent_remaining": 25.0 });
        let window = snapshot_window("Credits", Some(&bucket), None).expect("meter");
        assert_eq!(window.used_percent, 75.0);
        assert_eq!(window.window_seconds, Some(MONTHLY_WINDOW_SECS));
    }

    #[test]
    fn snapshot_window_derives_percent_from_entitlement_and_remaining() {
        let bucket = serde_json::json!({ "entitlement": 200, "remaining": 50 });
        let window = snapshot_window("Credits", Some(&bucket), None).expect("meter");
        assert_eq!(window.used_percent, 75.0);
    }

    #[test]
    fn snapshot_window_suppresses_unlimited_and_zero_entitlement() {
        let cases = [
            serde_json::json!({ "unlimited": true, "percent_remaining": 100.0 }),
            serde_json::json!({ "entitlement": -1, "percent_remaining": 100.0 }),
            serde_json::json!({ "remaining": -1, "percent_remaining": 100.0 }),
            // An org-managed placeholder / Credits on free: no allotment at all.
            serde_json::json!({ "entitlement": 0, "percent_remaining": 100.0 }),
            // No denominator and no percentage → no honest meter.
            serde_json::json!({ "remaining": 5 }),
        ];
        for bucket in cases {
            assert!(
                snapshot_window("Chat", Some(&bucket), None).is_none(),
                "{bucket} should be suppressed"
            );
        }
        assert!(snapshot_window("Chat", None, None).is_none());
    }

    #[test]
    fn overage_meter_needs_overage_permitted_but_shows_a_real_zero() {
        let enabled = serde_json::json!({ "overage_permitted": true, "overage_count": 12 });
        let meter = overage_meter(Some(&enabled)).expect("meter");
        assert_eq!(meter.label, "Extra usage");
        assert_eq!(meter.values[0].number, 12.0);
        let zero = serde_json::json!({ "overage_permitted": true });
        assert_eq!(overage_meter(Some(&zero)).unwrap().values[0].number, 0.0);
        let disabled = serde_json::json!({ "overage_permitted": false, "overage_count": 3 });
        assert!(overage_meter(Some(&disabled)).is_none());
        assert!(overage_meter(None).is_none());
    }

    #[test]
    fn limited_window_maps_remaining_against_a_monthly_total() {
        let remaining = serde_json::json!(10);
        let total = serde_json::json!(50);
        let window = limited_window("Chat", Some(&remaining), Some(&total), None).expect("meter");
        assert_eq!(window.used_percent, 80.0);
        // A zero/absent denominator gives no honest percentage.
        let zero = serde_json::json!(0);
        assert!(limited_window("Chat", Some(&remaining), Some(&zero), None).is_none());
        assert!(limited_window("Chat", Some(&remaining), None, None).is_none());
        assert!(limited_window("Chat", None, Some(&total), None).is_none());
    }

    #[test]
    fn format_plan_titles_the_github_plan_slug() {
        assert_eq!(
            format_plan(&serde_json::json!("copilot_pro")).as_deref(),
            Some("Copilot Pro")
        );
        assert_eq!(
            format_plan(&serde_json::json!("business")).as_deref(),
            Some("Business")
        );
        assert!(format_plan(&serde_json::json!("")).is_none());
        assert!(format_plan(&serde_json::json!(3)).is_none());
    }

    // ── fetch end-to-end via loopback server ─────────────────────────────────

    /// The file half of the scan only — [`load_token`]'s Keychain fallback reads
    /// the real `gh:github.com` item, so a full "no token anywhere" assertion
    /// can't be hermetic on a developer's Mac.
    #[test]
    fn token_from_files_none_with_an_empty_config_home() {
        let _g = lock();
        let _config = FakeConfigHome::empty();
        assert!(token_from_files().is_none());
    }

    #[test]
    fn token_from_files_reads_the_editor_plugin_file() {
        let _g = lock();
        let _config = FakeConfigHome::with_apps_json(r#"{"h":{"oauth_token":"gho_live"}}"#);
        assert_eq!(token_from_files().as_deref(), Some("gho_live"));
    }

    #[test]
    fn token_from_files_falls_through_to_gh_hosts_yml() {
        let _g = lock();
        let _config = FakeConfigHome::empty();
        let gh = config_home().unwrap().join("gh");
        std::fs::create_dir_all(&gh).unwrap();
        std::fs::write(
            gh.join("hosts.yml"),
            "github.com:\n    oauth_token: gho_from_gh\n",
        )
        .unwrap();
        assert_eq!(token_from_files().as_deref(), Some("gho_from_gh"));
    }

    #[tokio::test]
    async fn fetch_paid_plan_builds_credits_and_extra_usage() {
        let _g = lock();
        let _config =
            FakeConfigHome::with_apps_json(r#"{"github.com:abc":{"oauth_token":"gho_live"}}"#);
        let url = spawn_loopback(
            "200 OK",
            r#"{"copilot_plan":"copilot_pro","quota_reset_date":"2026-08-01","quota_snapshots":{"premium_interactions":{"entitlement":300,"remaining":75,"percent_remaining":25.0,"overage_permitted":true,"overage_count":4},"chat":{"unlimited":true,"entitlement":-1},"completions":{"entitlement":-1}}}"#,
        );
        std::env::set_var("RYU_USAGE_COPILOT_URL", &url);

        let snap = fetch("acp:copilot").await;
        assert!(snap.available, "reason={:?}", snap.reason);
        assert_eq!(snap.engine, "copilot");
        assert_eq!(snap.plan.as_deref(), Some("Copilot Pro"));
        // Chat + completions are the unlimited sentinel → suppressed.
        assert_eq!(snap.windows.len(), 1);
        assert_eq!(snap.windows[0].label, "Credits");
        assert_eq!(snap.windows[0].used_percent, 75.0);
        assert!(snap.windows[0]
            .resets_at
            .as_deref()
            .unwrap()
            .starts_with("2026-08-01"));
        assert_eq!(snap.meters.len(), 1);
        assert_eq!(snap.meters[0].values[0].number, 4.0);
    }

    #[tokio::test]
    async fn fetch_free_plan_falls_back_to_legacy_monthly_quotas() {
        let _g = lock();
        let _config = FakeConfigHome::with_apps_json(r#"{"h":{"oauth_token":"gho_live"}}"#);
        let url = spawn_loopback(
            "200 OK",
            r#"{"copilot_plan":"free","limited_user_reset_date":"2026-08-15","limited_user_quotas":{"chat":10,"completions":500},"monthly_quotas":{"chat":50,"completions":2000}}"#,
        );
        std::env::set_var("RYU_USAGE_COPILOT_URL", &url);

        let snap = fetch("acp:copilot").await;
        assert!(snap.available, "reason={:?}", snap.reason);
        assert_eq!(snap.plan.as_deref(), Some("Free"));
        assert_eq!(snap.windows.len(), 2);
        assert_eq!(snap.windows[0].label, "Chat");
        assert_eq!(snap.windows[0].used_percent, 80.0);
        assert_eq!(snap.windows[1].label, "Completions");
        assert_eq!(snap.windows[1].used_percent, 75.0);
    }

    #[tokio::test]
    async fn fetch_org_managed_seat_reports_no_plan_but_keeps_the_plan_name() {
        let _g = lock();
        let _config = FakeConfigHome::with_apps_json(r#"{"h":{"oauth_token":"gho_live"}}"#);
        // The zero-entitlement placeholder GitHub returns for a token-based-billing
        // seat: `overage_permitted` is set but there is no included pool.
        let url = spawn_loopback(
            "200 OK",
            r#"{"copilot_plan":"business","token_based_billing":true,"quota_snapshots":{"premium_interactions":{"entitlement":0,"remaining":0,"percent_remaining":100.0,"overage_permitted":true}}}"#,
        );
        std::env::set_var("RYU_USAGE_COPILOT_URL", &url);

        let snap = fetch("acp:copilot").await;
        assert!(!snap.available);
        assert!(matches!(snap.reason, Some(UsageUnavailable::NoPlan)));
        assert_eq!(snap.plan.as_deref(), Some("Business"));
        assert!(snap.windows.is_empty());
        // The placeholder must not have sneaked an "Extra usage: 0" row in.
        assert!(snap.meters.is_empty());
    }

    #[tokio::test]
    async fn fetch_maps_401_to_token_expired_and_429_to_rate_limited() {
        let _g = lock();
        {
            let _config = FakeConfigHome::with_apps_json(r#"{"h":{"oauth_token":"gho_live"}}"#);
            let url = spawn_loopback("401 Unauthorized", "{}");
            std::env::set_var("RYU_USAGE_COPILOT_URL", &url);
            let snap = fetch("acp:copilot").await;
            assert!(matches!(snap.reason, Some(UsageUnavailable::TokenExpired)));
        }
        {
            let _config = FakeConfigHome::with_apps_json(r#"{"h":{"oauth_token":"gho_live"}}"#);
            let url =
                spawn_loopback_with_headers("429 Too Many Requests", "Retry-After: 60\r\n", "{}");
            std::env::set_var("RYU_USAGE_COPILOT_URL", &url);
            let snap = fetch("acp:copilot").await;
            assert!(matches!(snap.reason, Some(UsageUnavailable::RateLimited)));
            assert_eq!(snap.retry_after_seconds, Some(60));
        }
    }

    #[tokio::test]
    async fn fetch_bad_json_body_is_error() {
        let _g = lock();
        let _config = FakeConfigHome::with_apps_json(r#"{"h":{"oauth_token":"gho_live"}}"#);
        let url = spawn_loopback("200 OK", "definitely-not-json");
        std::env::set_var("RYU_USAGE_COPILOT_URL", &url);
        let snap = fetch("acp:copilot").await;
        assert!(!snap.available);
        assert!(matches!(snap.reason, Some(UsageUnavailable::Error)));
    }

    #[test]
    fn ryu_auth_entry_maps_to_copilot_token() {
        let root = serde_json::json!({
            "github-copilot": {
                "type": "oauth",
                "access": "gho_access",
            }
        });
        assert_eq!(
            token_from_ryu_entry(&root["github-copilot"]).as_deref(),
            Some("gho_access")
        );
    }

    #[test]
    fn ryu_auth_entry_prefers_pis_github_token_over_the_copilot_api_token() {
        // Pi's real Copilot credential shape: `refresh` is the GitHub OAuth token
        // the usage endpoint accepts, `access` the short-lived Copilot API token.
        let entry = serde_json::json!({
            "type": "oauth",
            "refresh": "ghu_real",
            "access": "tid=abc;exp=1700000000;sku=x:sig",
            "expires": 1,
        });
        assert_eq!(token_from_ryu_entry(&entry).as_deref(), Some("ghu_real"));

        // A lone Copilot API token cannot authenticate the usage read.
        let entry = serde_json::json!({
            "type": "oauth",
            "access": "tid=abc;exp=1700000000;sku=x:sig",
        });
        assert_eq!(token_from_ryu_entry(&entry), None);
    }

    #[test]
    fn enterprise_entry_is_read_from_its_own_host_never_the_public_api() {
        let _g = lock();
        std::env::remove_var("RYU_USAGE_COPILOT_URL");
        let entry = |enterprise: serde_json::Value| {
            serde_json::json!({
                "type": "oauth",
                "refresh": "ghu_enterprise",
                "access": "tid=abc;exp=1700000000;sku=x:sig",
                "enterpriseUrl": enterprise,
            })
        };

        // A GitHub Enterprise login's token goes to that host's API only.
        for domain in ["acme.ghe.com", "https://acme.ghe.com/", " ACME.ghe.com "] {
            assert_eq!(
                usage_url_for_ryu_entry(&entry(serde_json::json!(domain))).as_deref(),
                Some("https://api.acme.ghe.com/copilot_internal/user"),
                "{domain}"
            );
        }
        // An unparseable or host-less domain refuses the read instead of
        // falling back to api.github.com.
        for bad in [
            serde_json::json!("https://"),
            serde_json::json!("10.0.0.1"),
            serde_json::json!(42),
        ] {
            assert_eq!(usage_url_for_ryu_entry(&entry(bad.clone())), None, "{bad}");
        }
        // Public GitHub logins (no domain recorded) keep the public endpoint.
        for public in [
            serde_json::Value::Null,
            serde_json::json!(""),
            serde_json::json!("github.com"),
        ] {
            assert_eq!(
                usage_url_for_ryu_entry(&entry(public.clone())).as_deref(),
                Some(USAGE_URL),
                "{public}"
            );
        }
        let mut no_domain = entry(serde_json::Value::Null);
        no_domain.as_object_mut().unwrap().remove("enterpriseUrl");
        assert_eq!(
            usage_url_for_ryu_entry(&no_domain).as_deref(),
            Some(USAGE_URL)
        );
    }

    #[tokio::test]
    async fn unusable_enterprise_domain_refuses_without_sending_the_token() {
        let _g = lock();
        // Any request reaching the override would be a public-host fallback.
        let url = spawn_loopback("200 OK", r#"{"copilot_plan":"individual"}"#);
        std::env::set_var("RYU_USAGE_COPILOT_URL", &url);
        let entry = serde_json::json!({
            "type": "oauth",
            "refresh": "ghu_enterprise",
            "enterpriseUrl": "https://",
        });
        let snap = fetch_ryu_with_credential("github-copilot", Some(entry)).await;
        std::env::remove_var("RYU_USAGE_COPILOT_URL");
        assert!(!snap.available);
        assert!(matches!(snap.reason, Some(UsageUnavailable::Unsupported)));
    }
}

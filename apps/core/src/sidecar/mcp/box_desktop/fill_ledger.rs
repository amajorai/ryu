//! Core's in-memory record of session Box credential fills (design
//! `docs/vault-env-session-parity/box-fill-verb/` 1.2 steps 2, 3, 9 to 11):
//! the rate limits, the items an echo blocked, the cached feature probe, the
//! live placeholder fills a fill-set revoke cancels, and the outcome audit.
//!
//! Nothing here holds a value: a record names the Box, the fill, the account
//! id or handle, the field and the host.

use std::collections::HashSet;

use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use ryu_sandbox::box_session::{BrowserFillEchoed, BrowserFillState, BROWSER_FILL_FEATURE};
use ryu_sandbox::WorkspaceId;

/// The window of every rate limit.
const RATE_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Fills (any field) per Box per window.
const MAX_FILLS_PER_BOX: usize = 10;
/// Password fills per (Box, account) per window.
const MAX_PASSWORD_FILLS_PER_ACCOUNT: usize = 3;
/// How long a feature probe answer is trusted.
const PROBE_TTL: Duration = Duration::from_secs(5 * 60);
/// How long a fill record is kept for echo attribution after it ends.
const RECORD_TTL: Duration = Duration::from_secs(30 * 60);
/// The bound on a fill-set revoke's cancels.
pub(super) const REVOKE_BUDGET: Duration = Duration::from_secs(2);

/// One placeholder fill Core committed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LiveFill {
    pub box_id: String,
    pub fill_id: String,
    pub set_id: Option<String>,
    pub account: String,
    pub agent_id: Option<String>,
    pub field: &'static str,
    pub host: String,
}

#[derive(Default)]
struct Ledger {
    /// `(box, account, password, at)` per fill whose value was released.
    rates: VecDeque<(String, String, bool, Instant)>,
    /// `(box, account)` an echo blocked for the Box's life.
    echoed: HashSet<(String, String)>,
    /// Live and recently ended placeholder fills, by (Box, fill id).
    fills: HashMap<(String, String), (LiveFill, Instant, bool)>,
    /// Box service endpoint → (checked at, serves browser-fill-v2).
    probes: HashMap<String, (Instant, bool)>,
}

fn ledger() -> MutexGuard<'static, Ledger> {
    static LEDGER: OnceLock<Mutex<Ledger>> = OnceLock::new();
    let mut ledger = LEDGER
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let now = Instant::now();
    while ledger
        .rates
        .front()
        .is_some_and(|(_, _, _, at)| now.duration_since(*at) >= RATE_WINDOW)
    {
        ledger.rates.pop_front();
    }
    ledger
        .fills
        .retain(|_, (_, at, _)| now.duration_since(*at) < RECORD_TTL);
    ledger
}

/// Refuse a fill over the Box or account rate limit, or of an item an echo
/// blocked in this Box.
pub(super) fn check(box_id: &str, account: &str, password: bool) -> Result<()> {
    let ledger = ledger();
    if ledger
        .echoed
        .contains(&(box_id.to_owned(), account.to_owned()))
    {
        bail!(
            "This site echoed a filled value, so fills of `{account}` are blocked in this Box; start a new session Box"
        );
    }
    let in_box = ledger.rates.iter().filter(|(b, ..)| b == box_id).count();
    if in_box >= MAX_FILLS_PER_BOX {
        bail!("This Box reached its limit of {MAX_FILLS_PER_BOX} credential fills in 10 minutes; try again later");
    }
    let for_account = ledger
        .rates
        .iter()
        .filter(|(b, a, p, _)| b == box_id && a == account && *p)
        .count();
    if password && for_account >= MAX_PASSWORD_FILLS_PER_ACCOUNT {
        bail!("`{account}` reached its limit of {MAX_PASSWORD_FILLS_PER_ACCOUNT} password fills in this Box in 10 minutes; try again later");
    }
    Ok(())
}

/// Count a fill whose value is about to be released.
pub(super) fn record(box_id: &str, account: &str, password: bool) {
    ledger().rates.push_back((
        box_id.to_owned(),
        account.to_owned(),
        password,
        Instant::now(),
    ));
}

/// Block `account` in this Box for its life.
pub(super) fn block(box_id: &str, account: &str) {
    ledger()
        .echoed
        .insert((box_id.to_owned(), account.to_owned()));
}

/// Remember a committed placeholder fill.
pub(super) fn track(fill: LiveFill) {
    let key = (fill.box_id.clone(), fill.fill_id.clone());
    ledger().fills.insert(key, (fill, Instant::now(), true));
}

/// A fill ended: keep it for echo attribution, but no longer as live.
pub(super) fn end(box_id: &str, fill_id: &str) {
    let key = (box_id.to_owned(), fill_id.to_owned());
    if let Some(entry) = ledger().fills.get_mut(&key) {
        entry.2 = false;
    }
}

/// The record of `fill_id` in Box `box_id`, live or recently ended.
pub(super) fn known(box_id: &str, fill_id: &str) -> Option<LiveFill> {
    ledger()
        .fills
        .get(&(box_id.to_owned(), fill_id.to_owned()))
        .map(|(fill, ..)| fill.clone())
}

/// The live fills of fill set `set_id`.
pub(super) fn live_for_set(set_id: &str) -> Vec<LiveFill> {
    ledger()
        .fills
        .values()
        .filter(|(fill, _, live)| *live && fill.set_id.as_deref() == Some(set_id))
        .map(|(fill, ..)| fill.clone())
        .collect()
}

/// Whether the Box service serves the browser-fills API: its `/health`
/// lists `browser-fill-v2`. Cached five minutes per endpoint; a failed probe
/// refuses (and is not cached).
pub(super) async fn probe(client: &BoxSessionClient) -> Result<()> {
    let endpoint = client.endpoint().to_owned();
    let cached = ledger()
        .probes
        .get(&endpoint)
        .filter(|(at, _)| at.elapsed() < PROBE_TTL)
        .map(|(_, supported)| *supported);
    let supported = match cached {
        Some(supported) => supported,
        None => {
            let features = client.features().await.map_err(|_| {
                anyhow!("The Box service did not answer its feature probe; try again")
            })?;
            let supported = features.iter().any(|f| f == BROWSER_FILL_FEATURE);
            ledger()
                .probes
                .insert(endpoint, (Instant::now(), supported));
            supported
        }
    };
    if supported {
        Ok(())
    } else {
        bail!("{UNSAFE_BOX_REFUSAL}")
    }
}

/// The refusal for a Box that cannot fill safely.
pub(super) const UNSAFE_BOX_REFUSAL: &str =
    "This Box cannot fill credentials safely; start a new session Box";

async fn write_audit(vault: &PluginSecretStore, fill: &LiveFill, action: &str, extra: Value) {
    let mut details = json!({
        "boxId": fill.box_id,
        "fillId": fill.fill_id,
        "account": fill.account,
        "field": fill.field,
        "host": fill.host,
    });
    if let (Some(details), Value::Object(extra)) = (details.as_object_mut(), extra) {
        details.extend(extra);
    }
    let actor = AuditActor::new("agent", fill.agent_id.as_deref());
    let entry = AuditEntry::new(&actor, action, "ok").details(details);
    if !vault.audit(&entry).await {
        tracing::warn!(action, fill_id = %fill.fill_id, "Box fill outcome audit could not be written");
    }
}

/// Audit an echo the Box service reported for this Box's fills, and block
/// each affected account (and `current`, the account being filled) here.
pub(super) async fn note_echo(
    vault: &PluginSecretStore,
    box_id: &str,
    echoed: &BrowserFillEchoed,
    current: &str,
) {
    block(box_id, current);
    for fill_id in &echoed.fill_ids {
        if let Some(fill) = known(box_id, fill_id) {
            block(box_id, &fill.account);
            let hosts = json!({ "hosts": echoed.hosts });
            write_audit(vault, &fill, "box_fill.echoed", hosts).await;
            end(box_id, fill_id);
        }
    }
}

/// Read a fill's outcome and audit it: `box_fill.consumed {method, path}`,
/// `box_fill.echoed {host, path}` (which blocks the account in this Box) or
/// `box_fill.expired`. Returns the state read.
pub(super) async fn audit_outcome(
    client: &BoxSessionClient,
    vault: &PluginSecretStore,
    fill: &LiveFill,
) -> Option<BrowserFillState> {
    let status = client
        .browser_fill_status(&WorkspaceId(fill.box_id.clone()), &fill.fill_id)
        .await
        .ok()?;
    match (&status.state, &status.consumed, &status.echoed) {
        (BrowserFillState::Consumed, Some((method, path)), _) => {
            let extra = json!({ "method": method, "path": path });
            write_audit(vault, fill, "box_fill.consumed", extra).await;
        }
        (BrowserFillState::Echoed, _, echoed) => {
            block(&fill.box_id, &fill.account);
            let extra = echoed
                .as_ref()
                .map(|(host, path)| json!({ "echoHost": host, "path": path }))
                .unwrap_or_else(|| json!({}));
            write_audit(vault, fill, "box_fill.echoed", extra).await;
        }
        (BrowserFillState::Expired, ..) => {
            write_audit(vault, fill, "box_fill.expired", json!({})).await;
        }
        _ => {}
    }
    if !matches!(
        status.state,
        BrowserFillState::Pending | BrowserFillState::Live | BrowserFillState::Filled
    ) {
        end(&fill.box_id, &fill.fill_id);
    }
    Some(status.state)
}

/// Cancel `fills` in parallel within [`REVOKE_BUDGET`]: `(cancelled,
/// pending)`. A pending fill still expires on the sidecar within 60 s.
pub(super) async fn cancel_all(client: &BoxSessionClient, fills: &[LiveFill]) -> (usize, usize) {
    let cancels = fills.iter().map(|fill| async move {
        let done = client
            .browser_fill_cancel(&WorkspaceId(fill.box_id.clone()), &fill.fill_id)
            .await
            .is_ok();
        if done {
            end(&fill.box_id, &fill.fill_id);
        }
        done
    });
    match tokio::time::timeout(REVOKE_BUDGET, futures_util::future::join_all(cancels)).await {
        Ok(results) => {
            let cancelled = results.iter().filter(|done| **done).count();
            (cancelled, fills.len() - cancelled)
        }
        Err(_) => (0, fills.len()),
    }
}

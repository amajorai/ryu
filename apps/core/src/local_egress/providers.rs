//! Provider routes: send one model provider's traffic from a cloud node out
//! through the desktop as well, not only browser and cloud-task traffic.
//!
//! Some providers block data-center address ranges for subscription logins
//! (Anthropic has refused Claude subscription requests from cloud hosts). The
//! node owner turns a route on per provider in that provider's settings. A
//! route only changes anything while a desktop routes this node: then the
//! provider's requests leave through that desktop and, like the rest of the
//! route, fail closed while it is away. Without a routing desktop the provider
//! keeps its cloud path.
//!
//! Provider clients reach the route through a dedicated proxy listener (see
//! [`super::entry`]). Connections on it go through the desktop only when their
//! destination belongs to an enabled route, so a client that always uses the
//! listener (the Gateway passthrough) follows the owner's current choice
//! without being restarted.

use super::PROVIDER_ROUTES_PREF_KEY;
use crate::server::preferences::PreferencesStore;
use serde::Serialize;
use std::{
    collections::BTreeSet,
    sync::{Mutex, OnceLock},
};

/// A provider whose traffic can be routed through the desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum ProviderRoute {
    /// Claude subscription logins: messages, usage, and token refresh.
    Claude,
}

impl ProviderRoute {
    pub(crate) const ALL: [Self; 1] = [Self::Claude];

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
        }
    }

    pub(crate) fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|route| route.id() == id)
    }

    /// Destination hosts whose connections the route carries.
    fn hosts(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &[
                "api.anthropic.com",
                "console.anthropic.com",
                "claude.ai",
                "platform.claude.com",
            ],
        }
    }
}

fn enabled_routes() -> &'static Mutex<BTreeSet<ProviderRoute>> {
    static ROUTES: OnceLock<Mutex<BTreeSet<ProviderRoute>>> = OnceLock::new();
    ROUTES.get_or_init(|| Mutex::new(BTreeSet::new()))
}

fn preferences() -> &'static OnceLock<PreferencesStore> {
    static PREFERENCES: OnceLock<PreferencesStore> = OnceLock::new();
    &PREFERENCES
}

fn parse(value: &str) -> BTreeSet<ProviderRoute> {
    serde_json::from_str::<Vec<String>>(value)
        .unwrap_or_default()
        .iter()
        .filter_map(|id| ProviderRoute::from_id(id))
        .collect()
}

/// Boot: restore the owner's provider routes.
pub(crate) async fn init(store: PreferencesStore) {
    if let Ok(Some(value)) = store.get(PROVIDER_ROUTES_PREF_KEY).await {
        if let Ok(mut routes) = enabled_routes().lock() {
            *routes = parse(&value);
        }
    }
    let _ = preferences().set(store);
    publish_state();
}

/// Whether the owner turned this provider route on.
pub(crate) fn enabled(route: ProviderRoute) -> bool {
    enabled_routes()
        .lock()
        .is_ok_and(|routes| routes.contains(&route))
}

/// Turn one provider route on or off and persist the choice. The choice is
/// saved first and only then takes effect, so a failed save (reported to the
/// owner as an error) never leaves a change running that a restart would undo.
pub(crate) async fn set_enabled(route: ProviderRoute, on: bool) -> Result<(), String> {
    let apply = |routes: &mut BTreeSet<ProviderRoute>| {
        if on {
            routes.insert(route);
        } else {
            routes.remove(&route);
        }
    };
    let serialized = {
        let mut next = enabled_routes()
            .lock()
            .map_err(|_| "provider routes are unavailable".to_owned())?
            .clone();
        apply(&mut next);
        serde_json::to_string(&next.iter().map(|route| route.id()).collect::<Vec<_>>())
            .map_err(|error| error.to_string())?
    };
    let store = preferences()
        .get()
        .ok_or_else(|| "this node does not support desktop routing".to_owned())?;
    store
        .set(PROVIDER_ROUTES_PREF_KEY, &serialized)
        .await
        .map_err(|error| format!("could not save the provider route: {error}"))?;
    apply(
        &mut *enabled_routes()
            .lock()
            .map_err(|_| "provider routes are unavailable".to_owned())?,
    );
    publish_state();
    Ok(())
}

/// Routes that currently leave through the desktop: enabled by the owner while
/// a desktop routes this node.
fn active_routes() -> Vec<&'static str> {
    if !super::entry::routed() {
        return Vec::new();
    }
    ProviderRoute::ALL
        .into_iter()
        .filter(|route| enabled(*route))
        .map(ProviderRoute::id)
        .collect()
}

/// The state file the Gateway reads to decide whether its Anthropic
/// passthrough uses the provider proxy (see [`super::PROVIDER_STATE_ENV`]).
pub(crate) fn state_file() -> std::path::PathBuf {
    crate::paths::state_path(STATE_FILE)
}

const STATE_FILE: &str = "local-egress-provider-routes.json";

/// `{"active":[…],"proxy":…}` for the routes in effect. `proxy` is this Core's
/// provider listener (with its credential), absent while it has none. The
/// Gateway reads it from here rather than from its spawn environment, so a
/// Gateway that outlives a Core restart follows the new listener.
fn state_json(active: &[&str], proxy: Option<&str>) -> String {
    serde_json::json!({ "active": active, "proxy": proxy }).to_string()
}

/// Rewrite the state file after the owner's routes, the routed flag, or the
/// provider listener change, so a running Gateway follows them without a
/// restart. Serialized: two writers racing could otherwise rename an older
/// snapshot last and leave the Gateway on a stale route.
pub(crate) fn publish_state() {
    static PUBLISHING: Mutex<()> = Mutex::new(());
    let _guard = PUBLISHING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = state_file();
    let temporary = path.with_extension("json.tmp");
    let contents = state_json(
        &active_routes(),
        super::entry::provider_proxy_url().as_deref(),
    );
    let written = write_private(&temporary, contents.as_bytes())
        .and_then(|()| std::fs::rename(&temporary, &path));
    if let Err(error) = written {
        tracing::warn!("local egress: could not publish provider route state: {error}");
    }
}

/// Write a file only this user can read: it holds the provider proxy credential.
fn write_private(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(contents)
}

/// The enabled route that carries connections to `host`, if any.
pub(crate) fn route_for_host(host: &str) -> Option<ProviderRoute> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ProviderRoute::ALL
        .into_iter()
        .find(|route| route.hosts().contains(&host.as_str()))
        .filter(|route| enabled(*route))
}

/// Why a provider that must leave through the desktop cannot: the route is on
/// and a desktop routes this node, but this Core has no provider listener.
/// Callers refuse rather than send the provider's traffic from the cloud.
pub(crate) const ROUTE_UNAVAILABLE: &str = "Claude traffic must leave through your computer, but this node's route for it is not running. Restart the node, or turn off \"Route through your computer\" for Claude";

/// Whether `route` should leave through the desktop: the owner enabled it and
/// a desktop routes this node.
pub(crate) fn route_required(route: ProviderRoute) -> bool {
    enabled(route) && super::entry::routed()
}

/// The provider proxy URL (with its credential) while `route` should leave
/// through the desktop. `Ok(None)` keeps the caller on its usual direct
/// client; `Err` means the route applies but cannot carry the traffic, and the
/// caller must refuse instead of going direct.
pub(crate) fn proxy_url(route: ProviderRoute) -> Result<Option<String>, &'static str> {
    decide(route_required(route), super::entry::provider_proxy_url)
}

/// [`proxy_url`]'s rule: a required route without a listener is an error, never
/// a quiet fall-back to the direct path.
fn decide(
    required: bool,
    listener: impl FnOnce() -> Option<String>,
) -> Result<Option<String>, &'static str> {
    if !required {
        return Ok(None);
    }
    listener().map(Some).ok_or(ROUTE_UNAVAILABLE)
}

/// [`proxy_url`] as a `reqwest` proxy.
pub(crate) fn reqwest_proxy(route: ProviderRoute) -> Result<Option<reqwest::Proxy>, &'static str> {
    let Some(url) = proxy_url(route)? else {
        return Ok(None);
    };
    reqwest::Proxy::all(url)
        .map(Some)
        .map_err(|_| ROUTE_UNAVAILABLE)
}

/// Environment for Pi's OAuth bridge. The bridge tunnels its own requests
/// through this proxy (see `pi_oauth_proxy.mjs`), so it does not depend on the
/// JavaScript runtime honouring proxy variables.
pub(crate) fn bridge_proxy_env(
    route: ProviderRoute,
) -> Result<Vec<(&'static str, String)>, &'static str> {
    Ok(proxy_url(route)?
        .map(|url| vec![(BRIDGE_PROXY_ENV, url)])
        .unwrap_or_default())
}

/// Read by `pi_oauth_login.mjs` and applied by `pi_oauth_proxy.mjs`.
const BRIDGE_PROXY_ENV: &str = "RYU_OAUTH_PROXY_URL";

/// Environment for Claude Code: it honours `HTTPS_PROXY`, so its direct
/// Anthropic traffic and its own token refresh take the route. Hosts in
/// `bypass` (the local Gateway, when Claude Code routes through it) and any
/// `NO_PROXY` this Core inherited stay direct. Both spellings are set because
/// Node's HTTP stack reads the lowercase one first. Passed as structured ACP
/// environment, never shell code.
pub(crate) fn claude_code_proxy_env(
    bypass: &[String],
) -> Result<Vec<(String, String)>, &'static str> {
    let Some(url) = proxy_url(ProviderRoute::Claude)? else {
        return Ok(Vec::new());
    };
    let inherited: Vec<String> = ["NO_PROXY", "no_proxy"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .collect();
    let no_proxy = no_proxy_list(bypass, &inherited);
    Ok(vec![
        ("HTTPS_PROXY".to_owned(), url.clone()),
        ("https_proxy".to_owned(), url),
        ("NO_PROXY".to_owned(), no_proxy.clone()),
        ("no_proxy".to_owned(), no_proxy),
    ])
}

/// Loopback, then `bypass`, then every inherited `NO_PROXY` entry, without
/// duplicates.
fn no_proxy_list(bypass: &[String], inherited: &[String]) -> String {
    let mut entries: Vec<String> = ["localhost", "127.0.0.1", "::1"]
        .into_iter()
        .map(str::to_owned)
        .chain(bypass.iter().cloned())
        .chain(
            inherited
                .iter()
                .flat_map(|value| value.split(','))
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_owned),
        )
        .collect();
    let mut seen = BTreeSet::new();
    entries.retain(|entry| seen.insert(entry.to_ascii_lowercase()));
    entries.join(",")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderRouteStatus {
    pub id: &'static str,
    pub enabled: bool,
}

pub(crate) fn status() -> Vec<ProviderRouteStatus> {
    ProviderRoute::ALL
        .into_iter()
        .map(|route| ProviderRouteStatus {
            id: route.id(),
            enabled: enabled(route),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_routes_ignore_unknown_and_malformed_values() {
        assert_eq!(
            parse(r#"["claude","openai",""]"#),
            BTreeSet::from([ProviderRoute::Claude])
        );
        assert!(parse("not json").is_empty());
        assert!(parse("{}").is_empty());
    }

    #[test]
    fn state_file_lists_the_active_routes_and_the_listener() {
        assert_eq!(state_json(&[], None), r#"{"active":[],"proxy":null}"#);
        assert_eq!(
            state_json(&["claude"], Some("http://ryu:pw@127.0.0.1:41000")),
            r#"{"active":["claude"],"proxy":"http://ryu:pw@127.0.0.1:41000"}"#
        );
    }

    #[test]
    fn a_required_route_without_a_listener_refuses_instead_of_going_direct() {
        assert_eq!(decide(false, || None), Ok(None));
        assert_eq!(
            decide(false, || Some("http://ryu:pw@127.0.0.1:1".to_owned())),
            Ok(None)
        );
        assert_eq!(
            decide(true, || Some("http://ryu:pw@127.0.0.1:1".to_owned())),
            Ok(Some("http://ryu:pw@127.0.0.1:1".to_owned()))
        );
        assert_eq!(decide(true, || None), Err(ROUTE_UNAVAILABLE));
    }

    #[test]
    fn claude_code_keeps_loopback_the_gateway_and_inherited_bypasses_direct() {
        assert_eq!(no_proxy_list(&[], &[]), "localhost,127.0.0.1,::1");
        assert_eq!(
            no_proxy_list(
                &["gateway.internal".to_owned()],
                &[
                    " .corp.example , LOCALHOST".to_owned(),
                    "git.corp.example".to_owned()
                ],
            ),
            "localhost,127.0.0.1,::1,gateway.internal,.corp.example,git.corp.example"
        );
    }

    #[test]
    fn only_enabled_routes_claim_their_hosts() {
        // The only test that touches the process-wide route set.
        enabled_routes().lock().unwrap().clear();
        assert_eq!(route_for_host("api.anthropic.com"), None);

        enabled_routes()
            .lock()
            .unwrap()
            .insert(ProviderRoute::Claude);
        assert_eq!(
            route_for_host("API.Anthropic.com."),
            Some(ProviderRoute::Claude)
        );
        assert_eq!(route_for_host("claude.ai"), Some(ProviderRoute::Claude));
        // Enabled but no desktop routes the node: clients keep their own path.
        assert_eq!(claude_code_proxy_env(&[]), Ok(Vec::new()));
        assert_eq!(bridge_proxy_env(ProviderRoute::Claude), Ok(Vec::new()));
        assert_eq!(route_for_host("api.openai.com"), None);
        assert_eq!(route_for_host("anthropic.com.evil.example"), None);
        enabled_routes().lock().unwrap().clear();
    }
}

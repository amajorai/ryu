//! Desktop (exit) side: keep one outbound session to each of the user's cloud
//! nodes while "Route traffic through this computer" is on.
//!
//! The desktop app supplies the node list and short-lived node credentials
//! (they are never persisted here); this module owns connecting, reconnecting
//! with backoff, reporting per-node state, and detaching nodes when the user
//! turns the setting off.

use super::{
    connect_screened,
    mux::{Dialer, Mux},
    DESKTOP_HEADER, ENABLED_PREF_KEY, LOCKED_STATUS, ROUTE_PATH, ROUTE_WS_PATH,
};
use crate::server::preferences::PreferencesStore;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{sync::Notify, task::JoinHandle};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, Message};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PING_INTERVAL: Duration = Duration::from_secs(20);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const LOCKED_RETRY: Duration = Duration::from_secs(5 * 60);
const UNAUTHORIZED_RETRY: Duration = Duration::from_secs(60);
const MAX_NODES: usize = 16;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExitTarget {
    pub node_id: String,
    /// The node's Core base URL (`https://…` or `http://…`).
    pub url: String,
    /// Bearer the node accepts for its owner (a managed user/delegation JWT).
    pub token: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "state")]
pub(crate) enum LinkState {
    Connecting,
    Connected {
        #[serde(rename = "connectedSinceMs")]
        since_ms: i64,
    },
    Offline {
        error: String,
    },
    /// The node's organization has turned local egress routing off.
    DisabledByAdmin,
    /// The node rejected the credential; the app must supply a fresh one.
    Unauthorized,
}

struct Link {
    url: String,
    token: Arc<Mutex<String>>,
    state: Arc<Mutex<LinkState>>,
    wake: Arc<Notify>,
    task: JoinHandle<()>,
}

struct Exit {
    links: Mutex<HashMap<String, Link>>,
    device_name: Mutex<String>,
}

fn exit() -> &'static Exit {
    static EXIT: OnceLock<Exit> = OnceLock::new();
    EXIT.get_or_init(|| Exit {
        links: Mutex::new(HashMap::new()),
        device_name: Mutex::new("Desktop".to_owned()),
    })
}

/// The user's persisted choice (default off).
pub(crate) async fn enabled(preferences: &PreferencesStore) -> bool {
    preferences
        .get(ENABLED_PREF_KEY)
        .await
        .ok()
        .flatten()
        .is_some_and(|value| matches!(value.trim(), "true" | "1" | "on" | "yes"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeLinkStatus {
    pub node_id: String,
    #[serde(flatten)]
    pub state: LinkState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExitStatus {
    pub enabled: bool,
    pub nodes: Vec<NodeLinkStatus>,
}

pub(crate) async fn status(preferences: &PreferencesStore) -> ExitStatus {
    let mut nodes: Vec<NodeLinkStatus> = exit()
        .links
        .lock()
        .map(|links| {
            links
                .iter()
                .map(|(node_id, link)| NodeLinkStatus {
                    node_id: node_id.clone(),
                    state: link
                        .state
                        .lock()
                        .map(|state| state.clone())
                        .unwrap_or(LinkState::Connecting),
                })
                .collect()
        })
        .unwrap_or_default();
    nodes.sort_by(|left, right| left.node_id.cmp(&right.node_id));
    ExitStatus {
        enabled: enabled(preferences).await,
        nodes,
    }
}

/// Reject targets whose URL is not an absolute http(s) base.
fn valid_target(target: &ExitTarget) -> bool {
    !target.node_id.trim().is_empty()
        && target.node_id.len() <= 128
        && !target.token.trim().is_empty()
        && url::Url::parse(&target.url).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.query().is_none()
                && url.username().is_empty()
        })
}

/// Apply the user's choice and the app's current node list.
pub(crate) async fn configure(
    preferences: &PreferencesStore,
    enable: bool,
    device_name: Option<String>,
    targets: Vec<ExitTarget>,
) -> Result<(), String> {
    if targets.len() > MAX_NODES || !targets.iter().all(valid_target) {
        return Err("invalid node list".to_owned());
    }
    preferences
        .set(ENABLED_PREF_KEY, if enable { "true" } else { "false" })
        .await
        .map_err(|error| format!("could not save the setting: {error}"))?;
    if let Some(name) = device_name
        .map(|name| {
            name.trim()
                .chars()
                .filter(|c| !c.is_control())
                .take(64)
                .collect::<String>()
        })
        .filter(|name| !name.is_empty())
    {
        if let Ok(mut device) = exit().device_name.lock() {
            *device = name;
        }
    }

    if !enable {
        let stopped: Vec<(String, Link)> = exit()
            .links
            .lock()
            .map(|mut links| links.drain().collect())
            .unwrap_or_default();
        // Detach every node we were serving and every node the app listed, so
        // the node returns to its cloud path instead of failing closed.
        let mut detach: HashMap<String, (String, String)> = HashMap::new();
        for (node_id, link) in stopped {
            link.task.abort();
            let token = link
                .token
                .lock()
                .map(|token| token.clone())
                .unwrap_or_default();
            detach.insert(node_id, (link.url, token));
        }
        for target in targets {
            detach.insert(target.node_id, (target.url, target.token));
        }
        let client = reqwest::Client::new();
        for (url, token) in detach.into_values() {
            let request = client
                .delete(format!("{}{ROUTE_PATH}", url.trim_end_matches('/')))
                .bearer_auth(token)
                .timeout(CONNECT_TIMEOUT)
                .send();
            if let Err(error) = request.await {
                tracing::debug!("local egress: detach request failed: {error}");
            }
        }
        return Ok(());
    }

    let Ok(mut links) = exit().links.lock() else {
        return Err("route state is unavailable".to_owned());
    };
    let wanted: HashMap<String, ExitTarget> = targets
        .into_iter()
        .map(|target| (target.node_id.clone(), target))
        .collect();
    links.retain(|node_id, link| {
        let keep = wanted
            .get(node_id)
            .is_some_and(|target| target.url == link.url);
        if !keep {
            link.task.abort();
        }
        keep
    });
    for (node_id, target) in wanted {
        if let Some(link) = links.get(&node_id) {
            let changed = link
                .token
                .lock()
                .map(|mut token| {
                    let changed = *token != target.token;
                    *token = target.token.clone();
                    changed
                })
                .unwrap_or(false);
            if changed {
                link.wake.notify_one();
            }
            continue;
        }
        let token = Arc::new(Mutex::new(target.token));
        let state = Arc::new(Mutex::new(LinkState::Connecting));
        let wake = Arc::new(Notify::new());
        let task = tokio::spawn(run_link(
            target.url.clone(),
            token.clone(),
            state.clone(),
            wake.clone(),
        ));
        links.insert(
            node_id,
            Link {
                url: target.url,
                token,
                state,
                wake,
                task,
            },
        );
    }
    Ok(())
}

enum LinkError {
    Locked,
    Unauthorized,
    Other(String),
}

fn set_state(state: &Mutex<LinkState>, next: LinkState) {
    if let Ok(mut state) = state.lock() {
        *state = next;
    }
}

async fn run_link(
    url: String,
    token: Arc<Mutex<String>>,
    state: Arc<Mutex<LinkState>>,
    wake: Arc<Notify>,
) {
    let mut backoff = Duration::from_secs(1);
    loop {
        set_state(&state, LinkState::Connecting);
        let bearer = token.lock().map(|token| token.clone()).unwrap_or_default();
        let wait = match connect_once(&url, &bearer, &state).await {
            Ok(()) => {
                backoff = Duration::from_secs(1);
                backoff
            }
            Err(LinkError::Locked) => {
                set_state(&state, LinkState::DisabledByAdmin);
                LOCKED_RETRY
            }
            Err(LinkError::Unauthorized) => {
                set_state(&state, LinkState::Unauthorized);
                UNAUTHORIZED_RETRY
            }
            Err(LinkError::Other(error)) => {
                set_state(&state, LinkState::Offline { error });
                let wait = backoff;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                wait
            }
        };
        // A fresh credential from the app retries immediately.
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            () = wake.notified() => {}
        }
    }
}

fn websocket_url(base: &str) -> Result<String, LinkError> {
    let base = base.trim_end_matches('/');
    let rest = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return Err(LinkError::Other("node URL must be http(s)".to_owned()));
    };
    Ok(format!("{rest}{ROUTE_WS_PATH}"))
}

fn dialer() -> Dialer {
    Arc::new(|host, port| {
        Box::pin(async move { connect_screened(&host, port, CONNECT_TIMEOUT).await })
    })
}

async fn connect_once(url: &str, bearer: &str, state: &Mutex<LinkState>) -> Result<(), LinkError> {
    let mut request = websocket_url(url)?
        .into_client_request()
        .map_err(|error| LinkError::Other(error.to_string()))?;
    let device = exit()
        .device_name
        .lock()
        .map(|name| name.clone())
        .unwrap_or_default();
    let headers = request.headers_mut();
    headers.insert(
        "authorization",
        format!("Bearer {bearer}")
            .parse()
            .map_err(|_| LinkError::Unauthorized)?,
    );
    if let Ok(value) = device.parse() {
        headers.insert(DESKTOP_HEADER, value);
    }
    let (socket, _) = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async(request),
    )
    .await
    {
        Err(_) => {
            return Err(LinkError::Other(
                "timed out connecting to the cloud node".to_owned(),
            ))
        }
        Ok(Err(tungstenite::Error::Http(response))) => {
            return Err(match response.status().as_u16() {
                401 | 403 => LinkError::Unauthorized,
                LOCKED_STATUS => LinkError::Locked,
                status => LinkError::Other(format!("cloud node answered HTTP {status}")),
            })
        }
        Ok(Err(error)) => return Err(LinkError::Other(error.to_string())),
        Ok(Ok(connected)) => connected,
    };
    set_state(
        state,
        LinkState::Connected {
            since_ms: chrono::Utc::now().timestamp_millis(),
        },
    );

    let (mux, mut outbound) = Mux::new(Some(dialer()));
    let (mut sink, mut stream) = socket.split();
    let mut ping = tokio::time::interval(PING_INTERVAL);
    let result = loop {
        tokio::select! {
            frame = outbound.recv() => {
                let Some(frame) = frame else { break Ok(()) };
                if let Err(error) = sink.send(Message::Binary(frame)).await {
                    break Err(LinkError::Other(error.to_string()));
                }
            }
            message = stream.next() => match message {
                Some(Ok(Message::Binary(frame))) => mux.receive(&frame),
                Some(Ok(Message::Close(_))) | None => break Ok(()),
                Some(Ok(_)) => {}
                Some(Err(error)) => break Err(LinkError::Other(error.to_string())),
            },
            _ = ping.tick() => {
                if let Err(error) = sink.send(Message::Ping(Vec::new())).await {
                    break Err(LinkError::Other(error.to_string()));
                }
            }
        }
    };
    mux.close();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(url: &str) -> ExitTarget {
        ExitTarget {
            node_id: "node-1".into(),
            url: url.into(),
            token: "jwt".into(),
        }
    }

    #[test]
    fn only_plain_http_bases_are_accepted() {
        assert!(valid_target(&target("https://node.example:7980")));
        assert!(valid_target(&target("http://203.0.113.4:7980/")));
        for url in [
            "ftp://node",
            "https://user@node",
            "https://node/?x=1",
            "node:7980",
        ] {
            assert!(!valid_target(&target(url)), "{url}");
        }
        let mut empty = target("https://node");
        empty.token = " ".into();
        assert!(!valid_target(&empty));
    }

    #[test]
    fn websocket_url_follows_the_node_scheme() {
        assert_eq!(
            websocket_url("https://node.example:7980/").ok(),
            Some(format!("wss://node.example:7980{ROUTE_WS_PATH}"))
        );
        assert_eq!(
            websocket_url("http://203.0.113.4:7980").ok(),
            Some(format!("ws://203.0.113.4:7980{ROUTE_WS_PATH}"))
        );
    }

    #[test]
    fn link_state_serializes_for_the_desktop() {
        let status = NodeLinkStatus {
            node_id: "n".into(),
            state: LinkState::Connected { since_ms: 5 },
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"nodeId": "n", "state": "connected", "connectedSinceMs": 5})
        );
        let status = NodeLinkStatus {
            node_id: "n".into(),
            state: LinkState::DisabledByAdmin,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"nodeId": "n", "state": "disabled_by_admin"})
        );
    }
}

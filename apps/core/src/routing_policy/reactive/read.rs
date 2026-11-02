//! Reading the vendor windows for the reactive path, uncached.

use super::{AgentWindows, RetryPolicy, WindowReading};

/// Read one agent's windows straight from the vendor, bypassing
/// [`crate::routing_policy::signals`]'s stale-while-revalidate cache.
///
/// See the module docs for why the cache is wrong here: it exists so a *per
/// turn* proactive check is affordable, and the snapshot it would serve is the
/// one that already proved wrong by letting this turn fail.
pub async fn read_agent_windows(agent_id: &str) -> AgentWindows {
    let snapshot = ryu_usage::fetch_usage(agent_id).await;
    AgentWindows {
        agent_id: agent_id.to_string(),
        plan: snapshot.plan.clone(),
        readable: snapshot.available,
        windows: snapshot
            .windows
            .iter()
            .map(|w| WindowReading {
                label: w.label.clone(),
                model: w.model.clone(),
                used_percent: w.used_percent,
                resets_at: w.resets_at.clone(),
                window_seconds: w.window_seconds,
            })
            .collect(),
    }
}

/// Read the failed agent and every eligible alternative, concurrently.
///
/// `installed` is the set of agent ids this node actually has configured; a plan
/// the user never set up would answer `NotLoggedIn` anyway, but filtering first
/// saves the round-trip and keeps the failure path fast.
pub async fn read_all_windows(
    policy: &RetryPolicy,
    failed_agent: &str,
    installed: &[String],
) -> Vec<AgentWindows> {
    let mut ids: Vec<String> = vec![failed_agent.to_string()];
    let pool: Vec<&str> = if policy.candidates.is_empty() {
        ryu_usage::SUBSCRIPTION_AGENTS.to_vec()
    } else {
        policy.candidates.iter().map(String::as_str).collect()
    };
    for id in pool {
        if id.eq_ignore_ascii_case(failed_agent) {
            continue;
        }
        // Only agents this node has configured. An explicit candidate list is
        // still filtered: naming an agent you never installed must not cost a
        // vendor round-trip on every failure.
        if !installed.iter().any(|a| a.eq_ignore_ascii_case(id)) {
            continue;
        }
        if !ids.iter().any(|a| a.eq_ignore_ascii_case(id)) {
            ids.push(id.to_string());
        }
    }
    let reads = ids.iter().map(|id| read_agent_windows(id));
    // Every live decision reads the windows first, so this is where the note's
    // language catches up with the node's `ui-language` preference.
    let (readings, locale) = futures_util::future::join(
        futures_util::future::join_all(reads),
        crate::i18n::locale::node_locale(),
    )
    .await;
    super::note::set_node_locale(locale);
    readings
}

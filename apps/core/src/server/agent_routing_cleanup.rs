//! Drop a deleted agent's per-agent smart-routing entries from the gateway.
//!
//! `routing.smart_routing.agent_pools[<id>]` and `agent_routes[<id>]` are keyed
//! by agent id. Left behind after a delete, they would be inherited by a later
//! agent that reuses the id, so every Core path that deletes an agent calls
//! [`clear_deleted_agent_routing`] once the agent store row is gone. Doing it
//! here (not in a client) covers REST, MCP, CLI, core-client and package
//! removals alike, and runs even when a later delete step (schedules) fails.

use std::future::Future;

use serde_json::Value;

/// Attempts before a revision conflict is given up on.
const CLEAR_ATTEMPTS: usize = 3;

/// Best effort: the agent is already deleted, so a gateway that is down,
/// remote without admin access, or not serving `smart_routing` only leaves a
/// warning behind instead of failing the delete.
pub(crate) async fn clear_deleted_agent_routing(client: &reqwest::Client, agent_id: &str) {
    let result = clear_agent_routing_with(
        agent_id,
        || crate::sidecar::gateway::fetch_config(client),
        |patch| async move { crate::sidecar::gateway::push_config(client, &patch).await },
    )
    .await;
    if let Err(error) = result {
        tracing::warn!("routing for deleted agent '{agent_id}' was not cleared: {error}");
    }
}

/// The routing section to PUT with `agent_id`'s pool and override removed, or
/// `None` when the view has neither (or serves no `smart_routing` at all, in
/// which case there is nothing that could be inherited and nothing to write).
/// `PUT /v1/config` replaces `routing` wholesale, so every sibling is carried.
fn routing_without_agent(view: &Value, agent_id: &str) -> Option<Value> {
    let mut routing = view.get("routing")?.clone();
    let smart = routing.get_mut("smart_routing")?.as_object_mut()?;
    let mut changed = false;
    for key in ["agent_pools", "agent_routes"] {
        if let Some(entries) = smart.get_mut(key).and_then(Value::as_object_mut) {
            changed |= entries.remove(agent_id).is_some();
        }
    }
    changed.then_some(routing)
}

/// Read-modify-write loop behind [`clear_deleted_agent_routing`], with the
/// gateway transport injected so it is testable. Every write carries the read's
/// `configRevision`; a 409 (a concurrent write landed in between) re-reads and
/// re-applies the removal. Returns whether anything was written.
async fn clear_agent_routing_with<Fetch, FetchFut, Push, PushFut>(
    agent_id: &str,
    mut fetch: Fetch,
    mut push: Push,
) -> anyhow::Result<bool>
where
    Fetch: FnMut() -> FetchFut,
    FetchFut: Future<Output = anyhow::Result<Value>>,
    Push: FnMut(Value) -> PushFut,
    PushFut: Future<Output = anyhow::Result<(reqwest::StatusCode, Value)>>,
{
    for attempt in 1..=CLEAR_ATTEMPTS {
        let view = fetch().await?;
        let Some(routing) = routing_without_agent(&view, agent_id) else {
            return Ok(false);
        };
        let mut patch = serde_json::json!({ "routing": routing });
        if let Some(revision) = view.get("configRevision").filter(|value| !value.is_null()) {
            patch["expectedRevision"] = revision.clone();
        }
        let (status, body) = push(patch).await?;
        if status.is_success() {
            return Ok(true);
        }
        if status != reqwest::StatusCode::CONFLICT || attempt == CLEAR_ATTEMPTS {
            anyhow::bail!("gateway PUT /v1/config returned {status}: {body}");
        }
    }
    unreachable!("the last attempt always returns or bails")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    fn view(revision: &str, pools: Value, routes: Value) -> Value {
        json!({
            "configRevision": revision,
            "routing": {
                "model_map": { "fast": "local" },
                "smart_routing": {
                    "enabled": true,
                    "agent_pools": pools,
                    "agent_routes": routes,
                },
            },
        })
    }

    #[test]
    fn removes_only_the_deleted_agents_entries_and_keeps_siblings() {
        let current = view(
            "r1",
            json!({ "gone": ["a"], "kept": ["b"] }),
            json!({ "gone": { "model": "x" }, "kept": { "model": "y" } }),
        );
        let routing = routing_without_agent(&current, "gone").expect("entries to clear");
        assert_eq!(routing["model_map"], json!({ "fast": "local" }));
        assert_eq!(routing["smart_routing"]["enabled"], json!(true));
        assert_eq!(
            routing["smart_routing"]["agent_pools"],
            json!({ "kept": ["b"] })
        );
        assert_eq!(
            routing["smart_routing"]["agent_routes"],
            json!({ "kept": { "model": "y" } })
        );
    }

    #[test]
    fn clears_a_pool_or_an_override_on_its_own() {
        let pool_only = view("r1", json!({ "gone": ["a"] }), json!({}));
        assert!(routing_without_agent(&pool_only, "gone").is_some());
        let route_only = view("r1", json!({}), json!({ "gone": { "model": "x" } }));
        assert!(routing_without_agent(&route_only, "gone").is_some());
    }

    #[test]
    fn nothing_to_write_without_entries_or_smart_routing() {
        let other = view("r1", json!({ "kept": ["b"] }), json!({}));
        assert!(routing_without_agent(&other, "gone").is_none());
        assert!(routing_without_agent(&json!({ "routing": {} }), "gone").is_none());
        assert!(routing_without_agent(&json!({}), "gone").is_none());
    }

    #[tokio::test]
    async fn writes_once_with_the_read_revision() {
        let pushes = RefCell::new(Vec::new());
        let wrote = clear_agent_routing_with(
            "gone",
            || async { Ok(view("r7", json!({ "gone": ["a"] }), json!({}))) },
            |patch| {
                pushes.borrow_mut().push(patch);
                async { Ok((reqwest::StatusCode::OK, json!({ "ok": true }))) }
            },
        )
        .await
        .expect("clear succeeds");
        assert!(wrote);
        let pushes = pushes.into_inner();
        assert_eq!(pushes.len(), 1);
        assert_eq!(pushes[0]["expectedRevision"], json!("r7"));
        assert_eq!(
            pushes[0]["routing"]["smart_routing"]["agent_pools"],
            json!({})
        );
    }

    #[tokio::test]
    async fn does_not_write_when_there_is_nothing_to_clear() {
        let pushes = RefCell::new(0_usize);
        let wrote = clear_agent_routing_with(
            "gone",
            || async { Ok(view("r1", json!({}), json!({}))) },
            |_| {
                *pushes.borrow_mut() += 1;
                async { Ok((reqwest::StatusCode::OK, json!({}))) }
            },
        )
        .await
        .expect("no-op succeeds");
        assert!(!wrote);
        assert_eq!(pushes.into_inner(), 0);
    }

    #[tokio::test]
    async fn a_conflict_rereads_and_keeps_the_concurrent_write() {
        // The first write races a concurrent one that added `other`'s pool; the
        // retry must re-read and keep it rather than write the stale view.
        let reads = RefCell::new(0_usize);
        let pushes = RefCell::new(Vec::new());
        let wrote = clear_agent_routing_with(
            "gone",
            || {
                *reads.borrow_mut() += 1;
                let current = if *reads.borrow() == 1 {
                    view("r1", json!({ "gone": ["a"] }), json!({}))
                } else {
                    view("r2", json!({ "gone": ["a"], "other": ["c"] }), json!({}))
                };
                async move { Ok(current) }
            },
            |patch| {
                pushes.borrow_mut().push(patch);
                let status = if pushes.borrow().len() == 1 {
                    reqwest::StatusCode::CONFLICT
                } else {
                    reqwest::StatusCode::OK
                };
                async move { Ok((status, json!({}))) }
            },
        )
        .await
        .expect("retry succeeds");
        assert!(wrote);
        let pushes = pushes.into_inner();
        assert_eq!(pushes.len(), 2);
        assert_eq!(pushes[1]["expectedRevision"], json!("r2"));
        assert_eq!(
            pushes[1]["routing"]["smart_routing"]["agent_pools"],
            json!({ "other": ["c"] })
        );
    }

    #[tokio::test]
    async fn gives_up_after_repeated_conflicts_and_surfaces_other_failures() {
        let pushes = RefCell::new(0_usize);
        let conflict = clear_agent_routing_with(
            "gone",
            || async { Ok(view("r1", json!({ "gone": ["a"] }), json!({}))) },
            |_| {
                *pushes.borrow_mut() += 1;
                async { Ok((reqwest::StatusCode::CONFLICT, json!({}))) }
            },
        )
        .await;
        assert!(conflict.is_err());
        assert_eq!(pushes.into_inner(), CLEAR_ATTEMPTS);

        let forbidden = clear_agent_routing_with(
            "gone",
            || async { Ok(view("r1", json!({ "gone": ["a"] }), json!({}))) },
            |_| async { Ok((reqwest::StatusCode::FORBIDDEN, json!({}))) },
        )
        .await;
        assert!(forbidden.is_err());

        let unreachable = clear_agent_routing_with(
            "gone",
            || async { Err(anyhow::anyhow!("connection refused")) },
            |_| async { Ok((reqwest::StatusCode::OK, json!({}))) },
        )
        .await;
        assert!(unreachable.is_err());
    }
}

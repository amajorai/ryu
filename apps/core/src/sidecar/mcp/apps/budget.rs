//! Gateway Budget Dial app. Wired (B2) to the Gateway rule API over loopback
//! admin-auth (D5): `budget` reads the current cap from `GET /v1/config` and the
//! spend from `GET /v1/audit`; `budget.set` is a governed read-modify-write of the
//! one budget rule via `PUT /v1/config`. Core owns no budget store — the Gateway
//! is the single source of truth, so the write is Gateway-audited.
//!
//! Contract note: `BudgetRule.limit` is a **token** cap (`u64`), not USD — there
//! is no USD budget in the gateway model — so `spent`/`limit` are token counts.
//! The frozen `BudgetDial` widget formats them as currency, so the numbers are
//! correct token counts shown with a `$` label; relabeling is a later widget-side
//! change. `period` (day/month) is cosmetic: gateway budgets are lifetime caps.

use anyhow::{anyhow, Result};
use serde_json::{json, Map, Value};

use super::{app_result, AppDispatchCtx};
use crate::sidecar::gateway::{gateway_bearer, gateway_url};

/// Which budget rule a scope resolves to. `user` and `org` both map to the
/// per-user rule (the gateway has no org-scoped budget on a local install);
/// `agent` → the per-agent rule; `session` → the single global session rule.
enum Target {
    User(String),
    Agent(String),
    Session,
}

pub async fn dispatch(tool: &str, args: Value, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    match tool {
        "budget" => budget(args, ctx).await,
        // The tool name is `budget.set` (`ryu.gateway__budget.set`).
        "budget.set" => set(args, ctx).await,
        other => Err(anyhow!("unknown ryu.gateway tool '{other}'")),
    }
}

/// Resolve the scope to a concrete rule target.
fn resolve_target(scope: &str, ctx: &AppDispatchCtx<'_>) -> Target {
    match scope {
        "session" => Target::Session,
        "agent" => Target::Agent(ctx.agent_id.clone().unwrap_or_else(|| "default".to_owned())),
        // "user" and "org" (no gateway-local org tier) both map to the user rule.
        _ => Target::User(ctx.user_id.clone().unwrap_or_else(|| "default".to_owned())),
    }
}

/// Read the current cap (from config) + spend (from audit) for a scope.
async fn budget(args: Value, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    let scope = args
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("user")
        .to_owned();
    let period = args
        .get("period")
        .and_then(Value::as_str)
        .unwrap_or("month")
        .to_owned();

    let target = resolve_target(&scope, ctx);

    // Cap (tokens): read from the live gateway config. 0 = no rule / unavailable.
    let limit = read_config(ctx.http)
        .await
        .ok()
        .and_then(|cfg| rule_limit(&cfg, &target))
        .unwrap_or(0);

    // Spend (tokens): aggregate audit rows. Best-effort — audit may be disabled.
    let (spent, breakdown) = read_spend(ctx.http, &scope, ctx)
        .await
        .unwrap_or((0, Vec::new()));

    let structured = json!({
        "scope": scope,
        "period": period,
        "spent": spent,
        "limit": limit,
        // The widget renders this as a currency label; the values are tokens.
        "currency": "USD",
        "unit": "tokens",
        "breakdown_by_model": breakdown,
    });
    Ok(app_result(
        structured,
        None,
        &format!("{spent} / {limit} tokens spent ({scope})."),
    ))
}

/// Governed write: set the scope's token cap via read-modify-write of the full
/// gateway `BudgetConfig` (`PUT /v1/config` hot-swaps it).
async fn set(args: Value, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    let scope = args
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("user")
        .to_owned();
    let limit = args
        .get("limit")
        .and_then(Value::as_f64)
        .ok_or_else(|| anyhow!("budget.set requires a numeric 'limit'"))?;
    if !(limit.is_finite() && limit >= 0.0) {
        return Err(anyhow!("'limit' must be a non-negative number"));
    }
    let limit = limit.round() as u64;
    let target = resolve_target(&scope, ctx);

    let cfg = read_config(ctx.http).await?;
    // Start from the live budgets so untouched rules are preserved verbatim.
    let mut budgets = cfg
        .get("budgets")
        .cloned()
        .and_then(|b| b.as_object().cloned())
        .unwrap_or_default();
    apply_limit(&mut budgets, &target, limit);

    put_budgets(ctx.http, Value::Object(budgets)).await?;

    Ok(app_result(
        json!({ "status": "ok", "scope": scope, "limit": limit }),
        None,
        &format!("Budget cap set to {limit} tokens ({scope})."),
    ))
}

// ── gateway HTTP (loopback admin-auth, D5) ───────────────────────────────────

/// `GET /v1/config` → the full config view (includes `budgets`).
async fn read_config(http: &reqwest::Client) -> Result<Value> {
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let mut req = http
        .get(format!("{base}/v1/config"))
        .timeout(std::time::Duration::from_secs(5));
    if let Ok(bearer) = gateway_bearer() {
        req = req.bearer_auth(bearer);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("gateway config unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("gateway config returned HTTP {}", resp.status()));
    }
    resp.json()
        .await
        .map_err(|e| anyhow!("gateway config was not valid JSON: {e}"))
}

/// `PUT /v1/config` with the full replacement `budgets` map (hot-swapped live).
async fn put_budgets(http: &reqwest::Client, budgets: Value) -> Result<()> {
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let mut req = http
        .put(format!("{base}/v1/config"))
        .timeout(std::time::Duration::from_secs(5))
        .json(&json!({ "budgets": budgets }));
    if let Ok(bearer) = gateway_bearer() {
        req = req.bearer_auth(bearer);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("gateway config write unreachable: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("gateway rejected budget write: HTTP {status} {body}"));
    }
    Ok(())
}

/// `GET /v1/audit` → aggregate token spend + a per-model breakdown. Session scope
/// filters by the owning conversation id when present.
async fn read_spend(
    http: &reqwest::Client,
    scope: &str,
    ctx: &AppDispatchCtx<'_>,
) -> Result<(u64, Vec<Value>)> {
    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let mut url = format!("{base}/v1/audit?limit=1000");
    if scope == "session" {
        if let Some(cid) = ctx.conversation_id.as_deref() {
            url.push_str(&format!("&session_id={cid}"));
        }
    }
    let mut req = http
        .get(url)
        .timeout(std::time::Duration::from_secs(5));
    if let Ok(bearer) = gateway_bearer() {
        req = req.bearer_auth(bearer);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("gateway audit unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("gateway audit returned HTTP {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| anyhow!("gateway audit was not valid JSON: {e}"))?;

    let entries = body
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // token totals + call counts, keyed by model, preserving first-seen order.
    let mut order: Vec<String> = Vec::new();
    let mut per_model: std::collections::HashMap<String, (u64, u64)> = std::collections::HashMap::new();
    let mut total: u64 = 0;
    for entry in &entries {
        let input = entry.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
        let output = entry
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let tokens = input.saturating_add(output);
        if tokens == 0 {
            continue;
        }
        total = total.saturating_add(tokens);
        let model = entry
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let slot = per_model.entry(model.clone()).or_insert_with(|| {
            order.push(model.clone());
            (0, 0)
        });
        slot.0 = slot.0.saturating_add(tokens);
        slot.1 = slot.1.saturating_add(1);
    }

    let breakdown = order
        .into_iter()
        .map(|model| {
            let (cost, calls) = per_model.get(&model).copied().unwrap_or((0, 0));
            json!({ "model": model, "cost": cost, "calls": calls })
        })
        .collect();
    Ok((total, breakdown))
}

// ── budgets JSON mutation ────────────────────────────────────────────────────

/// The token `limit` on the rule a target resolves to, from a config view.
fn rule_limit(cfg: &Value, target: &Target) -> Option<u64> {
    let budgets = cfg.get("budgets")?;
    match target {
        Target::User(key) => budgets.get("users")?.get(key)?.get("limit")?.as_u64(),
        Target::Agent(key) => budgets.get("agents")?.get(key)?.get("limit")?.as_u64(),
        Target::Session => budgets.get("session")?.get("limit")?.as_u64(),
    }
}

/// Set the token `limit` on the target's rule inside a `budgets` object,
/// preserving every other rule and field. Creates the rule/section if absent.
fn apply_limit(budgets: &mut Map<String, Value>, target: &Target, limit: u64) {
    match target {
        Target::User(key) => set_rule_limit(budgets, "users", key, limit),
        Target::Agent(key) => set_rule_limit(budgets, "agents", key, limit),
        Target::Session => {
            let session = budgets
                .entry("session".to_owned())
                .or_insert_with(|| json!({}));
            if let Some(obj) = session.as_object_mut() {
                obj.insert("limit".to_owned(), json!(limit));
            } else {
                *session = json!({ "limit": limit });
            }
        }
    }
}

fn set_rule_limit(budgets: &mut Map<String, Value>, section: &str, key: &str, limit: u64) {
    let map = budgets
        .entry(section.to_owned())
        .or_insert_with(|| json!({}));
    let Some(map) = map.as_object_mut() else {
        *budgets.get_mut(section).unwrap() = json!({ key: { "limit": limit } });
        return;
    };
    match map.get_mut(key) {
        Some(rule) if rule.is_object() => {
            rule.as_object_mut()
                .unwrap()
                .insert("limit".to_owned(), json!(limit));
        }
        _ => {
            map.insert(key.to_owned(), json!({ "limit": limit }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_limit_preserves_other_fields_and_rules() {
        let mut budgets = json!({
            "users": { "alice": { "limit": 10, "action": "stop" } },
            "agents": {},
            "session": { "limit": 0, "action": "notify" }
        })
        .as_object()
        .unwrap()
        .clone();

        apply_limit(&mut budgets, &Target::User("alice".to_owned()), 500);
        assert_eq!(budgets["users"]["alice"]["limit"], 500);
        // Untouched fields survive.
        assert_eq!(budgets["users"]["alice"]["action"], "stop");

        apply_limit(&mut budgets, &Target::Session, 999);
        assert_eq!(budgets["session"]["limit"], 999);
        assert_eq!(budgets["session"]["action"], "notify");

        // A new key is created.
        apply_limit(&mut budgets, &Target::User("bob".to_owned()), 42);
        assert_eq!(budgets["users"]["bob"]["limit"], 42);
    }

    #[test]
    fn rule_limit_reads_the_resolved_target() {
        let cfg = json!({
            "budgets": {
                "users": { "default": { "limit": 1234 } },
                "session": { "limit": 77 }
            }
        });
        assert_eq!(
            rule_limit(&cfg, &Target::User("default".to_owned())),
            Some(1234)
        );
        assert_eq!(rule_limit(&cfg, &Target::Session), Some(77));
        assert_eq!(rule_limit(&cfg, &Target::User("missing".to_owned())), None);
    }
}

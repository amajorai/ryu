//! Agent **teams** as Core consumes them: through the `teams.resolve` /
//! `teams.create` capabilities, never through a named app.
//!
//! Teams are persisted by whichever enabled app `provides` these capabilities (today
//! the Groups satellite, whose sidecar is the single owner of its store). Core keeps
//! only the parts welded to its own runtime — the `@team` chat orchestration that
//! interprets a team's coordination strategy, and `agent_builder.create_agent_team`,
//! which mints member agents in Core's agent store — and reaches the record through
//! the generic Core-as-consumer broker helper
//! ([`crate::sidecar::capability_consumer::CapabilityConsumer::call_capability`]).
//! No app id, sidecar name, port or route appears here.
//!
//! The wire shapes are the shared serde-only contract in [`ryu_teams_contracts`]:
//!
//! - `teams.resolve` — request `{ "id": "<team id>" }`; reply `200 { "team": TeamRecord }`
//!   or `404` for an unknown id.
//! - `teams.create` — request is [`CreateTeam`] verbatim; reply `2xx { "team": TeamRecord }`.

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use ryu_teams_contracts::{CreateTeam, TeamRecord};
use serde_json::{json, Value};

use crate::sidecar::capability_consumer::{CapabilityCallError, CapabilityConsumer};

/// Read one team by id.
pub const CAP_TEAMS_RESOLVE: &str = "teams.resolve";
/// Persist a new team.
pub const CAP_TEAMS_CREATE: &str = "teams.create";

/// Turn a refused capability call into a user-legible error. A missing provider is
/// the common case (the teams app is disabled or not installed), so it says so
/// instead of surfacing a binding code.
fn refusal(err: CapabilityCallError) -> anyhow::Error {
    match err {
        CapabilityCallError::Unbound { capability, .. } => anyhow!(
            "no enabled app provides the '{capability}' capability; install or enable an \
             app that manages agent teams"
        ),
        other => anyhow!(other),
    }
}

/// Decode the `{ "team": TeamRecord }` envelope both capabilities reply with.
fn team_from(body: &Value) -> Result<TeamRecord> {
    serde_json::from_value(body["team"].clone()).context("parsing TeamRecord from the provider")
}

/// Fetch one team by id. An unknown id is `Ok(None)`.
///
/// # Errors
/// The provider is unbound/unavailable, or it answered with a non-404 failure.
pub async fn resolve_team(
    capabilities: &CapabilityConsumer,
    id: &str,
) -> Result<Option<TeamRecord>> {
    let reply = capabilities
        .call_capability(CAP_TEAMS_RESOLVE, &json!({ "id": id }))
        .await
        .map_err(refusal)?;
    if reply.status == 404 {
        return Ok(None);
    }
    if !reply.is_success() {
        bail!("'{CAP_TEAMS_RESOLVE}' returned HTTP {}", reply.status);
    }
    team_from(&reply.body).map(Some)
}

/// The team-persistence seam `agent_builder::create_agent_team` writes through.
///
/// Prod uses [`CapabilityConsumer`] (the `teams.create` capability). Tests supply an
/// in-memory double (`runnable::agent_builder::tests::FakeTeamSink`) so roster minting
/// stays unit-testable without a live provider.
#[async_trait]
pub trait TeamSink: Send + Sync {
    async fn create_team(&self, input: CreateTeam) -> Result<TeamRecord>;
}

#[async_trait]
impl TeamSink for CapabilityConsumer {
    /// The contract struct is posted verbatim — it derives `Serialize` with no
    /// `skip_serializing_if`, so a field added to the contract reaches the provider
    /// without anyone widening a hand-built body here.
    async fn create_team(&self, input: CreateTeam) -> Result<TeamRecord> {
        let body = serde_json::to_value(&input).context("encoding CreateTeam")?;
        let reply = self
            .call_capability(CAP_TEAMS_CREATE, &body)
            .await
            .map_err(refusal)?;
        if !reply.is_success() {
            let detail = reply.body["error"].as_str().unwrap_or_default();
            bail!(
                "'{CAP_TEAMS_CREATE}' returned HTTP {} {detail}",
                reply.status
            );
        }
        team_from(&reply.body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The read path crosses from a separately-versioned provider binary, so a newer
    /// provider may serve a strategy this build has never heard of. The contract's
    /// lenient read degrades that one field instead of failing every `@team` turn.
    #[test]
    fn an_unknown_strategy_from_a_newer_provider_still_parses() {
        let body = json!({
            "team": { "id": "t1", "name": "Growth", "members": ["a", "b"], "coordination": "swarm" }
        });
        let team = team_from(&body).expect("an unknown strategy must not fail the record");
        assert_eq!(
            team.coordination,
            ryu_teams_contracts::Coordination::Broadcast
        );
        assert_eq!(team.members.len(), 2);
    }

    /// `teams.create` posts the struct verbatim; the provider's handler reads these keys.
    #[test]
    fn create_team_body_carries_the_five_keys() {
        let body = serde_json::to_value(CreateTeam {
            name: "Marketing".to_owned(),
            members: vec!["a".to_owned()],
            coordination: ryu_teams_contracts::Coordination::Router,
            ..Default::default()
        })
        .unwrap();
        for key in [
            "name",
            "description",
            "members",
            "coordination",
            "lead_agent_id",
        ] {
            assert!(body.get(key).is_some(), "missing {key} in {body}");
        }
        assert_eq!(body["coordination"], json!("router"));
    }

    /// The capability names Core consumes must not name an app.
    #[test]
    fn capability_names_carry_no_app_id() {
        for cap in [CAP_TEAMS_RESOLVE, CAP_TEAMS_CREATE] {
            assert!(!cap.contains('@') && !cap.contains('/'), "{cap}");
        }
    }

    /// With no enabled provider, `@team` resolution fails open with a legible error
    /// rather than dialing anything.
    #[tokio::test]
    async fn resolve_without_a_provider_is_a_legible_refusal() {
        let consumer = CapabilityConsumer::new(
            crate::sidecar::SidecarManager::new_noop(),
            std::sync::Arc::new(tokio::sync::RwLock::new(Vec::new())),
            crate::plugins::PluginStore::open_in_memory().unwrap(),
        );
        let err = resolve_team(&consumer, "t1").await.unwrap_err().to_string();
        assert!(err.contains(CAP_TEAMS_RESOLVE), "{err}");
        let err = consumer
            .create_team(CreateTeam {
                name: "x".to_owned(),
                ..Default::default()
            })
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains(CAP_TEAMS_CREATE), "{err}");
    }
}

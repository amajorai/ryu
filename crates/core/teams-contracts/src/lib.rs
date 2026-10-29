//! Wire contract for Ryu agent **teams** — the payloads that cross the boundary
//! between Core and the out-of-process `ryu-teams` sidecar.
//!
//! A team is a persisted, ordered collection of agents addressed as one unit
//! (`@team` in chat) plus a **coordination strategy** deciding how the members
//! respond. The split of responsibilities is:
//!
//! - the **sidecar** (`apps-store/teams/backend`) owns `teams.db` and serves
//!   `/api/teams/*`, which Core re-exposes verbatim through the generic ext-proxy
//!   `public_mount`;
//! - **Core** owns the orchestration that *interprets* the strategy
//!   (`sidecar::adapters::route_team_chat_stream` / `run_team_reply_text`) and the
//!   `agent_builder.create_agent_team` roster minter, reaching the store through
//!   the `teams.resolve` / `teams.create` capabilities the app `provides`
//!   (Core's `agent_teams` module over its generic capability consumer).
//!
//! Both halves need the same three shapes, and neither may link the other. This
//! crate is that shared middle: `serde`-only, no `apps/core` dependency, no
//! `rusqlite`. Same topology as [`ryu-notify`](https://docs.rs/ryu-notify) between
//! Core and the monitors sidecar.
//!
//! What is deliberately NOT here: `UpdateTeam` and its `double_option` tri-state
//! helper. Those are the sidecar's own PATCH shape and Core never names them, so
//! they stay in `store.rs` rather than widening the contract.

use serde::{Deserialize, Serialize};

// ── Coordination strategy ───────────────────────────────────────────────────────

/// How a team's members respond when the team is called. Stored per-team as a
/// kebab-case string; defaults to [`Coordination::Broadcast`].
///
/// The strategy is a per-team, swappable enum (Ryu's "nothing hardcoded"
/// principle): a team can be re-configured at any time without code changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Coordination {
    /// Every member answers the same prompt independently (the simplest, the
    /// default). No member sees another's output.
    #[default]
    Broadcast,
    /// Members answer in order; each sees the prior members' replies.
    RoundRobin,
    /// Members answer independently, then a lead agent synthesizes one answer.
    DebateSynthesis,
    /// A router picks the single best-suited member and routes only to it.
    Router,
}

impl Coordination {
    /// Parse the stored string form back into the enum, defaulting to
    /// [`Coordination::Broadcast`] for unknown/legacy values so a bad row never
    /// breaks listing.
    ///
    /// `pub` because the mapping is the SQL storage format *and* the wire format:
    /// the sidecar's store reads and writes rows through this pair, and
    /// [`TeamRecord`]'s lenient deserializer reads the wire through it. Keeping it
    /// private here would force the string table to be re-declared next to the SQL,
    /// which is the duplication this crate exists to avoid.
    pub fn from_str_lenient(s: &str) -> Self {
        match s {
            "round-robin" => Self::RoundRobin,
            "debate-synthesis" => Self::DebateSynthesis,
            "router" => Self::Router,
            _ => Self::Broadcast,
        }
    }

    /// The stored string form (kebab-case).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Broadcast => "broadcast",
            Self::RoundRobin => "round-robin",
            Self::DebateSynthesis => "debate-synthesis",
            Self::Router => "router",
        }
    }
}

/// Read a [`Coordination`] leniently: an unrecognized strategy name degrades to
/// [`Coordination::Broadcast`] instead of failing the whole parse.
///
/// This is the READ side only ([`TeamRecord`]), and the asymmetry is deliberate.
/// `ryu-teams` is a separately-versioned binary (redirectable via `RYU_TEAMS_BIN`),
/// so Core can be handed a record from a NEWER sidecar that has grown a fifth
/// strategy. Derived `Deserialize` would hard-error on it, and every `@team` turn
/// for that team would collapse into "failed to load team". Degrading one field is
/// strictly better than dropping the record.
///
/// It is NOT applied to [`CreateTeam`]: that is the write shape on a public
/// endpoint, where a typo'd strategy must still be rejected rather than silently
/// stored as `broadcast`. (`#[serde(other)]` would have covered the read case more
/// tersely, but serde restricts it to internally/adjacently tagged enums, which
/// this is not.)
fn coordination_lenient<'de, D>(deserializer: D) -> Result<Coordination, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    Ok(raw
        .as_deref()
        .map_or_else(Coordination::default, Coordination::from_str_lenient))
}

// ── Records ─────────────────────────────────────────────────────────────────────

/// A persisted team configuration record — the READ shape served by
/// `GET /api/teams/:id` and consumed by Core's `@team` orchestration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Ordered list of member agent ids. Order is meaningful for
    /// [`Coordination::RoundRobin`] (turn order) and is the default lead source
    /// for [`Coordination::DebateSynthesis`] when `lead_agent_id` is unset.
    #[serde(default)]
    pub members: Vec<String>,
    /// How members respond when the team is called. Read leniently: a strategy
    /// name this build does not know degrades to [`Coordination::Broadcast`]
    /// instead of failing the record (see `coordination_lenient` for why the write
    /// shape stays strict).
    #[serde(default, deserialize_with = "coordination_lenient")]
    pub coordination: Coordination,
    /// The synthesizer for [`Coordination::DebateSynthesis`] (and the classifier
    /// for [`Coordination::Router`]). Falls back to the first member when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_agent_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Fields a client may supply when creating a team. `id` is server-assigned.
///
/// `Serialize` is part of the contract, not a convenience: Core's
/// `teams.create` capability call posts this struct directly, so a field added here reaches
/// the sidecar without anyone remembering to widen a hand-built `json!` body.
/// Deliberately carries no `skip_serializing_if` — the emitted body must stay the
/// full five keys the sidecar's handler expects.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateTeam {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub members: Vec<String>,
    #[serde(default)]
    pub coordination: Coordination,
    #[serde(default)]
    pub lead_agent_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Coordination; 4] = [
        Coordination::Broadcast,
        Coordination::RoundRobin,
        Coordination::DebateSynthesis,
        Coordination::Router,
    ];

    #[test]
    fn as_str_and_from_str_lenient_round_trip() {
        for c in ALL {
            assert_eq!(Coordination::from_str_lenient(c.as_str()), c);
        }
    }

    #[test]
    fn from_str_lenient_defaults_unknown_to_broadcast() {
        assert_eq!(
            Coordination::from_str_lenient("nonsense"),
            Coordination::Broadcast
        );
    }

    /// The string table is BOTH the SQL storage format and the JSON wire format,
    /// so a serde rename and `as_str` drifting apart would silently corrupt stored
    /// rows. Pin them to each other.
    #[test]
    fn serde_repr_matches_as_str() {
        for c in ALL {
            let json = serde_json::to_value(c).unwrap();
            assert_eq!(json, serde_json::Value::String(c.as_str().to_owned()));
            let back: Coordination = serde_json::from_value(json).unwrap();
            assert_eq!(back, c);
        }
    }

    /// A record from a NEWER sidecar carrying a strategy this build has never
    /// heard of must still load, degraded to the default.
    #[test]
    fn team_record_tolerates_an_unknown_strategy() {
        let rec: TeamRecord = serde_json::from_str(
            r#"{"id":"t1","name":"Growth","members":["a"],"coordination":"swarm"}"#,
        )
        .expect("an unknown strategy must not fail the whole record");
        assert_eq!(rec.coordination, Coordination::Broadcast);
        assert_eq!(rec.members, vec!["a".to_owned()]);
    }

    #[test]
    fn team_record_tolerates_a_missing_or_null_strategy() {
        let missing: TeamRecord = serde_json::from_str(r#"{"id":"t1","name":"G"}"#).unwrap();
        assert_eq!(missing.coordination, Coordination::Broadcast);
        let null: TeamRecord =
            serde_json::from_str(r#"{"id":"t1","name":"G","coordination":null}"#).unwrap();
        assert_eq!(null.coordination, Coordination::Broadcast);
    }

    /// The write shape stays STRICT: a typo on `POST /api/teams` must 400 rather
    /// than be stored as `broadcast`.
    #[test]
    fn create_team_rejects_an_unknown_strategy() {
        let err = serde_json::from_str::<CreateTeam>(r#"{"name":"G","coordination":"swarm"}"#)
            .expect_err("the write shape must not be lenient");
        assert!(err.to_string().contains("swarm"), "{err}");
    }

    /// The `teams.create` capability call posts this struct verbatim; the sidecar's handler
    /// reads exactly these five keys.
    #[test]
    fn create_team_serializes_the_full_five_keys() {
        let body = serde_json::to_value(CreateTeam {
            name: "Marketing".to_owned(),
            coordination: Coordination::DebateSynthesis,
            ..Default::default()
        })
        .unwrap();
        let obj = body.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "coordination",
                "description",
                "lead_agent_id",
                "members",
                "name"
            ]
        );
        assert_eq!(obj["coordination"], serde_json::json!("debate-synthesis"));
    }
}

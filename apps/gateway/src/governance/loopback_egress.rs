//! Reviewed owners of the wholesale loopback egress grant.
//!
//! `tool:http-egress:127.0.0.1` names a host, not a port: Core's egress check
//! and SSRF guard let a holder's declarative `http` tool reach ANY listener on
//! the node's loopback interface. That is fine for the first-party plugins whose
//! manifests pin a reviewed URL (Core bridges, the ext-proxy, a local model
//! server, Bytebot's `bytebotd`), but a third-party marketplace manifest must not
//! be able to self-request it. So the grant is owner-exclusive: approved only for
//! the exact ids below (scoped id plus legacy `com.ryu.*` alias). An operator who
//! trusts a further app can still add the grant to
//! `RYU_MARKETPLACE_GRANT_ALLOWLIST`.
//!
//! `loopback_egress_tests::every_in_repo_loopback_declarer_is_an_owner` fails
//! when a new in-repo manifest declares the grant without a row here.

/// The loopback egress grant this module scopes.
pub(super) const LOOPBACK_EGRESS_GRANT: &str = "tool:http-egress:127.0.0.1";

/// First-party manifests (apps-store, plugins-store, Core-only fixtures) that
/// declare [`LOOPBACK_EGRESS_GRANT`].
pub(super) const LOOPBACK_EGRESS_OWNERS: &[&str] = &[
    // Core-local bridges (/api/advisor/consult, the shadow proxy).
    "@ryu/advisor",
    "com.ryu.advisor",
    "@ryu/shadow",
    "com.ryu.shadow",
    // Bytebot's `bytebotd` daemon at 127.0.0.1:9990.
    "@ryu/bytebot",
    "com.ryu.bytebot",
    // Local model / decision servers.
    "@ryu/laya",
    "com.ryu.laya",
    "@ryu/kev",
    "com.ryu.kev",
    "@ryu/needle3",
    "com.ryu.needle3",
    "@ryu/ollaya",
    "com.ryu.ollaya",
    "@ryu/functiongemma",
    "com.ryu.functiongemma",
    "@ryu/cloudflare-clef",
    "com.ryu.cloudflare-clef",
    "@ryu/agent-comms",
    "com.ryu.agent-comms",
    // Apps whose declarative tools call their own sidecar through Core.
    "@ryu/projects",
    "com.ryu.projects",
    "@ryu/crm",
    "com.ryu.crm",
    "@ryu/browser",
    "com.ryu.browser",
    "@ryu/checks",
    "com.ryu.checks",
    "@ryu/mpp",
    "com.ryu.mpp",
    // Core-only fixtures.
    "@ryu/memory",
    "com.ryu.memory",
    "@ryu/cloud-search",
    "com.ryu.cloud-search",
];

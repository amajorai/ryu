//! Route inventory (spec 00.13, acceptance test AT-1).
//!
//! The inventory is read from the constructed `axum::Router` that
//! [`super::router`] returns for each custody, never from a regex over this
//! module's source, so a route added by a merge, a nest or a helper function
//! is seen exactly as it is served. Every `(method, path)` the router serves
//! must have one row in [`INVENTORY`] that says whether it can reach a
//! provider and why that is safe, and every row must still be served. A new
//! route fails this test until it is classified; a removed route fails it
//! until its row is deleted.
//!
//! axum 0.7 has no public route iterator. Its `Router` `Debug` output prints
//! the route table (`RouteId(n): "/path"`) and each method router's handler
//! slots (`post: Route`, `get: None`, ...), so the walker parses that. If an
//! axum upgrade changes the format, [`walk`] panics instead of returning an
//! empty or partial table.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use regex::Regex;

use crate::{custody::GatewayCustody, state::AppState};

/// How a route relates to provider egress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reach {
    /// Sends caller text to a provider. Every string it forwards passes the
    /// inbound firewall and the locked guardrails before dispatch. `evidence`
    /// names the floor bypass suite test that proves it, or is `None` when
    /// the screen is proven only by code reading (reported as a gap).
    Screened { evidence: Option<&'static str> },
    /// Could send caller text upstream, so the fleet refuses it before any
    /// provider I/O. Off the fleet it spends the node's own credentials.
    RefusedOnFleet { evidence: &'static str },
    /// Served only off the fleet: it forwards the caller's own subscription
    /// credential, never a Ryu one.
    OffFleetOnly,
    /// Reaches a provider with no caller-authored text (ids, discovery).
    NoCallerText,
    /// Hands the request to Core, which owns that dispatch.
    ViaCore,
    /// Master key or local admin only, on the operator's own account.
    OperatorOnly,
    /// Never reaches a provider.
    NoEgress,
}

/// One served route and why its provider reach is safe.
struct Row {
    method: &'static str,
    path: &'static str,
    reach: Reach,
    reason: &'static str,
}

const fn row(method: &'static str, path: &'static str, reach: Reach, reason: &'static str) -> Row {
    Row {
        method,
        path,
        reach,
        reason,
    }
}

const fn screened(evidence: &'static str) -> Reach {
    Reach::Screened {
        evidence: Some(evidence),
    }
}

use Reach::{NoCallerText, NoEgress, OffFleetOnly, OperatorOnly, ViaCore};

/// Every route the Gateway serves. Keep rows grouped as in `api::router`.
const INVENTORY: &[Row] = &[
    row("GET", "/", NoEgress, "service description or a redirect to the operator dashboard"),
    // Inference.
    row(
        "POST",
        "/v1/chat/completions",
        screened("b03_prompt_only_chat_is_screened"),
        "pipeline::run screens every dispatched string leaf",
    ),
    row(
        "POST",
        "/v1/responses",
        screened("sweep_inference_routes_refuse_the_marker"),
        "translated into the chat pipeline before dispatch",
    ),
    row(
        "POST",
        "/v1/agents/:agent_id/chat/completions",
        screened("sweep_inference_routes_refuse_the_marker"),
        "agent-scoped alias of the chat pipeline",
    ),
    row(
        "POST",
        "/v1/agents/:agent_id/:agent_proof/chat/completions",
        Reach::Screened { evidence: None },
        "agent-scoped alias of the chat pipeline; the proof segment needs Core's key, so no suite probe yet",
    ),
    row(
        "POST",
        "/v1/embeddings",
        screened("sweep_inference_routes_refuse_the_marker"),
        "run_embedding screens every input string",
    ),
    row(
        "POST",
        "/v1/rerank",
        screened("sweep_inference_routes_refuse_the_marker"),
        "run_embedding screens the query and every document",
    ),
    row(
        "POST",
        "/v1/messages",
        screened("sweep_inference_routes_refuse_the_marker"),
        "Anthropic dialect translated into the chat pipeline",
    ),
    row(
        "POST",
        "/v1beta/models/:spec",
        screened("sweep_inference_routes_refuse_the_marker"),
        "Gemini dialect translated into the chat pipeline",
    ),
    row(
        "POST",
        "/v1/cursor/chat/completions",
        screened("sweep_inference_routes_refuse_the_marker"),
        "labelled alias of the chat handler",
    ),
    // Media.
    row(
        "POST",
        "/v1/images/generations",
        screened("b08_replicate_nested_input_is_screened"),
        "run_multimodal screens the body the provider will send, nested input included",
    ),
    row(
        "POST",
        "/v1/audio/speech",
        screened("b13_speech_instructions_and_text_are_screened"),
        "run_speech screens every forwarded speech field",
    ),
    row(
        "POST",
        "/v1/audio/transcriptions",
        screened("b14_transcription_prompt_is_screened"),
        "the text fields are screened; audio bytes are out of Phase 0 scope",
    ),
    row(
        "POST",
        "/v1/videos/generations",
        screened("b11_runway_prompt_text_is_screened"),
        "submit_video_job screens the body the provider will send",
    ),
    row(
        "GET",
        "/v1/videos/generations/:id",
        NoCallerText,
        "polls a stored job by its opaque reference",
    ),
    row(
        "POST",
        "/v1/audio/generations",
        Reach::Screened { evidence: None },
        "submit_media_job screens the body the provider will send, as video does; no suite probe yet",
    ),
    row(
        "GET",
        "/v1/audio/generations/:id",
        NoCallerText,
        "polls a stored job by its opaque reference",
    ),
    row("GET", "/v1/modalities", NoEgress, "static modality registry"),
    row(
        "GET",
        "/v1/models",
        NoCallerText,
        "provider model discovery carries no caller text",
    ),
    // Batches.
    row(
        "GET",
        "/v1/batches",
        NoCallerText,
        "master key only; lists batch ids",
    ),
    row(
        "POST",
        "/v1/batches",
        Reach::RefusedOnFleet {
            evidence: "b24_batch_creation_is_refused_on_fleet",
        },
        "D14: batch bodies are unscreened, so the fleet refuses creation",
    ),
    row(
        "GET",
        "/v1/batches/:id",
        NoCallerText,
        "master key only; reads a batch by id",
    ),
    row(
        "DELETE",
        "/v1/batches/:id",
        NoCallerText,
        "master key only; cancels a batch by id",
    ),
    // Web.
    row(
        "POST",
        "/v1/web/search",
        screened("sweep_web_search_refuses_the_marker"),
        "the web pipeline screens the query before provider selection",
    ),
    row(
        "POST",
        "/v1/web/fetch",
        Reach::Screened { evidence: None },
        "the web pipeline screens the URL before provider selection; no suite probe yet",
    ),
    row("GET", "/v1/web/capabilities", NoEgress, "local capability projection"),
    row(
        "GET",
        "/v1/tools/composio",
        NoEgress,
        "lists the locally configured Composio action names",
    ),
    // Observability.
    row("GET", "/metrics", NoEgress, "local counters"),
    row("GET", "/v1/metrics", NoEgress, "local counters"),
    row("GET", "/v1/traffic", NoEgress, "local live-traffic feed"),
    row("GET", "/v1/savings", NoEgress, "local anonymous aggregate"),
    row("GET", "/savings", NoEgress, "local anonymous aggregate"),
    row("GET", "/v1/concurrency", NoEgress, "local admission queue depth"),
    row("GET", "/v1/evals", NoEgress, "local rolling scores"),
    row("GET", "/v1/evals/online", NoEgress, "local online scoring summary"),
    // Evals.
    row(
        "POST",
        "/v1/evals/score",
        Reach::Screened { evidence: None },
        "a judge, when one is needed, is a second pipeline::run call; no suite probe yet",
    ),
    row(
        "POST",
        "/v1/evals/run",
        screened("sweep_eval_run_refuses_the_marker"),
        "every case replays through pipeline::run",
    ),
    row("GET", "/v1/evaluators", NoEgress, "static evaluator taxonomy"),
    // Governance.
    row("POST", "/v1/grants/validate", NoEgress, "local computation over caller data"),
    row("POST", "/v1/manifests/sign", NoEgress, "local signature"),
    row("POST", "/v1/manifests/verify", NoEgress, "local verification"),
    row("GET", "/v1/manifests/pubkey", NoEgress, "public key readback"),
    // Budget and wallet.
    row("GET", "/v1/budget/spend", NoEgress, "in-memory spend counters"),
    row(
        "POST",
        "/v1/budget/charge",
        NoEgress,
        "records a tool charge; reaches only the Ryu control plane",
    ),
    // Provider seam.
    row("GET", "/v1/providers", NoEgress, "lists configured provider ids"),
    row(
        "POST",
        "/v1/providers/status",
        NoEgress,
        "reports whether a provider is configured",
    ),
    row(
        "POST",
        "/v1/providers/call",
        screened("b18_provider_call_composio_text_is_screened"),
        "provider_call_guard screens every string before any provider I/O",
    ),
    row(
        "GET",
        "/v1/wallet",
        NoEgress,
        "last metered balance; reaches only the Ryu control plane",
    ),
    // Audit and exec.
    row("GET", "/v1/audit", NoEgress, "local audit query"),
    row("GET", "/v1/audit/usage", NoEgress, "local audit rollup"),
    row("POST", "/v1/audit/prune", NoEgress, "local audit maintenance"),
    row("POST", "/v1/audit/control", NoEgress, "control activity ingest"),
    row("POST", "/v1/exec/audit", NoEgress, "exec audit ingest"),
    row("POST", "/v1/exec/budget/check", NoEgress, "pre-run budget gate"),
    row("POST", "/sandbox/tick", NoEgress, "sandbox metering tick"),
    row("POST", "/sandbox/quote", NoEgress, "local hourly rate lookup for a sandbox shape"),
    row("POST", "/sandbox/complete", NoEgress, "releases a run's local metering state"),
    row(
        "POST",
        "/v1/exec/tool",
        ViaCore,
        "trusted forwarder or master key only; forwards to Core, which owns tool dispatch",
    ),
    row("POST", "/v1/exec/scan", NoEgress, "local command scan"),
    // Configuration.
    row("GET", "/v1/config", NoEgress, "configuration readback"),
    row("PUT", "/v1/config", NoEgress, "local configuration write"),
    row(
        "POST",
        "/v1/config/providers/apply",
        NoEgress,
        "applies a local provider revision",
    ),
    row("GET", "/v1/doctor", NoEgress, "local configuration doctor"),
    row("POST", "/v1/doctor/fix", NoEgress, "local protective fixes"),
    row("GET", "/v1/egress/posture", NoEgress, "local posture report"),
    row(
        "GET",
        "/v1/screening/status",
        NoEgress,
        "local screener status; reads breaker and probe state, sends nothing",
    ),
    row(
        "POST",
        "/v1/firewall/check",
        NoEgress,
        "local pattern scan; no classifier or provider call",
    ),
    // Subscription passthrough.
    row(
        "ANY",
        "/passthrough/anthropic/*path",
        OffFleetOnly,
        "forwards the caller's own Anthropic subscription; not mounted on the fleet",
    ),
    row(
        "ANY",
        "/passthrough/openai-responses/*path",
        OffFleetOnly,
        "forwards the caller's own ChatGPT login; not mounted on the fleet",
    ),
    // Health.
    row("GET", "/health", NoEgress, "liveness"),
    row("GET", "/.well-known/security.txt", NoEgress, "static security contact"),
    row("GET", "/v1/health", NoEgress, "liveness"),
    row("GET", "/v1/auth/status", NoEgress, "local auth status"),
    row("GET", "/v1/auth/readiness", NoEgress, "signed local readiness proof"),
    row(
        "POST",
        "/internal/enforcement/invalidate",
        NoEgress,
        "control-plane enforcement push; drops cached resolutions only",
    ),
    // Voice and phone.
    row(
        "POST",
        "/voice/twilio/answer",
        NoEgress,
        "Twilio-signed callback answered with TwiML",
    ),
    row(
        "POST",
        "/voice/twilio/outbound/:intent_id",
        NoEgress,
        "Twilio-signed callback answered with TwiML",
    ),
    row(
        "POST",
        "/voice/twilio/status/:intent_id",
        NoEgress,
        "Twilio-signed status callback",
    ),
    row(
        "GET",
        "/voice/twilio/stream",
        ViaCore,
        "Twilio-signed media stream bridged to Core's voice agent",
    ),
    row(
        "GET",
        "/v1/phone-calls",
        OperatorOnly,
        "lists calls on the operator's Twilio account",
    ),
    row(
        "POST",
        "/v1/phone-calls",
        OperatorOnly,
        "places a call on the operator's Twilio account; the goal goes to Core's voice agent",
    ),
    row(
        "GET",
        "/v1/phone-calls/numbers/available",
        OperatorOnly,
        "searches numbers on the operator's Twilio account",
    ),
    row(
        "POST",
        "/v1/phone-calls/numbers",
        OperatorOnly,
        "buys a number on the operator's Twilio account",
    ),
    row(
        "POST",
        "/v1/phone-calls/caller-id-verifications",
        OperatorOnly,
        "starts a caller ID verification on the operator's Twilio account",
    ),
    row(
        "POST",
        "/v1/phone-calls/:call_sid/control",
        OperatorOnly,
        "sends guidance to a live call's assistant session",
    ),
    row(
        "POST",
        "/v1/channels/pairing/approve",
        OperatorOnly,
        "admin only: approves a pending channel sender on the operator's own node",
    ),
    row(
        "POST",
        "/v1/phone-calls/:call_sid/handoff",
        OperatorOnly,
        "transfers a live call on the operator's Twilio account",
    ),
    row(
        "POST",
        "/v1/phone-calls/:call_sid/hangup",
        OperatorOnly,
        "ends a live call on the operator's Twilio account",
    ),
];

/// The floor bypass suite, which [`Reach::Screened`] and
/// [`Reach::RefusedOnFleet`] evidence must name.
const FLOOR_SUITE: &str = include_str!("../pipeline/fallback_tests/floor_bypass_test.rs");

/// The `(method, path)` pairs the router serves, from its `Debug` output.
fn walk(router: &axum::Router) -> BTreeSet<(String, String)> {
    let debug = format!("{router:?}");
    let start = debug
        .find("path_router: ")
        .expect("the axum Router Debug format names its path router");
    let end = debug
        .find(", fallback_router: ")
        .expect("the axum Router Debug format names its fallback router");
    let table = &debug[start..end];
    assert!(
        debug.contains("default_fallback: true"),
        "the Gateway router must not install a catch-all fallback handler"
    );

    let path_pattern = Regex::new(r#"RouteId\((\d+)\): "((?:[^"\\]|\\.)*)""#).unwrap();
    let paths: BTreeMap<u32, String> = path_pattern
        .captures_iter(table)
        .map(|captures| (captures[1].parse().unwrap(), captures[2].to_owned()))
        .collect();

    let slots = [
        "get", "head", "delete", "options", "patch", "post", "put", "trace", "connect", "fallback",
    ];
    let method_pattern = Regex::new(&format!(
        r"RouteId\((\d+)\): MethodRouter\(MethodRouter \{{ {}",
        slots
            .iter()
            .map(|slot| format!(r"{slot}: (\w+),"))
            .collect::<Vec<_>>()
            .join(" ")
            .trim_end_matches(',')
    ))
    .unwrap();
    let service_pattern = Regex::new(r"RouteId\((\d+)\): Route\(").unwrap();

    let mut methods: BTreeMap<u32, BTreeSet<String>> = BTreeMap::new();
    for captures in method_pattern.captures_iter(table) {
        let id: u32 = captures[1].parse().unwrap();
        let mut served = BTreeSet::new();
        for (index, slot) in slots.iter().enumerate() {
            let handler = &captures[index + 2];
            match *slot {
                // An `any(...)` handler, or a `fallback(...)` on a method
                // router, serves every method.
                "fallback" if handler != "Default" => {
                    served.insert("ANY".to_owned());
                }
                "fallback" => {}
                // `get(...)` also answers HEAD, so HEAD is folded into GET.
                "head" if &captures[2] != "None" => {}
                _ if handler != "None" => {
                    served.insert(slot.to_ascii_uppercase());
                }
                _ => {}
            }
        }
        methods.insert(id, served);
    }
    for captures in service_pattern.captures_iter(table) {
        methods.insert(
            captures[1].parse().unwrap(),
            BTreeSet::from(["ANY".to_owned()]),
        );
    }

    let mut routes = BTreeSet::new();
    for (id, path) in paths {
        // axum's own nest and fallback plumbing, never a Gateway route.
        if path.contains("__private__axum") {
            continue;
        }
        let served = methods
            .get(&id)
            .unwrap_or_else(|| panic!("no handler parsed for {path}: the walker is out of date"));
        assert!(
            !served.is_empty(),
            "{path} serves no method: the walker is out of date"
        );
        for method in served {
            routes.insert((method.clone(), path.clone()));
        }
    }
    routes
}

fn router_for(custody: GatewayCustody) -> axum::Router {
    let mut state = AppState::new_for_test_default();
    state.custody = custody;
    super::router(Arc::new(state))
}

fn expected_for(custody: GatewayCustody) -> BTreeSet<(String, String)> {
    INVENTORY
        .iter()
        .filter(|row| custody.mounts_passthrough() || row.reach != OffFleetOnly)
        .map(|row| (row.method.to_owned(), row.path.to_owned()))
        .collect()
}

#[test]
fn walker_reads_the_constructed_router() {
    let routes = walk(&router_for(GatewayCustody::SelfHosted));
    for (method, path) in [
        ("POST", "/v1/chat/completions"),
        ("GET", "/v1/batches"),
        ("POST", "/v1/batches"),
        ("DELETE", "/v1/batches/:id"),
        ("ANY", "/passthrough/anthropic/*path"),
        ("GET", "/health"),
    ] {
        assert!(
            routes.contains(&(method.to_owned(), path.to_owned())),
            "the walker must see {method} {path}: {routes:#?}"
        );
    }
    assert!(
        !routes.contains(&("HEAD".to_owned(), "/health".to_owned())),
        "HEAD is folded into GET"
    );
    assert!(
        routes.len() >= INVENTORY.len() - 1,
        "the walker saw too few routes: {routes:#?}"
    );
}

/// AT-1: the served routes equal the classified rows on every custody.
#[test]
fn every_served_route_is_classified_on_every_custody() {
    let mut problems = Vec::new();
    for custody in [
        GatewayCustody::Fleet,
        GatewayCustody::ManagedNode,
        GatewayCustody::SelfHosted,
    ] {
        let served = walk(&router_for(custody));
        let expected = expected_for(custody);
        for (method, path) in served.difference(&expected) {
            problems.push(format!(
                "{custody:?}: {method} {path} is served but not classified in INVENTORY"
            ));
        }
        for (method, path) in expected.difference(&served) {
            problems.push(format!(
                "{custody:?}: {method} {path} is classified but no longer served"
            ));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// AT-31 at the router level: the fleet never mounts the passthrough routes.
#[test]
fn the_fleet_serves_no_subscription_passthrough() {
    let fleet = walk(&router_for(GatewayCustody::Fleet));
    assert!(
        fleet
            .iter()
            .all(|(_, path)| !path.starts_with("/passthrough")),
        "{fleet:#?}"
    );
    let node = walk(&router_for(GatewayCustody::ManagedNode));
    assert!(node
        .iter()
        .any(|(_, path)| path.starts_with("/passthrough")));
}

#[test]
fn every_row_is_unique_and_reasoned_and_its_evidence_exists() {
    let mut seen = BTreeSet::new();
    let mut problems = Vec::new();
    for row in INVENTORY {
        if !seen.insert((row.method, row.path)) {
            problems.push(format!("{} {} is listed twice", row.method, row.path));
        }
        if row.reason.trim().is_empty() {
            problems.push(format!("{} {} has no reason", row.method, row.path));
        }
        let evidence = match row.reach {
            Reach::Screened { evidence } => evidence,
            Reach::RefusedOnFleet { evidence } => Some(evidence),
            _ => None,
        };
        if let Some(name) = evidence {
            if !FLOOR_SUITE.contains(&format!("async fn {name}(")) {
                problems.push(format!(
                    "{} {} cites {name}, which the floor bypass suite does not define",
                    row.method, row.path
                ));
            }
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

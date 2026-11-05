//! Route matching, sub-path safety, route permissions and the agent lane.

use super::*;

/// Match an incoming sub-path against a declared route pattern. Supports `:param`
/// (one non-empty segment) and a trailing `*rest` (the remainder). Pure + unit-tested
/// because this IS the gate: undeclared paths must 404, and a parametric route like
/// `/inboxes/:id` must still match `/inboxes/abc` (naive string-equality would 404 it,
/// naive prefix-match would wrongly admit undeclared subpaths).
///
/// `pub(crate)` because [`crate::ext_api::lower`] intersects an app's OpenAPI
/// operations against the same declared patterns before minting derived tools —
/// an operation this matcher would 404 must not become a tool that always fails.
/// It calls THIS function rather than carrying its own copy: two definitions of
/// one security gate is exactly how the gate quietly stops matching the thing it
/// was written to catch. Do not re-privatize.
pub(crate) fn route_matches(pattern: &str, actual: &str) -> bool {
    let pat: Vec<&str> = pattern.trim_start_matches('/').split('/').collect();
    let act: Vec<&str> = actual.trim_start_matches('/').split('/').collect();
    for (i, p) in pat.iter().enumerate() {
        if p.starts_with('*') {
            // Trailing wildcard: matches the remainder (including empty).
            return true;
        }
        let Some(a) = act.get(i) else {
            return false; // pattern longer than the actual path.
        };
        if let Some(_param) = p.strip_prefix(':') {
            if a.is_empty() {
                return false;
            }
        } else if p != a {
            return false;
        }
    }
    // No wildcard consumed the tail ⇒ lengths must match exactly.
    pat.len() == act.len()
}

/// Reject any path carrying a `.` or `..` segment. The auth decision is taken from
/// the pattern matching the RAW sub-path, but reqwest normalizes `..` on the URL it
/// forwards — so `/webhook/..%2fadmin` could match a Public `/webhook/*rest` route
/// (no node bearer) yet reach the sidecar's protected `/admin` mount carrying a valid
/// Core-stamped bearer. Reject dot-segments up front so match and forward can never
/// disagree.
///
/// ## Why this decodes in a loop rather than trusting the extractor
///
/// This used to compare each segment against the literal `"."`/`".."` on the stated
/// grounds that "`%2e`/`%2E` are already decoded to `.` by the axum path extractor".
/// That is true, but it is true exactly ONCE, and one decode is not enough as soon as
/// a caller controls a path parameter's VALUE rather than the route.
///
/// A derived (OpenAPI-generated) tool fills `{id}` from model-supplied arguments, and
/// `build_rest_request` percent-encodes that value on the way in — so a model that
/// sends `%2e%2e` produces `%252e%252e`, the extractor decodes it once back to
/// `%2e%2e`, and a literal comparison against `".."` sees an ordinary-looking segment
/// and waves it through. The sidecar's own framework then decodes a second time and
/// gets `..`. The gate and the thing it is guarding disagreed about how many times to
/// decode, which is the whole bug.
///
/// So: decode until it stops changing (bounded — a decode loop on attacker-supplied
/// input must not be unbounded), and reject if ANY round shows a dot segment.
pub(super) fn has_dot_segment(sub_path: &str) -> bool {
    /// Enough to cover realistic multi-encoding while staying a hard bound. Real
    /// traffic needs zero or one round; anything approaching this is an attack.
    const MAX_DECODE_ROUNDS: usize = 8;

    let mut current = sub_path.to_owned();
    for _ in 0..MAX_DECODE_ROUNDS {
        if current
            .trim_start_matches('/')
            .split('/')
            .any(|seg| seg == "." || seg == "..")
        {
            return true;
        }
        if current.contains('\\') {
            return true;
        }
        let decoded = match urlencoding::decode(&current) {
            Ok(next) => next.into_owned(),
            // Not valid percent-encoding (or not UTF-8 once decoded). Nothing
            // downstream will get a cleaner read of it than we just did.
            Err(_) => return true,
        };
        // A segment separator that only APPEARS after decoding (`..%2fadmin`) means
        // the pre-decode split never saw the boundary. Re-splitting on the next
        // round is what catches it.
        if decoded.matches('/').count() != current.matches('/').count() || decoded.contains('\\') {
            return true;
        }
        if decoded == current {
            return false;
        }
        current = decoded;
    }
    // Still changing after the bound: pathologically nested encoding. Refuse rather
    // than hand a path we have not finished understanding to the forwarder.
    true
}

/// Whether `sub_path` holds a `?` or `#`, literally or under any layer of percent
/// encoding.
///
/// Axum has already decoded the path once, so a caller's `%3F` arrives here as a
/// literal `?`. The route and permission gates would match the path WITH it (and gate
/// on a resource id such as `job-1?`), but the forward builds a URL from the same
/// string, where the first `?` starts the query and `#` the fragment: the sidecar
/// would serve the shorter path (`job-1`) the gates never saw. A deeper layer
/// (`%253F`) is refused for the same reason the dot-segment guard decodes until the
/// path stops changing: the sidecar's own framework may decode once more.
pub(super) fn has_query_or_fragment_delimiter(sub_path: &str) -> bool {
    const MAX_DECODE_ROUNDS: usize = 8;

    let mut current = sub_path.to_owned();
    for _ in 0..MAX_DECODE_ROUNDS {
        if current.contains(['?', '#']) {
            return true;
        }
        let decoded = match urlencoding::decode(&current) {
            Ok(next) => next.into_owned(),
            Err(_) => return true,
        };
        if decoded == current {
            return false;
        }
        current = decoded;
    }
    true
}

/// Whether `sub_path` holds a tab, LF or CR, literally or under any layer of percent
/// encoding.
///
/// The gates match `sub_path` as given, but the forward hands
/// `http://127.0.0.1:<port><mount><sub_path><query>` to reqwest, whose URL parser
/// deletes every tab, LF and CR BEFORE it collapses dot segments. So
/// `/webhook/.<TAB>./admin` (sent as `.%09.`) has no literal `..` for
/// [`has_dot_segment`] to refuse and matches a Public `/webhook/*rest` route, yet the
/// sidecar is asked for `/admin` carrying Core's hop bearer. Deletion alone renames a
/// path too: under a Public `/*rest`, `/ad<TAB>min` is forwarded as the Protected
/// `/admin`. A deeper layer (`%09`) is refused for the same reason the dot-segment
/// guard decodes until the path stops changing: the sidecar's own framework may
/// decode once more. Other C0 controls are not refused here: the parser
/// percent-encodes them inside the path, so they reach the sidecar as matched (a
/// trailing one is trimmed instead; see [`forward_url_trims_path_end`]).
pub(super) fn has_url_parser_deleted_character(sub_path: &str) -> bool {
    const MAX_DECODE_ROUNDS: usize = 8;

    let mut current = sub_path.to_owned();
    for _ in 0..MAX_DECODE_ROUNDS {
        if current.contains(['\t', '\n', '\r']) {
            return true;
        }
        let decoded = match urlencoding::decode(&current) {
            Ok(next) => next.into_owned(),
            Err(_) => return true,
        };
        if decoded == current {
            return false;
        }
        current = decoded;
    }
    true
}

/// Whether the HTTP forward's URL parser would trim the end of `sub_path` off the path
/// it requests from the sidecar.
///
/// reqwest's URL parser trims C0 controls and spaces off the end of the WHOLE URL. The
/// forward appends `?<query>` whenever the request had one (even an empty one), so the
/// path is the end of that URL exactly when `query` is `None`. Only then is anything
/// trimmed, and then it always is: `/webhook/..<SPACE>` is forwarded as `/webhook/..`
/// and collapses to the mount root, and under a Public `/*rest` route `/admin<SPACE>`
/// is forwarded as the Protected `/admin`. So this refuses only a path the forward
/// would already send to a different place from the one the gates matched. A space
/// anywhere else, or one followed by a query, is percent-encoded and reaches the
/// sidecar as matched, and a still-encoded `%20` is never trimmed.
///
/// The WebSocket lane needs no such check: its bridge parses the upstream URL as an
/// `http::Uri`, which rejects a literal space or control character outright, so such
/// a socket is closed without ever reaching the sidecar.
pub(super) fn forward_url_trims_path_end(sub_path: &str, query: Option<&str>) -> bool {
    query.is_none() && sub_path.ends_with(|c: char| c <= ' ')
}

/// The value captured by a named `:param` of `pattern` from `actual`, or `None` when
/// the pattern has no such param (or the paths do not line up). Split out from
/// [`route_matches`] because only the permission gate needs the captured value, and
/// the matcher itself stays a pure yes/no on the security-critical 404 path.
pub(super) fn captured_param(pattern: &str, actual: &str, name: &str) -> Option<String> {
    let act: Vec<&str> = actual.trim_start_matches('/').split('/').collect();
    for (index, segment) in pattern.trim_start_matches('/').split('/').enumerate() {
        // A wildcard swallows an unknown number of segments, so nothing after it
        // lines up positionally any more. Give up rather than read whatever
        // happens to sit at this index — a wrong capture would resolve the ACL
        // against a resource id the caller effectively chose.
        if segment.starts_with('*') {
            return None;
        }
        if segment.strip_prefix(':') == Some(name) {
            return act
                .get(index)
                .filter(|value| !value.is_empty())
                .map(|value| (*value).to_owned());
        }
    }
    None
}

/// The permission a matched route demands, paired with the resource id it applies
/// to — `None` for a route the app did not annotate, which is every route shipping
/// today and must keep proxying exactly as before.
///
/// The resource id falls back to the plugin id when the rule names no
/// [`RouteSpec::resource_param`] (or the param captured nothing), so an admin can
/// always express "this person may use this app" even for a route that identifies no
/// object. Pure, so the rule this returns is unit-testable without a server.
pub(super) fn required_permission_for(
    route: &crate::plugin_manifest::schema::RouteSpec,
    sub_path: &str,
    plugin_id: &str,
) -> Option<(String, String)> {
    let permission = route.permission.clone()?;
    let resource_id = route
        .resource_param
        .as_deref()
        .and_then(|param| captured_param(&route.path, sub_path, param))
        .unwrap_or_else(|| plugin_id.to_owned());
    Some((permission, resource_id))
}

/// The agent a request runs for, when Core's HTTP-tool seam stamped one.
///
/// Browser managed-Bot lanes are an internal Core capability, not a public
/// query selector. Accept the query only when the Core HTTP-tool seam supplied
/// a proof tied to the exact request; direct ext-proxy callers are refused.
///
/// Every other app learns its agent from [`HDR_CALLER_AGENT_ID`], which counts
/// only with a [`HDR_CALLER_AGENT_PROOF`] tied to the same agent, method, path
/// and query. A named agent with a missing or bad proof is refused rather than
/// forwarded as an agent-less call, so an agent can never shed its account
/// access by mangling the proof.
pub(super) fn verified_agent_lane(
    req: &Request,
    plugin_id: &str,
) -> Result<Option<String>, Response> {
    if plugin_id != "@ryu/browser" {
        return verified_agent_header(req);
    }
    let query = req.uri().query().unwrap_or_default();
    let agent_ids: Vec<String> = url::form_urlencoded::parse(query.as_bytes())
        .filter(|(name, _)| name == "agent_id")
        .map(|(_, value)| value.into_owned())
        .collect();
    let Some(agent_id) = agent_ids.first() else {
        return Ok(None);
    };
    if agent_ids.len() != 1 || agent_id.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "browser agent_id must be supplied exactly once",
        )
            .into_response());
    }
    let Some(proof) = req
        .headers()
        .get(HDR_CALLER_AGENT_PROOF)
        .and_then(|value| value.to_str().ok())
    else {
        return Err((
            StatusCode::FORBIDDEN,
            "browser agent lanes require a Core-issued capability proof",
        )
            .into_response());
    };
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or_else(|| req.uri().path());
    if !verify_agent_lane(agent_id, req.method().as_str(), path_and_query, proof) {
        return Err((StatusCode::FORBIDDEN, "browser agent lane proof is invalid").into_response());
    }
    Ok(Some(agent_id.clone()))
}

/// Whether a request that resolved to a `Public` route must be refused because its
/// ORIGINAL (still percent-encoded) URI path hides a dot segment, a backslash, or a
/// separator that only appears after decoding.
///
/// Axum has already decoded the Path capture that [`resolve_route`] sees, so a
/// separator encoded once (`/slug%2F..%2Fadmin`, `/slug%2Fsessions`) is invisible
/// there. Public routes are reachable without any credential, and the satellites
/// behind them (Forms, Bot Flows, inbound webhooks, …) resolve slugs against their
/// own stores, so the raw URI must be unambiguous before it reaches them. This holds
/// for every plugin's public routes; there is deliberately no per-app branch.
/// Protected routes keep the decoded-path check only: they already require the node
/// bearer, and some legitimately carry encoded separators in ids.
pub(super) fn public_route_raw_path_is_unsafe(auth: RouteAuth, raw_path: &str) -> bool {
    auth == RouteAuth::Public && has_dot_segment(raw_path)
}

pub(super) fn verified_agent_header(req: &Request) -> Result<Option<String>, Response> {
    let mut named = req.headers().get_all(HDR_CALLER_AGENT_ID).iter();
    let Some(agent_id) = named.next() else {
        return Ok(None);
    };
    let agent_id = agent_id
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|value| !value.is_empty() && named.next().is_none())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "the calling agent must be named exactly once",
            )
                .into_response()
        })?;
    let Some(proof) = req
        .headers()
        .get(HDR_CALLER_AGENT_PROOF)
        .and_then(|value| value.to_str().ok())
    else {
        return Err((
            StatusCode::FORBIDDEN,
            "a calling agent requires a Core-issued capability proof",
        )
            .into_response());
    };
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or_else(|| req.uri().path());
    if !verify_agent_lane(agent_id, req.method().as_str(), path_and_query, proof) {
        return Err((StatusCode::FORBIDDEN, "calling agent proof is invalid").into_response());
    }
    Ok(Some(agent_id.to_owned()))
}

/// Find the most-specific declared route on `manifest` that matches `sub_path`,
/// returning the matched sidecar spec, its http spec, and the matched route. Equal
/// specificity is rejected so auth posture never depends on declaration order.
///
/// The whole ROUTE comes back rather than just its auth posture: the permission gate
/// reads the same matched entry the forward decision came from, so the two can never
/// be resolved against different routes.
pub(super) fn resolve_route<'a>(
    manifest: &'a crate::plugin_manifest::PluginManifest,
    sub_path: &str,
    method: &str,
) -> Option<(
    &'a SidecarSpec,
    &'a HttpProxySpec,
    &'a crate::plugin_manifest::schema::RouteSpec,
)> {
    if has_dot_segment(sub_path)
        || has_query_or_fragment_delimiter(sub_path)
        || has_url_parser_deleted_character(sub_path)
    {
        return None;
    }
    let mut best: Option<(
        &SidecarSpec,
        &HttpProxySpec,
        &crate::plugin_manifest::schema::RouteSpec,
    )> = None;
    for spec in &manifest.sidecars {
        let Some(http) = &spec.http else { continue };
        for route in &http.routes {
            let method_matches = route
                .method
                .as_deref()
                .is_none_or(|declared| declared.eq_ignore_ascii_case(method));
            if method_matches && route_matches(&route.path, sub_path) {
                let candidate = (spec, http, route);
                if best.is_none_or(|(_, _, current)| {
                    crate::plugin_manifest::route_specificity(&route.path)
                        > crate::plugin_manifest::route_specificity(&current.path)
                }) {
                    best = Some(candidate);
                } else if best.is_some_and(|(_, _, current)| {
                    crate::plugin_manifest::route_specificity(&route.path)
                        == crate::plugin_manifest::route_specificity(&current.path)
                }) {
                    // A tie is ambiguous even when the manifest bypassed validation.
                    return None;
                }
            }
        }
    }
    best
}

// ── Hop-by-hop header handling (mirrors mail.rs) ──────────────────────────────

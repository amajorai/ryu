//! The agent-lane proof: how Core names the calling agent on an ext-proxy
//! request, and how the proxy verifies that a named agent is Core-issued.

use super::*;

/// Bumped from `v1` when the proof started covering the egress allowlist, so a
/// proof of one shape can never verify as the other.
pub(super) const AGENT_LANE_PROOF_DOMAIN: &str = "ryu-agent-lane-v2";

/// What [`sign_agent_lane`] hands out when the agent's egress allowlist cannot
/// be read. It is not hex, so it never verifies: the named agent is refused
/// rather than sent on as an agent-less (unrestricted) call.
pub(super) const UNVERIFIABLE_LANE_PROOF: &str = "egress-policy-unavailable";

pub(super) type AgentLaneMac = Hmac<Sha256>;

/// The signed text. It names the agent's egress allowlist as Core stamps it on
/// the hop (`none` when the agent has none), so a proof minted under one policy
/// does not verify once the policy changed.
pub(super) fn agent_lane_payload(
    agent_id: &str,
    method: &str,
    path_and_query: &str,
    egress_allowlist: Option<&str>,
) -> String {
    let egress = match egress_allowlist {
        Some(value) => format!("allow:{value}"),
        None => "none".to_owned(),
    };
    format!("{AGENT_LANE_PROOF_DOMAIN}\n{method}\n{path_and_query}\n{agent_id}\n{egress}")
}

fn lane_mac(token: &str, payload: &str) -> Option<AgentLaneMac> {
    let mut mac = AgentLaneMac::new_from_slice(token.trim().as_bytes()).ok()?;
    mac.update(payload.as_bytes());
    Some(mac)
}

/// Sign a lane under an explicit egress allowlist. [`sign_agent_lane`] reads it
/// from the store; tests pin it.
pub(super) fn sign_agent_lane_under(
    agent_id: &str,
    method: &str,
    path_and_query: &str,
    egress_allowlist: Option<&str>,
) -> Option<String> {
    let token = crate::node_token::active_token()?;
    sign_lane_with(&token, agent_id, method, path_and_query, egress_allowlist)
}

fn sign_lane_with(
    token: &str,
    agent_id: &str,
    method: &str,
    path_and_query: &str,
    egress_allowlist: Option<&str>,
) -> Option<String> {
    let payload = agent_lane_payload(agent_id, method, path_and_query, egress_allowlist);
    let mac = lane_mac(token, &payload)?;
    Some(hex::encode(mac.finalize().into_bytes()))
}

/// The lane proof for an agent given the node token and its stored egress
/// policy. `None` (send the request agent-less) only when the agent has no
/// policy and nothing can sign. An agent with a policy, or whose policy cannot
/// be read, always gets a proof: a real one, or one that never verifies, so it
/// is refused rather than run unrestricted when no token can sign.
pub(super) fn agent_lane_proof(
    token: Option<&str>,
    egress: anyhow::Result<Option<String>>,
    agent_id: &str,
    method: &str,
    path_and_query: &str,
) -> Option<String> {
    match (egress, token) {
        (Ok(egress), Some(token)) => {
            sign_lane_with(token, agent_id, method, path_and_query, egress.as_deref())
                .or_else(|| egress.map(|_| UNVERIFIABLE_LANE_PROOF.to_owned()))
        }
        (Ok(None), None) => None,
        (Ok(Some(_)), None) => {
            tracing::warn!(
                "no node token to sign an agent with an egress allowlist; refusing the agent lane"
            );
            Some(UNVERIFIABLE_LANE_PROOF.to_owned())
        }
        (Err(error), _) => {
            tracing::warn!(%error, "agent egress allowlist unreadable; refusing the agent lane");
            Some(UNVERIFIABLE_LANE_PROOF.to_owned())
        }
    }
}

/// Stamp a Core-generated agent-lane request. The proof is tied to the active
/// node bearer, the exact method/path/query, and the agent's current egress
/// allowlist, so a sidecar never trusts a caller-supplied lane query on its
/// own. When the allowlist cannot be read, or the agent has one but no token
/// can sign, the proof is one that never verifies, so the request is refused
/// instead of running unrestricted.
pub(crate) fn sign_agent_lane(
    agent_id: &str,
    method: &str,
    path_and_query: &str,
) -> Option<String> {
    agent_lane_proof(
        crate::node_token::active_token().as_deref(),
        crate::sidecar::ext_proxy::egress_policy::current_header_value(agent_id),
        agent_id,
        method,
        path_and_query,
    )
}

/// Verify a lane proof against the agent's current egress allowlist. `Ok` holds
/// that allowlist (the value Core stamps on the hop); a bad proof is refused
/// with `invalid`, and an unreadable allowlist store with 503.
pub(super) fn verify_agent_lane(
    agent_id: &str,
    method: &str,
    path_and_query: &str,
    proof: &str,
    invalid: &'static str,
) -> Result<Option<String>, Response> {
    let egress = crate::sidecar::ext_proxy::egress_policy::current_header_value(agent_id).map_err(
        |error| {
            tracing::warn!(%error, "agent egress allowlist unreadable; refusing the agent lane");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "the calling agent's egress allowlist could not be read",
            )
                .into_response()
        },
    )?;
    let refused = || (StatusCode::FORBIDDEN, invalid).into_response();
    let token = crate::node_token::active_token().ok_or_else(refused)?;
    let bytes = hex::decode(proof.trim()).map_err(|_| refused())?;
    let payload = agent_lane_payload(agent_id, method, path_and_query, egress.as_deref());
    let mac = lane_mac(&token, &payload).ok_or_else(refused)?;
    mac.verify_slice(&bytes).map_err(|_| refused())?;
    Ok(egress)
}

/// A calling agent the proxy verified, with the egress allowlist its proof
/// covers (`None`: the agent has no allowlist).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct VerifiedAgent {
    pub(super) id: String,
    pub(super) egress_allowlist: Option<String>,
}

/// Refuse a request that carries the egress allowlist header itself. Only Core
/// stamps it, on the hop to the app, from the agent's stored policy; a copy
/// from the caller could otherwise pin an app's session to a list of its
/// choosing.
pub(super) fn refuse_caller_egress_allowlist(req: &Request) -> Result<(), Response> {
    if req.headers().contains_key(HDR_CALLER_EGRESS_ALLOWLIST) {
        return Err((
            StatusCode::BAD_REQUEST,
            "the egress allowlist header is set by Core only",
        )
            .into_response());
    }
    Ok(())
}

/// [`verified_agent`] without the allowlist, for tests that need only the id.
#[cfg(test)]
pub(super) fn verified_agent_lane(
    req: &Request,
    plugin_id: &str,
) -> Result<Option<String>, Response> {
    Ok(verified_agent(req, plugin_id)?.map(|agent| agent.id))
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
pub(super) fn verified_agent(
    req: &Request,
    plugin_id: &str,
) -> Result<Option<VerifiedAgent>, Response> {
    refuse_caller_egress_allowlist(req)?;
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
    let egress_allowlist = verify_agent_lane(
        agent_id,
        req.method().as_str(),
        path_and_query,
        proof,
        "browser agent lane proof is invalid",
    )?;
    Ok(Some(VerifiedAgent {
        id: agent_id.clone(),
        egress_allowlist,
    }))
}

pub(super) fn verified_agent_header(req: &Request) -> Result<Option<VerifiedAgent>, Response> {
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
    let egress_allowlist = verify_agent_lane(
        agent_id,
        req.method().as_str(),
        path_and_query,
        proof,
        "calling agent proof is invalid",
    )?;
    Ok(Some(VerifiedAgent {
        id: agent_id.to_owned(),
        egress_allowlist,
    }))
}

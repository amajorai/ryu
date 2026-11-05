//! Which request headers cross the hop, and the caller facts Core stamps.

use super::*;

pub(super) fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "content-length" | "connection" | "transfer-encoding" | "keep-alive" | "upgrade"
    )
}

/// Browser-context headers describing the ORIGINAL caller (the desktop webview's
/// cross-origin `fetch` to Core), not the Core→sidecar hop. Sidecar loopback
/// control servers 403 any request carrying a non-empty `Origin` as CSRF /
/// DNS-rebind defense (the island-pattern hardening, e.g. the browser sidecar's
/// `isTrustedLocalRequest`), so forwarding it would make Core's own
/// authenticated proxy hop indistinguishable from a drive-by browser request.
pub(super) fn is_browser_context(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "origin" | "referer")
}

pub(super) fn is_caller_credential(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "x-ryu-user-jwt" | "x-ryu-node-token" | "cookie"
    )
}

/// Return only the app-owned cookies a manifest explicitly opted into.
///
/// Core authentication cookies never cross the process boundary. A sidecar can
/// still use an HttpOnly browser session, but only by declaring the cookie name in
/// its own manifest namespace; unknown names and malformed cookie fragments are
/// discarded before the loopback hop is built.
pub(super) fn forwarded_cookie_header(
    src: &HeaderMap,
    allowed_cookie_names: &[String],
) -> Option<reqwest::header::HeaderValue> {
    if allowed_cookie_names.is_empty() {
        return None;
    }
    let allowed: HashSet<&str> = allowed_cookie_names.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    let mut pairs = Vec::new();
    for value in src.get_all("cookie").iter() {
        let Ok(raw) = value.to_str() else { continue };
        for fragment in raw.split(';') {
            let pair = fragment.trim();
            let Some((name, _cookie_value)) = pair.split_once('=') else {
                continue;
            };
            let name = name.trim();
            if allowed.contains(name) && seen.insert(name.to_owned()) {
                pairs.push(pair.to_owned());
            }
        }
    }
    if pairs.is_empty() {
        return None;
    }
    reqwest::header::HeaderValue::from_str(&pairs.join("; ")).ok()
}

pub(super) fn copy_headers(
    src: &HeaderMap,
    dst: &mut reqwest::header::HeaderMap,
    allowed_cookie_names: &[String],
) {
    let forwarded_cookie = forwarded_cookie_header(src, allowed_cookie_names);
    for (name, value) in src.iter() {
        if is_hop_by_hop(name.as_str())
            || is_browser_context(name.as_str())
            || is_caller_credential(name.as_str())
            || name
                .as_str()
                .eq_ignore_ascii_case(HDR_FORWARDED_AUTHORIZATION)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_USER_ID)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_ORG_ID)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_EMAIL)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_RESOURCE_IDS)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_RATE_SUBJECT)
            || name
                .as_str()
                .eq_ignore_ascii_case(crate::sidecar::deferred_authorization::PRINCIPAL_HEADER)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_AGENT_ID)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_AGENT_PROOF)
            || name
                .as_str()
                .eq_ignore_ascii_case(crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER)
            || name.as_str().eq_ignore_ascii_case(HDR_WEB_DELEGATION)
            || name.as_str().eq_ignore_ascii_case(HDR_APP_CALLER)
            || name.as_str().eq_ignore_ascii_case(HDR_EVENT_DELIVERY)
        {
            continue;
        }
        if let (Ok(n), Ok(v)) = (
            reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            dst.append(n, v);
        }
    }
    if let Some(cookie) = forwarded_cookie {
        dst.insert(reqwest::header::HeaderName::from_static("cookie"), cookie);
    }
}

/// Preserve an MPP credential only for a manifest-public route. Bearer tokens and
/// every other authorization scheme remain hop-local and are never forwarded.
pub(super) fn forwarded_payment_authorization(
    headers: &HeaderMap,
    allow: bool,
) -> Option<reqwest::header::HeaderValue> {
    if !allow {
        return None;
    }
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let (scheme, credential) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Payment") || credential.trim().is_empty() {
        return None;
    }
    reqwest::header::HeaderValue::from_str(value).ok()
}

// ── Inbound proxy (/api/ext/:plugin_id/*rest) ─────────────────────────────────

/// The pseudonymous rate subject Core stamps as [`HDR_CALLER_RATE_SUBJECT`]:
///
/// - `user:<24 hex>` for a verified caller (their user id);
/// - `peer:<24 hex>` for an anonymous caller, from the client address Core
///   resolved (the socket peer, or `X-Forwarded-For` only behind a configured
///   trusted proxy). IPv6 addresses are reduced to their /64 prefix, which one
///   client typically controls whole;
/// - `unknown` when Core cannot tell clients apart: no connect info, a loopback
///   peer behind the forwarding tunnel, or a resolved address that is not a
///   plausible end-client address ([`is_shared_or_local_address`]). The last
///   case is a reverse proxy on the same host or network that Core was not told
///   to trust (nginx, Caddy or a user-run tunnel on loopback, a LAN proxy): every
///   visitor would arrive from that one address, so a per-client bucket keyed on
///   it would let one visitor exhaust the bound for all of them.
///
/// Each hash is `SHA-256` over a domain tag, the plugin id and the value, so two
/// apps cannot correlate one visitor and no app receives the raw address.
pub(super) fn rate_subject_for(
    plugin_id: &str,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    client_ip: Option<std::net::IpAddr>,
) -> String {
    let (kind, value) = if let Some(caller) = caller {
        ("user", caller.user_id.clone())
    } else if let Some(ip) = client_ip
        .map(|ip| ip.to_canonical())
        .filter(|ip| !is_shared_or_local_address(*ip))
    {
        let network = match ip {
            std::net::IpAddr::V4(v4) => v4.to_string(),
            std::net::IpAddr::V6(v6) => {
                let segments = v6.segments();
                format!(
                    "{:x}:{:x}:{:x}:{:x}::/64",
                    segments[0], segments[1], segments[2], segments[3]
                )
            }
        };
        ("peer", network)
    } else {
        return "unknown".to_owned();
    };
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"ryu-caller-rate-subject-v1\0");
    hasher.update(plugin_id.as_bytes());
    hasher.update([0]);
    hasher.update(kind.as_bytes());
    hasher.update([0]);
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    format!("{kind}:{}", hex::encode(&digest[..12]))
}

/// Whether `ip` is a loopback, unspecified, private (RFC 1918 / ULA),
/// link-local, shared carrier-grade NAT (RFC 6598) or broadcast address. Such an
/// address is not a distinct public client: it is Core's own host, a proxy on the
/// same host or network, or a NAT that many clients share. `ip` must already be
/// canonical (IPv4-mapped IPv6 unwrapped).
pub(super) fn is_shared_or_local_address(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let [first, second, ..] = v4.octets();
            v4.is_loopback()
                || v4.is_unspecified()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                // 100.64.0.0/10, shared address space for carrier-grade NAT.
                || (first == 100 && (second & 0b1100_0000) == 64)
        }
        std::net::IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                // fc00::/7, unique local addresses.
                || (first & 0xfe00) == 0xfc00
                // fe80::/10, link-local unicast.
                || (first & 0xffc0) == 0xfe80
        }
    }
}

/// The client address of an inbound proxy request, resolved the same way the
/// vault's CIDR binding does ([`crate::vault::tokens::resolve_client_ip`]).
pub(super) fn request_client_ip(req: &Request) -> Option<std::net::IpAddr> {
    let peer = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip());
    let forwarded = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok());
    crate::vault::tokens::resolve_client_ip(
        peer,
        forwarded,
        &crate::vault::tokens::trusted_proxies(),
        crate::sidecar::forwarding_tunnel_active(),
    )
}

/// Upper bound for the `x-ryu-caller-resource-ids` header. Sized well inside the
/// default HTTP/1 header buffer of a hyper/axum sidecar (~408 KiB) while holding
/// several thousand UUID conversation ids.
pub(super) const MAX_CALLER_RESOURCE_IDS_BYTES: usize = 256 * 1024;

/// Encode the caller's authorized resource ids as a JSON array no longer than
/// `max_bytes`. `ids` must arrive in priority order (newest first): when the full
/// set does not fit, the tail is dropped and its length is returned, so the
/// sidecar sees FEWER ids than the caller may read, never more. Fails closed
/// without refusing every request of a caller who can see many resources.
pub(super) fn encode_caller_resource_ids<'a>(
    ids: impl Iterator<Item = &'a str>,
    max_bytes: usize,
) -> (String, usize) {
    let mut encoded = String::from("[");
    let mut omitted = 0usize;
    for id in ids {
        if omitted > 0 {
            omitted += 1;
            continue;
        }
        let quoted = ascii_json_string(id);
        let separator = usize::from(encoded.len() > 1);
        // +1 for the closing bracket.
        if encoded.len() + separator + quoted.len() + 1 > max_bytes {
            omitted += 1;
            continue;
        }
        if separator == 1 {
            encoded.push(',');
        }
        encoded.push_str(&quoted);
    }
    encoded.push(']');
    (encoded, omitted)
}

/// A JSON string literal that is pure printable ASCII, so it is always a valid
/// header value: control and non-ASCII characters become `\uXXXX` escapes
/// (surrogate pairs above the BMP), which any JSON parser decodes back exactly.
pub(super) fn ascii_json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            ' '..='~' => out.push(character),
            _ => {
                let mut units = [0u16; 2];
                for unit in character.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
    }
    out.push('"');
    out
}

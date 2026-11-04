//! App catalog browse, install-from-URL and hot reload: `screen_guarded_hostname` through `strip_unattested_url_backend`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// SSRF host-name guard applied inside every resolve path so all callers
/// benefit. Returns `Err(reason)` when the host must be rejected. Rejects:
/// - cloud-metadata hostnames (`metadata.google.internal`, `metadata.goog`,
///   and bare `metadata`), case-insensitive, exact or domain-suffix match;
/// - hostile / homograph hosts: any non-ASCII character (covers unicode
///   homographs, zero-width joiners, and bidi-control code points), any
///   embedded control character or whitespace, or a domain that fails to
///   round-trip through IDNA/punycode (decode mismatch).
///
/// IP literals are passed through (they are screened by [`is_blocked_ip`]
/// after resolution); only domain names get the IDNA round-trip.
pub(in crate::server) fn screen_guarded_hostname(host: &str) -> Result<(), String> {
    if host.is_empty() {
        return Err("host is empty".to_owned());
    }
    // Control characters or whitespace anywhere in the host are illegal. This
    // also rejects leading/trailing whitespace and embedded newlines (checked
    // on the raw input, before any trimming, so a trailing `\n` cannot slip
    // through).
    if host.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("host contains control or whitespace characters".to_owned());
    }
    // Non-ASCII covers unicode homographs, zero-width joiners, and bidi marks.
    if !host.is_ascii() {
        return Err("non-ASCII host is not allowed".to_owned());
    }
    // Strip a single trailing dot (absolute FQDN form) for the remaining
    // checks so `example.com.` is treated like `example.com`.
    let bare = host.strip_suffix('.').unwrap_or(host);
    let lower = bare.to_ascii_lowercase();
    // Cloud-metadata hostname denylist (the IP form is screened separately).
    let is_metadata = lower == "metadata"
        || BLOCKED_METADATA_HOSTS
            .iter()
            .any(|deny| lower == *deny || lower.ends_with(&format!(".{deny}")));
    if is_metadata {
        return Err("cloud metadata host is not allowed".to_owned());
    }
    // IP literals (bracketed IPv6 from `host_str`, bare IPv4/IPv6 from clone
    // parsing) are handled by `is_blocked_ip` after resolution; don't run the
    // IDNA round-trip on them.
    let unbracketed = lower.trim_start_matches('[').trim_end_matches(']');
    if unbracketed.parse::<std::net::IpAddr>().is_ok() {
        return Ok(());
    }
    // IDNA round-trip: an ASCII domain must parse + re-serialize unchanged. A
    // host that decodes to a different value (malformed/ambiguous punycode) is
    // rejected.
    match url::Host::parse(bare) {
        Ok(parsed) if parsed.to_string().eq_ignore_ascii_case(bare) => Ok(()),
        Ok(_) => Err("host failed IDNA round-trip".to_owned()),
        Err(e) => Err(format!("invalid host: {e}")),
    }
}

/// Remove an inline node backend (`backend_code` + `backend_sha256`) from a
/// manifest fetched by URL. The URL path carries no signature Core can verify, so
/// it reuses the marketplace's unsigned-item gate
/// ([`crate::catalog_source::sources::gate_plugin_backend_code`]) with
/// `signed = false`. Manifests without an inline backend are returned verbatim.
pub(in crate::server) fn strip_unattested_url_backend(
    manifest_json: &str,
) -> Result<String, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(manifest_json).map_err(|e| format!("Invalid manifest JSON: {e}"))?;
    let carries_backend = value
        .as_object()
        .is_some_and(|obj| obj.contains_key("backend_code") || obj.contains_key("backend_sha256"));
    if !carries_backend {
        return Ok(manifest_json.to_owned());
    }
    let id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    crate::catalog_source::sources::gate_plugin_backend_code(&id, &mut value, false);
    serde_json::to_string_pretty(&value).map_err(|e| format!("Failed to re-encode manifest: {e}"))
}

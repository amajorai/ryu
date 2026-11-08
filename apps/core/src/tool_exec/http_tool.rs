//! The governed `http` plugin-tool runner.
//!
//! Split out of `tool_exec/mod.rs`; items are re-exported there, so
//! `crate::tool_exec::*` paths are unchanged.

use super::*;

/// Variant of [`run_http_tool_with_agent`] that carries the server-derived
/// user/node/team/org context needed for `secret:NAME` references. The context
/// is only used during this call and is never placed in the model-visible args.
#[allow(clippy::too_many_arguments)]
pub async fn run_http_tool_with_secret_context(
    url: &str,
    method: &str,
    args: Value,
    header_params: &[String],
    secret_headers: &std::collections::BTreeMap<String, String>,
    fail_open: bool,
    unwrap_body: bool,
    body_defaults: &Value,
    grants: &std::collections::HashSet<String>,
    profile_ids: &[String],
    agent_id: &str,
    session_id: Option<&str>,
    audit_agent_id: Option<&str>,
    secret_context: Option<&crate::plugin_secrets::SecretResolutionContext>,
) -> Result<Value, String> {
    // 0. Lower the REST args onto the request BEFORE any guard, so the egress /
    //    SSRF checks below run on the FINAL host (path params can appear before
    //    the host in a templated base, and query/body partitioning is settled here).
    let method_upper = method.to_ascii_uppercase();
    let m = reqwest::Method::from_bytes(method_upper.as_bytes())
        .map_err(|_| format!("http tool: invalid method '{method}'"))?;
    let bodyless = matches!(m, reqwest::Method::GET | reqwest::Method::HEAD);
    // Expand `core:` to this profile's loopback origin BEFORE the egress/SSRF
    // guards, so they screen the URL that is actually dialled.
    let url = resolve_core_url(url);
    // Secret headers are deliberately omitted from this first lowering pass. The
    // URL, query, and body do not depend on them, and this lets the cheap egress /
    // SSRF / gateway gates run before Core decrypts any user-managed value.
    let (final_url, query_pairs, mut body, ordinary_headers) =
        build_rest_request(&url, &args, bodyless, header_params, &[])?;

    let is_local_core = node_token_target_is_local_core(&final_url);
    if !secret_headers.is_empty() {
        let scheme = reqwest::Url::parse(&final_url)
            .map_err(|error| format!("http tool: invalid secret-header URL: {error}"))?
            .scheme()
            .to_owned();
        let local_core_node_token =
            is_local_core && secret_headers_use_only_node_token(secret_headers);
        if scheme != "https" && !local_core_node_token {
            return Err("http tool: secret headers require an HTTPS destination".to_owned());
        }
    }

    let uses_node_token = secret_headers.values().any(|source| {
        source
            .split_whitespace()
            .any(|word| word == "env:RYU_TOKEN")
    });
    if uses_node_token && !is_local_core {
        return Err(
            "http tool: the Core node token may only authenticate loopback Core destinations"
                .to_owned(),
        );
    }

    // 0c. Apply the manifest's static `body_defaults` UNDER the model-provided body
    //     (model args win; nested objects merge key-by-key). This is a declarative,
    //     tool-agnostic default+nesting seam — e.g. exa's num_results/use_autoprompt
    //     defaults and its `contents:{text:true}` nesting — that the generic verbatim
    //     forwarding otherwise dropped. `Null` (the default) is a no-op; for bodyless
    //     methods `body` is `Null` and stays `Null` (defaults do not become query).
    if body_defaults.is_object() && !bodyless {
        let mut merged = body_defaults.clone();
        deep_merge_json(&mut merged, &body);
        body = merged;
    }

    // 1. Egress-grant check FIRST (deterministic refusal, before any I/O).
    let domain = http_egress_domain(&final_url)
        .ok_or_else(|| format!("http tool: could not parse a host from url '{final_url}'"))?;
    let needed = format!("{GRANT_HTTP_EGRESS_PREFIX}{domain}");
    let wildcard = format!("{GRANT_HTTP_EGRESS_PREFIX}*");
    if !(grants.contains(&needed) || grants.contains(&wildcard)) {
        return Err(format!(
            "http egress to '{domain}' is not granted (needs '{needed}')"
        ));
    }

    // 1b. SSRF guard: the granted domain must not be — or resolve to — an internal
    //     address, unless it was explicitly granted as one. Blocks the metadata /
    //     loopback / LAN sinks a public-domain grant could otherwise reach via DNS.
    //     Returns the exact addresses to PIN the request to so reqwest cannot
    //     re-resolve DNS to a different (internal) address at send() — closing the
    //     DNS-rebinding TOCTOU window (see `http_ssrf_guard`).
    let ssrf_pin = http_ssrf_guard(&final_url, &domain).await?;

    // 2. Gateway governance: fail-closed budget + opt-in firewall/DLP scan.
    use crate::sidecar::gateway::{
        check_exec_budget, check_exec_scan, report_exec_audit_with_attribution,
        ExecAuditAttribution, ExecBudgetOutcome, ExecScanOutcome,
    };
    let audit_attribution = ExecAuditAttribution {
        agent_id: audit_agent_id.map(str::to_owned),
        feature: Some("agent".to_owned()),
        ..Default::default()
    };
    let backend = "tool_http";
    if let ExecBudgetOutcome::Deny(reason) = check_exec_budget(backend, "tool_http").await {
        return Err(format!("gateway denied http egress: {reason}"));
    }
    // Scan the method + final URL + body. Header VALUES (auth tokens injected by
    // the identity vault) are deliberately excluded so a secret never lands in the
    // firewall/DLP scan or audit trail.
    let scan_content = format!("{method_upper} {final_url}\n{body}");
    match check_exec_scan(backend, &scan_content, session_id, Some(agent_id)).await {
        ExecScanOutcome::Allow => {}
        ExecScanOutcome::Deny(reason) | ExecScanOutcome::ApprovalRequired(reason) => {
            report_exec_audit_with_attribution(
                backend,
                "tool_http",
                0,
                1,
                session_id.map(str::to_owned),
                Some(format!("scan denied: {reason}")),
                audit_attribution.clone(),
            )
            .await;
            return Err(format!("gateway denied http egress: {reason}"));
        }
    }

    // Remote identity mode consumes vault state inside Passport. Other secret
    // sources retain the owning plugin's existing resolution rules; structured
    // parts ensure their values cannot become new vault references.
    let uses_vault = secret_headers.values().any(|source| {
        source
            .split_whitespace()
            .any(|word| word.starts_with("vault:"))
    });
    if uses_vault && std::env::var_os("RYU_PASSPORT_URL").is_some() {
        let base = std::env::var("RYU_PASSPORT_URL")
            .map_err(|_| "Invalid Passport URL configuration".to_owned())?;
        let calling_agent = audit_agent_id.ok_or_else(|| {
            "Passport HTTP execution requires the calling agent identity".to_owned()
        })?;
        let mut templates = BTreeMap::new();
        for (name, source) in secret_headers {
            let mut parts = Vec::new();
            let mut saw_token = false;
            let mut absent = false;
            for part in source.split_inclusive(char::is_whitespace) {
                use ryu_vault::passport::HeaderPart;
                let word = part.trim_end_matches(char::is_whitespace);
                if let Some(domain) = word.strip_prefix("vault:") {
                    parts.push(HeaderPart::Vault(domain.to_owned()));
                    saw_token = true;
                } else {
                    match resolve_secret_token(
                        word,
                        agent_id,
                        profile_ids,
                        session_id,
                        secret_context,
                    )
                    .await
                    {
                        SecretToken::Literal => parts.push(HeaderPart::Literal(word.to_owned())),
                        SecretToken::Value(value) => {
                            parts.push(HeaderPart::Sensitive(value));
                            saw_token = true;
                        }
                        SecretToken::Absent => {
                            absent = true;
                            break;
                        }
                    }
                }
                let whitespace = &part[word.len()..];
                if !whitespace.is_empty() {
                    parts.push(HeaderPart::Literal(whitespace.to_owned()));
                }
            }
            if absent {
                continue;
            }
            if !saw_token {
                return Err("Passport HTTP header requires a secret source".to_owned());
            }
            templates.insert(name.clone(), parts);
        }
        let mut target =
            url::Url::parse(&final_url).map_err(|_| "Invalid Passport HTTP target".to_owned())?;
        if bodyless && !query_pairs.is_empty() {
            target.query_pairs_mut().extend_pairs(&query_pairs);
        }
        let started = std::time::Instant::now();
        let response = crate::identity::passport::execute_http(
            &base,
            calling_agent,
            profile_ids,
            crate::identity::passport::HttpRequest {
                url: target.to_string(),
                method: method_upper.clone(),
                headers: ordinary_headers.into_iter().collect(),
                credential_headers: BTreeMap::new(),
                header_templates: Some(templates),
                body: (!bodyless).then_some(body),
            },
            session_id.map(str::to_owned),
        )
        .await;
        let (result, exit_code, audit_err) = match response {
            Ok(response) => {
                target.set_query(None);
                target.set_fragment(None);
                let payment = if response.status == 402 {
                    crate::payment::PaymentRequiredEnvelope::from_http_headers(
                        response.payment_challenges.iter().map(String::as_str),
                        serde_json::json!({"kind":"http_tool","method":method_upper,"url":target.as_str()}),
                    )
                } else {
                    None
                };
                if let Some(envelope) = payment {
                    (
                        Ok(envelope.into_value()),
                        2,
                        Some("MPP payment required".to_owned()),
                    )
                } else {
                    finalize_http_result(
                        fail_open,
                        unwrap_body,
                        Some(response.status),
                        response.body,
                        None,
                    )
                }
            }
            Err(error) => finalize_http_result(
                fail_open,
                unwrap_body,
                None,
                Value::Null,
                Some(error.to_string()),
            ),
        };
        report_exec_audit_with_attribution(
            backend,
            "tool_http",
            started.elapsed().as_millis() as u64,
            exit_code,
            session_id.map(str::to_owned),
            audit_err,
            audit_attribution,
        )
        .await;
        return result;
    }

    // 2b. Resolve server-side SECRET headers only after the destination and
    // governance gates pass. Each source (`env:` / `vault:` / `secret:`) resolves
    // to a concrete value or "absent" (header omitted). Secret VALUES never enter
    // the args map, so they never reach the path/query/body, model-visible schema,
    // firewall/DLP scan, or audit trail.
    //
    // The `env:` arm is scoped to what the OWNING PLUGIN may read (`agent_id` is
    // the owning plugin id at this seam — see `resolve_app_tool_backend`), so a
    // disk manifest cannot name an unrelated credential var.
    let mut resolved_secret_headers: Vec<(String, String)> = Vec::new();
    for (name, source) in secret_headers {
        if let Some(value) = resolve_secret_header_source_with_context(
            name,
            source,
            agent_id,
            profile_ids,
            session_id,
            secret_context,
        )
        .await?
        {
            resolved_secret_headers.push((name.clone(), value));
        }
    }
    // Lower the same args a second time to attach the now-resolved headers. The
    // first pass already established the final URL/query/body, so only this
    // metadata-free header projection is used below.
    let (_, _, _, headers) = build_rest_request(
        &url,
        &args,
        bodyless,
        header_params,
        &resolved_secret_headers,
    )?;
    let resolved_secret_values: Vec<String> = resolved_secret_headers
        .iter()
        .map(|(_, value)| value.clone())
        .collect();

    // The calling agent of an app request is Core-owned. When a tool calls the
    // local Core ext-proxy, stamp the dispatcher-selected agent with an HMAC
    // tied to the exact request actually sent (see `sign_agent_lane_request`).
    // The proxy refuses a named agent without it, and forwards the app a grant
    // it hands back on managed provider calls (Treg), so the agent's account
    // access applies there too.
    let lane_agent = audit_agent_id.filter(|_| targets_local_ext_proxy(&final_url));

    // 3. Perform the request. Body is the tool args as JSON for methods that carry
    //    one; GET/HEAD send none. Response is `{ status, body }` (JSON if parseable).
    let started = std::time::Instant::now();
    // Redirects DISABLED: a 3xx is returned to the caller as-is. Following it would
    // re-issue the request to the `Location` host WITHOUT re-running the egress-grant
    // + SSRF checks above — the classic allowlist bypass (granted public domain →
    // 302 → 127.0.0.1 / 169.254.169.254). The guarded first hop is the only hop.
    let client = guarded_http_client(ssrf_pin.as_ref())?;
    let mut req = client
        .request(m.clone(), &final_url)
        .timeout(std::time::Duration::from_secs(30));
    for (name, value) in &headers {
        // Invalid header name/value surfaces as a request error at `.send()`.
        req = req.header(name, value);
    }
    if bodyless {
        if !query_pairs.is_empty() {
            req = req.query(&query_pairs);
        }
    } else {
        req = req.json(&body);
    }
    let sent = match req.build() {
        Ok(mut request) => {
            sign_agent_lane_request(&mut request, lane_agent);
            client.execute(request).await
        }
        Err(error) => Err(error),
    };
    let (result, exit_code, audit_err) = match sent {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if status == reqwest::StatusCode::PAYMENT_REQUIRED.as_u16() {
                let challenge_headers: Vec<String> = resp
                    .headers()
                    .get_all(reqwest::header::WWW_AUTHENTICATE)
                    .iter()
                    .filter_map(|value| value.to_str().ok().map(str::to_owned))
                    .collect();
                let redacted_url = url::Url::parse(&final_url)
                    .map(|mut url| {
                        url.set_query(None);
                        url.set_fragment(None);
                        url.to_string()
                    })
                    .unwrap_or_else(|_| "redacted".to_owned());
                if let Some(envelope) = crate::payment::PaymentRequiredEnvelope::from_http_headers(
                    challenge_headers.iter().map(String::as_str),
                    serde_json::json!({
                        "kind": "http_tool",
                        "method": method_upper,
                        "url": redacted_url,
                    }),
                ) {
                    (
                        Ok(envelope.into_value()),
                        2,
                        Some("MPP payment required".to_owned()),
                    )
                } else {
                    match read_http_response_text_capped(resp).await {
                        Ok(text) => {
                            let body: Value =
                                serde_json::from_str(&text).unwrap_or(Value::String(text));
                            finalize_http_result_with_secrets(
                                fail_open,
                                unwrap_body,
                                Some(status),
                                body,
                                None,
                                &resolved_secret_values,
                            )
                        }
                        Err(error) => finalize_http_result_with_secrets(
                            fail_open,
                            unwrap_body,
                            Some(status),
                            Value::Null,
                            Some(error),
                            &resolved_secret_values,
                        ),
                    }
                }
            } else {
                match read_http_response_text_capped(resp).await {
                    Ok(text) => {
                        let body: Value =
                            serde_json::from_str(&text).unwrap_or(Value::String(text));
                        finalize_http_result_with_secrets(
                            fail_open,
                            unwrap_body,
                            Some(status),
                            body,
                            None,
                            &resolved_secret_values,
                        )
                    }
                    Err(error) => finalize_http_result_with_secrets(
                        fail_open,
                        unwrap_body,
                        Some(status),
                        Value::Null,
                        Some(error),
                        &resolved_secret_values,
                    ),
                }
            }
        }
        Err(e) => finalize_http_result(
            fail_open,
            unwrap_body,
            None,
            Value::Null,
            Some(e.to_string()),
        ),
    };
    report_exec_audit_with_attribution(
        backend,
        "tool_http",
        started.elapsed().as_millis() as u64,
        exit_code,
        session_id.map(str::to_owned),
        audit_err,
        audit_attribution,
    )
    .await;
    result
}

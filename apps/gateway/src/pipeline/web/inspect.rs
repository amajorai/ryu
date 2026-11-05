//! Firewall inspection of a web request before egress and of its results
//! before they reach the caller.

use ryu_gw_providers::web::WebSearchRequest;
use serde_json::Value;

use super::super::{sanitize_text_or_survivor, RequestContext};
use super::WebRequest;
use crate::config::FirewallPolicy;
use crate::error::GatewayError;
use crate::policy_alert::PolicyAlert;
use crate::state::AppState;

impl WebRequest {
    pub(super) fn inspect(
        &mut self,
        state: &AppState,
        ctx: &RequestContext,
    ) -> Result<Option<PolicyAlert>, GatewayError> {
        for text in self.screened_texts() {
            super::super::inference_governance::enforce_locked_guardrails(state, ctx, &text)?;
        }
        let scanner = state.resolved_scanner(ctx);
        if ctx.companion_source {
            match self {
                Self::Search(request) => {
                    let (redacted, _) = scanner.redact_companion_egress(request.query());
                    *request = WebSearchRequest::new(redacted, request.limit()).map_err(|_| {
                        GatewayError::BadRequest(
                            "Web query is invalid after privacy inspection".into(),
                        )
                    })?;
                }
                Self::Fetch(request) => {
                    let private = fetch_url_forms(request.url().as_str()).iter().any(|form| {
                        let (redacted, _) = scanner.redact_companion_egress(form);
                        redacted != *form
                    });
                    if private {
                        return Err(GatewayError::FirewallBlocked(
                            "Web URL contains private context".into(),
                            None,
                        ));
                    }
                }
            }
        }
        let hit = self
            .screened_texts()
            .iter()
            .find_map(|text| scanner.scan_inbound(text));
        if let Some(hit) = hit {
            match scanner.policy() {
                FirewallPolicy::Block => {
                    return Err(GatewayError::FirewallBlocked(
                        format!("Web input blocked: {}", hit.pattern_name),
                        super::super::firewall_policy_alert(scanner.config(), ctx, "block"),
                    ))
                }
                FirewallPolicy::Sanitize => match self {
                    Self::Search(request) => {
                        // Fail closed: a match that survives redaction (and
                        // its folded retry) never reaches the search vendor.
                        let sanitized = sanitize_text_or_survivor(
                            request.query(),
                            scanner.as_ref(),
                        )
                        .map_err(|survivor| {
                            GatewayError::FirewallBlocked(
                                format!(
                                    "Web input blocked: {} survived redaction",
                                    survivor.pattern_name
                                ),
                                super::super::firewall_policy_alert(scanner.config(), ctx, "block"),
                            )
                        })?;
                        *request =
                            WebSearchRequest::new(sanitized, request.limit()).map_err(|_| {
                                GatewayError::BadRequest(
                                    "Web query is invalid after input inspection".into(),
                                )
                            })?
                    }
                    Self::Fetch(_) => {
                        return Err(GatewayError::FirewallBlocked(
                            "Web URL contains restricted input".into(),
                            super::super::firewall_policy_alert(scanner.config(), ctx, "block"),
                        ))
                    }
                },
                FirewallPolicy::WarnAndContinue => {
                    return Ok(super::super::firewall_policy_alert(
                        scanner.config(),
                        ctx,
                        "notify",
                    ))
                }
            }
        }
        Ok(None)
    }
}

/// Rounds of `%XX` decoding applied to a fetch URL, so a double-encoded
/// escape (`%2552`) is screened decoded as well.
const URL_DECODE_ROUNDS: usize = 3;

/// A fetch URL as written, then each distinct percent-decoded form. The target
/// site decodes its URL, so an escaped marker (`%52YU...`) or credential must
/// be screened as the site reads it, not only as written.
pub(super) fn fetch_url_forms(url: &str) -> Vec<String> {
    let mut forms = vec![url.to_owned()];
    for _ in 0..URL_DECODE_ROUNDS {
        let last = forms.last().map_or(url, String::as_str);
        match super::super::outbound_text::percent_decoded(last) {
            Some(decoded) if decoded != last => forms.push(decoded),
            _ => break,
        }
    }
    forms
}

/// Screen each result field the caller receives. Under Sanitize a field is
/// redacted, and a match that survives redaction refuses the results.
pub(super) fn inspect_output(
    state: &AppState,
    ctx: &RequestContext,
    output: &mut Value,
) -> Result<(), GatewayError> {
    let scanner = state.resolved_scanner(ctx);
    let Some(results) = output.get_mut("results").and_then(Value::as_array_mut) else {
        return Err(GatewayError::ProviderDeliveryUncertain(
            "Invalid normalized web response".into(),
        ));
    };
    let mut hits = 0usize;
    let mut first_pattern = None;
    for result in results {
        for field in ["title", "snippet", "content", "url"] {
            let Some(text) = result.get(field).and_then(Value::as_str) else {
                continue;
            };
            if let Some(hit) = scanner.scan_outbound(text) {
                match scanner.policy() {
                    FirewallPolicy::Block => {
                        tracing::warn!(
                            request_id = %ctx.request_id,
                            pattern = %hit.pattern_name,
                            "firewall: blocked web output"
                        );
                        return Err(GatewayError::FirewallBlocked(
                            format!("Web output blocked: {}", hit.pattern_name),
                            super::super::firewall_policy_alert(scanner.config(), ctx, "block"),
                        ));
                    }
                    FirewallPolicy::Sanitize => {
                        if field == "url" {
                            tracing::warn!(
                                request_id = %ctx.request_id,
                                pattern = %hit.pattern_name,
                                "firewall: blocked web output"
                            );
                            return Err(GatewayError::FirewallBlocked(
                                "Web result URL contains restricted output".into(),
                                super::super::firewall_policy_alert(scanner.config(), ctx, "block"),
                            ));
                        }
                        // Fail closed, as for the query: a surviving match
                        // refuses the results instead of returning it.
                        let sanitized = sanitize_text_or_survivor(text, scanner.as_ref()).map_err(
                            |survivor| {
                                tracing::warn!(
                                    request_id = %ctx.request_id,
                                    pattern = %survivor.pattern_name,
                                    "firewall: blocked web output"
                                );
                                GatewayError::FirewallBlocked(
                                    format!(
                                        "Web output blocked: {} survived redaction",
                                        survivor.pattern_name
                                    ),
                                    super::super::firewall_policy_alert(
                                        scanner.config(),
                                        ctx,
                                        "block",
                                    ),
                                )
                            },
                        )?;
                        result[field] = Value::String(sanitized);
                    }
                    FirewallPolicy::WarnAndContinue => {}
                }
                hits += 1;
                first_pattern.get_or_insert(hit.pattern_name);
            }
        }
    }
    if let Some(pattern) = first_pattern {
        detection_log!(
            scanner.config().log_detections,
            request_id = %ctx.request_id,
            hits,
            pattern = %pattern,
            "firewall: outbound web results matched"
        );
    }
    Ok(())
}

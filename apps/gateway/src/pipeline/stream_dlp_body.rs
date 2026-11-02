//! The streaming driver around [`StreamingDlp`]: pulls provider chunks,
//! releases scanned frames, and reports, counts and audits violations.

use super::{DlpOutput, StreamingDlp, MAX_HELD_BYTES, OVERSIZED};
use crate::config::FirewallPolicy;

/// Stream `upstream` to the client through [`StreamingDlp`], logging, counting
/// and auditing violations the way the buffered path does. `scanner` is the
/// tenant-resolved scanner for `ctx` (`AppState::resolved_scanner`), never the
/// node base, and `policy` / `enforce` / `outbound_enabled` are read from it:
/// `enforce` is whether `Block` / `Sanitize` apply; `outbound_enabled` gates the
/// warn-only log.
pub(in crate::pipeline) fn dlp_body(
    upstream: axum::body::Body,
    state: std::sync::Arc<crate::state::AppState>,
    ctx: super::super::RequestContext,
    scanner: std::sync::Arc<crate::firewall::FirewallScanner>,
    policy: FirewallPolicy,
    enforce: bool,
    outbound_enabled: bool,
) -> axum::body::Body {
    use futures_util::StreamExt;

    struct Driver {
        upstream: axum::body::BodyDataStream,
        dlp: StreamingDlp,
        state: std::sync::Arc<crate::state::AppState>,
        ctx: super::super::RequestContext,
        scanner: std::sync::Arc<crate::firewall::FirewallScanner>,
        request_id: String,
        policy: FirewallPolicy,
        enforce: bool,
        outbound_enabled: bool,
        done: bool,
        /// The upstream returned `None`. It is an `Unfold` (the usage
        /// observer), which panics if polled again, so it is never drained
        /// after this.
        upstream_ended: bool,
    }

    impl Driver {
        fn report(&self, output: &DlpOutput) {
            let Some(found) = output.violation.as_ref() else {
                return;
            };
            let pattern = &found.pattern_name;
            match self.policy {
                FirewallPolicy::Block if self.enforce => {
                    tracing::warn!(request_id = %self.request_id, pattern = %pattern, "firewall: blocked outbound response (streaming)");
                    self.state.metrics.inc_firewall_blocked();
                    if output.blocked {
                        super::super::audit_stream_dlp_block(
                            &self.state,
                            &self.ctx,
                            pattern,
                            &format!("{:?}", found.kind),
                        );
                    }
                }
                // A Sanitize stream ends blocked only when a match survives
                // redaction; count and audit it like a Block.
                FirewallPolicy::Sanitize if self.enforce && output.blocked => {
                    tracing::warn!(request_id = %self.request_id, pattern = %pattern, "firewall: outbound match survived Sanitize; blocked (streaming)");
                    self.state.metrics.inc_firewall_blocked();
                    super::super::audit_stream_dlp_block(
                        &self.state,
                        &self.ctx,
                        pattern,
                        &format!("{:?}", found.kind),
                    );
                }
                FirewallPolicy::Sanitize if self.enforce => {
                    tracing::warn!(request_id = %self.request_id, pattern = %pattern, "firewall: sanitized outbound response (streaming)");
                }
                FirewallPolicy::WarnAndContinue if self.outbound_enabled => {
                    tracing::warn!(request_id = %self.request_id, pattern = %pattern, "firewall: outbound violation (warn-and-continue, streaming)");
                }
                _ => {}
            }
        }

        fn refuse(&mut self, message: &str) -> bytes::Bytes {
            self.done = true;
            self.state.metrics.inc_firewall_blocked();
            bytes::Bytes::from(super::super::sse_content_frames(message))
        }
    }

    let driver = Driver {
        upstream: upstream.into_data_stream(),
        dlp: StreamingDlp::new(policy.clone(), enforce),
        state,
        request_id: ctx.request_id.clone(),
        ctx,
        scanner,
        policy,
        enforce,
        outbound_enabled,
        done: false,
        upstream_ended: false,
    };

    let stream = futures_util::stream::unfold(driver, |mut driver| async move {
        // Loop until there is something to send: an empty chunk is never yielded.
        while !driver.done {
            let step = match driver.upstream.next().await {
                Some(Ok(chunk)) => driver.dlp.push(&chunk, driver.scanner.as_ref()),
                Some(Err(error)) => {
                    tracing::warn!(request_id = %driver.request_id, %error, "firewall: provider stream failed during outbound scan");
                    let refused = driver.refuse(
                        "[Ryu firewall] Unable to scan the response stream; request aborted.",
                    );
                    return Some((Ok::<_, std::io::Error>(refused), driver));
                }
                None => {
                    driver.done = true;
                    driver.upstream_ended = true;
                    driver.dlp.finish(driver.scanner.as_ref())
                }
            };
            match step {
                Ok(output) => {
                    driver.report(&output);
                    if output.blocked && !driver.upstream_ended {
                        // The usage observer wraps the original provider body.
                        // Drain it without releasing bytes so its final usage
                        // frame still settles the request once. The caller's
                        // admission permit remains held until this completes.
                        // A block decided in `finish` has nothing left to drain:
                        // the upstream already ended and settled its usage.
                        let drain = async {
                            let mut bytes = 0usize;
                            while let Some(chunk) = driver.upstream.next().await {
                                match chunk {
                                    Ok(chunk) => bytes += chunk.len(),
                                    Err(_) => break,
                                }
                                if bytes > MAX_HELD_BYTES {
                                    break;
                                }
                            }
                        };
                        if tokio::time::timeout(std::time::Duration::from_secs(300), drain)
                            .await
                            .is_err()
                        {
                            tracing::warn!(request_id = %driver.request_id, "firewall: timed out draining blocked provider stream for usage");
                        }
                        driver.done = true;
                    }
                    if !output.bytes.is_empty() {
                        return Some((Ok(bytes::Bytes::from(output.bytes)), driver));
                    }
                }
                Err(error) if error == OVERSIZED => {
                    tracing::warn!(request_id = %driver.request_id, %error, "firewall: failed to buffer stream for outbound scan");
                    let refused = driver.refuse(
                        "[Ryu firewall] Unable to scan the response stream; request aborted.",
                    );
                    return Some((Ok(refused), driver));
                }
                Err(error) => {
                    tracing::warn!(request_id = %driver.request_id, %error, "firewall: unscannable response stream");
                    let refused = driver.refuse(
                        "[Ryu firewall] Response blocked because the provider stream could not be scanned.",
                    );
                    return Some((Ok(refused), driver));
                }
            }
        }
        None
    });
    axum::body::Body::from_stream(stream)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::config::{FirewallConfig, GatewayConfig};
    use crate::state::AppState;

    async fn drive(policy: FirewallPolicy, parts: &[&str]) -> String {
        let config = GatewayConfig {
            firewall: FirewallConfig {
                policy: policy.clone(),
                ..FirewallConfig::default()
            },
            ..GatewayConfig::default()
        };
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit");
        let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
        let state = Arc::new(AppState::new_for_test(config, audit, evals));
        let ctx = crate::pipeline::test_support::plain_request_context();
        let scanner = state.resolved_scanner(&ctx);
        let mut raw = String::new();
        for part in parts {
            let frame =
                serde_json::json!({ "choices": [{ "index": 0, "delta": { "content": part } }] });
            raw.push_str(&format!("data: {frame}\n\n"));
        }
        raw.push_str("data: [DONE]\n\n");
        let body = dlp_body(raw.into(), state, ctx, scanner, policy, true, true);
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn sanitize_masks_a_fold_only_address_split_across_deltas() {
        let out = drive(
            FirewallPolicy::Sanitize,
            &["mail alice\u{FF20}exa", "mple.com today. ", "Bye. "],
        )
        .await;
        assert!(!out.contains("alice") && !out.contains("mple.com"), "{out}");
        assert!(out.ends_with("data: [DONE]\n\n"));
    }

    #[tokio::test]
    async fn block_replaces_the_stream_with_the_notice() {
        let out = drive(
            FirewallPolicy::Block,
            &["key sk-abcdefghijklmnopqrstuvwxyz0123 ", "ok. "],
        )
        .await;
        assert!(!out.contains("sk-abcdefghijklmnopqrstuvwxyz0123"), "{out}");
        assert!(out.contains("Response blocked by policy"), "{out}");
    }
}

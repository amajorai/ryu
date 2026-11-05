//! Drives [`StreamingDlp`] over a provider body: logging, counting and
//! auditing violations, refusing unscannable streams, and draining a blocked
//! upstream so its usage still settles.

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
        /// The Sanitize match let through so far. Its line is logged when
        /// the stream ends unblocked (`Drop`): a survivor that blocks a
        /// later step logs only the block, one line per decision.
        sanitized: Option<String>,
    }

    impl Drop for Driver {
        fn drop(&mut self) {
            if let Some(pattern) = self.sanitized.take() {
                self.log_let_through(&pattern);
            }
        }
    }

    impl Driver {
        fn report(&mut self, output: &DlpOutput) {
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
                    self.sanitized = None;
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
                    self.sanitized.get_or_insert_with(|| pattern.clone());
                }
                FirewallPolicy::WarnAndContinue if self.outbound_enabled => {
                    self.log_let_through(pattern);
                }
                _ => {}
            }
        }

        fn log_let_through(&self, pattern: &str) {
            crate::pipeline::outbound_detection::log_let_through(
                self.scanner.config().log_detections,
                &self.request_id,
                pattern,
                &self.policy,
                true,
            );
        }

        /// End the stream with `message`. `count` only for a firewall
        /// verdict: a provider failure or the size cap is not a block, as on
        /// the buffered path. After released text the notice starts on its
        /// own paragraph, as a block notice does.
        fn refuse(&mut self, message: &str, count: bool) -> bytes::Bytes {
            self.done = true;
            if count {
                // A block: the stream is never logged as sanitized.
                self.sanitized = None;
                self.state.metrics.inc_firewall_blocked();
            }
            let text = if self.dlp.released_any {
                format!("\n\n{message}")
            } else {
                message.to_owned()
            };
            bytes::Bytes::from(super::super::sse_content_frames(&text))
        }

        /// Read the rest of the provider body without releasing it, so its
        /// usage frame still settles the request (as a block does).
        async fn drain(&mut self) {
            if self.upstream_ended {
                return;
            }
            let drain = async {
                let mut bytes = 0usize;
                while let Some(chunk) = self.upstream.next().await {
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
                tracing::warn!(request_id = %self.request_id, "firewall: timed out draining refused provider stream for usage");
            }
            self.upstream_ended = true;
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
        sanitized: None,
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
                        false,
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
                        false,
                    );
                    return Some((Ok(refused), driver));
                }
                Err(error) => {
                    tracing::warn!(request_id = %driver.request_id, %error, "firewall: unscannable response stream");
                    driver.drain().await;
                    let refused = driver.refuse(
                        "[Ryu firewall] Response blocked because the provider stream could not be scanned.",
                        true,
                    );
                    return Some((Ok(refused), driver));
                }
            }
        }
        None
    });
    axum::body::Body::from_stream(stream)
}

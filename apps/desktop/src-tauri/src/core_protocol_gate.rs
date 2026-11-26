//! Checks a Ryu Core that is already running before the desktop adopts it.
//!
//! The desktop used to adopt whatever answered `/api/health` on its Core port,
//! so after an app update an old Core kept serving until something restarted
//! it. The desktop now reads the protocol range the running Core reports
//! (`ryu-protocol`) and picks the highest number both sides speak:
//!
//! - a shared protocol: adopt the running Core;
//! - no shared protocol, the running Core is the outdated side and this app
//!   started it: stop it, so the bundled Core starts in its place;
//! - no shared protocol otherwise (a Core someone else runs, or a Core newer
//!   than this app): leave it running. The webview reads the same range from
//!   `/api/health` and shows which side to update.
//!
//! A Core too old to report a range counts as protocol 0, which this release
//! still accepts, so an app update never locks a user out of their node.

use std::time::Duration;

use ryu_protocol::{negotiate, NoSharedProtocol, ProtocolRange, UpdateSide};

use crate::core::process::RyuCoreProcess;

/// What the desktop does about the Core on this profile's port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Admission {
    /// Nothing answers. The desktop starts the bundled Core.
    NotRunning,
    /// The running Core shares a protocol with this app. The desktop adopts it.
    Adopt { protocol: u32 },
    /// The running Core is too old for this app and this app started it. It is
    /// stopped and the bundled Core starts in its place.
    ReplaceOwned(NoSharedProtocol),
    /// No shared protocol, and the Core is not this app's to replace: someone
    /// else runs it, or it is newer than this app and replacing it would run
    /// an older Core on data a newer one has written.
    LeaveRunning(NoSharedProtocol),
}

/// Decide for this build's accepted range. `running` is `None` when nothing
/// answers on the Core port.
pub(crate) fn decide(running: Option<ProtocolRange>, owned: bool) -> Admission {
    decide_for(ProtocolRange::CLIENT_ACCEPTS, running, owned)
}

fn decide_for(accepted: ProtocolRange, running: Option<ProtocolRange>, owned: bool) -> Admission {
    let Some(running) = running else {
        return Admission::NotRunning;
    };
    match negotiate(accepted, running) {
        Ok(protocol) => Admission::Adopt { protocol },
        Err(refused) if owned && refused.update == UpdateSide::Remote => {
            Admission::ReplaceOwned(refused)
        }
        Err(refused) => Admission::LeaveRunning(refused),
    }
}

/// The protocol range of the Core answering at `base_url`, or `None` when
/// nothing healthy answers there. A healthy Core whose body carries no usable
/// range predates the protocol number and counts as protocol 0.
async fn probe(base_url: &str) -> Option<ProtocolRange> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    let response = client
        .get(format!("{base_url}/api/health"))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null);
    Some(ProtocolRange::from_health(&body))
}

/// Run the check for this profile's Core port. Call it right before
/// `RyuCoreProcess::start`, which adopts whatever is still healthy afterwards
/// and spawns the bundled Core otherwise.
pub(crate) async fn admit_running_core(process: &mut RyuCoreProcess) -> Admission {
    let running = probe(&crate::profile::core_base_url()).await;
    // Ownership needs a process table scan, so ask only when it can matter.
    let owned = decide(running, true) != decide(running, false) && process.owns_process();
    let admission = decide(running, owned);
    match admission {
        Admission::NotRunning => {}
        Admission::Adopt { protocol } => {
            tracing::info!(
                protocol,
                "the running Ryu Core shares a protocol with this app; adopting it"
            );
        }
        Admission::ReplaceOwned(refused) => {
            tracing::warn!(
                "{}; this app started it, so it is stopped and the bundled Ryu Core starts",
                refused.describe("this app", "the running Ryu Core")
            );
            if let Err(error) = process.stop().await {
                tracing::error!("could not stop the outdated Ryu Core: {error}");
            }
        }
        Admission::LeaveRunning(refused) => {
            tracing::warn!(
                "{}; it is not this app's to replace, so it keeps running",
                refused.describe("this app", "the running Ryu Core")
            );
        }
    }
    admission
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const CURRENT: ProtocolRange = ProtocolRange::CURRENT;
    const LEGACY: ProtocolRange = ProtocolRange::LEGACY;

    #[test]
    fn nothing_running_means_the_bundled_core_starts() {
        assert_eq!(decide(None, false), Admission::NotRunning);
        assert_eq!(decide(None, true), Admission::NotRunning);
    }

    #[test]
    fn a_core_on_a_shared_protocol_is_adopted_whoever_runs_it() {
        for owned in [true, false] {
            assert_eq!(
                decide(Some(CURRENT), owned),
                Admission::Adopt {
                    protocol: ryu_protocol::PROTOCOL_MAX
                }
            );
        }
    }

    #[test]
    fn a_core_too_old_to_report_a_range_is_still_adopted_in_this_release() {
        // The first release with the check must not lock anyone out on update day.
        for owned in [true, false] {
            assert_eq!(
                decide(Some(LEGACY), owned),
                Admission::Adopt {
                    protocol: ryu_protocol::LEGACY_PROTOCOL
                }
            );
        }
    }

    #[test]
    fn an_outdated_core_is_replaced_only_when_this_app_started_it() {
        // A later app that no longer accepts protocol 0.
        let accepted = ProtocolRange::new(1, 2);
        let own = decide_for(accepted, Some(LEGACY), true);
        let Admission::ReplaceOwned(refused) = own else {
            panic!("an owned outdated Core must be replaced, got {own:?}");
        };
        assert_eq!(refused.update, UpdateSide::Remote);

        let foreign = decide_for(accepted, Some(LEGACY), false);
        let Admission::LeaveRunning(refused) = foreign else {
            panic!("a foreign Core must never be stopped, got {foreign:?}");
        };
        assert_eq!(refused.update, UpdateSide::Remote);
        assert_eq!(
            refused.describe("this app", "the running Ryu Core"),
            "no shared protocol: this app speaks protocol 1 to 2, the running Ryu Core speaks protocol 0; update the running Ryu Core"
        );
    }

    #[test]
    fn a_core_newer_than_this_app_is_never_replaced_by_an_older_one() {
        let newer = ProtocolRange::new(
            ryu_protocol::PROTOCOL_MAX + 1,
            ryu_protocol::PROTOCOL_MAX + 2,
        );
        for owned in [true, false] {
            let admission = decide(Some(newer), owned);
            let Admission::LeaveRunning(refused) = admission else {
                panic!("a newer Core must be left running, got {admission:?}");
            };
            assert_eq!(refused.update, UpdateSide::Local);
            assert!(refused
                .describe("this app", "the running Ryu Core")
                .ends_with("update this app"));
        }
    }

    /// Serve one canned HTTP response on a loopback port and return its base URL.
    async fn serve_once(status: &'static str, body: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).await;
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn probe_reads_the_range_a_core_reports() {
        let url = serve_once(
            "200 OK",
            r#"{"status":"ok","version":"9.9.9","protocol":{"min":1,"max":4}}"#,
        )
        .await;
        assert_eq!(probe(&url).await, Some(ProtocolRange::new(1, 4)));
    }

    #[tokio::test]
    async fn probe_counts_a_healthy_core_without_a_range_as_protocol_zero() {
        let old = serve_once("200 OK", r#"{"status":"ok","version":"0.5.0"}"#).await;
        assert_eq!(probe(&old).await, Some(LEGACY));
        let not_json = serve_once("200 OK", "ok").await;
        assert_eq!(probe(&not_json).await, Some(LEGACY));
    }

    #[tokio::test]
    async fn probe_reports_nothing_running_for_an_unhealthy_or_absent_core() {
        let failing = serve_once("503 Service Unavailable", "{}").await;
        assert_eq!(probe(&failing).await, None);
        // A port that was bound and released: nothing listens there.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        assert_eq!(probe(&format!("http://{address}")).await, None);
    }
}

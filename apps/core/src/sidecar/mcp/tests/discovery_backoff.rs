//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;

#[test]
fn a_timed_out_server_backs_off_longer_each_time_and_recovers() {
    let backoff = DiscoveryBackoff::default();
    let start = std::time::Instant::now();
    let generation = backoff.generation();
    let timed_out: Result<Vec<RegistryTool>> =
        Err(anyhow::Error::new(DiscoveryTimedOut("stalled".to_owned())));
    backoff.record("stalled", &timed_out, generation, start);
    assert_eq!(
        backoff.remaining("stalled", start),
        Some(MCP_DISCOVERY_BACKOFF)
    );
    assert!(backoff.remaining("other", start).is_none());
    assert!(backoff
        .remaining("stalled", start + MCP_DISCOVERY_BACKOFF)
        .is_none());
    // Concurrent discoveries timing out against the same stall are one strike.
    backoff.record("stalled", &timed_out, generation, start);
    assert_eq!(
        backoff.remaining("stalled", start),
        Some(MCP_DISCOVERY_BACKOFF)
    );
    // Each timeout after a backoff ends doubles the wait, up to the cap.
    let mut now = start + MCP_DISCOVERY_BACKOFF;
    backoff.record("stalled", &timed_out, generation, now);
    assert_eq!(
        backoff.remaining("stalled", now),
        Some(MCP_DISCOVERY_BACKOFF * 2)
    );
    for _ in 0..10 {
        now += MCP_DISCOVERY_BACKOFF_MAX;
        backoff.record("stalled", &timed_out, generation, now);
    }
    assert_eq!(
        backoff.remaining("stalled", now),
        Some(MCP_DISCOVERY_BACKOFF_MAX)
    );

    // A refusal is not a stall: it ends the backoff instead of starting one.
    let refused: Result<Vec<RegistryTool>> = Err(anyhow!("MCP authentication required"));
    backoff.record("stalled", &refused, generation, start);
    assert!(backoff.remaining("stalled", start).is_none());
    backoff.record("auth", &refused, generation, start);
    assert!(backoff.remaining("auth", start).is_none());

    // A successful listing ends it, whichever path asked for it.
    backoff.record("stalled", &timed_out, generation, start);
    backoff.succeeded("stalled");
    assert!(backoff.remaining("stalled", start).is_none());
    backoff.record("stalled", &timed_out, generation, start);
    backoff.record("stalled", &Ok(Vec::new()), generation, start);
    assert!(backoff.remaining("stalled", start).is_none());

    // Rebuilding the server map clears it, and a discovery that started
    // before the rebuild cannot start a new one.
    backoff.record("stalled", &timed_out, generation, start);
    backoff.clear();
    assert!(backoff.remaining("stalled", start).is_none());
    backoff.record("stalled", &timed_out, generation, start);
    assert!(backoff.remaining("stalled", start).is_none());
    backoff.record("stalled", &timed_out, backoff.generation(), start);
    assert_eq!(
        backoff.remaining("stalled", start),
        Some(MCP_DISCOVERY_BACKOFF)
    );
}

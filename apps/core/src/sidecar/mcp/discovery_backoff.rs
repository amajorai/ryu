//! Discovery timeouts, backoff and result cache expiry.

use super::*;

/// A slow external MCP server must not hold the whole discovery response open
/// while a fresh node is booting. The per-request client timeout remains longer
/// for explicit tool calls; discovery is best-effort and can skip one server.
pub(super) const MCP_DISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// After a server's discovery times out, skip it for a while: this long after
/// the first timeout, doubling with each further one up to
/// [`MCP_DISCOVERY_BACKOFF_MAX`]. Every chat turn lists tools (often more than
/// once), so a server that never answers (an `npx` launcher with no route to
/// the registry on an offline node, say) would otherwise add the whole timeout
/// to every turn.
const MCP_DISCOVERY_BACKOFF: std::time::Duration = std::time::Duration::from_secs(15);
const MCP_DISCOVERY_BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(60);

/// A discovery that ran out of time, as opposed to one the server refused.
#[derive(Debug)]
pub(super) struct DiscoveryTimedOut(String);

impl std::fmt::Display for DiscoveryTimedOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MCP server '{}' tools/list timed out after {}s",
            self.0,
            MCP_DISCOVERY_TIMEOUT.as_secs()
        )
    }
}

impl std::error::Error for DiscoveryTimedOut {}

pub(super) async fn discover_mcp_server_with_timeout<F>(
    name: String,
    operation: F,
) -> Result<Vec<RegistryTool>>
where
    F: std::future::Future<Output = Result<Vec<RegistryTool>>>,
{
    tokio::time::timeout(MCP_DISCOVERY_TIMEOUT, operation)
        .await
        .map_err(|_| anyhow::Error::new(DiscoveryTimedOut(name)))?
}

/// Servers whose last discoveries timed out: when to try each again, and how
/// many timeouts in a row it has had.
#[derive(Default)]
pub(super) struct DiscoveryBackoff(Mutex<DiscoveryBackoffState>);

#[derive(Default)]
struct DiscoveryBackoffState {
    /// Bumped by [`DiscoveryBackoff::clear`], so a discovery that started
    /// against the previous server map cannot back off the rebuilt one.
    generation: u64,
    servers: BTreeMap<String, (std::time::Instant, u32)>,
}

impl DiscoveryBackoff {
    pub(super) fn generation(&self) -> u64 {
        self.0.lock().map_or(0, |state| state.generation)
    }

    /// Time left before `name` may be discovered again, if it is backing off.
    pub(super) fn remaining(
        &self,
        name: &str,
        now: std::time::Instant,
    ) -> Option<std::time::Duration> {
        let (retry_at, _) = *self.0.lock().ok()?.servers.get(name)?;
        retry_at
            .checked_duration_since(now)
            .filter(|left| !left.is_zero())
    }

    /// Record the outcome of a discovery that started at `generation`: a
    /// timeout starts or lengthens a backoff, anything else ends it.
    pub(super) fn record(
        &self,
        name: &str,
        result: &Result<Vec<RegistryTool>>,
        generation: u64,
        now: std::time::Instant,
    ) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        if state.generation != generation {
            return;
        }
        match result {
            Err(error) if error.is::<DiscoveryTimedOut>() => {
                // Concurrent turns that all timed out against the same stall are
                // one strike: only a timeout after the backoff ended lengthens it.
                if state
                    .servers
                    .get(name)
                    .is_some_and(|(retry_at, _)| *retry_at > now)
                {
                    return;
                }
                let strikes = state.servers.get(name).map_or(0, |(_, strikes)| *strikes);
                let wait = MCP_DISCOVERY_BACKOFF
                    .saturating_mul(1 << strikes.min(8))
                    .min(MCP_DISCOVERY_BACKOFF_MAX);
                state
                    .servers
                    .insert(name.to_owned(), (now + wait, strikes.saturating_add(1)));
            }
            _ => {
                state.servers.remove(name);
            }
        }
    }

    /// The server listed its tools, however it was asked.
    pub(super) fn succeeded(&self, name: &str) {
        if let Ok(mut state) = self.0.lock() {
            state.servers.remove(name);
        }
    }

    pub(super) fn clear(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.generation = state.generation.wrapping_add(1);
            state.servers.clear();
        }
    }
}

/// The config-driven MCP server registry. Cheap to clone-share via `Arc`.
///
/// Interior mutability: `servers` uses `RwLock` (reads dominate) so the
/// registry can reload without a process restart. `tool_cache` uses `Mutex`
/// for freshness-scoped tool inventories. Never hold either lock guard across
/// an `.await` point.
#[derive(Clone)]
pub(super) struct CachedMcpValue<T> {
    pub(super) value: T,
    pub(super) expires_at: Option<std::time::Instant>,
}

impl<T> CachedMcpValue<T> {
    pub(super) fn is_fresh_at(&self, now: std::time::Instant) -> bool {
        self.expires_at.map_or(true, |deadline| now < deadline)
    }
}

pub(super) fn mcp_result_cache_expiry(
    hints: Option<client::McpCacheHints>,
    now: std::time::Instant,
) -> Option<Option<std::time::Instant>> {
    match hints {
        // Older MCP servers have no freshness metadata. Keep their historical
        // per-process cache behavior for backward compatibility.
        None => Some(None),
        Some(hints) if hints.scope == client::McpCacheScope::Public && hints.ttl_ms > 0 => now
            .checked_add(std::time::Duration::from_millis(hints.ttl_ms))
            .map(Some),
        // Private results cannot be shared by this registry-wide cache, and a
        // zero TTL means the result is already stale.
        Some(_) => None,
    }
}

#[cfg(test)]
mod mcp_tool_cache_policy_tests {
    use super::{
        client::McpCacheHints, client::McpCacheScope, mcp_result_cache_expiry, CachedMcpValue,
        RegistryTool,
    };

    #[test]
    fn cache_policy_honors_public_ttl_and_never_shares_private_or_stale_results() {
        let now = std::time::Instant::now();
        assert_eq!(mcp_result_cache_expiry(None, now), Some(None));
        assert_eq!(
            mcp_result_cache_expiry(
                Some(McpCacheHints {
                    ttl_ms: 5_000,
                    scope: McpCacheScope::Public,
                }),
                now,
            ),
            Some(Some(now + std::time::Duration::from_secs(5)))
        );
        assert_eq!(
            mcp_result_cache_expiry(
                Some(McpCacheHints {
                    ttl_ms: 5_000,
                    scope: McpCacheScope::Private,
                }),
                now,
            ),
            None
        );

        let expires_at = now + std::time::Duration::from_millis(1);
        let cached = CachedMcpValue::<Vec<RegistryTool>> {
            value: Vec::new(),
            expires_at: Some(expires_at),
        };
        assert!(cached.is_fresh_at(now));
        assert!(!cached.is_fresh_at(expires_at));
        let legacy = CachedMcpValue::<Vec<RegistryTool>> {
            value: Vec::new(),
            expires_at: None,
        };
        assert!(legacy.is_fresh_at(expires_at));
        assert_eq!(
            mcp_result_cache_expiry(
                Some(McpCacheHints {
                    ttl_ms: 0,
                    scope: McpCacheScope::Public,
                }),
                now,
            ),
            None
        );
    }
}

#[cfg(test)]
#[path = "tests/discovery_backoff.rs"]
mod tests;

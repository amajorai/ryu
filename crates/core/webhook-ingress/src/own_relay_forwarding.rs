//! Own-relay loopback distrust.
//!
//! An own-relay ingress is a declaration that Core is already reachable at a
//! public URL through something the operator runs. When that something is a
//! reverse proxy on this host (ngrok, Caddy, nginx), every internet request
//! reaches Core from `127.0.0.1`, exactly like a Cloudflare Quick Tunnel. Core
//! cannot see the operator's proxy topology, so it fails closed: while own-relay
//! is configured, a loopback peer is not proof of a local caller. A proxy that
//! reaches Core over a non-loopback address is unaffected, because such peers
//! were never trusted as local.
//!
//! The flag is armed, never cleared: a backend change takes effect on the next
//! Core start, and until then the public URL may still be live.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::OwnRelaySource;

/// See [`OwnRelaySource::forwarding_active`].
static OWN_RELAY_FORWARDING: AtomicBool = AtomicBool::new(false);

impl OwnRelaySource {
    /// Mark this process as publicly exposed through an own-relay ingress.
    /// Core calls this at boot, before the listener accepts a request, whenever
    /// own-relay is the configured backend; [`OwnRelaySource::start`] also calls
    /// it once a public base URL is present.
    pub fn arm_forwarding() {
        OWN_RELAY_FORWARDING.store(true, Ordering::Release);
    }

    /// Whether an own-relay ingress may be re-originating public requests to
    /// Core over loopback. While true, Core must not treat a loopback peer as
    /// the local owner.
    pub fn forwarding_active() -> bool {
        OWN_RELAY_FORWARDING.load(Ordering::Acquire)
    }
}

/**
 * The truth this figure draws: one Passport connection's credential lifecycle.
 *
 * Every claim in the figure's description comes from the Passport and vault source.
 * Re-verified against the working tree on 2026-10-22:
 *
 * - A connection has two durable statuses, AUTHENTICATED and NEEDS_AUTH:
 *   crates/core/vault/src/lib.rs:95-101 (`ConnectionStatus`). Creating one stores
 *   NEEDS_AUTH: crates/core/vault/src/store.rs:765-800 (`create`).
 * - Login starts a flow that is either a hosted page or a manual sign-in followed by
 *   an import: crates/core/vault/src/source/mod.rs:80-90 (`LoginKind`),
 *   apps/passport/src/lib.rs:820-857 (`begin_login` marks the flow IN_PROGRESS).
 * - Only an import makes a connection AUTHENTICATED: crates/core/vault/src/store.rs:1320-1335
 *   (`write_imported_state` sets AUTHENTICATED and flow DONE).
 * - Imported state is limited to 512 KiB: apps/passport/src/lib.rs:49
 *   (`MAX_STATE_LENGTH = 512 * 1024`) and the check at lib.rs:874-879.
 * - It is sealed with ChaCha20-Poly1305 under a per-tenant HKDF subkey
 *   (crates/core/crypto/src/lib.rs:12, 42, 78-82), with the tenant, table, column and
 *   the row's id, profile and domain as associated data, so a value moved to another
 *   row will not open: crates/core/vault/src/store.rs:13-16, 108-113, 919-936.
 * - Passport makes the upstream fetch itself and only content leaves the service:
 *   apps/passport/src/fetch.rs:1. A connection that is not AUTHENTICATED is refused
 *   (fetch.rs:495-496), and imported credential values are redacted from the content
 *   (fetch.rs:297-330, applied at :562).
 * - A health sweep flips connections whose state is missing or stale back to
 *   NEEDS_AUTH and broadcasts the change: crates/core/vault/src/health.rs:117-163.
 *   Passport runs it every hour by default: crates/core/vault/src/health.rs:53
 *   (`DEFAULT_INTERVAL = "1h"`), apps/passport/src/lib.rs:987-994.
 * - Every route takes a per-tenant bearer token. An address that presents 30 unknown
 *   tokens within 60 s is refused with 429 for 60 s, each further block doubling up
 *   to 900 s (15 min): apps/passport/src/throttle.rs:39-41 (defaults), :327-335
 *   (doubling), :421-434 (429 with Retry-After).
 *
 * The drawing shows only the fetch: the key leaves its box for the site and comes back,
 * and only the page reaches the agent's tray. It is a simulation shown slower than a
 * real fetch; the other keys are decoration, not data from a real deployment. The
 * remaining steps live in the description only.
 */

export const MAX_STATE_KIB = 512;
export const SWEEP_EVERY = "hourly";
export const FAILURE_LIMIT = 30;
export const FAILURE_WINDOW_S = 60;
export const MAX_BLOCK_MIN = 15;
export const LOCKOUT_STATUS = 429;

/** The short name assistive tech hears for the drawing. */
export const LABEL = "Ryu Passport drawn as a cabinet of keys";

/** The drawing's accessible description: the whole lifecycle, in plain sentences. */
export const DESCRIPTION = [
	"Ryu Passport drawn as a cabinet of keys: each box holds one connection's sign-in, a session of at most " +
		`${MAX_STATE_KIB} KiB sealed with its tenant's own key and bound to its box, so a copy moved elsewhere will not open.`,
	"One key leaves its box and Passport carries it to the site itself; only the fetched page comes back down to the agent's tray, with any echoed credential blacked out, so the agent never holds the key.",
	`A health sweep runs ${SWEEP_EVERY} and sends a missing or stale session back to needs sign-in.`,
	`${FAILURE_LIMIT} unknown tokens from one address within ${FAILURE_WINDOW_S} seconds are refused with ${LOCKOUT_STATUS}, the block doubling up to ${MAX_BLOCK_MIN} minutes.`,
	"The motion is a simulation, shown slower than a real fetch; the other keys are decoration.",
].join(" ");

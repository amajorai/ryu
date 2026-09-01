// apps/desktop/src/lib/api/mesh.ts
//
// Typed client for Core's private-network status surface (`GET /api/mesh/status`,
// Contract 6 of the unified-tool-gateway spec). The endpoint is the canonical
// superset Core emits in snake_case; this module normalizes raw → camelCase.
//
// Null handling is load-bearing (P7 review fix): a vanilla install has mesh
// disabled (`enabled: false`) — that must read as NEUTRAL, never amber. Callers
// map `enabled: false` (and the 404/absent case) to `null` so `resolveTone`
// ignores the mesh slice entirely. Only `enabled && !reachable` is a real
// "mesh down" signal.
//
// The webhook-ingress mode is read from a SEPARATE endpoint
// (`GET /api/webhook-ingress/status`), NOT from mesh-status — the two planes are
// independent (a node can have ingress with mesh off), so folding the field into
// mesh-status would under-report it when mesh is disabled.

import { type ApiTarget, request } from "./client.ts";

/** A peer node on the tailnet, as surfaced in Contract 6. */
export interface MeshPeer {
	/** MagicDNS name (preferred) or first Tailscale IP — what to dial. */
	hostOrDns: string;
	/** Full MagicDNS name, empty when none. */
	magicDnsName: string;
	/** Short node name (P7 display key). */
	name: string;
	/** Whether the peer is currently online on the tailnet. */
	online: boolean;
	/** Peer OS (e.g. "macOS", "windows"). */
	os: string;
	/** Peer's Tailscale IPs. */
	tailscaleIps: string[];
}

/** Normalized private-network status (Contract 6). */
export interface MeshStatus {
	/** `"tailscale"` | `"headscale"` | `"tailcat"` | null. */
	backend: string | null;
	/** Raw `BackendState` passthrough (e.g. "Running", "NeedsLogin"). */
	backendState: string;
	/** Control-plane server URL, when known. */
	controlServer: string | null;
	/**
	 * Mesh opted-in at all. Core's `ryu_mesh::is_enabled()` reads the `RYU_MESH_ENABLED`
	 * env var (wins when set) OR the `mesh-enabled` pref, which this client's
	 * {@link setMeshEnabled} writes via `POST /api/mesh/config` (the Gateway →
	 * Integrations toggle). Defaults to `false` in {@link normalizeMeshStatus} so an
	 * older Core that omits the field also reads as "not relevant".
	 */
	enabled: boolean;
	/** This node's MagicDNS name (trailing dot stripped), or null. */
	magicDnsName: string | null;
	/** Peer nodes on the tailnet. */
	peers: MeshPeer[];
	/** Selected network provider is live. Equal to `up`. */
	reachable: boolean;
	/** The short-lived Tailcat connection address, or null for mesh backends. */
	tailcatAddress: string | null;
	/** This node's Tailscale IPs. */
	tailscaleIps: string[];
}

// ── Raw wire shapes (snake_case, as Core emits) ───────────────────────────────

interface RawPeer {
	host_or_dns?: string;
	magic_dns_name?: string;
	name?: string;
	online?: boolean;
	os?: string;
	tailscale_ips?: string[];
}

export interface RawMeshStatus {
	backend?: string | null;
	backend_state?: string;
	control_server?: string | null;
	enabled?: boolean;
	magic_dns_name?: string | null;
	peers?: RawPeer[];
	reachable?: boolean;
	tailcat_address?: string | null;
	tailscale_ips?: string[];
	up?: boolean;
	webhook_ingress_mode?: string | null;
}

function normalizePeer(raw: RawPeer): MeshPeer {
	return {
		name: raw.name ?? "",
		hostOrDns: raw.host_or_dns ?? "",
		magicDnsName: raw.magic_dns_name ?? "",
		tailscaleIps: raw.tailscale_ips ?? [],
		online: raw.online ?? false,
		os: raw.os ?? "",
	};
}

export function normalizeMeshStatus(raw: RawMeshStatus): MeshStatus {
	return {
		enabled: raw.enabled ?? false,
		// `up` is an alias of `reachable`; prefer `reachable`, fall back to `up`.
		reachable: raw.reachable ?? raw.up ?? false,
		backend: raw.backend ?? null,
		backendState: raw.backend_state ?? "Stopped",
		controlServer: raw.control_server ?? null,
		magicDnsName: raw.magic_dns_name ?? null,
		tailscaleIps: raw.tailscale_ips ?? [],
		tailcatAddress: raw.tailcat_address ?? null,
		peers: (raw.peers ?? []).map(normalizePeer),
	};
}

/**
 * Fetch mesh status via Core (`GET /api/mesh/status`).
 *
 * Throws on any non-2xx (including 404 when the mesh feature is absent) so the
 * caller can map the failure to `null` (neutral). A reachable Core with mesh
 * disabled returns `{ enabled: false }` (HTTP 200) and resolves normally.
 */
export async function fetchMeshStatus(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<MeshStatus> {
	const raw = await request<RawMeshStatus>(target, "/api/mesh/status", {
		signal,
	});
	return normalizeMeshStatus(raw);
}

/** Live install state for the selected network client. */
export interface MeshInstallStatus {
	error: string | null;
	state: "failed" | "installed" | "installing" | "not_installed";
}

/**
 * Read the Core install state used by the mesh enable watcher. This is separate
 * from mesh status because a failed download must be reported immediately rather
 * than leaving an enabled-but-unreachable tunnel polling until its deadline.
 */
export async function fetchMeshInstallStatus(
	target: ApiTarget,
	backend: MeshBackend
): Promise<MeshInstallStatus> {
	const name = backend === MESH_BACKEND_TAILCAT ? "tailcat" : "tailscale";
	const raw = await request<{
		status?: {
			error?: string;
			state?: MeshInstallStatus["state"];
		};
	}>(target, `/api/setup/status/${name}`);
	const state = raw.status?.state;
	return {
		error: raw.status?.error ?? null,
		state:
			state === "failed" || state === "installed" || state === "installing"
				? state
				: "not_installed",
	};
}

/**
 * The result of {@link setMeshEnabled}: the live {@link MeshStatus} after the
 * change, plus an optional `startError` when the selected provider could not
 * start while its managed client is being installed.
 * The private network is still ON in that case — the caller should reflect the
 * toggle as enabled and surface `startError` as a warning.
 */
export interface SetMeshEnabledResult {
	/**
	 * This node has a managed route to install the selected client itself. False
	 * means this build/platform has no managed release route, so the response must
	 * explain the operator override rather than pretending an install will work.
	 */
	canInstall: boolean;
	/**
	 * Core started installing the selected network client for this enable. The mesh
	 * IS on; Core starts the selected daemon itself once the binary lands, so the
	 * caller shows progress and re-reads the status rather than surfacing
	 * `startError` as a failure.
	 */
	installing: boolean;
	/** Binaries that could not be resolved anywhere (`tailscaled`, `tailscale`). */
	missingBinaries: string[];
	startError: string | null;
	status: MeshStatus;
}

/**
 * Enable or disable the mesh plane (`POST /api/mesh/config`).
 *
 * Writes the `mesh-enabled` pref (survives a Core restart), flips Core's
 * in-process signal immediately, and starts (enable) or stops (disable) the
 * selected network sidecar. Resolves with the updated status; when enabling, a
 * daemon-start failure is NOT a rejection — it rides in `startError` while the
 * mesh stays enabled. Throws (via `ApiError`) only on a genuinely unusable
 * response (pref write failure, network).
 */
export async function setMeshEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<SetMeshEnabledResult> {
	const raw = await request<
		RawMeshStatus & {
			can_install?: boolean;
			installing?: boolean;
			missing_binaries?: string[];
			start_error?: string | null;
		}
	>(target, "/api/mesh/config", { method: "POST", body: { enabled } });
	return {
		startError: raw.start_error ?? null,
		// All three ride WITH `start_error` and are absent on a clean enable, so
		// they default to the "nothing is wrong" reading rather than to `false`
		// meaning "cannot install".
		installing: raw.installing ?? false,
		canInstall: raw.can_install ?? false,
		missingBinaries: raw.missing_binaries ?? [],
		status: normalizeMeshStatus(raw),
	};
}

/**
 * Select the network backend and apply the current enabled state in one
 * Core-owned operation. The backend is persisted before Core starts the
 * selected sidecar, so switching between Tailscale/Headscale and Tailcat
 * cannot leave the old listener running.
 */
export async function setMeshBackend(
	target: ApiTarget,
	backend: MeshBackend,
	enabled: boolean
): Promise<SetMeshEnabledResult> {
	const raw = await request<
		RawMeshStatus & {
			can_install?: boolean;
			installing?: boolean;
			missing_binaries?: string[];
			start_error?: string | null;
		}
	>(target, "/api/mesh/config", {
		method: "POST",
		body: { backend, enabled },
	});
	return {
		startError: raw.start_error ?? null,
		installing: raw.installing ?? false,
		canInstall: raw.can_install ?? false,
		missingBinaries: raw.missing_binaries ?? [],
		status: normalizeMeshStatus(raw),
	};
}

// ── Network backend (`mesh-backend` pref) ─────────────────────────────────────
//
// Which private-network backend this node uses. A SETTING, distinct from
// `MeshStatus.backend`, which is derived from provider status once connected —
// before a node has ever started there is nothing to derive, so the picker reads
// this instead.

/** Self-hosted Headscale. Needs a control server URL. */
export const MESH_BACKEND_HEADSCALE = "headscale";
/** Tailscale's SaaS coordination server. */
export const MESH_BACKEND_TAILSCALE = "tailscale";
/** Tailcat's short-lived point-to-point connection. */
export const MESH_BACKEND_TAILCAT = "tailcat";

export type MeshBackend =
	| typeof MESH_BACKEND_HEADSCALE
	| typeof MESH_BACKEND_TAILSCALE
	| typeof MESH_BACKEND_TAILCAT;

/** The `mesh-backend` pref key, mirroring `MESH_BACKEND_PREF_KEY` in Core. */
export const MESH_BACKEND_PREF = "mesh-backend";
/** The `mesh-login-server` pref key — the Headscale control server URL. */
export const MESH_LOGIN_SERVER_PREF = "mesh-login-server";

/**
 * Normalize a stored `mesh-backend` value. Unset or unrecognized reads as
 * Tailcat — the same fresh-install default Core's `parse_backend` applies, so
 * the picker and daemon never disagree about an unconfigured node. A legacy
 * Headscale URL is also treated as the old implicit choice when no backend
 * preference exists.
 */
export function parseMeshBackend(
	raw: string | null | undefined,
	legacyLoginServer?: string | null
): MeshBackend {
	switch (raw?.trim().toLowerCase()) {
		case MESH_BACKEND_TAILSCALE:
			return MESH_BACKEND_TAILSCALE;
		case MESH_BACKEND_TAILCAT:
			return MESH_BACKEND_TAILCAT;
		default:
			return legacyLoginServer?.trim()
				? MESH_BACKEND_HEADSCALE
				: MESH_BACKEND_TAILCAT;
	}
}

// ── Mesh peers + candidate bearer (`GET /api/mesh/peers`, P7) ──────────────────
//
// Distinct from `/api/mesh/status`: this endpoint returns, per reachable peer, a
// registerable URL (`http://<magicDns>:<port>`) AND a *candidate* node-admittance
// bearer to attach when the desktop registers that peer — so a freshly added mesh
// peer's protected routes don't 401. The bearer is this node's own `RYU_TOKEN`,
// valid on a peer ONLY when that peer shares the same token (the shared-fleet
// convention). `bearerSource: "none"` (⇒ `bearer: null`, `note` set) means no
// usable token exists on this node — the desktop must then show an honest
// "needs enrollment token" state instead of silently adding a node that 401s.

/** `"shared-mesh-token"` — a candidate bearer is offered on every peer entry. */
export const BEARER_SOURCE_SHARED = "shared-mesh-token";
/** `"none"` — no usable bearer on this node; peers can't be added with a token. */
export const BEARER_SOURCE_NONE = "none";

/** One reachable mesh peer, ready to register with `addNode(name, url, bearer)`. */
export interface MeshPeerEntry {
	/** Candidate node-admittance bearer, or null when none is usable. */
	bearer: string | null;
	/** Whether a candidate bearer is obtainable for this peer. */
	bearerAvailable: boolean;
	/** MagicDNS name (preferred) or Tailscale IP fallback. */
	hostOrDns: string;
	/** Full MagicDNS name, empty when none. */
	magicDnsName: string;
	/** Short node name (display key). */
	name: string;
	/** Whether the peer is currently online on the tailnet. */
	online: boolean;
	/** Peer OS (e.g. "macOS", "windows"). */
	os: string;
	/** Core listen port peers are dialed on. */
	port: number;
	/** The URL to register with `addNode` — `http://<magicDns|host>:<port>`. */
	url: string;
}

/** Normalized `GET /api/mesh/peers` response. */
export interface MeshPeersResult {
	/** `"shared-mesh-token"` when a candidate bearer is offered, else `"none"`. */
	bearerSource: string;
	/** Mesh opted-in at all. */
	enabled: boolean;
	/** Provisioning guidance when no bearer is available, else null. */
	note: string | null;
	/** Reachable tailnet peers, each carrying the shared candidate bearer. */
	peers: MeshPeerEntry[];
	/** tailscaled client up + authed. */
	reachable: boolean;
}

interface RawMeshPeerEntry {
	bearer?: string | null;
	bearer_available?: boolean;
	host_or_dns?: string;
	magic_dns_name?: string;
	name?: string;
	online?: boolean;
	os?: string;
	port?: number;
	url?: string;
}

interface RawMeshPeersResponse {
	bearer_source?: string;
	enabled?: boolean;
	note?: string | null;
	peers?: RawMeshPeerEntry[];
	reachable?: boolean;
}

function normalizePeerEntry(raw: RawMeshPeerEntry): MeshPeerEntry {
	return {
		name: raw.name ?? "",
		url: raw.url ?? "",
		magicDnsName: raw.magic_dns_name ?? "",
		hostOrDns: raw.host_or_dns ?? "",
		port: raw.port ?? 0,
		online: raw.online ?? false,
		os: raw.os ?? "",
		bearerAvailable: raw.bearer_available ?? false,
		bearer: raw.bearer ?? null,
	};
}

/**
 * Fetch reachable mesh peers + a candidate node-admittance bearer via Core
 * (`GET /api/mesh/peers`).
 *
 * Throws on any non-2xx (including 404 on an older Core without the surface) so
 * the caller can map the failure to `null` (no addable peers). A reachable Core
 * with mesh disabled returns `{ enabled: false, peers: [], bearer_source: "none" }`
 * (HTTP 200) and resolves normally.
 */
export async function fetchMeshPeers(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<MeshPeersResult> {
	const raw = await request<RawMeshPeersResponse>(target, "/api/mesh/peers", {
		signal,
	});
	return {
		enabled: raw.enabled ?? false,
		reachable: raw.reachable ?? false,
		peers: (raw.peers ?? []).map(normalizePeerEntry),
		bearerSource: raw.bearer_source ?? BEARER_SOURCE_NONE,
		note: raw.note ?? null,
	};
}

// ── Webhook-ingress status (read from its own endpoint, soft dependency) ───────

/** Normalized webhook-ingress status (`GET /api/webhook-ingress/status`). */
export interface WebhookIngressStatus {
	/**
	 * Backend selector in Core's kebab wire form — `"ryu-relay"` |
	 * `"tailscale-funnel"` | `"cloudflared"` | `"own-relay"`. Core emits
	 * `IngressKind::as_str()` here exactly as it does on
	 * `/api/webhook-ingress/backend`; render it through {@link ingressLabel}
	 * rather than as-is.
	 */
	kind: string;
	/** Resolved public URL, or null when not yet established. */
	publicUrl: string | null;
	/** Whether ingress can currently receive webhooks (public URL resolved). */
	up: boolean;
}

interface RawWebhookIngressStatus {
	kind?: string;
	public_url?: string | null;
	up?: boolean;
}

/**
 * Fetch webhook-ingress status. Soft dependency: Core always answers HTTP 200,
 * with `up:false` when no public URL is resolved — so callers gate the ingress
 * line on `up && kind`. A Core build without the plane (older binary) 404s, which
 * callers catch and render as no ingress line.
 */
export async function fetchWebhookIngressStatus(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<WebhookIngressStatus> {
	const raw = await request<RawWebhookIngressStatus>(
		target,
		"/api/webhook-ingress/status",
		{ signal }
	);
	return {
		kind: raw.kind ?? "",
		publicUrl: raw.public_url ?? null,
		up: raw.up ?? false,
	};
}

// ── Webhook-ingress backend selector (`/api/webhook-ingress/backend`) ──────────

/** The configured ingress backend + the full pickable set (Contract: GET). */
export interface IngressBackendConfig {
	/** Every selectable backend kind, in registry order. */
	available: string[];
	/** Currently configured backend kind (env override → pref → default). */
	backend: string;
	/** The built-in default kind, shown as a hint in the picker. */
	default: string;
}

interface RawIngressBackendConfig {
	available?: string[];
	backend?: string;
	default?: string;
}

/**
 * The canonical wire form of the BYO ("bring your own public URL") backend.
 *
 * Core's `IngressKind` serializes **kebab-case** (`IngressKind::as_str()` in
 * `crates/core/webhook-ingress/src/lib.rs`), and `as_str()` is the only spelling
 * `GET /api/webhook-ingress/backend` ever emits — for both `backend` and every
 * entry of `available`.
 */
export const INGRESS_KIND_OWN_RELAY = "own-relay";

/**
 * The Core pref holding the BYO public base URL that `own-relay` needs
 * (`ryu_webhook_ingress::INGRESS_URL_PREF`). Core reads it raw — `prefs.get(key)`
 * → `Option<String>` handed straight to `from_prefs` — so the client writes the
 * bare URL string, exactly like `mesh-login-server`. No JSON encoding.
 */
export const INGRESS_URL_PREF = "webhook.ingress.url";

/**
 * Whether `kind` is the BYO backend, i.e. the one that cannot produce a public
 * URL on its own and therefore requires {@link INGRESS_URL_PREF} (or the
 * `RYU_WEBHOOK_INGRESS_URL` env override) to be set.
 *
 * Comparison is separator- and case-insensitive because Core's `FromStr` accepts
 * the `ownrelay` alias as well as the canonical `own-relay`; only the canonical
 * form is emitted today, but a pref written by hand may hold the alias.
 */
export function isOwnRelayKind(kind: string): boolean {
	return kind.trim().toLowerCase().replaceAll(/[-_]/g, "") === "ownrelay";
}

/**
 * Friendly labels for the ingress backend kinds Core emits.
 *
 * The keys MUST stay byte-identical to `IngressKind::as_str()` (kebab-case). They
 * were snake_case until 2026-07 and every label except `cloudflared` silently
 * fell through to {@link ingressLabel}'s title-caser, rendering "Own-relay" —
 * proof the own-relay path had never been exercised end to end.
 */
export const INGRESS_LABELS: Record<string, string> = {
	"ryu-relay": "Ryu Relay (managed)",
	"tailscale-funnel": "Tailscale Funnel",
	cloudflared: "Cloudflare Tunnel",
	"own-relay": "Self-hosted relay",
};

/**
 * Label for an ingress backend kind. Falls back to a title-cased form for any
 * kind not in {@link INGRESS_LABELS}, so a backend added in Core still renders
 * sensibly without a desktop change. The fallback splits on BOTH `-` and `_`:
 * Core emits kebab-case, and splitting on `_` alone is what made every
 * multi-word kind render with a stray hyphen.
 */
export function ingressLabel(kind: string): string {
	const known = INGRESS_LABELS[kind];
	if (known) {
		return known;
	}
	return kind
		.split(/[-_]/)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/**
 * Fetch the configured webhook-ingress backend and the list of choices
 * (`GET /api/webhook-ingress/backend`). Throws on non-2xx (incl. 404 on an
 * older Core without the plane) so the caller can hide the picker.
 */
export async function fetchIngressBackend(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<IngressBackendConfig> {
	const raw = await request<RawIngressBackendConfig>(
		target,
		"/api/webhook-ingress/backend",
		{ signal }
	);
	return {
		backend: raw.backend ?? "",
		default: raw.default ?? "",
		available: raw.available ?? [],
	};
}

/**
 * Select the active webhook-ingress backend
 * (`POST /api/webhook-ingress/backend`). The change is persisted to a pref and
 * takes effect on the NEXT Core start — the ingress is built once at startup —
 * so the UI must say "applies on restart".
 *
 * Throws (via `request`'s `ApiError`) on three rejections, each carrying an
 * actionable message in the body's `error` field that callers should surface
 * verbatim rather than replacing with their own text:
 *
 * - **400**, unknown backend;
 * - **400**, `own-relay` selected while neither `webhook.ingress.url` nor
 *   `RYU_WEBHOOK_INGRESS_URL` holds a usable absolute URL — the selection would
 *   have been saved and reported as live with nothing able to receive a webhook;
 * - **409**, `RYU_WEBHOOK_INGRESS_URL` is set in the node's environment, which
 *   pins the backend to `own-relay`; any other kind would be persisted and then
 *   permanently overridden.
 *
 * A caller must NOT treat a resolved promise as "the URL is configured" — the
 * 409 case means the env supplies one this client cannot read.
 */
export async function setIngressBackend(
	target: ApiTarget,
	backend: string
): Promise<void> {
	await request<{ ok?: boolean; backend?: string }>(
		target,
		"/api/webhook-ingress/backend",
		{ method: "POST", body: { backend } }
	);
}

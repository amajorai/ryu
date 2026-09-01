import { create } from "zustand";
import { DEFAULT_CORE_URL } from "@/lib/core-url.ts";
import {
	fetchManagedNodes,
	type ManagedNode,
} from "@/src/lib/api/managed-nodes.ts";
import { enforcePlanCap } from "@/src/lib/gating/planCapBridge.ts";
// `init()` runs from App.tsx's first effect, so `refresh()` was the earliest IPC
// the app made — early enough that Tauri had not always injected its bridge, which
// is how "Object.refresh → window.__TAURI_INTERNALS__.invoke is undefined" became
// one of the top production errors. Every command here goes through the gate, so a
// too-early call queues behind the bridge instead of rejecting.
import {
	invokeWhenReady,
	listenWhenReady,
	TauriUnavailableError,
} from "@/src/lib/tauri-ready.ts";

export interface Node {
	/**
	 * True for a managed (Ryu Cloud) node hydrated from the control plane (A4 /
	 * #501). Such nodes live in memory only (never persisted to nodes.json) and
	 * the NodeSelector labels them "Cloud". `false`/absent for local + LAN + mesh
	 * nodes the user added.
	 */
	managed?: boolean;
	name: string;
	/**
	 * The org this managed node belongs to. Carried only for managed nodes; a
	 * local, LAN or mesh node has no org.
	 */
	orgId?: string | null;
	/**
	 * The managed-server row this node runs on, when it has one.
	 *
	 * Carried so the desktop can address `/api/servers/orgs/:orgId/servers/
	 * :serverId/...` — the resize and quiet-hour-zone surfaces. It is NOT the same
	 * id the control plane calls `id` (that one is the node's GatewayCredential),
	 * and it cannot be derived from anything else on this object, which is why it
	 * has to be carried rather than looked up locally.
	 *
	 * Null/absent for adopted and resumed nodes, which are never linked to a
	 * server row. A surface that needs it must hide itself rather than guess.
	 */
	serverId?: string | null;
	token: string | null;
	url: string;
	/** Short-lived Better Auth JWT for a managed node; memory-only. */
	userJwt?: string | null;
}

interface NodesData {
	default: string;
	nodes: Node[];
}

interface NodeState {
	/**
	 * Reachability of the *active* node. `null` until the first probe resolves, so
	 * a banner can stay silent rather than flashing "unreachable" on boot. Nothing
	 * in the store answered this before: `getActiveNode` is a pure name lookup, and
	 * the only probing (auto-select) is opt-in, OFF by default, and never considers
	 * the local node. An unreachable active node was simply used anyway.
	 */
	activeNodeOnline: boolean | null;
	addNode: (name: string, url: string, token?: string) => Promise<void>;
	/**
	 * Persist a suggested cloud instance as a real node (A4 follow-up). Adds it to
	 * the local nodes.json via {@link addNode} so it survives without the control
	 * plane and gets a stable local entry; it then decorates as a "Cloud" node and
	 * drops out of {@link suggestedCloudNodes}.
	 */
	addSuggestedNode: (node: Node) => Promise<void>;
	/**
	 * Opt-in auto node selection (M10: "a client prefers a reachable REMOTE node,
	 * else local compute"). When true, {@link getActiveNode} prefers the node the
	 * probe picked ({@link autoSelectedNode}) over the manual {@link defaultNode}
	 * — and the probe only ever considers REMOTE nodes, failing over to local when
	 * none answers. OFF by default (local-first rule): when off the selection path
	 * is byte-identical to the pre-existing manual behaviour.
	 */
	autoSelect: boolean;
	/**
	 * Name of the node the reachability probe last picked (a reachable remote, or
	 * the local node when no remote answered), or null before the first probe.
	 */
	autoSelectedNode: string | null;
	clearTabOverride: (tabId: string) => void;
	/**
	 * All managed cloud nodes the active org can reach, hydrated from the control
	 * plane (in-memory only). This is the *detection* set: nodes already added
	 * locally are decorated as "Cloud" in {@link nodes}; the rest surface as
	 * {@link suggestedCloudNodes}.
	 */
	cloudNodes: Node[];
	defaultNode: string;
	/**
	 * Normalized URLs of cloud instances the user dismissed from the suggestion
	 * nudge. Persisted to localStorage so a dismissed instance stays hidden across
	 * launches (until it is actually added). A dismissal never removes an added
	 * node — it only silences the "add this" suggestion.
	 */
	dismissedCloudUrls: string[];
	/** Hide a suggested cloud instance without adding it (persisted, per URL). */
	dismissSuggestion: (url: string) => void;
	getActiveNode: (tabId?: string) => Node;
	/** Re-fetch the org's managed nodes from the control plane and merge them in. */
	hydrateCloudNodes: () => Promise<void>;
	init: () => Promise<() => void>;
	/** Locally-persisted nodes (local + LAN + mesh + manual adds). */
	localNodes: Node[];
	/** Display set: local nodes plus any cloud node not already present by URL. */
	nodes: Node[];
	/** Probe the active node and publish the result to {@link activeNodeOnline}. */
	probeActiveNode: () => Promise<boolean>;
	/**
	 * Probe the REMOTE nodes for reachability (`GET /api/health`) and record the
	 * pick in {@link autoSelectedNode}: the first reachable remote (the manual
	 * default first when it is itself a remote), else the local node. Local is
	 * never probed — it is the failover, not a candidate. No-op unless
	 * {@link autoSelect} is on. Async, so never call this from render;
	 * {@link getActiveNode} stays sync.
	 */
	probeAutoSelect: () => Promise<void>;
	refresh: () => Promise<void>;
	/**
	 * Refresh ONLY the auth token on already-added cloud nodes. The control-plane
	 * mints a short-lived (~15 min) user JWT per `/nodes` fetch, so a token grabbed
	 * once at init expires mid-session and every authed call to the node then 401s.
	 * This re-fetches the authoritative managed-node scope without touching
	 * selection. A transient failed fetch keeps the existing nodes; a successful
	 * refresh adds newly visible nodes and removes nodes that left the scope. Driven
	 * by a timer under the TTL plus window-focus (to cover laptop sleep/wake).
	 */
	refreshCloudTokens: () => Promise<void>;
	removeNode: (name: string) => Promise<void>;
	/** Publish the shared status spine's latest active-node reachability result. */
	setActiveNodeOnline: (online: boolean | null) => void;
	setAutoSelect: (enabled: boolean) => void;
	setDefault: (name: string) => Promise<void>;
	/** Adopt a local node token returned by a native standalone bootstrap. */
	setLocalNodeToken: (token: string) => void;
	setTabOverride: (tabId: string, name: string) => void;
	/**
	 * Cloud instances tied to the active workspace that the user can reach but has
	 * NOT added yet (detected from {@link cloudNodes}, minus already-added URLs and
	 * dismissed ones). The NodeSelector surfaces these as an "add this" nudge
	 * rather than silently injecting them, so node membership stays user-driven.
	 */
	suggestedCloudNodes: Node[];
	tabOverrides: Record<string, string>;
}

// The local Core node URL is profile-aware via VITE_CORE_URL (DEFAULT_CORE_URL):
// release → :7980 (~/.ryu), the `dev` profile → :8980 (~/.ryu-dev) through
// `.env.development`. Hardcoding :7980 here made a `bun dev` webview dial the
// INSTALLED prod Core, so dev and prod shared one node — the profile collision.
export const LOCAL_FALLBACK: Node = {
	name: "local",
	url: DEFAULT_CORE_URL,
	token: null,
	userJwt: null,
};

/** Strip a trailing slash so two spellings of the same URL dedupe. */
const normalizeUrl = (url: string) => url.replace(/\/$/, "");

/**
 * Better Auth user JWTs are compact JWTs. A legacy managed-node entry stored
 * one in `Node.token` before the credential names were separated; never let
 * that stale identity win over the current node bearer slot.
 */
function looksLikeUserJwt(token: string | null): boolean {
	return token?.split(".").length === 3;
}

/**
 * True when a node is the local Core process (the desktop host), false for any
 * remote/LAN/mesh/cloud node. Callers use this to decide whether a filesystem
 * operation may be validated against the desktop's own disk (local) or must be
 * delegated to the node over HTTP (remote), since a remote node's paths do not
 * exist on this machine. Compares on the normalized URL so a trailing slash or
 * an alternate name for the local node still resolves as local.
 */
export function isLocalNode(node: Pick<Node, "url">): boolean {
	return normalizeUrl(node.url) === normalizeUrl(LOCAL_FALLBACK.url);
}

/** localStorage key persisting the set of dismissed cloud-suggestion URLs. */
const DISMISSED_CLOUD_KEY = "ryu:node-dismissed-cloud";

/** Read the persisted dismissed cloud-suggestion URLs (normalized). */
function loadDismissedCloudUrls(): string[] {
	try {
		const raw = localStorage.getItem(DISMISSED_CLOUD_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(parsed)
			? parsed.filter((u): u is string => typeof u === "string")
			: [];
	} catch {
		return [];
	}
}

/**
 * Decorate the local node list with the "Cloud" (managed) flag — and the LIVE
 * control-plane user JWT — for any node whose URL matches a managed cloud node the
 * org can reach. A managed node that is NOT added locally is never injected here
 * — it surfaces as a suggestion instead (see {@link computeSuggestions}).
 *
 * WHY THE JWT IS ADOPTED HERE: the control plane mints a short-lived (~15 min)
 * user JWT per `/nodes` fetch, and {@link useNodeStore.refreshCloudTokens} exists
 * to keep an added cloud node's credential fresh. It swapped the token only into
 * `cloudNodes` though, while every caller reads the merged `nodes` — so the
 * persisted, hours-old token from add-time was the one actually sent, and the
 * refresh timer changed nothing an added node could see. Merging by URL fixes
 * that at the single point where the two lists meet, and it is also what lets a
 * node added from a TOKENLESS connection string (the web dashboard holds no node
 * secret to put in one) authenticate at all. A local node with no cloud match is
 * untouched, so self-hosted/LAN tokens are never overwritten.
 */
function decorateLocal(local: Node[], cloud: Node[]): Node[] {
	const cloudByUrl = new Map(cloud.map((n) => [normalizeUrl(n.url), n]));
	return local.map((n) => {
		const match = cloudByUrl.get(normalizeUrl(n.url));
		if (!match) {
			return n;
		}
		// `orgId`/`serverId` come from the CLOUD record and must be carried across.
		// The local record is whatever Tauri persisted in `nodes.json` — name, url,
		// token — so spreading it alone silently drops both ids, and every surface
		// that needs them (the quiet-hour picker) reads `undefined` and hides
		// itself. That is a feature that looks shipped and does nothing.
		const legacyUserJwt = looksLikeUserJwt(n.token) ? n.token : null;
		return {
			...n,
			// A JWT-shaped value in the persisted node-token slot is from the old
			// managed-node response. Clear it in memory; explicit opaque node
			// bearers remain valid for self-hosted nodes.
			token: legacyUserJwt ? null : n.token,
			managed: true,
			// `null` is authoritative here. Reusing an expired managed JWT would
			// make a failed refresh look like a valid node until every request 401s.
			userJwt: match.userJwt ?? null,
			orgId: match.orgId ?? null,
			serverId: match.serverId ?? null,
		};
	});
}

/** Merge discovered managed nodes into the display set without persisting them. */
function mergeNodes(local: Node[], cloud: Node[]): Node[] {
	const decorated = decorateLocal(local, cloud);
	const localUrls = new Set(local.map((node) => normalizeUrl(node.url)));
	return [
		...decorated,
		...cloud.filter((node) => !localUrls.has(normalizeUrl(node.url))),
	];
}

/**
 * The cloud instances tied to the active workspace that are not yet added and
 * not dismissed — i.e. the "add this" suggestions. A managed node whose URL is
 * already among the local nodes (added) or in the dismissed set is excluded.
 */
function computeSuggestions(
	local: Node[],
	cloud: Node[],
	dismissed: string[]
): Node[] {
	const localUrls = new Set(local.map((n) => normalizeUrl(n.url)));
	const dismissedUrls = new Set(dismissed);
	return cloud.filter((n) => {
		const url = normalizeUrl(n.url);
		return !(localUrls.has(url) || dismissedUrls.has(url));
	});
}

/** Convert the control-plane scope into the in-memory cloud-node shape. */
function cloudNodesFromManaged(managed: ManagedNode[]): Node[] {
	return managed
		.filter((node) => Boolean(node.url?.trim()))
		.map((node) => ({
			name: `cloud-${node.name}`,
			url: node.url,
			token: null,
			userJwt: node.userJwt ?? null,
			managed: true,
			orgId: node.orgId ?? null,
			serverId: node.serverId ?? null,
		}));
}

/** Short timeout (ms) for the auto-select reachability probe. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * How often the auto-select reachability probe re-runs while the flag is ON.
 * Reachability is not a one-shot fact — a remote node goes down, a laptop leaves
 * the LAN — so the pick has to be re-evaluated, not just decided at boot. Only
 * ever ticks while auto-select is on (the timer is stopped on opt-out AND the
 * tick itself re-checks the flag), so the local-first path never pays for it.
 */
const AUTO_SELECT_PROBE_INTERVAL_MS = 30_000;

/** localStorage key persisting the opt-in auto-select flag across launches. */
const AUTO_SELECT_KEY = "ryu:node-auto-select";

/** Read the persisted auto-select flag (default false / OFF). */
function loadAutoSelect(): boolean {
	try {
		return localStorage.getItem(AUTO_SELECT_KEY) === "true";
	} catch {
		return false;
	}
}

/**
 * Probe a single node's `GET /api/health` with a short timeout. Resolves true
 * when the node answers 2xx within {@link PROBE_TIMEOUT_MS}, false otherwise.
 * Never throws: a timeout, network error, or non-2xx all resolve false.
 */
async function probeNode(node: Node): Promise<boolean> {
	const base = node.url.replace(/\/$/, "");
	const headers: Record<string, string> = {};
	const bearer = node.token ?? node.userJwt;
	if (bearer) {
		headers.Authorization = `Bearer ${bearer}`;
	}
	if (node.userJwt) {
		headers["x-ryu-user-jwt"] = node.userJwt;
	}
	try {
		const res = await fetch(`${base}/api/health`, {
			headers,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * The single auto-select probe timer. Module-scoped (not store state) so it has
 * exactly ONE lifecycle no matter how many components read the flag: starting
 * twice never stacks two intervals, and stopping is idempotent.
 */
let probeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic reachability probe. Idempotent: a second call while a timer
 * is live is a no-op rather than a second interval. Each tick delegates to
 * `probeAutoSelect`, which itself no-ops while the flag is OFF — so even a timer
 * that somehow outlived an opt-out can never re-pick a node.
 */
export function startAutoSelectProbe(): void {
	if (probeTimer !== null) {
		return;
	}
	probeTimer = setInterval(() => {
		useNodeStore
			.getState()
			.probeAutoSelect()
			.catch(() => undefined);
	}, AUTO_SELECT_PROBE_INTERVAL_MS);
}

/** Stop the periodic probe. Idempotent; safe to call when no timer is running. */
export function stopAutoSelectProbe(): void {
	if (probeTimer !== null) {
		clearInterval(probeTimer);
		probeTimer = null;
	}
}

/**
 * How often the cloud-node auth token is proactively refreshed. Must stay under
 * the control plane's ~15 min user-JWT TTL so the token is swapped BEFORE it
 * expires — otherwise authed calls to a managed node 401 for the rest of the
 * session. 10 min leaves a comfortable margin.
 */
const CLOUD_TOKEN_REFRESH_INTERVAL_MS = 10 * 60_000;

/** The single cloud-token refresh timer. Module-scoped, one lifecycle. */
let cloudTokenTimer: ReturnType<typeof setInterval> | null = null;
/** The window-focus refresh handler, kept so it can be removed on teardown. */
let cloudTokenFocusHandler: (() => void) | null = null;

/**
 * Start proactively refreshing cloud-node tokens (a timer under the JWT TTL plus
 * a window-focus refresh for the sleep/wake case). Idempotent: a second call
 * while live is a no-op, never a second timer/listener.
 */
export function startCloudTokenRefresh(): void {
	if (cloudTokenTimer === null) {
		cloudTokenTimer = setInterval(() => {
			useNodeStore
				.getState()
				.refreshCloudTokens()
				.catch(() => undefined);
		}, CLOUD_TOKEN_REFRESH_INTERVAL_MS);
	}
	if (cloudTokenFocusHandler === null && typeof window !== "undefined") {
		cloudTokenFocusHandler = () => {
			useNodeStore
				.getState()
				.refreshCloudTokens()
				.catch(() => undefined);
		};
		window.addEventListener("focus", cloudTokenFocusHandler);
	}
}

/** Stop the cloud-token refresh timer + focus listener. Idempotent. */
export function stopCloudTokenRefresh(): void {
	if (cloudTokenTimer !== null) {
		clearInterval(cloudTokenTimer);
		cloudTokenTimer = null;
	}
	if (cloudTokenFocusHandler !== null && typeof window !== "undefined") {
		window.removeEventListener("focus", cloudTokenFocusHandler);
		cloudTokenFocusHandler = null;
	}
}

export const useNodeStore = create<NodeState>((set, get) => ({
	localNodes: [LOCAL_FALLBACK],
	cloudNodes: [],
	suggestedCloudNodes: [],
	dismissedCloudUrls: loadDismissedCloudUrls(),
	nodes: [LOCAL_FALLBACK],
	defaultNode: "local",
	tabOverrides: {},
	autoSelect: loadAutoSelect(),
	autoSelectedNode: null,
	activeNodeOnline: null,

	probeActiveNode: async () => {
		const online = await probeNode(get().getActiveNode());
		set({ activeNodeOnline: online });
		return online;
	},

	setActiveNodeOnline: (online) => set({ activeNodeOnline: online }),

	getActiveNode: (tabId) => {
		const { nodes, defaultNode, tabOverrides, autoSelect, autoSelectedNode } =
			get();
		// Precedence: tab override (manual, always wins) -> auto-selected node
		// (only when auto-select is on) -> manual default -> local fallback.
		const override = tabId === undefined ? undefined : tabOverrides[tabId];
		const auto = autoSelect ? (autoSelectedNode ?? undefined) : undefined;
		const name = override || auto || defaultNode;
		return nodes.find((n) => n.name === name) ?? LOCAL_FALLBACK;
	},

	setDefault: async (name) => {
		await invokeWhenReady("set_default_node", { name });
		set({ activeNodeOnline: null, defaultNode: name });
	},

	addNode: async (name, url, token) => {
		// Managed-path numeric cap: free tier gets local Core + 1 remote node. The
		// local fallback never counts; only genuinely remote (LAN/mesh/cloud) nodes
		// do. Off the managed path (not signed in) this is a no-op — self-host stays
		// uncapped. Throws PlanCapError + opens the upgrade modal when over cap.
		const remoteCount = get().localNodes.filter((n) => !isLocalNode(n)).length;
		enforcePlanCap("maxRemoteNodes", remoteCount);
		await invokeWhenReady("add_node", { name, url, token: token ?? null });
		await get().refresh();
	},

	removeNode: async (name) => {
		await invokeWhenReady("remove_node", { name });
		await get().refresh();
	},

	addSuggestedNode: async (node) => {
		// Persist the suggested cloud instance under its control-plane name (the
		// `cloud-` prefix already can't collide with a local node). refresh() then
		// re-decorates it as a Cloud node and drops it from the suggestions.
		await get().addNode(node.name, node.url, node.token ?? undefined);
	},

	dismissSuggestion: (url) => {
		const normalized = normalizeUrl(url);
		set((s) => {
			if (s.dismissedCloudUrls.includes(normalized)) {
				return s;
			}
			const dismissedCloudUrls = [...s.dismissedCloudUrls, normalized];
			try {
				localStorage.setItem(
					DISMISSED_CLOUD_KEY,
					JSON.stringify(dismissedCloudUrls)
				);
			} catch {
				// Persistence is best-effort; the in-memory dismissal still applies.
			}
			return {
				dismissedCloudUrls,
				suggestedCloudNodes: computeSuggestions(
					s.localNodes,
					s.cloudNodes,
					dismissedCloudUrls
				),
			};
		});
	},

	setTabOverride: (tabId, name) => {
		set((s) => ({ tabOverrides: { ...s.tabOverrides, [tabId]: name } }));
	},

	clearTabOverride: (tabId) => {
		set((s) => {
			const next = { ...s.tabOverrides };
			delete next[tabId];
			return { tabOverrides: next };
		});
	},

	setAutoSelect: (enabled) => {
		try {
			localStorage.setItem(AUTO_SELECT_KEY, enabled ? "true" : "false");
		} catch {
			// Persistence is best-effort; the in-memory flag still applies.
		}
		set({ activeNodeOnline: null, autoSelect: enabled });
		if (enabled) {
			// Probe immediately so the choice takes effect without waiting for a
			// later trigger. Fire-and-forget: probeAutoSelect never throws.
			get()
				.probeAutoSelect()
				.catch(() => undefined);
			// ...then keep re-probing, so reachability stays a live fact.
			startAutoSelectProbe();
		} else {
			// Opt-out stops the timer AND clears the pick, so selection falls straight
			// back to the manual default with nothing left running in the background.
			stopAutoSelectProbe();
			set({ autoSelectedNode: null });
		}
	},

	setLocalNodeToken: (token) => {
		set((state) => {
			const localNodes = state.localNodes.map((node) =>
				isLocalNode(node) ? { ...node, token } : node
			);
			return {
				localNodes,
				nodes: mergeNodes(localNodes, state.cloudNodes),
			};
		});
	},

	probeAutoSelect: async () => {
		if (!get().autoSelect) {
			return;
		}
		const { nodes, defaultNode } = get();
		// REMOTE-FIRST (M10: "a client prefers a reachable REMOTE node, else local
		// compute"). Only remotes are probed — local is never a candidate, it is the
		// failover. Ranking among the remotes: an explicitly-chosen manual default
		// wins over the other remotes, so a deliberate choice still ranks. A LOCAL
		// manual default is deliberately NOT probed first: doing so short-circuits
		// the probe on every healthy install (local is always up) and makes the whole
		// toggle a no-op.
		const remotes = nodes.filter((n) => !isLocalNode(n));
		const preferredRemote = remotes.find((n) => n.name === defaultNode);
		const candidates = [
			...(preferredRemote ? [preferredRemote] : []),
			...remotes.filter((n) => n.name !== defaultNode),
		];
		for (const node of candidates) {
			if (await probeNode(node)) {
				set({ autoSelectedNode: node.name });
				return;
			}
		}
		// No remote answered: fail over to local compute EXPLICITLY (the "else local"
		// half of the policy). Leaving this null would hand the pick back to the
		// manual default — and when that default is a remote that is currently down,
		// the app would keep resolving to the dead remote, which is the exact case
		// auto-select exists to avoid.
		set({ autoSelectedNode: LOCAL_FALLBACK.name });
	},

	refresh: async () => {
		// Safe to call at boot: the gate queues the command until Tauri's bridge
		// exists. Only when there IS no bridge at all (a plain browser — the
		// Playwright story harness, browser-mode QA) does this give up, and then it
		// LEAVES STATE ALONE rather than writing an empty node list: an untouched
		// store still resolves `getActiveNode()` to LOCAL_FALLBACK, whereas a wipe
		// would drop every node the user has. A genuine `list_nodes` failure still
		// propagates.
		let data: NodesData;
		try {
			data = await invokeWhenReady<NodesData>("list_nodes");
		} catch (error) {
			if (error instanceof TauriUnavailableError) {
				return;
			}
			throw error;
		}
		set((s) => ({
			localNodes: data.nodes,
			defaultNode: data.default,
			nodes: mergeNodes(data.nodes, s.cloudNodes),
			suggestedCloudNodes: computeSuggestions(
				data.nodes,
				s.cloudNodes,
				s.dismissedCloudUrls
			),
		}));
	},

	hydrateCloudNodes: async () => {
		const managed = await fetchManagedNodes();
		if (managed === null) {
			return;
		}
		// Name managed nodes off the control-plane name, prefixed so they can't
		// collide with a local node's name in the picker. Carry the per-org
		// short-lived user JWT separately from a node bearer. Core validates it
		// against the control-plane JWKS and narrows it to the node's organization.
		// A managed node that advertised no reachable URL is DROPPED, not carried
		// with `url: ""`. An empty base makes `apiUrl` throw before it fetches, so
		// such a node would sit in the picker looking selectable and then fail every
		// call with "No node URL configured" — worse than not offering it at all.
		const cloud = cloudNodesFromManaged(managed);
		set((s) => ({
			cloudNodes: cloud,
			// Added cloud nodes decorate as "Cloud"; the rest surface as suggestions
			// (tied to the active workspace, deduped against added + dismissed URLs).
			nodes: mergeNodes(s.localNodes, cloud),
			suggestedCloudNodes: computeSuggestions(
				s.localNodes,
				cloud,
				s.dismissedCloudUrls
			),
		}));
		// Keep the short-lived node JWT fresh for as long as a cloud node is present
		// (and only then). Idempotent, so re-hydrating never stacks timers; stopping
		// when the set empties avoids a pointless /nodes poll.
		if (cloud.length > 0) {
			startCloudTokenRefresh();
		} else {
			stopCloudTokenRefresh();
		}
	},

	refreshCloudTokens: async () => {
		if (get().cloudNodes.length === 0) {
			return;
		}
		const managed = await fetchManagedNodes();
		// A transient failure / offline server returns null; do NOT wipe the added
		// cloud nodes on that. Keep the existing JWT and try again next tick.
		if (managed === null) {
			return;
		}
		const cloud = cloudNodesFromManaged(managed);
		set((s) => {
			// A successful scope refresh is authoritative. Remove managed nodes that
			// disappeared from it, while retaining all local/LAN nodes and preserving
			// the previous cloud set when the refresh was unavailable above.
			const previousCloudUrls = new Set(
				s.cloudNodes.map((node) => normalizeUrl(node.url))
			);
			const cloudUrls = new Set(cloud.map((node) => normalizeUrl(node.url)));
			const localNodes = s.localNodes.filter(
				(node) =>
					!previousCloudUrls.has(normalizeUrl(node.url)) ||
					cloudUrls.has(normalizeUrl(node.url))
			);
			return {
				cloudNodes: cloud,
				localNodes,
				nodes: mergeNodes(localNodes, cloud),
				suggestedCloudNodes: computeSuggestions(
					localNodes,
					cloud,
					s.dismissedCloudUrls
				),
			};
		});
		if (cloud.length === 0) {
			stopCloudTokenRefresh();
		}
	},

	init: async () => {
		await get().refresh();
		// Best-effort: a signed-out user / no org / offline server all no-op.
		// hydrateCloudNodes itself starts the short-lived-JWT refresh timer when it
		// finds at least one cloud node, so the token never expires mid-session.
		try {
			await get().hydrateCloudNodes();
		} catch {
			// Managed-node hydration is purely additive; never block init on it.
		}
		// Opt-in: only probes when auto-select is on. Off by default, so this is a
		// no-op for the local-first path. Never blocks init on it.
		try {
			await get().probeAutoSelect();
		} catch {
			// probeAutoSelect never throws, but stay defensive.
		}
		// Keep the pick fresh for the rest of the session (opt-in only).
		if (get().autoSelect) {
			startAutoSelectProbe();
		}
		const unlisten = await listenWhenReady("nodes-changed", async () => {
			await get().refresh();
			// The node set changed (added/removed/renamed) — re-pick immediately
			// instead of waiting out the interval. No-ops while auto-select is off.
			await get()
				.probeAutoSelect()
				.catch(() => undefined);
		});
		// Composite teardown: the caller (App.tsx) already invokes this on unmount,
		// so the timers die with the listener rather than outliving the app.
		return () => {
			stopAutoSelectProbe();
			stopCloudTokenRefresh();
			(unlisten as () => void)();
		};
	},
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { fetchManagedNodes } from "@/src/lib/api/managed-nodes.ts";
import { enforcePlanCap } from "@/src/lib/gating/planCapBridge.ts";

export interface Node {
	/**
	 * True for a managed (Ryu Cloud) node hydrated from the control plane (A4 /
	 * #501). Such nodes live in memory only (never persisted to nodes.json) and
	 * the NodeSelector labels them "Cloud". `false`/absent for local + LAN + mesh
	 * nodes the user added.
	 */
	managed?: boolean;
	name: string;
	token: string | null;
	url: string;
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
	removeNode: (name: string) => Promise<void>;
	setAutoSelect: (enabled: boolean) => void;
	setDefault: (name: string) => Promise<void>;
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

export const LOCAL_FALLBACK: Node = {
	name: "local",
	url: "http://127.0.0.1:7980",
	token: null,
};

/** Strip a trailing slash so two spellings of the same URL dedupe. */
const normalizeUrl = (url: string) => url.replace(/\/$/, "");

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
 * Decorate the local node list with the "Cloud" (managed) flag for any node
 * whose URL matches a managed cloud node the org can reach. Local nodes keep
 * their own name + token; only the display-time `managed` flag is added, so an
 * added cloud node shows the Cloud label and the org-wallet nudge. A managed
 * node that is NOT added locally is never injected here — it surfaces as a
 * suggestion instead (see {@link computeSuggestions}).
 */
function decorateLocal(local: Node[], cloud: Node[]): Node[] {
	const cloudUrls = new Set(cloud.map((n) => normalizeUrl(n.url)));
	return local.map((n) =>
		cloudUrls.has(normalizeUrl(n.url)) ? { ...n, managed: true } : n
	);
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
	if (node.token) {
		headers.Authorization = `Bearer ${node.token}`;
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
		await invoke("set_default_node", { name });
		set({ defaultNode: name });
	},

	addNode: async (name, url, token) => {
		// Managed-path numeric cap: free tier gets local Core + 1 remote node. The
		// local fallback never counts; only genuinely remote (LAN/mesh/cloud) nodes
		// do. Off the managed path (not signed in) this is a no-op — self-host stays
		// uncapped. Throws PlanCapError + opens the upgrade modal when over cap.
		const remoteCount = get().localNodes.filter((n) => !isLocalNode(n)).length;
		enforcePlanCap("maxRemoteNodes", remoteCount);
		await invoke("add_node", { name, url, token: token ?? null });
		await get().refresh();
	},

	removeNode: async (name) => {
		await invoke("remove_node", { name });
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
		set({ autoSelect: enabled });
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
		const data = await invoke<NodesData>("list_nodes");
		set((s) => ({
			localNodes: data.nodes,
			defaultNode: data.default,
			nodes: decorateLocal(data.nodes, s.cloudNodes),
			suggestedCloudNodes: computeSuggestions(
				data.nodes,
				s.cloudNodes,
				s.dismissedCloudUrls
			),
		}));
	},

	hydrateCloudNodes: async () => {
		const managed = await fetchManagedNodes();
		// Name managed nodes off the control-plane name, prefixed so they can't
		// collide with a local node's name in the picker. Carry the per-org
		// data-plane token (WS4) so the node authenticates to the hosted gateway;
		// it degrades to null on an older control plane that doesn't mint one yet.
		const cloud: Node[] = managed.map((m) => ({
			name: `cloud-${m.name}`,
			url: m.url,
			token: m.token ?? null,
			managed: true,
		}));
		set((s) => ({
			cloudNodes: cloud,
			// Added cloud nodes decorate as "Cloud"; the rest surface as suggestions
			// (tied to the active workspace, deduped against added + dismissed URLs).
			nodes: decorateLocal(s.localNodes, cloud),
			suggestedCloudNodes: computeSuggestions(
				s.localNodes,
				cloud,
				s.dismissedCloudUrls
			),
		}));
	},

	init: async () => {
		await get().refresh();
		// Best-effort: a signed-out user / no org / offline server all no-op.
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
		const unlisten = await listen("nodes-changed", async () => {
			await get().refresh();
			// The node set changed (added/removed/renamed) — re-pick immediately
			// instead of waiting out the interval. No-ops while auto-select is off.
			await get()
				.probeAutoSelect()
				.catch(() => undefined);
		});
		// Composite teardown: the caller (App.tsx) already invokes this on unmount,
		// so the probe timer dies with the listener rather than outliving the app.
		return () => {
			stopAutoSelectProbe();
			(unlisten as () => void)();
		};
	},
}));

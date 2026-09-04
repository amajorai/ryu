// apps/desktop/src/hooks/useSystemStatus.ts
//
// The system-status spine. Polls Core for liveness (`/api/health`), the active
// engine (`/api/engine/active`), and sidecar run state (`/api/sidecar/status`)
// against the active node, and exposes a single reachable/down + active-engine
// view the shell indicator renders. Degrades gracefully: any fetch failure marks
// Core unreachable rather than throwing or hanging on `loading`.
//
// Shadow reachability is read from the active node's Core (`/api/system/status`,
// the same merged snapshot every other service row uses), NOT a device-local
// probe. Shadow is a fully cross-platform Core-managed sidecar, so its status is
// reported the same on every OS and stays per-node correct for remote nodes.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import type { MeshStatus } from "@/src/lib/api/mesh.ts";
import {
	fetchHealth,
	fetchSystemStatus,
	type SystemStatusSnapshot,
} from "@/src/lib/api/system.ts";
import {
	type ConnectionPhase,
	resolveConnectionPhase,
} from "@/src/lib/connectivity.ts";
import { triggerGlobalRefresh } from "@/src/lib/core-refresh.ts";
import { invokeWhenReady, isTauriReady } from "@/src/lib/tauri-ready.ts";
import { isLocalNode, useNodeStore } from "@/src/store/useNodeStore.ts";

/** The Island Electron companion's loopback control server (see apps/island). */
const ISLAND_CONTROL_URL = "http://127.0.0.1:7989/control";

/** Probe the device-local Island control server; best-effort (may CORS-fail or
 *  be refused when Island isn't running, both → false). */
async function probeIsland(): Promise<boolean> {
	try {
		const resp = await fetch(ISLAND_CONTROL_URL, { method: "GET" });
		return resp.ok;
	} catch {
		return false;
	}
}

/** Read the browser's network hint without assuming a browser during tests. */
function browserIsOnline(): boolean {
	return typeof navigator === "undefined" || navigator.onLine;
}

export interface SystemStatus {
	/** Active engine id reported by Core, or null when none / unreachable. */
	activeEngine: string | null;
	/** Whether the browser currently reports an available network connection. */
	browserOnline: boolean;
	/** User-facing connection phase for the shell status toast. */
	connectionPhase: ConnectionPhase;
	/** Whether Core responded to the last health probe. */
	coreReachable: boolean;
	/** Whether the active engine's process is running. */
	engineRunning: boolean;
	/** Most recent error message, when the last poll failed. */
	error: string | null;
	/**
	 * Whether Core could reach a healthy gateway. False when the gateway is down
	 * OR when Core itself is unreachable (in which case `coreReachable` is the
	 * real signal).
	 */
	gatewayReachable: boolean;
	/**
	 * Whether the device-local Island companion (Electron, loopback :7989) is
	 * running. `null` when Island is not relevant — the active node is remote (a
	 * device-local process has no meaning for another machine). Only `false`
	 * (local node, Island down) is a real "down" signal.
	 */
	islandReachable: boolean | null;
	/** True until the first poll resolves. */
	loading: boolean;
	/**
	 * Whether the mesh is enabled-and-reachable. `null` when mesh is NOT relevant
	 * — either not enabled on this node, the mesh feature is absent (404), or Core
	 * is unreachable. Consumers MUST treat `null` as "not relevant" (it never
	 * contributes amber). Only `false` (enabled but down) is a real "mesh down"
	 * signal. Mirrors `shadowReachable`'s null semantics exactly.
	 */
	meshReachable: boolean | null;
	/**
	 * The full normalized mesh status snapshot when mesh is enabled and Core could
	 * report it; `null` otherwise (disabled / absent / Core down). Surfaces
	 * MagicDNS + peers to the node selector.
	 */
	meshStatus: MeshStatus | null;
	/** Whether the active node answered the latest status request. */
	nodeReachable: boolean | null;
	refresh: () => Promise<void>;
	/**
	 * Whether Shadow is running, as reported by the active node's Core. `null`
	 * only when Core itself is unreachable (status unknown) — consumers must
	 * treat `null` as "not relevant" (it never contributes amber).
	 */
	shadowReachable: boolean | null;
	/** Per-sidecar running map (empty when Core is unreachable). */
	sidecars: Record<string, boolean>;
}

const POLL_INTERVAL_MS = 5000;
const STATUS_PROBE_TIMEOUT_MS = 3000;
const HEALTH_FALLBACK_TIMEOUT_MS = 1500;

/** Bound a black-holed node so the shell can say "offline" promptly. */
async function fetchSystemStatusWithTimeout(
	target: ApiTarget
): Promise<SystemStatusSnapshot> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS);
	try {
		return await fetchSystemStatus(target, controller.signal);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * `/api/system/status` is a rich snapshot and can be briefly unavailable while
 * a local engine is starting, restarting, or under load. Confirm basic node
 * liveness before showing the user an offline banner; a healthy Core should not
 * look disconnected just because its optional status aggregation missed one
 * poll.
 */
async function fetchHealthWithTimeout(target: ApiTarget): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		HEALTH_FALLBACK_TIMEOUT_MS
	);
	try {
		await fetchHealth(target, controller.signal);
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Tauri can still reach the local Core when the webview's CORS preflight is
 * briefly delayed or rejected. Use the native probe as a local-only transport
 * fallback so the shell does not tell a user their working node is offline.
 */
async function probeLocalNodeNative(name: string): Promise<boolean> {
	if (!isTauriReady()) {
		return false;
	}
	try {
		const result = await invokeWhenReady<{ online?: unknown }>("test_node", {
			name,
		});
		return result.online === true;
	} catch {
		return false;
	}
}

export function useSystemStatus(): SystemStatus {
	const getActiveNode = useNodeStore((s) => s.getActiveNode);
	const setActiveNodeOnline = useNodeStore((s) => s.setActiveNodeOnline);
	const activeNodeUrl = useNodeStore((s) => s.getActiveNode().url);
	const [coreReachable, setCoreReachable] = useState(false);
	const [browserOnline, setBrowserOnline] = useState(browserIsOnline);
	const [nodeReachable, setNodeReachable] = useState<boolean | null>(null);
	const [activeEngine, setActiveEngine] = useState<string | null>(null);
	const [engineRunning, setEngineRunning] = useState(false);
	const [sidecars, setSidecars] = useState<Record<string, boolean>>({});
	const [gatewayReachable, setGatewayReachable] = useState(false);
	// null until the first poll resolves (or when Core is unreachable); true/false
	// once Core reports Shadow's run state in the merged status snapshot.
	const [shadowReachable, setShadowReachable] = useState<boolean | null>(null);
	// null = Island not relevant (active node is remote); true/false once the
	// device-local :7989 control probe resolves for a local node.
	const [islandReachable, setIslandReachable] = useState<boolean | null>(null);
	// null = mesh not relevant (disabled / absent / Core down); false = enabled
	// but unreachable; true = enabled + reachable. Mirrors shadowReachable.
	const [meshReachable, setMeshReachable] = useState<boolean | null>(null);
	const [meshStatus, setMeshStatus] = useState<MeshStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	// Tracks the previous reachability so we can fire ONE global refresh the moment
	// Core comes back — not on the first successful poll. `null` = never probed yet.
	const wasReachableRef = useRef<boolean | null>(null);
	const activeNodeUrlRef = useRef(activeNodeUrl);
	const latestPollRef = useRef(0);

	const poll = useCallback(async () => {
		const node = getActiveNode();
		const pollId = latestPollRef.current + 1;
		latestPollRef.current = pollId;
		const target: ApiTarget = {
			url: node.url,
			token: node.token,
			userJwt: node.userJwt ?? null,
		};
		const local = isLocalNode(node);

		// Core merges engine/sidecar/gateway/mesh (and the degrade rules) into one
		// call, so the client makes a single request. Shadow's run state rides in
		// `snapshot.sidecars` like every other Core-managed sidecar — no separate
		// device-local probe (which was Windows-only and wrong for remote nodes).
		//
		// Island is the exception: it is a device-local Electron process (loopback
		// :7989), NOT a Core sidecar, so Core cannot report it. Probe it directly,
		// but only for a local node — a device-local process is meaningless for a
		// remote machine (→ null, "not relevant"). The probe is independent of the
		// Core snapshot, so it is set even when Core itself is down.
		const [statusResult, islandUp] = await Promise.all([
			fetchSystemStatusWithTimeout(target)
				.then((snapshot) => ({ error: null as unknown, snapshot }))
				.catch((error: unknown) => ({ error, snapshot: null })),
			local ? probeIsland() : Promise.resolve(false),
		]);
		if (pollId !== latestPollRef.current || getActiveNode().url !== node.url) {
			return;
		}
		setIslandReachable(local ? islandUp : null);
		const { error: statusError, snapshot } = statusResult;

		// A failed status call is the single "Core down" signal: clear every derived
		// slice rather than surfacing stale "up" data. Shadow + mesh → null (unknown,
		// not down) so the tone stays driven by coreReachable.
		if (!snapshot) {
			// A typed ApiError means the node answered and rejected the status route;
			// that is a live node with an unavailable status endpoint, not a network
			// outage. Transport errors are the only failures that mark the node down.
			const nodeAnswered =
				statusError instanceof ApiError ||
				(
					await Promise.all([
						fetchHealthWithTimeout(target),
						local ? probeLocalNodeNative(node.name) : Promise.resolve(false),
					])
				).some(Boolean);
			setNodeReachable(nodeAnswered);
			setActiveNodeOnline(nodeAnswered);
			setCoreReachable(nodeAnswered);
			setActiveEngine(null);
			setEngineRunning(false);
			setSidecars({});
			setGatewayReachable(false);
			setShadowReachable(null);
			setMeshReachable(null);
			setMeshStatus(null);
			setError(nodeAnswered ? "Core status unavailable" : "Core unreachable");
			setLoading(false);
			wasReachableRef.current = false;
			return;
		}

		// Core just came back after being down: refetch every data source once so
		// the whole app recovers on its own — no per-section "Try again" needed.
		if (wasReachableRef.current === false) {
			triggerGlobalRefresh();
		}
		wasReachableRef.current = true;

		setCoreReachable(true);
		setNodeReachable(true);
		setActiveNodeOnline(true);
		setError(null);
		setActiveEngine(snapshot.activeEngine);
		setEngineRunning(snapshot.engineRunning);
		setSidecars(snapshot.sidecars);
		setGatewayReachable(snapshot.gatewayReachable);
		// Shadow is opt-in; Core always lists it, so `?? null` only trips on an
		// older Core that omits the entry (treated as not-relevant, not "down").
		setShadowReachable(snapshot.sidecars.shadow ?? null);
		// mesh is null when disabled/absent; when enabled, reachable drives the tone.
		setMeshStatus(snapshot.mesh);
		setMeshReachable(snapshot.mesh === null ? null : snapshot.mesh.reachable);
		setLoading(false);
	}, [getActiveNode, setActiveNodeOnline]);

	useEffect(() => {
		poll().catch(() => undefined);
		intervalRef.current = setInterval(() => {
			poll().catch(() => undefined);
		}, POLL_INTERVAL_MS);
		return () => {
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
			}
		};
	}, [poll]);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		const onOffline = () => {
			setBrowserOnline(false);
			setNodeReachable(false);
			setActiveNodeOnline(false);
			wasReachableRef.current = false;
		};
		const onOnline = () => {
			setBrowserOnline(true);
			setNodeReachable(null);
			setActiveNodeOnline(null);
			setLoading(true);
			poll().catch(() => undefined);
		};
		window.addEventListener("offline", onOffline);
		window.addEventListener("online", onOnline);
		return () => {
			window.removeEventListener("offline", onOffline);
			window.removeEventListener("online", onOnline);
		};
	}, [poll, setActiveNodeOnline]);

	useEffect(() => {
		if (activeNodeUrlRef.current === activeNodeUrl) {
			return;
		}
		activeNodeUrlRef.current = activeNodeUrl;
		wasReachableRef.current = false;
		setNodeReachable(null);
		setActiveNodeOnline(null);
		setLoading(true);
		poll().catch(() => undefined);
	}, [activeNodeUrl, poll, setActiveNodeOnline]);

	return {
		coreReachable,
		browserOnline,
		connectionPhase: resolveConnectionPhase({
			browserOnline,
			loading,
			nodeReachable,
		}),
		activeEngine,
		engineRunning,
		sidecars,
		gatewayReachable,
		shadowReachable,
		islandReachable,
		meshReachable,
		meshStatus,
		loading,
		nodeReachable,
		error,
		refresh: poll,
	};
}

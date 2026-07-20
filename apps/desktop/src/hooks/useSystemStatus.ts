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
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { MeshStatus } from "@/src/lib/api/mesh.ts";
import { fetchSystemStatus } from "@/src/lib/api/system.ts";
import { triggerGlobalRefresh } from "@/src/lib/core-refresh.ts";
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

export interface SystemStatus {
	/** Active engine id reported by Core, or null when none / unreachable. */
	activeEngine: string | null;
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

export function useSystemStatus(): SystemStatus {
	const getActiveNode = useNodeStore((s) => s.getActiveNode);
	const [coreReachable, setCoreReachable] = useState(false);
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

	const poll = useCallback(async () => {
		const node = getActiveNode();
		const target: ApiTarget = { url: node.url, token: node.token ?? null };
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
		const [snapshot, islandUp] = await Promise.all([
			fetchSystemStatus(target).catch(() => null),
			local ? probeIsland() : Promise.resolve(false),
		]);
		setIslandReachable(local ? islandUp : null);

		// A failed status call is the single "Core down" signal: clear every derived
		// slice rather than surfacing stale "up" data. Shadow + mesh → null (unknown,
		// not down) so the tone stays driven by coreReachable.
		if (!snapshot) {
			setCoreReachable(false);
			setActiveEngine(null);
			setEngineRunning(false);
			setSidecars({});
			setGatewayReachable(false);
			setShadowReachable(null);
			setMeshReachable(null);
			setMeshStatus(null);
			setError("Core unreachable");
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
	}, [getActiveNode]);

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

	return {
		coreReachable,
		activeEngine,
		engineRunning,
		sidecars,
		gatewayReachable,
		shadowReachable,
		islandReachable,
		meshReachable,
		meshStatus,
		loading,
		error,
		refresh: poll,
	};
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRyuStatus, startRyuCore } from "@/lib/tauri-bridge.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchHealth, fetchSystemStatus } from "@/src/lib/api/system.ts";
import { checkForUpdate, type UpdateCheck } from "@/src/lib/api/update.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";

/** The Island Electron companion's loopback control server (see apps/island). */
export const ISLAND_CONTROL_URL = "http://127.0.0.1:7989/control";

export const POLL_INTERVAL_MS = 2500;

/** The full health snapshot the page polls into. */
export interface Health {
	coreState: "running" | "starting" | "stopped";
	coreUpdate: UpdateCheck | null;
	coreVersion: string | null;
	gatewayReachable: boolean | null;
	islandReachable: boolean | null;
	loading: boolean;
	/** name -> running, from /api/system/status. */
	sidecars: { name: string; running: boolean }[];
}

export const INITIAL_HEALTH: Health = {
	coreState: "starting",
	coreVersion: null,
	coreUpdate: null,
	gatewayReachable: null,
	islandReachable: null,
	loading: true,
	sidecars: [],
};

/** Probe the Island loopback control server; best-effort (may CORS-fail). */
export async function probeIsland(): Promise<boolean> {
	try {
		const resp = await fetch(ISLAND_CONTROL_URL, { method: "GET" });
		return resp.ok;
	} catch {
		return false;
	}
}

export function usePreflightHealth(target: ApiTarget) {
	const scope = useMemo(
		() => ({
			target: { ...target },
			controller: new AbortController(),
			autoStarted: false,
			poll: 0,
			polling: new Set<AbortSignal>(),
		}),
		[target.url, target.token, target.userJwt]
	);
	const current = useRef(scope);
	current.current = scope;
	const [result, setResult] = useState<{
		scope: typeof scope;
		health: Health;
	}>();
	const setCoreStatus = useAppStore((store) => store.setCoreStatus);
	const poll = useCallback(async () => {
		const signal = scope.controller.signal;
		if (scope.polling.has(signal)) {
			return;
		}
		scope.polling.add(signal);
		try {
			const sequence = ++scope.poll;
			const owns = () =>
				current.current === scope && !signal.aborted && sequence === scope.poll;
			const target = scope.target;
			const local = isLocalNode(target);
			const status = local
				? await getRyuStatus().catch(() => "stopped")
				: await fetchHealth(target, signal)
						.then(() => "running")
						.catch(() => "stopped");
			if (!owns()) {
				return;
			}
			const coreRunning = status === "running";
			if (local && !(coreRunning || scope.autoStarted)) {
				scope.autoStarted = true;
				void startRyuCore().catch(() => undefined);
			}
			if (!coreRunning) {
				const island = await probeIsland();
				if (owns()) {
					setResult({
						scope,
						health: {
							...INITIAL_HEALTH,
							coreState: "stopped",
							islandReachable: island,
							loading: false,
						},
					});
				}
				return;
			}
			const [sys, health, update, island] = await Promise.all([
				fetchSystemStatus(target).catch(() => null),
				fetchHealth(target, signal).catch(() => null),
				checkForUpdate(target, { signal }).catch(() => null),
				probeIsland(),
			]);
			if (!owns()) {
				return;
			}
			setCoreStatus("running");
			setResult({
				scope,
				health: {
					coreState: "running",
					coreVersion: health?.version ?? null,
					coreUpdate: update,
					gatewayReachable: sys?.gatewayReachable ?? false,
					islandReachable: island,
					loading: false,
					sidecars: sys
						? Object.entries(sys.sidecars).map(([name, running]) => ({
								name,
								running,
							}))
						: [],
				},
			});
		} finally {
			scope.polling.delete(signal);
		}
	}, [scope, setCoreStatus]);
	useEffect(() => {
		scope.controller = new AbortController();
		void poll().catch(() => undefined);
		const timer = setInterval(() => {
			void poll().catch(() => undefined);
		}, POLL_INTERVAL_MS);
		return () => {
			scope.controller.abort();
			clearInterval(timer);
		};
	}, [scope, poll]);
	return {
		health: result?.scope === scope ? result.health : INITIAL_HEALTH,
		refresh: poll,
	};
}

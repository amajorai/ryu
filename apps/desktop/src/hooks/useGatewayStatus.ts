// apps/desktop/src/hooks/useGatewayStatus.ts
//
// Polls Core's gateway-status proxy (`/api/gateway/status`) against the active
// node and exposes the combined health + metrics snapshot for the Gateway view.
// Degrades gracefully: a failed proxy/Core call surfaces an error and marks the
// gateway unreachable rather than throwing.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayStatus,
	type GatewayStatus,
} from "@/src/lib/api/gateway.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

const POLL_INTERVAL_MS = 5000;

export interface UseGatewayStatus {
	/** Set when the Core proxy call itself failed (Core unreachable). */
	error: string | null;
	loading: boolean;
	refresh: () => Promise<void>;
	status: GatewayStatus | null;
}

export function useGatewayStatus(): UseGatewayStatus {
	const getActiveNode = useNodeStore((s) => s.getActiveNode);
	const [status, setStatus] = useState<GatewayStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const poll = useCallback(async () => {
		const node = getActiveNode();
		const target: ApiTarget = { url: node.url, token: node.token ?? null };
		try {
			const next = await fetchGatewayStatus(target);
			setStatus(next);
			setError(null);
		} catch (e) {
			// A throw here means Core (not the gateway) is unreachable: the proxy
			// returns 200 + reachable:false when the gateway alone is down.
			setStatus(null);
			setError(e instanceof Error ? e.message : "Core unreachable");
		} finally {
			setLoading(false);
		}
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

	return { status, loading, error, refresh: poll };
}

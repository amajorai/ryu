// Gateway metrics are only needed while settings is open. Keep one request in
// flight, and dispose both the request and its next poll when the scope changes.
import { useCallback, useEffect, useRef, useState } from "react";
import {
	fetchGatewayStatus,
	type GatewayStatus,
} from "@/src/lib/api/gateway.ts";
import { useActiveNode } from "./useActiveNode.ts";

const POLL_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface UseGatewayStatus {
	error: string | null;
	loading: boolean;
	refresh: () => Promise<void>;
	status: GatewayStatus | null;
}

export function useGatewayStatus(enabled = true): UseGatewayStatus {
	const node = useActiveNode();
	const { url, token, userJwt } = node;
	const [status, setStatus] = useState<GatewayStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const refreshRef = useRef<() => Promise<void>>(async () => undefined);
	const refresh = useCallback(() => refreshRef.current(), []);

	useEffect(() => {
		setStatus(null);
		setError(null);
		setLoading(enabled);
		if (!enabled) {
			return;
		}

		const lifetime = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let inFlight: Promise<void> | undefined;
		const poll = (): Promise<void> => {
			if (inFlight) {
				return inFlight;
			}
			clearTimeout(timer);
			inFlight = (async () => {
				try {
					const next = await fetchGatewayStatus(
						{ url, token, userJwt: userJwt ?? null },
						AbortSignal.any([
							lifetime.signal,
							AbortSignal.timeout(REQUEST_TIMEOUT_MS),
						])
					);
					if (!lifetime.signal.aborted) {
						setStatus(next);
						setError(null);
					}
				} catch (cause) {
					if (!lifetime.signal.aborted) {
						setStatus(null);
						setError(
							cause instanceof Error ? cause.message : "Core unreachable"
						);
					}
				} finally {
					inFlight = undefined;
					if (!lifetime.signal.aborted) {
						setLoading(false);
						timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
					}
				}
			})();
			return inFlight;
		};

		refreshRef.current = poll;
		void poll();
		return () => {
			lifetime.abort();
			clearTimeout(timer);
			refreshRef.current = async () => undefined;
		};
	}, [enabled, url, token, userJwt]);

	return { status, loading, error, refresh };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import { fetchGatewayConfig } from "@/src/lib/api/gateway.ts";
import {
	answerSecurityKeyRequest,
	listSecurityKeyRequests,
	type PendingSecurityKeyRequest,
	type SecurityKeyDecision,
	withLocalDeadline,
} from "@/src/lib/api/security-key.ts";
import {
	isLocalNode,
	LOCAL_FALLBACK,
	useNodeStore,
} from "@/src/store/useNodeStore.ts";

/** How often the active node's Core is asked for waiting requests. */
export const SECURITY_KEY_POLL_MS = 2000;
/** How often this device's "Allow hardware security key" setting is re-read. */
export const SECURITY_KEY_GATE_REFRESH_MS = 15_000;

export interface SecurityKeyRequestsState {
	/** Answer a request; it leaves the queue whether or not Core accepted it. */
	answer: (id: string, decision: SecurityKeyDecision) => Promise<void>;
	/** This device's setting allows its key to answer remote browsers. */
	enabled: boolean;
	/** Name of the node whose Core holds the request. */
	nodeName: string;
	/**
	 * The oldest unanswered, unexpired request, or null. Its `expires_at_ms`
	 * is on this device's clock (see `withLocalDeadline`), not the node's.
	 */
	request: PendingSecurityKeyRequest | null;
}

/** Equality on the target's credential, so a re-render never restarts a loop. */
function useStableTarget(target: ApiTarget): ApiTarget {
	const { token, url, userJwt } = target;
	return useMemo(
		() => ({ token, url, userJwt: userJwt ?? null }),
		[token, url, userJwt]
	);
}

/** Wait `ms`, or resolve early when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

/**
 * Whether THIS device's Gateway allows its security key to be used:
 * `computer_use.security_key === true` on the local node, re-read
 * periodically so a toggle in Settings takes effect without a restart. Any
 * failure to read it counts as off.
 */
function useLocalSecurityKeyGate(): boolean {
	const localNode = useNodeStore(
		(state) => state.localNodes.find(isLocalNode) ?? LOCAL_FALLBACK
	);
	const localTarget = useStableTarget(toTarget(localNode));
	const [enabled, setEnabled] = useState(false);

	useEffect(() => {
		const controller = new AbortController();
		const run = async () => {
			while (!controller.signal.aborted) {
				let allowed = false;
				try {
					const config = await fetchGatewayConfig(
						localTarget,
						controller.signal
					);
					allowed = config.computer_use?.security_key === true;
				} catch {
					allowed = false;
				}
				if (controller.signal.aborted) {
					return;
				}
				setEnabled(allowed);
				await pause(SECURITY_KEY_GATE_REFRESH_MS, controller.signal);
			}
		};
		run().catch(() => undefined);
		return () => controller.abort();
	}, [localTarget]);

	return enabled;
}

/**
 * Security-key requests from browsers on the active node (a VM, cloud node or
 * Bot lane) that want the hardware key plugged into this device. Polls the
 * active node's Core every {@link SECURITY_KEY_POLL_MS} only while this
 * device's own setting is on; with it off nothing is fetched and a waiting
 * page's request times out with `NotAllowedError`.
 */
export function useSecurityKeyRequests(): SecurityKeyRequestsState {
	const enabled = useLocalSecurityKeyGate();
	const activeNode = useActiveNode();
	const target = useStableTarget(toTarget(activeNode));
	const [requests, setRequests] = useState<PendingSecurityKeyRequest[]>([]);
	const [now, setNow] = useState(() => Date.now());
	// Answered ids stay hidden even if a poll in flight still lists them.
	const answered = useRef(new Set<string>());
	// When each listed request first arrived, on this device's clock. The
	// node's clock may be far off ours, so deadlines are rebased onto this.
	const received = useRef(new Map<string, number>());

	useEffect(() => {
		if (!enabled) {
			setRequests([]);
			return;
		}
		received.current.clear();
		const controller = new AbortController();
		const run = async () => {
			while (!controller.signal.aborted) {
				try {
					const next = await listSecurityKeyRequests(target, controller.signal);
					if (controller.signal.aborted) {
						return;
					}
					const receivedAt = Date.now();
					const listed = new Set(next.map((entry) => entry.id));
					for (const id of answered.current) {
						if (!listed.has(id)) {
							answered.current.delete(id);
						}
					}
					for (const id of received.current.keys()) {
						if (!listed.has(id)) {
							received.current.delete(id);
						}
					}
					const local: PendingSecurityKeyRequest[] = [];
					for (const entry of next) {
						if (answered.current.has(entry.id)) {
							continue;
						}
						const firstSeen = received.current.get(entry.id) ?? receivedAt;
						received.current.set(entry.id, firstSeen);
						local.push(withLocalDeadline(entry, firstSeen));
					}
					setRequests(local);
					setNow(receivedAt);
				} catch {
					// An unreachable or older Core keeps the last known list; the
					// expiry filter below still drops requests whose time is up.
					setNow(Date.now());
				}
				await pause(SECURITY_KEY_POLL_MS, controller.signal);
			}
		};
		run().catch(() => undefined);
		return () => {
			controller.abort();
			setRequests([]);
		};
	}, [enabled, target]);

	const answer = useCallback(
		async (id: string, decision: SecurityKeyDecision) => {
			answered.current.add(id);
			setRequests((current) => current.filter((entry) => entry.id !== id));
			await answerSecurityKeyRequest(target, id, decision);
		},
		[target]
	);

	const request =
		requests.find(
			(entry) => !answered.current.has(entry.id) && entry.expires_at_ms > now
		) ?? null;

	return { answer, enabled, nodeName: activeNode.name, request };
}

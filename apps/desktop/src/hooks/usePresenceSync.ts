import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { reportPresence } from "@/src/lib/api/presence.ts";
import {
	getCorePresenceStatus,
	setDetectedGame,
	setDetectedStreamingApp,
	setStreamingPrivacyActive,
	subscribeUserAvailability,
} from "@/src/lib/user-availability.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** Well inside Core's 150 s report TTL, so a live desktop never reads as stale. */
const PRESENCE_HEARTBEAT_MS = 10_000;

/**
 * One id per window. Each window has its own idle clock, so Core keeps a report
 * per window and merges them; an idle second window must not mark the user away
 * while they work in the first.
 */
const PRESENCE_CLIENT_ID =
	globalThis.crypto?.randomUUID === undefined
		? `window-${Date.now()}-${Math.random().toString(36).slice(2)}`
		: crypto.randomUUID();

/**
 * Keep Core's view of the user's availability current.
 *
 * Core decides whether an agent's question blocks its turn, so it needs to know
 * when nobody is there to answer. It also reports back detected games and
 * streaming apps, which the availability store folds into the status.
 */
export function usePresenceSync(): void {
	const queryClient = useQueryClient();
	const node = useActiveNode();
	const url = node.url;
	const token = node.token;
	const userJwt = node.userJwt ?? null;

	useEffect(() => {
		const target = { token, url, userJwt };
		let cancelled = false;
		let lastReported: string | null = null;
		let lastStreamingPrivacyActive: boolean | null = null;

		const updateStreamingPrivacy = (active: boolean) => {
			setStreamingPrivacyActive(active);
			if (lastStreamingPrivacyActive !== active) {
				lastStreamingPrivacyActive = active;
				void queryClient.invalidateQueries({ queryKey: ["notifications"] });
			}
		};

		const report = async () => {
			const status = getCorePresenceStatus();
			lastReported = status;
			try {
				const snapshot = await reportPresence(
					target,
					status,
					PRESENCE_CLIENT_ID
				);
				if (!cancelled) {
					setDetectedGame(snapshot.gaming.detectedGame?.name ?? null);
					setDetectedStreamingApp(
						snapshot.streaming?.detectedApp?.name ?? null
					);
					updateStreamingPrivacy(snapshot.streaming?.active ?? false);
				}
			} catch {
				// An older Core without presence, or a node that is briefly down:
				// questions keep their previous behaviour and the next beat retries.
				if (!cancelled) {
					setDetectedGame(null);
					setDetectedStreamingApp(null);
					updateStreamingPrivacy(false);
				}
			}
		};

		report();
		const heartbeat = setInterval(report, PRESENCE_HEARTBEAT_MS);
		const unsubscribe = subscribeUserAvailability(() => {
			if (getCorePresenceStatus() !== lastReported) {
				report();
			}
		});
		return () => {
			cancelled = true;
			clearInterval(heartbeat);
			unsubscribe();
		};
	}, [token, url, userJwt, queryClient]);
}

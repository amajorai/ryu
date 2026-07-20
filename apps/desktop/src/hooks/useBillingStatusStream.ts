// apps/desktop/src/hooks/useBillingStatusStream.ts
//
// Live subscription + seat status for the caller's active org, streamed from the
// control-plane server (`/api/billing/status/stream`) via the shared SSE reader
// (lib/api/teams-billing.ts → @ryuhq/protocol/sse). Any billing UI can mount this
// to reflect a plan change, renewal, cancellation, or seat update the moment the
// Polar/Stripe webhook lands, without polling.
//
// Like useWalletStream, this targets :3000 (session-authed) rather than the
// active Core node, so it lives outside the node-scoped query cache. It keeps a
// single reconnecting socket alive for the component's lifetime: the server
// re-sends the current status as a snapshot frame on every (re)connect, so a push
// missed while disconnected self-heals.

import { useEffect, useState } from "react";
import {
	type BillingStatusUpdate,
	hasTeamsBillingAuth,
	openBillingStatusStream,
} from "@/src/lib/api/teams-billing.ts";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/** Pause that resolves early when the stream is torn down. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
	});
}

/** Run (and keep reconnecting) the billing-status stream until `signal` aborts. */
async function runBillingStatusStream(
	signal: AbortSignal,
	onStatus: (status: BillingStatusUpdate) => void
): Promise<void> {
	let backoff = INITIAL_BACKOFF_MS;
	while (!signal.aborted) {
		if (hasTeamsBillingAuth()) {
			try {
				for await (const message of openBillingStatusStream(signal)) {
					onStatus(message.data);
					backoff = INITIAL_BACKOFF_MS; // a live frame resets the backoff
				}
			} catch {
				// Connect/read failed (sign-out, control-plane restart) — reconnect.
			}
		}
		if (signal.aborted) {
			break;
		}
		// When signed out we have no token; wait a full interval before retrying so
		// a later sign-in is picked up without hot-looping.
		await delay(hasTeamsBillingAuth() ? backoff : MAX_BACKOFF_MS, signal);
		backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
	}
}

/**
 * Subscribe to the active org's live billing status. Returns the latest
 * {@link BillingStatusUpdate} (null until the first snapshot frame arrives),
 * updating in place as subscription/seat changes land.
 */
export function useBillingStatusStream(): BillingStatusUpdate | null {
	const [status, setStatus] = useState<BillingStatusUpdate | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		runBillingStatusStream(controller.signal, setStatus).catch(() => {
			// runBillingStatusStream swallows its own errors and never rejects.
		});
		return () => controller.abort();
	}, []);

	return status;
}

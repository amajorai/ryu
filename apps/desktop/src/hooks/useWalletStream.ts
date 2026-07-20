// apps/desktop/src/hooks/useWalletStream.ts
//
// Live platform-credits balance for the caller's active org, streamed from the
// control-plane server (`/api/credits/wallet/stream`) via the shared SSE reader
// (lib/api/credits.ts → @ryuhq/protocol/sse). Any balance UI can mount this to
// reflect top-ups/debits the moment they land, without polling.
//
// Like useChannelStatus, this targets :3000 (session-authed) rather than the
// active Core node, so it lives outside the node-scoped query cache. It keeps a
// single reconnecting socket alive for the component's lifetime: the server
// re-sends the current balance as a snapshot frame on every (re)connect, so a
// heartbeat missed while disconnected self-heals.

import { useEffect, useState } from "react";
import {
	hasCreditsAuth,
	openWalletStream,
	type WalletUpdate,
} from "@/src/lib/api/credits.ts";

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

/** Run (and keep reconnecting) the wallet stream until `signal` aborts. */
async function runWalletStream(
	signal: AbortSignal,
	onWallet: (wallet: WalletUpdate) => void
): Promise<void> {
	let backoff = INITIAL_BACKOFF_MS;
	while (!signal.aborted) {
		if (hasCreditsAuth()) {
			try {
				for await (const message of openWalletStream(signal)) {
					onWallet(message.data);
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
		await delay(hasCreditsAuth() ? backoff : MAX_BACKOFF_MS, signal);
		backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
	}
}

/**
 * Subscribe to the active org's live wallet balance. Returns the latest
 * {@link WalletUpdate} (null until the first snapshot frame arrives), updating in
 * place as top-ups/debits land.
 */
export function useWalletStream(): WalletUpdate | null {
	const [wallet, setWallet] = useState<WalletUpdate | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		runWalletStream(controller.signal, setWallet).catch(() => {
			// runWalletStream swallows its own errors and never rejects.
		});
		return () => controller.abort();
	}, []);

	return wallet;
}

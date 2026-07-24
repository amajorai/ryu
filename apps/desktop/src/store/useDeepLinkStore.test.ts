// apps/desktop/src/store/useDeepLinkStore.test.ts
//
// Tests for the pending `ryu://` deep-link queue that hands an intent from the
// Tauri event listener to the confirm dialog. The load-bearing detail is the
// monotonic `nonce`: `/models` is a singleton tab that may already be mounted
// when a link arrives, so the dialog re-opens by reacting to the nonce
// *changing*, not to a fresh mount. If two identical links fire, the intent is
// value-equal but the nonce must still advance, or the second link is swallowed.

import { beforeEach, describe, expect, test } from "bun:test";
import type { DeepLinkIntent } from "@ryuhq/protocol/deep-link";
import { useDeepLinkStore } from "./useDeepLinkStore.ts";

// A minimal intent; the store treats it opaquely, so the exact shape only needs
// to satisfy the type.
const intent = { type: "open-models" } as unknown as DeepLinkIntent;

beforeEach(() => {
	useDeepLinkStore.setState({ pending: null });
});

describe("useDeepLinkStore", () => {
	test("starts empty", () => {
		expect(useDeepLinkStore.getState().pending).toBeNull();
	});

	test("request queues the intent and starts the nonce at 1", () => {
		useDeepLinkStore.getState().request(intent);
		const { pending } = useDeepLinkStore.getState();
		expect(pending?.intent).toBe(intent);
		expect(pending?.nonce).toBe(1);
	});

	test("a second identical request advances the nonce so the dialog re-opens", () => {
		const { request } = useDeepLinkStore.getState();
		request(intent);
		request(intent);
		expect(useDeepLinkStore.getState().pending?.nonce).toBe(2);
	});

	test("clear resets to no pending intent", () => {
		useDeepLinkStore.getState().request(intent);
		useDeepLinkStore.getState().clear();
		expect(useDeepLinkStore.getState().pending).toBeNull();
	});

	test("requesting after a clear restarts the nonce from 1", () => {
		const { request, clear } = useDeepLinkStore.getState();
		request(intent);
		request(intent); // nonce 2
		clear(); // pending back to null
		request(intent);
		// nonce derives from `state.pending?.nonce ?? 0`, so a cleared queue
		// begins again at 1.
		expect(useDeepLinkStore.getState().pending?.nonce).toBe(1);
	});
});

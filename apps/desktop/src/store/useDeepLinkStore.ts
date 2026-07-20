import type { DeepLinkIntent } from "@ryuhq/protocol/deep-link";
import { create } from "zustand";

// A pending `ryu://` deep-link intent, handed from the Tauri event listener to
// the confirm dialog. A monotonic `nonce` makes each request distinct so the
// dialog re-opens even when the same link fires twice (the consumer reacts to
// the value changing, not to a one-time mount — `/models` is a singleton tab
// that may already be mounted when the link arrives).
export interface PendingDeepLink {
	intent: DeepLinkIntent;
	nonce: number;
}

interface DeepLinkState {
	/** Clear the pending intent once handled (or dismissed). */
	clear: () => void;
	pending: PendingDeepLink | null;
	/** Queue an intent for the confirm dialog. */
	request: (intent: DeepLinkIntent) => void;
}

export const useDeepLinkStore = create<DeepLinkState>((set) => ({
	pending: null,
	request: (intent) =>
		set((state) => ({
			pending: { intent, nonce: (state.pending?.nonce ?? 0) + 1 },
		})),
	clear: () => set({ pending: null }),
}));

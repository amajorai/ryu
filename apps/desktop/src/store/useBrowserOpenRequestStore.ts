import { create } from "zustand";

export interface BrowserOpenRequest {
	nonce: number;
	url: string;
}

interface BrowserOpenRequestState {
	clear: () => void;
	open: (url: string) => void;
	pending: BrowserOpenRequest | null;
}

// Monotonic for the whole session. The panel clears `pending` as soon as it
// consumes a request, so deriving the nonce from `pending` would restart at 1
// every time and a repeated request for the same URL would look already handled.
let nextOpenNonce = 0;

/** One-shot bridge from an agent navigation event to the Browser dock panel. */
export const useBrowserOpenRequestStore = create<BrowserOpenRequestState>(
	(set) => ({
		pending: null,
		open: (url) => {
			nextOpenNonce += 1;
			set({ pending: { nonce: nextOpenNonce, url } });
		},
		clear: () => set({ pending: null }),
	})
);

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

/** One-shot bridge from an agent navigation event to the Browser dock panel. */
export const useBrowserOpenRequestStore = create<BrowserOpenRequestState>(
	(set) => ({
		pending: null,
		open: (url) =>
			set((state) => ({
				pending: { nonce: (state.pending?.nonce ?? 0) + 1, url },
			})),
		clear: () => set({ pending: null }),
	})
);

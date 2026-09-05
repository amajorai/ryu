import { create } from "zustand";

export interface TerminalCommandRequest {
	command: string;
	cwd: string | null;
	env?: Record<string, string>;
	shell: string | null;
}

export interface DockPanelRequest {
	command?: TerminalCommandRequest;
	kind: string;
	label: string;
	nonce: number;
	side?: "bottom" | "right";
}

let requestNonce = 0;

interface DockPanelRequestState {
	clear: () => void;
	open: (
		kind: string,
		label: string,
		side?: "bottom" | "right",
		command?: TerminalCommandRequest
	) => void;
	pending: DockPanelRequest | null;
}

/** Programmatic seam for opening or focusing a workspace panel. */
export const useDockPanelRequestStore = create<DockPanelRequestState>(
	(set) => ({
		pending: null,
		open: (kind, label, side, command) =>
			set({
				pending: {
					kind,
					label,
					nonce: ++requestNonce,
					...(command ? { command } : {}),
					...(side ? { side } : {}),
				},
			}),
		clear: () => set({ pending: null }),
	})
);

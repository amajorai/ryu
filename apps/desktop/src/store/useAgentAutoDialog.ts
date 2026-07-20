import { create } from "zustand";

// A tiny global so any surface can open the agent-auto routing editor (the
// Plane B "pick which agent serves the turn" rules, surfaced as the universal
// picker's "Auto" row). Mirrors `useGatewayDialog`: the dialog is rendered once
// (next to the Gateway dialog in NodeSelector) and reads this store, so there is
// a single instance regardless of how many places trigger it — which also keeps
// it clear of the picker dropdown's portal, so opening it never races the
// dropdown's own dismiss-on-outside-click teardown.
interface AgentAutoDialogState {
	/** Whether the agent-auto routing editor is open. */
	open: boolean;
	/** Open the editor. */
	openAgentAutoConfig: () => void;
	/** Controlled open/close passthrough for the dialog's onOpenChange. */
	setOpen: (open: boolean) => void;
}

export const useAgentAutoDialog = create<AgentAutoDialogState>((set) => ({
	open: false,
	openAgentAutoConfig: () => set({ open: true }),
	setOpen: (open) => set({ open }),
}));

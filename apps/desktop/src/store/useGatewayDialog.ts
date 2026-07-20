import { create } from "zustand";

// The named sections of the Gateway settings dialog. Kept here (not in
// GatewayDialog.tsx) so external openers — the command palette, deep links, the
// Settings page — can request a specific section without importing the dialog
// component (which would pull the whole gateway UI into those entry points).
export type GatewaySection =
	| "overview"
	| "workspace"
	| "providers"
	| "routing"
	| "guardrails"
	| "budgets"
	| "keys"
	| "channels"
	| "identities"
	| "integrations"
	| "usage"
	| "audit"
	| "evals";

interface GatewayDialogState {
	/** Whether the Gateway dialog is open. */
	open: boolean;
	/** Open the dialog at a section (defaults to the overview). */
	openGateway: (section?: GatewaySection) => void;
	/** The section to show when it opens. */
	section: GatewaySection;
	/** Controlled open/close passthrough for the dialog's onOpenChange. */
	setOpen: (open: boolean) => void;
}

// A tiny global so any surface can open the Gateway dialog at a chosen section.
// The dialog itself is rendered once (in NodeSelector) and reads this store, so
// there is a single instance regardless of how many places trigger it.
export const useGatewayDialog = create<GatewayDialogState>((set) => ({
	open: false,
	section: "overview",
	openGateway: (section = "overview") => set({ open: true, section }),
	setOpen: (open) => set({ open }),
}));

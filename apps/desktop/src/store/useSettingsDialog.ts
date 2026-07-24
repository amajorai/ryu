import { create } from "zustand";

// The named sections of the desktop App Settings dialog. Kept here (not in
// SettingsDialog.tsx) so external openers — the Gateway dialog cross-link, the
// command palette, deep links — can request a specific section without
// importing the dialog component (which would pull the whole settings UI into
// those entry points). Mirrors useGatewayDialog.ts.
// Desktop-client / user-account sections only. Node-level tabs (meetings, memory,
// privacy, storage, updates, email-alerts, connections, health, predict, tasks) and
// the Danger Zone moved to the Gateway dialog (see `GatewaySection`); per-app/plugin
// user-scoped tabs are dynamic and use `app:<id>` / `plugin:<id>` values.
export type SettingsSectionValue =
	| "general"
	| "account"
	| "appearance"
	| "keyboard"
	| "island"
	| "shadow"
	| "integrations"
	| "sessions"
	| "authorized-apps"
	| "billing"
	| "referrals"
	| "teams"
	| "credits"
	| "voice"
	| "goals"
	| "double-check"
	| "experimental";

interface SettingsDialogState {
	/** Whether the App Settings dialog is open. */
	open: boolean;
	/** Open the dialog at a section (defaults to general, the dialog's own default). */
	openSettings: (section?: SettingsSectionValue) => void;
	/** The section to show when it opens. */
	section: SettingsSectionValue;
	/** Controlled open/close passthrough for the dialog's onOpenChange. */
	setOpen: (open: boolean) => void;
}

// A tiny global so any surface can open the App Settings dialog at a chosen
// section. The dialog itself is rendered once (in NavUser) and reads this
// store, so there is a single instance regardless of how many places trigger
// it.
export const useSettingsDialog = create<SettingsDialogState>((set) => ({
	open: false,
	section: "general",
	openSettings: (section = "general") => set({ open: true, section }),
	setOpen: (open) => set({ open }),
}));

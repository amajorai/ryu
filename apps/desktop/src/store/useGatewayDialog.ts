import { create } from "zustand";

// The named sections of the Gateway settings dialog. Kept here (not in
// GatewayDialog.tsx) so external openers — the command palette, deep links, the
// Settings page — can request a specific section without importing the dialog
// component (which would pull the whole gateway UI into those entry points).
// Node/gateway-level sections. Beyond the gateway-policy sections this dialog has
// always owned, it also hosts the node-level CORE-INFRA tabs that used to live in
// the App Settings dialog (they configure the whole node, not the per-user desktop
// client, and are not apps): connections, email/alerts, privacy, storage, updates,
// health, and the Danger Zone. App settings (meetings, memory, quests, predict, …)
// are NOT static sections — apps register them via the manifest and they render
// dynamically under the Apps/Plugins headers (`app:<id>` / `plugin:<id>` values).
export type GatewaySection =
	| "overview"
	| "workspace"
	| "defaults"
	| "providers"
	| "routing"
	| "guardrails"
	| "budgets"
	| "runtime"
	| "hooks"
	| "keys"
	| "integrations"
	// The node's network surface (Tailscale / Headscale / Tailcat), extracted from
	// Integrations into its own tab.
	| "network"
	| "usage"
	| "audit"
	| "evals"
	// The node's public API surface: endpoint URLs to point OpenAI/Anthropic/
	// Gemini clients at, local API-key management, and a live traffic dashboard.
	| "api"
	// The Ryu MCP server layer: registered servers + the tools they expose.
	| "mcp"
	| "git"
	| "worktrees"
	| "environments"
	// Ryu-canonical import/export sync for Claude, Codex, Cursor, and portable
	// bundles. Kept as two sections because each direction has an independent
	// opt-in toggle and a different safety model.
	| "import"
	| "export"
	// Moved from the App Settings dialog (node-level Core infra, not apps):
	| "connections"
	| "email-alerts"
	| "computer"
	| "privacy"
	| "storage"
	| "encryption"
	// Who may talk to this node: pending device-pairing approvals, already-paired
	// devices, and the node's own access token.
	| "access"
	// Per-resource permission exceptions (which team may do what, where).
	| "permissions"
	// No "parsing": the node-wide `document.parse` binding is picked from the node
	// dropdown's Toolkits row, the generic surface every swappable capability uses.
	// Its upload ceiling moved onto "storage".
	| "updates"
	| "health"
	| "danger";

interface GatewayDialogState {
	/** Whether the Gateway dialog is open. */
	open: boolean;
	/**
	 * Open the dialog at a section. A known {@link GatewaySection}, or a dynamic
	 * app/plugin entity value (`app:<id>` / `plugin:<id>`) so a deep link can open a
	 * specific app's settings. Defaults to the overview.
	 */
	openGateway: (section?: GatewaySection | (string & {})) => void;
	/** The section to show when it opens. */
	section: string;
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

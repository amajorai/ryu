import type { ComposerSelectionApplyMode } from "@/src/hooks/useComposerSelectionApplyMode.ts";
import type { QueueDrainMode } from "@/src/hooks/useQueueDrainMode.ts";
import type { StartupBehavior } from "@/src/hooks/useStartupBehavior.ts";
import type { TabSwitchBehavior } from "@/src/hooks/useTabSwitchBehavior.ts";
import type { TerminalPanelLocation } from "@/src/hooks/useTerminalPanelLocation.ts";
import type { DefaultFileOpener } from "@/src/lib/default-file-opener.ts";
import type { StartupSelectionMode } from "@/src/lib/startup-selection.ts";

// What the window opens on at launch — a Chrome-style "On startup" choice.
export const STARTUP_OPTIONS: { value: StartupBehavior; label: string }[] = [
	{ value: "empty", label: "The launchpad (no tabs)" },
	{ value: "home", label: "The Home page" },
	{ value: "chat", label: "A new chat" },
	{ value: "restore", label: "Reopen previous tabs" },
];

export const STARTUP_SELECTION_OPTIONS: {
	value: StartupSelectionMode;
	label: string;
}[] = [
	{ value: "always", label: "Always ask" },
	{ value: "defaults", label: "Use defaults" },
	{ value: "never", label: "Never show" },
];

export const NO_STARTUP_DEFAULT = "__ask_at_startup__";

// How the message queue drains while an agent is still responding.
export const QUEUE_DRAIN_OPTIONS: { value: QueueDrainMode; label: string }[] = [
	{ value: "off", label: "Off (send immediately)" },
	{ value: "auto", label: "Auto (Claude Code)" },
	{ value: "oldest-first", label: "Oldest first" },
	{ value: "latest-first", label: "Latest first" },
	{ value: "send-all", label: "Send all together" },
];

export const COMPOSER_SELECTION_APPLY_OPTIONS: {
	value: ComposerSelectionApplyMode;
	label: string;
}[] = [
	{ value: "next-turn", label: "On the next turn" },
	{ value: "next-user-message", label: "On the next user message" },
];

// Which shell the built-in terminal and git actions run their commands through.
// "auto" lets the Rust side pick the OS default; every other value is an
// allowlisted shell name understood by the `shell_execute` command.
export const TERMINAL_SHELL_OPTIONS = [
	{ value: "auto", label: "OS default" },
	{ value: "bash", label: "Bash" },
	{ value: "zsh", label: "Zsh" },
	{ value: "sh", label: "sh" },
	{ value: "fish", label: "Fish" },
	{ value: "powershell", label: "PowerShell" },
	{ value: "pwsh", label: "pwsh" },
	{ value: "cmd", label: "cmd" },
];

export const IS_MACOS = navigator.userAgent.includes("Mac");
export const FILE_MANAGER_NAME = IS_MACOS
	? "Finder"
	: navigator.userAgent.includes("Windows")
		? "Explorer"
		: "Files";

export const DEFAULT_FILE_OPENER_OPTIONS: {
	value: DefaultFileOpener;
	label: string;
}[] = [
	{ value: "system", label: FILE_MANAGER_NAME },
	{ value: "vscode", label: "VS Code" },
	{ value: "cursor", label: "Cursor" },
	{ value: "zed", label: "Zed" },
];

// Minute thresholds offered for auto-unloading inactive tabs. 0 disables it.
export const TAB_UNLOAD_OPTIONS = [
	{ value: "0", label: "Never" },
	{ value: "5", label: "After 5 minutes" },
	{ value: "10", label: "After 10 minutes" },
	{ value: "15", label: "After 15 minutes" },
	{ value: "30", label: "After 30 minutes" },
	{ value: "60", label: "After 1 hour" },
];

// Ctrl/Cmd+Tab cycle order — sequential strip order (default) or MRU.
export const TAB_SWITCH_OPTIONS: { value: TabSwitchBehavior; label: string }[] =
	[
		{ value: "sequential", label: "In order (left to right)" },
		{ value: "recent", label: "Most recently used" },
	];

export const TERMINAL_LOCATION_LABELS = {
	bottom: "Bottom",
	right: "Right",
} satisfies Record<TerminalPanelLocation, string>;

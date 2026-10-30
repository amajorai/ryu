import {
	Add01Icon,
	ComputerIcon,
	DollarCircleIcon,
	Download01Icon,
	FingerPrintIcon,
	FullScreenIcon,
	Logout01Icon,
	Moon01Icon,
	Package01Icon,
	PlugSocketIcon,
	Settings01Icon,
	Settings02Icon,
	ShieldKeyIcon,
	Sun01Icon,
	Tv01Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import type { CommandAction } from "@ryu/command/types";
import type { CommandPaletteActionContext } from "./CommandPalette-actions.ts";

/** Theme choices plus the Appearance settings shortcut. */
export function pushThemeActions(
	items: CommandAction[],
	ctx: CommandPaletteActionContext
): void {
	const { close, handleOpenSettings, setTheme, theme } = ctx;
	items.push(
		{
			id: "theme-light",
			group: "Theme",
			title: "Light",
			value: "theme light",
			icon: Sun01Icon,
			checked: theme === "light",
			onSelect: () => {
				setTheme("light");
				close();
			},
		},
		{
			id: "theme-dark",
			group: "Theme",
			title: "Dark",
			value: "theme dark",
			icon: Moon01Icon,
			checked: theme === "dark",
			onSelect: () => {
				setTheme("dark");
				close();
			},
		},
		{
			id: "theme-system",
			group: "Theme",
			title: "System",
			value: "theme system",
			icon: ComputerIcon,
			checked: theme === "system",
			onSelect: () => {
				setTheme("system");
				close();
			},
		},
		{
			id: "appearance-settings",
			group: "Appearance",
			title: "Open Appearance Settings",
			value: "appearance settings",
			icon: Settings01Icon,
			onSelect: () => handleOpenSettings("appearance"),
		}
	);
}

/** Secondary destinations outside the primary sidebar list. */
export function pushSecondaryNavActions(
	items: CommandAction[],
	ctx: CommandPaletteActionContext
): void {
	const { handleNavigate } = ctx;
	// Secondary destinations that aren't in the primary sidebar list but are
	// still real pages — surface them here so a first-time user can actually
	// find them from the command palette.
	items.push(
		{
			id: "nav-marketplace",
			group: "Navigation",
			title: "Marketplace",
			value: "navigate marketplace store buy licenses sell",
			icon: DollarCircleIcon,
			prefetchPath: "/marketplace",
			onSelect: () => handleNavigate("/marketplace"),
		},
		{
			id: "nav-apps",
			group: "Navigation",
			title: "Plugins",
			value: "navigate plugins apps installed",
			icon: Package01Icon,
			prefetchPath: "/apps",
			onSelect: () => handleNavigate("/apps"),
		},
		{
			id: "nav-extensions",
			group: "Navigation",
			title: "Extensions",
			value: "navigate extensions browser desktop add-ons",
			icon: PlugSocketIcon,
			prefetchPath: "/extensions",
			onSelect: () => handleNavigate("/extensions"),
		}
		// "Webhooks" used to be a fourth row here. `/webhooks` is owned by the
		// `@ryu/webhooks` app, which declares a companion — so the section index
		// already lists it, live, exactly when the app is enabled. The hardcoded
		// row was the same mistake NAV_ITEMS' comment describes (it rendered on a
		// fresh install, where the app is off, and led to "App not enabled"), and
		// worse: sitting in a hardcoded list put it in `navTargets`, whose dedupe
		// then SUPPRESSED the app's own declaration. Deleting it is what makes
		// the real entry appear.
	);
}

/** Library pages, billing destinations, and the built-in palette actions. */
export function pushLibraryAndCoreActions(
	items: CommandAction[],
	ctx: CommandPaletteActionContext
): void {
	const {
		handleImportSetup,
		handleImportThread,
		handleNavigate,
		handleNewChat,
		handleOpenSettings,
		handleSignOutAction,
		handleToggleFullscreen,
		isSigningOut,
		modKey,
	} = ctx;
	// Channels and Identities are Library collections with dedicated manage
	// pages. Credits lives in App Settings → Services.
	items.push({
		id: "nav-channels",
		group: "Navigation",
		title: "Channels",
		value:
			"navigate channels telegram slack whatsapp personal business cloud api discord bots",
		icon: Tv01Icon,
		resultType: "channels",
		prefetchPath: "/library/channel",
		onSelect: () => handleNavigate("/library/channel", "Channels"),
	});

	items.push({
		id: "nav-identities",
		group: "Navigation",
		title: "Identities",
		value: "navigate identities logins credentials connections vault",
		icon: FingerPrintIcon,
		resultType: "identities",
		prefetchPath: "/library/identity",
		onSelect: () => handleNavigate("/library/identity", "Identities"),
	});

	items.push({
		id: "nav-vault",
		group: "Navigation",
		title: "Vault",
		value: "navigate vault secrets variables credentials mcp",
		icon: ShieldKeyIcon,
		prefetchPath: "/vault",
		onSelect: () => handleNavigate("/vault", "Vault"),
	});

	items.push({
		id: "nav-knowledge-graph",
		group: "Navigation",
		title: "Knowledge graph",
		value: "navigate knowledge graph spaces pages links backlinks wiki",
		icon: WorkflowCircle06Icon,
		onSelect: () => handleNavigate("/graph", "Knowledge graph"),
	});

	items.push({
		id: "nav-credits",
		group: "Navigation",
		title: "Credits",
		value: "navigate credits wallet balance billing top up",
		icon: DollarCircleIcon,
		onSelect: () => handleOpenSettings("credits"),
	});

	items.push({
		id: "nav-usage",
		group: "Navigation",
		title: "Usage",
		// The words someone actually types when a charge surprises them, which
		// are rarely the word "usage".
		value:
			"navigate usage statement spend history transactions what did i spend charges cost",
		icon: DollarCircleIcon,
		onSelect: () => handleOpenSettings("usage"),
	});

	items.push(
		{
			id: "action-new-chat",
			group: "Actions",
			title: "New Chat",
			value: "new chat",
			resultType: "chats",
			icon: Add01Icon,
			shortcut: `${modKey}N`,
			onSelect: handleNewChat,
		},
		{
			id: "action-toggle-fullscreen",
			group: "Actions",
			title: "Toggle Full Screen",
			value: "fullscreen full screen maximize window presentation f11",
			icon: FullScreenIcon,
			shortcut: "F11",
			onSelect: handleToggleFullscreen,
		},
		{
			id: "action-import-thread",
			group: "Actions",
			title: "Import Thread",
			value: "import thread claude code codex history resume past conversation",
			resultType: "chats",
			icon: Download01Icon,
			onSelect: handleImportThread,
		},
		{
			id: "action-import-setup",
			group: "Actions",
			title: "Import Agent Setup",
			value:
				"import setup instructions skills mcp server plugin memory claude cursor codex from folder",
			icon: Settings02Icon,
			onSelect: handleImportSetup,
		},
		{
			id: "action-profile",
			group: "Actions",
			title: "Profile & Account",
			value: "settings profile account",
			icon: Settings01Icon,
			onSelect: () => handleOpenSettings("profile"),
		},
		{
			id: "action-memory",
			group: "Actions",
			title: "Memory",
			value: "settings memory long-term",
			icon: Settings01Icon,
			onSelect: () => handleOpenSettings("memory"),
		},
		{
			id: "action-settings",
			group: "Actions",
			title: "Settings",
			value: "settings open",
			icon: Settings01Icon,
			shortcut: `${modKey}.`,
			onSelect: () => handleOpenSettings("appearance"),
		},
		{
			id: "action-sign-out",
			group: "Actions",
			title: "Sign Out",
			value: "sign out log out",
			icon: Logout01Icon,
			disabled: isSigningOut,
			onSelect: handleSignOutAction,
		}
	);
}

import controls from "./chat-page-control-paths.playwright.config.ts";
import transcript from "./chat-performance-proof.playwright.config.ts";
import sidebar from "./chat-sidebar-suite-proof.playwright.config.ts";
import keyboardAuthority from "./keyboard-shortcuts-authority-proof.playwright.config.ts";
import keyboard from "./keyboard-shortcuts-proof.playwright.config.ts";
import scrollableTabs from "./scrollable-tabs-host-proof.playwright.config.ts";
import dock from "./workspace-dock-proof.playwright.config.ts";

// Each selection retains a whole existing canonical suite, including looped
// registrations. These names select a build/server graph; they are not grep
// filters and do not replace any shipping provider or test body.
export const desktopBrowserStaticSuites = {
	controls: {
		config: controls,
		port: 5197,
		html: ["share-conversation-toolbar-entry.html"],
	},
	dock: {
		config: dock,
		port: 5411,
		html: ["workspace-dock-proof.html"],
	},
	keyboard: {
		config: keyboard,
		port: 5208,
		html: ["keyboard-shortcuts-proof.html"],
	},
	"keyboard-authority": {
		config: keyboardAuthority,
		port: 5208,
		html: ["keyboard-shortcuts-authority-proof.html"],
	},
	"scrollable-tabs": {
		config: scrollableTabs,
		port: 5388,
		html: ["scrollable-tabs-host-proof.html"],
	},
	sidebar: {
		config: sidebar,
		port: 5182,
		html: [
			"chat-row-menus-story.html",
			"agent-conversation-branch-proof.html",
			"keyboard-shortcuts-search-proof.html",
		],
	},
	transcript: {
		config: transcript,
		port: 5205,
		html: [
			"chat-scroll-story.html",
			"chat-grouping-story.html",
			"chat-search-story.html",
		],
	},
} as const;

export function selectedDesktopBrowserStaticSuite() {
	const name = process.env.RYU_DESKTOP_BROWSER_SUITE;
	if (!(name && Object.hasOwn(desktopBrowserStaticSuites, name))) {
		throw new Error(
			`Set RYU_DESKTOP_BROWSER_SUITE to one complete canonical suite: ${Object.keys(desktopBrowserStaticSuites).join(", ")}`
		);
	}
	return {
		name,
		...desktopBrowserStaticSuites[
			name as keyof typeof desktopBrowserStaticSuites
		],
	};
}

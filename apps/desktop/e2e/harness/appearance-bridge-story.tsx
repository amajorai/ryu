import {
	COMPANION_THEME_MUTATION_ATTRIBUTES,
	readCompanionThemeTokens,
} from "@ryu/app-host/companion-theme";
import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import type { Capability, HostServices } from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { type ComponentProps, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

interface ThemeAwareHostProps extends ComponentProps<typeof ExtensionHost> {
	initialThemeTokens: Record<string, string>;
}

function ThemeAwareHost({ initialThemeTokens, ...props }: ThemeAwareHostProps) {
	const [themeTokens, setThemeTokens] = useState(initialThemeTokens);
	useEffect(() => {
		const observer = new MutationObserver(() => {
			setThemeTokens(readCompanionThemeTokens());
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: [...COMPANION_THEME_MUTATION_ATTRIBUTES],
		});
		return () => observer.disconnect();
	}, []);
	return <ExtensionHost {...props} themeTokens={themeTokens} />;
}

interface AppearanceBridgeApi {
	apply: (input: {
		attributes?: Record<string, string | null>;
		className?: string;
		tokens: Record<string, string>;
	}) => void;
	connected: () => boolean;
	mount: (input: { appHtml: string }) => void;
}

let connected = false;
let root: Root | null = null;

function mount({ appHtml }: { appHtml: string }): void {
	connected = false;
	const nonce = `appearance-${Date.now()}`;
	const granted: ReadonlySet<Capability> = new Set();
	const services: HostServices = {
		listAgents: () => Promise.resolve([]),
		registerRoute: () => Promise.reject(new Error("not used in this proof")),
	};
	const initialThemeTokens = readCompanionThemeTokens();
	const srcdoc = htmlCompanionSrcdoc(
		nonce,
		appHtml,
		"@ryu/appearance-proof",
		undefined,
		undefined,
		initialThemeTokens,
		true
	);
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("appearance proof host root is missing");
	}
	root?.unmount();
	root = createRoot(container);
	root.render(
		createElement(ThemeAwareHost, {
			granted,
			initialThemeTokens,
			nonce,
			onConnected: () => {
				connected = true;
			},
			services,
			srcdoc,
			title: "Appearance bridge proof",
		})
	);
}

const api: AppearanceBridgeApi = {
	apply: ({ attributes, className, tokens }) => {
		const rootElement = document.documentElement;
		if (className !== undefined) {
			rootElement.className = className;
		}
		for (const [name, value] of Object.entries(tokens)) {
			rootElement.style.setProperty(name, value);
			if (name === "--ryu-ui-scale") {
				rootElement.style.zoom = value;
			}
		}
		for (const [name, value] of Object.entries(attributes ?? {})) {
			if (value === null) {
				rootElement.removeAttribute(name);
			} else {
				rootElement.setAttribute(name, value);
			}
		}
	},
	connected: () => connected,
	mount,
};

/* SAFETY: This assignment publishes the complete locally checked AppearanceBridgeApi value on the native browser Window under __ryuAppearanceBridge. The view owns only that publication slot; it makes no claim about plugin messages or native SDK members. */ (
	window as typeof window & { __ryuAppearanceBridge: AppearanceBridgeApi }
).__ryuAppearanceBridge = api;
document.body.setAttribute("data-harness-ready", "1");

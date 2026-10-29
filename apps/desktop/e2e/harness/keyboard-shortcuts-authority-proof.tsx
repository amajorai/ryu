import type { HotkeyStorage } from "@ryu/hotkeys/react";
import { HotkeysProvider } from "@ryu/hotkeys/react";
import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { KeyboardShortcutsTab } from "../../src/components/settings/KeyboardShortcutsTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { DEFAULT_DICTATION_PREFS } from "../../src/lib/api/preferences.ts";
import { DESKTOP_HOTKEYS } from "../../src/lib/hotkeys/actions.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import {
	LOCAL_FALLBACK,
	type Node,
	useNodeStore,
} from "../../src/store/useNodeStore.ts";
import type { ShortcutProofState } from "./keyboard-shortcuts-proof.types.ts";
import "../../src/index.css";

const proofWindow: Window & ShortcutProofState = window;
proofWindow.__shortcutApiOrigin = new URL(LOCAL_FALLBACK.url).origin;
proofWindow.__shortcutOverrides = JSON.parse(
	localStorage.getItem("shortcut-proof-saved-overrides") ?? "{}"
);
proofWindow.__shortcutStorage = { refuseNext: false, calls: [] };
proofWindow.__shortcutDictationPrefs = structuredClone(DEFAULT_DICTATION_PREFS);

const authorityNodes: Node[] = [
	{
		name: "Authority A",
		url: "http://127.0.0.1:63341",
		token: "shortcut-A-node-token",
		userJwt: null,
	},
	{
		name: "Authority B",
		url: "http://127.0.0.1:63342",
		token: "shortcut-B-node-token",
		userJwt: null,
	},
];
declare global {
	interface Window {
		__registerShortcutAuthorityTransport: (input: {
			nodes: Node[];
			prefs: ShortcutProofState["__shortcutDictationPrefs"];
		}) => Promise<void>;
		__shortcutAuthorityNativeCalls: Array<{ command: string; name: string }>;
		__shortcutAuthorityNodes: Node[];
		__shortcutAuthorityUnexpectedNative: string[];
	}
}
window.__shortcutAuthorityNodes = authorityNodes;
window.__shortcutAuthorityNativeCalls = [];
window.__shortcutAuthorityUnexpectedNative = [];
// Select through the real NodeStore action and real Tauri invoke SDK. Only
// persistence acknowledgement is supplied; no shortcut/native registration is faked.
Reflect.set(window, "__TAURI_INTERNALS__", {
	// Callback ids are handed out only for the listen below; any other native
	// subscription still fails as an unexpected command.
	transformCallback: () => 1,
	invoke: async (
		command: string,
		args?: {
			event?: string;
			name?: string;
			path?: string;
			options?: unknown;
			rid?: number;
			key?: string;
		}
	) => {
		// The real auth client boots its vault from the sealed native slot (empty
		// here), then probes the legacy plaintext `auth.bin` store to migrate it.
		// Keep this namespace finite and read the same seeded local account mirror.
		const keys = Object.keys(args ?? {})
			.sort()
			.join(",");
		if (
			(command === "desktop_secret_get" ||
				command === "desktop_secret_delete") &&
			keys === "name" &&
			args?.name === "auth-vault"
		) {
			return null;
		}
		if (
			command === "desktop_secret_set" &&
			keys === "name,value" &&
			args?.name === "auth-vault"
		) {
			return null;
		}
		if (
			command === "plugin:event|listen" &&
			args?.event === "desktop-secret-changed"
		) {
			return 1;
		}
		if (
			command === "plugin:store|load" &&
			keys === "options,path" &&
			args?.path === "auth.bin" &&
			args.options === undefined
		) {
			return 4301;
		}
		if (
			command === "plugin:store|get" &&
			keys === "key,rid" &&
			args?.rid === 4301 &&
			typeof args.key === "string" &&
			["accounts", "activeUserId", "token"].includes(args.key)
		) {
			const mirrorKey =
				args.key === "accounts"
					? "ryu_accounts"
					: args.key === "activeUserId"
						? "ryu_active_user_id"
						: "ryu_session_token";
			const value = localStorage.getItem(mirrorKey);
			return [
				value === null
					? null
					: args.key === "accounts"
						? JSON.parse(value)
						: value,
				value !== null,
			];
		}
		if (
			command === "plugin:store|save" &&
			keys === "rid" &&
			args?.rid === 4301
		) {
			return null;
		}
		if (
			command === "quick_capture_status" &&
			Object.keys(args ?? {}).length === 0
		) {
			return {
				supported: false,
				enabled: false,
				listening: false,
				accessibility: false,
				input_monitoring: false,
				quests_enabled: false,
				binding: "either",
				error: null,
			};
		}
		if (
			command === "clips_quick_attach_status" &&
			Object.keys(args ?? {}).length === 0
		) {
			return {
				supported: false,
				enabled: false,
				listening: false,
				input_monitoring: false,
				destination: "automatic",
				error: null,
			};
		}
		if (
			command !== "set_default_node" ||
			Object.keys(args ?? {}).length !== 1 ||
			!Object.hasOwn(args ?? {}, "name") ||
			typeof args?.name !== "string" ||
			!authorityNodes.some((node) => node.name === args.name)
		) {
			window.__shortcutAuthorityUnexpectedNative.push(command);
			throw new Error(`Unexpected native command ${command}`);
		}
		window.__shortcutAuthorityNativeCalls.push({
			command,
			name: args.name ?? "",
		});
		return null;
	},
});
useNodeStore.setState({
	nodes: authorityNodes,
	localNodes: authorityNodes,
	defaultNode: "Authority A",
	autoSelect: false,
	tabOverrides: {},
});

const shortcutStorage: HotkeyStorage = {
	load: async () => proofWindow.__shortcutOverrides,
	save: async (overrides) => {
		proofWindow.__shortcutStorage.calls.push(structuredClone(overrides));
		if (proofWindow.__shortcutStorage.refuseNext) {
			proofWindow.__shortcutStorage.refuseNext = false;
			throw new Error("Shortcut storage write refused");
		}
		localStorage.setItem(
			"shortcut-proof-saved-overrides",
			JSON.stringify(overrides)
		);
		proofWindow.__shortcutOverrides = structuredClone(overrides);
	},
};

function installShortcutApiMock(): () => void {
	const nativeFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		const requestUrl = new URL(url, window.location.href);
		if (requestUrl.pathname === "/api/plugins") {
			return Response.json({ apps: [] });
		}
		if (requestUrl.pathname === "/api/plugins/contributions") {
			return Response.json({});
		}
		if (requestUrl.pathname === "/api/preferences/keybindings") {
			return Response.json({ key: "keybindings", value: "{}" });
		}
		if (requestUrl.pathname === "/api/preferences/dictation") {
			// Use the actual SDK's browser HTTP request; the spec owns the finite
			// wire transport, persisted state and refused/held responses.
			const response = await nativeFetch(input, init);
			if (response.ok) {
				const data = await response.clone().json();
				proofWindow.__shortcutDictationPrefs = JSON.parse(data.value);
			}
			return response;
		}
		return nativeFetch(input, init);
	};
	return () => {
		window.fetch = nativeFetch;
	};
}

function ProofSurface() {
	useEffect(() => installShortcutApiMock(), []);

	return (
		<QueryClientProvider client={queryClient}>
			<HotkeysProvider registry={DESKTOP_HOTKEYS} storage={shortcutStorage}>
				<AppSurfaceProvider surface="desktop">
					<I18nProvider>
						<I18nDirectionProvider>
							<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
								<Toaster position="bottom-right" theme="dark" />
								<main
									className="min-h-dvh bg-background p-8 text-foreground"
									data-testid="keyboard-shortcuts-proof"
								>
									<div>
										{authorityNodes.map((node) => (
											<button
												key={node.name}
												onClick={() =>
													void useNodeStore.getState().setDefault(node.name)
												}
												type="button"
											>
												Select {node.name}
											</button>
										))}
									</div>
									<div className="mx-auto max-w-5xl rounded-2xl border bg-card p-6 shadow-sm">
										<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
											Desktop settings verification
										</p>
										<h1 className="mt-2 mb-6 font-semibold text-2xl">
											Keyboard Shortcuts
										</h1>
										<div className="h-[70vh] min-h-0">
											<KeyboardShortcutsTab />
										</div>
									</div>
								</main>
							</ThemeProvider>
						</I18nDirectionProvider>
					</I18nProvider>
				</AppSurfaceProvider>
			</HotkeysProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing actual shortcut authority proof root");
}
await window.__registerShortcutAuthorityTransport({
	nodes: authorityNodes,
	prefs: proofWindow.__shortcutDictationPrefs,
});
const proofRoot = createRoot(root);
window.__shortcutUnmount = () => proofRoot.unmount();
proofRoot.render(
	<MemoryRouter>
		<ProofSurface />
	</MemoryRouter>
);

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
import { LOCAL_FALLBACK } from "../../src/store/useNodeStore.ts";
import type { ShortcutProofState } from "./keyboard-shortcuts-proof.types.ts";
import "../../src/index.css";

const proofWindow: Window & ShortcutProofState = window;
proofWindow.__shortcutApiOrigin = new URL(LOCAL_FALLBACK.url).origin;
proofWindow.__shortcutOverrides = JSON.parse(
	localStorage.getItem("shortcut-proof-saved-overrides") ?? "{}"
);
proofWindow.__shortcutStorage = { refuseNext: false, calls: [] };
proofWindow.__shortcutDictationPrefs = structuredClone(DEFAULT_DICTATION_PREFS);

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
		const url = input instanceof Request ? input.url : String(input);
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
	throw new Error("Missing actual shortcut proof root");
}
await window.__registerShortcutTransport({
	origin: proofWindow.__shortcutApiOrigin,
	prefs: proofWindow.__shortcutDictationPrefs,
});
const proofRoot = createRoot(root);
window.__shortcutUnmount = () => proofRoot.unmount();
proofRoot.render(
	<MemoryRouter>
		<ProofSurface />
	</MemoryRouter>
);

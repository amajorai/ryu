import { HotkeysProvider } from "@ryu/hotkeys/react";
import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { KeyboardShortcutsTab } from "../../../src/components/settings/KeyboardShortcutsTab.tsx";
import { AppSurfaceProvider } from "../../../src/contexts/app-surface-context.tsx";
import { DESKTOP_HOTKEYS } from "../../../src/lib/hotkeys/actions.ts";
import { queryClient } from "../../../src/lib/query-client.ts";
import { useNodeStore } from "../../../src/store/useNodeStore.ts";
import "../../../src/index.css";
function select(authority: "a" | "b") {
	const node = {
		name: `plugin-${authority}`,
		url: `http://127.0.0.1:33367/${authority}`,
		token: `plugin-token-${authority}`,
	};
	sessionStorage.setItem("plugin-proof-authority", authority);
	useNodeStore.setState({
		nodes: [node],
		localNodes: [node],
		cloudNodes: [],
		defaultNode: node.name,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
}
select(sessionStorage.getItem("plugin-proof-authority") === "b" ? "b" : "a");
Object.assign(window, { __PLUGIN_AUTHORITY__: { select } });
// Only unrelated in-app HotkeyStorage is bounded local state. Tested node-owned
// plugin preferences, app manifests, contributions and active-node hooks are real.
let localOverrides = {};
const storage = {
	load: async () => localOverrides,
	save: async (value: Record<string, string | null>) => {
		localOverrides = value;
	},
};
createRoot(document.getElementById("root")!).render(
	<MemoryRouter>
		<QueryClientProvider client={queryClient}>
			<HotkeysProvider registry={DESKTOP_HOTKEYS} storage={storage}>
				<AppSurfaceProvider surface="desktop">
					<I18nProvider>
						<I18nDirectionProvider>
							<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
								<Toaster position="bottom-right" theme="dark" />
								<main data-testid="plugin-shortcuts-full-consumer">
									<KeyboardShortcutsTab />
								</main>
							</ThemeProvider>
						</I18nDirectionProvider>
					</I18nProvider>
				</AppSurfaceProvider>
			</HotkeysProvider>
		</QueryClientProvider>
	</MemoryRouter>
);

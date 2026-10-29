declare const window: Window;

// Native/browser proof of the shipping Layout, TabsProvider, TitleBar, drag
// handlers and artifact renderer. Only backend data is isolated test data.
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../contexts/auth-context.tsx";
import { LanguagePackBridge } from "../../src/components/LanguagePackBridge.tsx";
import Layout from "../../src/components/layout/Layout.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { initializeTabTransfer } from "../../src/lib/tab-transfer.ts";
import { useArtifactStore } from "../../src/store/useArtifactStore.ts";
import "@fontsource-variable/geist";
import "../../src/index.css";

function recordProof<Detail>(event: string, detail: Detail) {
	navigator.sendBeacon(
		"/__tab-proof",
		JSON.stringify({ event, detail, window: location.search || "main" })
	);
}
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
	originalConsoleError(...args);
	if (args[0] === "Tab window transfer failed") {
		recordProof("transfer-error", args[1]);
	}
};
for (const name of ["dragstart", "dragend"] as const) {
	document.addEventListener(name, (event) =>
		recordProof(name, {
			clientX: event.clientX,
			clientY: event.clientY,
			screenX: event.screenX,
			screenY: event.screenY,
			buttons: event.buttons,
			effect: event.dataTransfer?.dropEffect,
		})
	);
}
const nativeFetch = window.fetch.bind(globalThis);
window.fetch = (input, init) => {
	const url = new URL(
		input instanceof Request ? input.url : String(input),
		location.href
	);
	if (
		url.protocol === "ipc:" ||
		url.hostname === "ipc.localhost" ||
		(url.origin === location.origin && !url.pathname.startsWith("/api/"))
	) {
		return nativeFetch(input, init);
	}
	return Promise.resolve(
		new Response(
			JSON.stringify({ error: "Isolated tab proof: backend unavailable" }),
			{ status: 503, headers: { "content-type": "application/json" } }
		)
	);
};

if ("__TAURI_INTERNALS__" in window) {
	const current = getCurrentWindow();
	if (current.label === "main") {
		void Promise.all([
			current.outerPosition(),
			current.outerSize(),
			current.scaleFactor(),
		])
			.then(([position, size, scale]) =>
				recordProof("window-bounds", {
					label: current.label,
					position,
					size,
					scale,
				})
			)
			.catch(() => undefined);
	} else {
		recordProof("destination-mounted", { label: current.label });
	}
}
localStorage.setItem("ryu:tab-dropdown", "false");
localStorage.setItem("ryu_startup_behavior", "restore");
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });
const params = new URLSearchParams(location.search);
if (params.get("window") !== "tab") {
	const tabs = [
		{ path: "/artifact/overview", title: "Workspace overview" },
		{ path: "/artifact/notes", title: "Tab tear-out notes" },
		{ path: "/artifact/checklist", title: "Release checklist" },
	];
	localStorage.setItem(
		"ryu_session_tabs",
		JSON.stringify({ tabs, activeIndex: 1 })
	);
	for (const tab of tabs) {
		const id = tab.path.slice("/artifact/".length);
		useArtifactStore.getState().put({
			id,
			title: tab.title,
			kind: "html",
			sourceMessageId: "tab-proof-fixture",
			content: `<html><body style="margin:0;background:#131315;color:#e7e7e8;font:16px system-ui;line-height:1.8;padding:48px"><p style="color:#aaa;font-size:13px">LOCAL WORKSPACE · VERIFICATION FIXTURE</p><h1 style="font-size:32px;line-height:1.25;margin-top:24px">${tab.title}</h1><p>Keep one piece of work in its own window.</p><p>This document is an in-memory workspace artifact. Its content should travel with this tab when it moves.</p><h2 style="font-size:20px;margin-top:40px">Working notes</h2><ul><li>Drag the tab outside this window and release.</li><li>The new window contains only the selected tab.</li><li>The remaining tabs stay in the source workspace.</li></ul><p style="color:#aaa;margin-top:48px">Fixture reference: RYU-TABS-042</p></body></html>`,
		});
	}
}
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
await initializeTabTransfer();
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<AppSurfaceProvider surface="desktop">
			<QueryClientProvider client={queryClient}>
				<ThemeProvider
					attribute="class"
					defaultTheme="dark"
					enableSystem={false}
				>
					<LanguagePackBridge>
						<AuthProvider>
							<MemoryRouter>
								<EntitlementProvider>
									<Layout />
									<Toaster />
								</EntitlementProvider>
							</MemoryRouter>
						</AuthProvider>
					</LanguagePackBridge>
				</ThemeProvider>
			</QueryClientProvider>
		</AppSurfaceProvider>
	);
}

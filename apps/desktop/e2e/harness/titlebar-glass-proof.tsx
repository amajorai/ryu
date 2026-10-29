// Native/browser proof of the shipping Layout, TabsProvider, TitleBar, drag
// handlers and artifact renderer. Only backend data is isolated test data.
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../contexts/auth-context.tsx";
import { LanguagePackBridge } from "../../src/components/LanguagePackBridge.tsx";
import Layout from "../../src/components/layout/Layout.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { TitlebarScrollGeometry } from "./titlebar-scroll-geometry.tsx";
import "@fontsource-variable/geist";
import "../../src/index.css";

// OS is rollout-flagged (off by default) and this proof exercises it, so switch
// it on as the app's flag sync (ProductModeAccessSync) would.
useProductModeStore.getState().setOsAccess(true);

// Real desktop shell/pages; only unavailable backend responses are isolated.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
	const url = new URL(
		input instanceof Request ? input.url : String(input),
		location.href
	);
	if (url.origin === location.origin && !url.pathname.startsWith("/api/")) {
		return nativeFetch(input, init);
	}
	if (url.pathname.startsWith("/api/preferences/")) {
		return Promise.resolve(Response.json({ value: null }));
	}
	if (url.pathname === "/api/vault/secrets") {
		return Promise.resolve(
			Response.json({
				caller: {
					userId: "proof-user",
					role: "owner",
					teamIds: [],
					orgId: null,
				},
				node: {
					id: "proof",
					scope: "local",
					orgId: null,
					ownerUserId: "proof-user",
					teamId: null,
				},
				canManageShared: true,
				secrets: Array.from({ length: 24 }, (_, i) => ({
					name: `WORKSPACE_TOKEN_${i + 1}`,
					scope: "user",
					scopeId: "proof-user",
					updatedAt: "2026-09-17T08:00:00Z",
				})),
			})
		);
	}
	return Promise.resolve(
		Response.json(
			{ error: "Isolated visual fixture: backend unavailable" },
			{ status: 503 }
		)
	);
};
const params = new URLSearchParams(location.search);
const realm = params.get("realm") === "os" ? "os" : "console";
localStorage.setItem("ryu:product-mode", realm);
localStorage.setItem("ryu:tab-dropdown", "false");
localStorage.setItem(
	"ryu:sidebar-variant",
	params.get("chrome") === "inset" ? "inset" : "floating"
);
localStorage.setItem("ryu_startup_behavior", "restore");
localStorage.setItem(
	"ryu_session_tabs",
	JSON.stringify({
		tabs:
			realm === "os"
				? []
				: [
						{ path: "/vault", title: "Vault" },
						{ path: "/settings", title: "Settings" },
						{ path: "/store", title: "Store" },
						{ path: "/library", title: "Library" },
						{ path: "/chat", title: "Chat" },
					],
		activeIndex: 0,
	})
);
useProductModeStore.setState({ requestedMode: realm, consoleAccess: true });
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
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
									{params.has("geometry") ? (
										<TitlebarScrollGeometry />
									) : (
										<Layout />
									)}
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

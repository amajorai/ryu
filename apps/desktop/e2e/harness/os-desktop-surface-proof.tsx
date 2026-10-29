import { HotkeysProvider } from "@ryu/hotkeys/react";
import { I18nProvider } from "@ryu/i18n/react";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "../../contexts/auth-context.tsx";
import { NavUser } from "../../src/components/layout/NavUser.tsx";
import {
	OS_APPS,
	type OsApp,
	type OsAppRecord,
	OsDesktopSurface,
	type OsWindow,
} from "../../src/components/os/OsDesktopSurface.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { SystemStatusProvider } from "../../src/contexts/SystemStatusContext.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { DESKTOP_HOTKEYS } from "../../src/lib/hotkeys/actions.ts";
import { MIN_CORE_VERSION } from "../../src/lib/node-compat.ts";
import {
	setProductMode,
	useProductModeStore,
} from "../../src/lib/product-mode.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import "../../src/index.css";

function WindowPreview({ app }: { app: OsApp }) {
	return (
		<div className="flex size-full flex-col bg-background p-6 text-foreground sm:p-10">
			<div className="flex items-start justify-between gap-4">
				<div>
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						OS window
					</p>
					<h1 className="mt-2 font-medium text-3xl tracking-tight">
						{app.label}
					</h1>
				</div>
				<span className="rounded-full bg-success/10 px-2.5 py-1 font-medium text-success text-xs">
					Live
				</span>
			</div>
			<div className="mt-8 grid gap-3 sm:grid-cols-3">
				<div className="rounded-2xl bg-muted/55 p-4">
					<p className="text-muted-foreground text-xs">Surface</p>
					<p className="mt-2 font-medium text-sm">{app.description}</p>
				</div>
				<div className="rounded-2xl bg-muted/55 p-4">
					<p className="text-muted-foreground text-xs">Workspace</p>
					<p className="mt-2 font-medium text-sm">Shared Core session</p>
				</div>
				<div className="rounded-2xl bg-muted/55 p-4">
					<p className="text-muted-foreground text-xs">Status</p>
					<p className="mt-2 font-medium text-sm">Ready for the next move</p>
				</div>
			</div>
			<div className="mt-8 rounded-2xl border border-border bg-muted/25 p-4">
				<p className="font-medium text-sm">Keep this window open</p>
				<p className="mt-1 text-muted-foreground text-sm leading-relaxed">
					Use App Launcher to switch Apps without losing the work already in
					this window.
				</p>
			</div>
		</div>
	);
}

function makeWindow(app: OsApp): OsWindow {
	return {
		content: <WindowPreview app={app} />,
		id: `window-${app.id}`,
		path: app.path,
		title: app.label,
	};
}

const initialWindows = OS_APPS.filter((app) =>
	["chat", "spaces"].includes(app.id)
).map(makeWindow);

// The harness has no Core app endpoint, so seed the real Mission Control
// manifest presentation here to exercise the same override path the desktop
// shell receives from useApps().
const manifestAppRecords: OsAppRecord[] = [
	{
		companion: null,
		icon: "radar-01",
		iconBackground: null,
		iconDither: { direction: "down", from: 201, to: "transparent" },
		iconPadding: null,
		iconUrl: null,
		id: "@ryu/mission-control",
		installed: true,
		installedVersion: "0.1.14",
		version: "0.1.14",
	},
];

// A contributed companion represents the current enabled-app feed that the
// production `OsDesktopSurfaceWithApps` adds to the launcher grid.
const contributedApps: OsApp[] = [
	{
		description: "Follow live work from an enabled Ryu App.",
		iconId: "activity-03",
		id: "app__activity",
		label: "Activity",
		manifestId: "@ryu/activity",
		path: "/plugin/app__activity",
	},
];

function Story() {
	const [windows, setWindows] = useState<OsWindow[]>(initialWindows);
	const [activeWindowId, setActiveWindowId] = useState("window-chat");

	const openApp = (app: OsApp) => {
		const existing = windows.find((item) => item.path === app.path);
		if (existing) {
			setActiveWindowId(existing.id);
			return;
		}
		const next = makeWindow(app);
		setWindows((current) => [...current, next]);
		setActiveWindowId(next.id);
	};

	const closeWindow = (id: string) => {
		const next = windows.filter((item) => item.id !== id);
		setWindows(next);
		if (activeWindowId === id) {
			setActiveWindowId(next[0]?.id ?? "");
		}
	};

	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="dark"
			enableSystem={false}
			storageKey="ryu-os-surface-proof-theme"
		>
			<TooltipProvider delay={0}>
				<main className="h-screen bg-os-desktop text-foreground">
					<OsDesktopSurface
						activeWindowId={activeWindowId}
						appRecords={manifestAppRecords}
						canSwitchToConsole
						contributedApps={contributedApps}
						menubarActions={<NavUser presentation="menubar" />}
						onActivateWindow={setActiveWindowId}
						onCloseWindow={closeWindow}
						onOpenApp={openApp}
						windows={windows}
					/>
				</main>
			</TooltipProvider>
		</ThemeProvider>
	);
}

// Keep service boundaries deterministic while mounting the production controls.
// No fixture request reaches a user's Core node or account backend.
window.fetch = (input) => {
	const url = new URL(
		input instanceof Request ? input.url : String(input),
		window.location.href
	);
	if (url.pathname === "/api/auth/get-session") {
		return Promise.resolve(
			Response.json({
				session: {
					id: "os-proof-session",
					userId: "os-proof-user",
					expiresAt: "2099-01-01T00:00:00.000Z",
				},
				user: {
					id: "os-proof-user",
					name: "Jiawei",
					email: "jiawei@example.test",
					image: null,
				},
			})
		);
	}
	if (url.pathname.includes("subscription-status")) {
		return Promise.resolve(
			Response.json({ subscription: null, lifetime: null })
		);
	}
	if (url.pathname === "/api/health") {
		return Promise.resolve(
			Response.json({
				status: "ok",
				version: MIN_CORE_VERSION,
				capabilities: [],
			})
		);
	}
	if (url.pathname === "/api/system/status") {
		return Promise.resolve(
			Response.json({
				engine: { active: null, running: false },
				gateway: { reachable: true },
				sidecars: [],
			})
		);
	}
	if (url.pathname.includes("/api/preferences/")) {
		return Promise.resolve(Response.json({ value: "false" }));
	}
	return Promise.resolve(
		Response.json({ error: "Unavailable in the OS proof" }, { status: 404 })
	);
};
queryClient.setDefaultOptions({
	queries: { retry: false, refetchOnWindowFocus: false },
});
useProductModeStore.getState().setConsoleAccess(true);
setProductMode("os");
const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("OS proof root was not found");
}
const root = createRoot(rootElement);
root.render(
	<I18nProvider>
		<AppSurfaceProvider surface="web">
			<QueryClientProvider client={queryClient}>
				<AuthProvider>
					<EntitlementProvider>
						<TabsProvider>
							<SystemStatusProvider>
								<HotkeysProvider registry={DESKTOP_HOTKEYS}>
									<Story />
								</HotkeysProvider>
							</SystemStatusProvider>
						</TabsProvider>
					</EntitlementProvider>
				</AuthProvider>
			</QueryClientProvider>
		</AppSurfaceProvider>
	</I18nProvider>
);
document.body.dataset.harnessReady = "1";

if (import.meta.hot) {
	import.meta.hot.dispose(() => root.unmount());
}

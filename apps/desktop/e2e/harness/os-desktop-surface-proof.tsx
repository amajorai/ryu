import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	OS_APPS,
	type OsApp,
	type OsAppRecord,
	OsDesktopSurface,
	type OsWindow,
} from "../../src/components/os/OsDesktopSurface.tsx";
import {
	setProductMode,
	useProductModeStore,
} from "../../src/lib/product-mode.ts";
import "../../src/index.css";

function WindowPreview({ app }: { app: OsApp }) {
	return (
		<div className="flex size-full flex-col bg-background p-6 text-foreground sm:p-10">
			<div className="flex items-start justify-between gap-4">
				<div>
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.16em]">
						Ryu OS window
					</p>
					<h1 className="mt-2 font-medium text-3xl tracking-[-0.04em]">
						{app.label}
					</h1>
				</div>
				<span className="rounded-full bg-emerald-500/10 px-2.5 py-1 font-medium text-emerald-700 text-xs dark:text-emerald-300">
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
			<main className="h-screen bg-[#121126] text-foreground">
				<OsDesktopSurface
					activeWindowId={activeWindowId}
					appRecords={manifestAppRecords}
					canSwitchToConsole
					contributedApps={contributedApps}
					onActivateWindow={setActiveWindowId}
					onCloseWindow={closeWindow}
					onOpenApp={openApp}
					windows={windows}
				/>
			</main>
		</ThemeProvider>
	);
}

useProductModeStore.getState().setConsoleAccess(true);
setProductMode("os");
createRoot(document.getElementById("root") as HTMLElement).render(<Story />);
document.body.dataset.harnessReady = "1";

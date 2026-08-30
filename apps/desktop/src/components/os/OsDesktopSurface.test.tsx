import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	OS_APPS,
	OsDesktopSurface,
	resolveOsApp,
} from "./OsDesktopSurface.tsx";

test("Ryu OS exposes the dock and App Launcher entry point", () => {
	const html = renderToStaticMarkup(
		<OsDesktopSurface
			activeWindowId="chat-window"
			onActivateWindow={() => undefined}
			onCloseWindow={() => undefined}
			onOpenApp={() => undefined}
			windows={[
				{
					content: <div>Chat window</div>,
					id: "chat-window",
					path: "/chat",
					title: "Chat",
				},
			]}
		/>
	);

	expect(html).toContain('data-testid="ryu-os-desktop"');
	expect(html).toContain('data-testid="ryu-os-dock"');
	expect(html).not.toContain("rgba(143,123,242");
	expect(html).not.toContain("rgba(45,212,191");
	expect(html).toContain("bg-success");
	const menubar =
		html.match(/<div[^>]*data-testid="ryu-os-menubar"[^>]*>/)?.[0] ?? "";
	expect(menubar).toContain("bg-transparent");
	expect(menubar).not.toContain("bg-white/5");
	const topbar =
		html.match(/<div[^>]*data-tauri-drag-region="true"[^>]*>/)?.[0] ?? "";
	expect(topbar).not.toContain("border-b");
	expect(html).toContain("aspect-square");
	expect(html).toContain('data-testid="os-dock-app-launcher"');
	expect(html).toContain("hugeicons/dashboard-square-01.svg");
	expect(html).toContain("hugeicons/radar-01.svg");
	expect(html).toContain("App Launcher");
	expect(html).toContain("Mission Control");
	expect(OS_APPS.every((app) => app.iconBackground == null)).toBe(true);
	for (const app of OS_APPS) {
		expect(html).toContain(`data-testid="os-dock-${app.id}"`);
		expect(html).toContain(`hugeicons/${app.iconId}.svg`);
	}
});

test("OS app tiles use manifest presentation when an app record is available", () => {
	const missionControl = OS_APPS.find((app) => app.id === "mission-control");
	if (!missionControl) {
		throw new Error("Mission Control is missing from the OS app registry");
	}

	const resolved = resolveOsApp(missionControl, [
		{
			companion: { icon: "manifest-radar" },
			icon: "manifest-icon",
			iconBackground: "#manifest-background",
			iconDither: { direction: "up", from: 123, to: "transparent" },
			iconPadding: "md",
			iconUrl: "https://cdn.example.test/manifest-icon.png",
			id: "@ryu/mission-control",
			installed: true,
			installedVersion: "0.1.14",
			version: "0.1.14",
		},
	]);

	expect(resolved.cacheKey).toBe("@ryu/mission-control@0.1.14");
	expect(resolved.iconBackground).toBe("#manifest-background");
	expect(resolved.iconDither).toEqual({
		direction: "up",
		from: 123,
		to: "transparent",
	});
	expect(resolved.iconId).toBe("manifest-radar");
	expect(resolved.iconPadding).toBe("md");
	expect(resolved.iconUrl).toBe("https://cdn.example.test/manifest-icon.png");
});

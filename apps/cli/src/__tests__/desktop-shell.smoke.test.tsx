/* @jsxImportSource @opentui/react */
// Integration smoke tests for the desktop-mirrored shell wiring: every registered
// surface opens as a tab and resolves through the router (no "unregistered"
// placeholder), a tab can be pinned (pin glyph in the strip), and the real
// Settings / Gateway overlay bodies (not the skeletons) mount from the overlay
// registry. A capture probe exposes the workspace + overlay controls inside the
// same provider stack the App mounts, so these drive the real contexts.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { z } from "zod";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { ChatIntentProvider } from "../core/ChatIntentContext.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { InputFocusProvider } from "../core/InputFocusContext.tsx";
import { ProductModeProvider } from "../core/ProductModeContext.tsx";
import {
	OverlayHost,
	OverlayProvider,
	useOverlay,
} from "../overlays/OverlayHost.tsx";
import { testRender } from "./cli-test-render.ts";
// Side-effect import: swaps the skeleton overlay bodies for the real ones.
import "../overlays/register.ts";
import { TerminalThemeProvider } from "../ui/TerminalThemeProvider.tsx";
import { ryuTheme } from "../ui/theme.ts";
import { ToastHost, ToastProvider } from "../ui/toast.tsx";
import { listSurfaces, resolveSurface } from "../workspace/router.ts";
import { SplitView } from "../workspace/SplitView.tsx";
import { TabStrip } from "../workspace/TabStrip.tsx";
import {
	useWorkspace,
	WorkspaceProvider,
} from "../workspace/WorkspaceContext.tsx";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let testHome: string | null = null;

// The canonical path each surface owns (deep-link aliases own a different path
// than their id — store-models owns /models, etc.).
const canonicalSurfacePathsSchema = z.looseObject({
	home: z.literal("/home"),
	chat: z.literal("/chat"),
	agents: z.literal("/agents"),
	teams: z.literal("/teams"),
	store: z.literal("/store"),
	"store-models": z.literal("/models"),
	"store-skills": z.literal("/skills"),
	"store-engines": z.literal("/engines"),
	"store-finetune": z.literal("/finetune"),
	"app-launcher": z.literal("/app-launcher"),
	library: z.literal("/library"),
	spaces: z.literal("/spaces"),
	tools: z.literal("/tools"),
	workflows: z.literal("/workflows"),
	calendar: z.literal("/calendar"),
	timeline: z.literal("/timeline"),
	monitors: z.literal("/monitors"),
	tasks: z.literal("/tasks"),
	meetings: z.literal("/meetings"),
	inbox: z.literal("/inbox"),
	downloads: z.literal("/downloads"),
	setup: z.literal("/setup"),
	"plugin-view": z.literal("/plugin-view/com.example.app/demo"),
});
const canonicalRoutePathSchema = z.string();
const CANONICAL_PATH = canonicalSurfacePathsSchema.parse({
	home: "/home",
	chat: "/chat",
	agents: "/agents",
	teams: "/teams",
	store: "/store",
	"store-models": "/models",
	"store-skills": "/skills",
	"store-engines": "/engines",
	"store-finetune": "/finetune",
	"app-launcher": "/app-launcher",
	library: "/library",
	spaces: "/spaces",
	tools: "/tools",
	workflows: "/workflows",
	calendar: "/calendar",
	timeline: "/timeline",
	monitors: "/monitors",
	tasks: "/tasks",
	meetings: "/meetings",
	inbox: "/inbox",
	downloads: "/downloads",
	setup: "/setup",
	// The generic contributed-view surface owns no built-in path: its routes are
	// minted per contribution, so the canonical path is a synthetic one. With no
	// contributions provider in this harness it must still render (the "no enabled
	// app contributes this view" state) rather than blow up.
	"plugin-view": "/plugin-view/com.example.app/demo",
});

let ws: ReturnType<typeof useWorkspace> | null = null;
let ov: ReturnType<typeof useOverlay> | null = null;

function Capture() {
	ws = useWorkspace();
	ov = useOverlay();
	return null;
}

function Harness() {
	return (
		<ThemeProvider theme={ryuTheme}>
			<CoreProvider initial={LOCAL_TARGET}>
				<TerminalThemeProvider>
					<InputFocusProvider>
						<ToastProvider>
							<ChatIntentProvider>
								<WorkspaceProvider>
									<OverlayProvider>
										<ProductModeProvider>
											<Capture />
											<box flexDirection="column" height="100%" width="100%">
												<TabStrip />
												<SplitView />
												<OverlayHost />
												<ToastHost />
											</box>
										</ProductModeProvider>
									</OverlayProvider>
								</WorkspaceProvider>
							</ChatIntentProvider>
						</ToastProvider>
					</InputFocusProvider>
				</TerminalThemeProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
	await act(async () => {
		testSetup?.renderer.destroy();
	});
	testSetup = null;
	ws = null;
	ov = null;
	if (testHome) {
		rmSync(testHome, { force: true, recursive: true });
		testHome = null;
	}
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalUserProfile;
	}
});

function isolateHome(): void {
	testHome = mkdtempSync(join(tmpdir(), "ryu-cli-desktop-shell-smoke-"));
	process.env.HOME = testHome;
	delete process.env.USERPROFILE;
}

async function flush(
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> {
	for (let pass = 0; pass < 4; pass += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
		});
	}
}

test("every registered surface opens as a tab and resolves through the router", async () => {
	isolateHome();
	testSetup = await testRender(<Harness />, { width: 140, height: 40 });
	await flush(testSetup);

	const surfaces = listSurfaces();
	// Foundation Chat + all 6 builder bundles must be registered.
	expect(surfaces.length).toBeGreaterThanOrEqual(17);

	for (const surface of surfaces) {
		const path = CANONICAL_PATH[surface.id];
		expect(path).toBeDefined();
		const routePath = canonicalRoutePathSchema.parse(path);
		// The router owns the path with no earlier-registered collision.
		expect(resolveSurface(routePath)?.id).toBe(surface.id);

		await act(async () => {
			ws?.openTab(routePath);
		});
		await flush(testSetup);
		const frame = testSetup.captureCharFrame();
		expect(frame).not.toContain("No surface registered");
		expect(frame).not.toContain("Error:");
	}
});

test("a tab can be pinned and shows the pin glyph in the tab strip", async () => {
	isolateHome();
	testSetup = await testRender(<Harness />, { width: 140, height: 40 });
	await flush(testSetup);
	// Before pinning, the Agents chip carries no leading pin glyph.
	expect(testSetup.captureCharFrame()).not.toContain("*Agents");

	let id: string | undefined;
	await act(async () => {
		id = ws?.openTab("/agents");
	});
	await flush(testSetup);
	expect(id).toBeDefined();

	if (id) {
		const tabId = id;
		await act(async () => {
			ws?.pinTab(tabId);
		});
	}
	await flush(testSetup);

	const pinned = ws?.tabs.find((tab) => tab.id === id);
	expect(pinned?.pinned).toBe(true);
	// The strip renders the pin glyph immediately before the tab title.
	expect(testSetup.captureCharFrame()).toContain("*Agents");
});

test("Settings overlay mounts the real grouped body (not the skeleton)", async () => {
	isolateHome();
	testSetup = await testRender(<Harness />, { width: 140, height: 40 });
	await testSetup.renderOnce();

	await act(async () => {
		ov?.openOverlay("settings");
	});
	await flush(testSetup);
	const frame = testSetup.captureCharFrame();
	expect(frame).not.toContain("Error:");
	expect(frame).toContain("Settings");
	// The real body renders its grouped nav (skeleton renders nothing).
	expect(frame).toContain("General");
});

test("Gateway overlay mounts the real grouped body (not the skeleton)", async () => {
	isolateHome();
	testSetup = await testRender(<Harness />, { width: 140, height: 40 });
	await testSetup.renderOnce();

	await act(async () => {
		ov?.openOverlay("gateway");
	});
	await flush(testSetup);
	const frame = testSetup.captureCharFrame();
	expect(frame).not.toContain("Error:");
	expect(frame).toContain("Gateway");
	// The real body renders its Overview section (skeleton renders nothing).
	expect(frame).toContain("Overview");
});

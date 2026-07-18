/* @jsxImportSource @opentui/react */
// Integration smoke tests for the desktop-mirrored shell wiring: every registered
// surface opens as a tab and resolves through the router (no "unregistered"
// placeholder), a tab can be pinned (pin glyph in the strip), and the real
// Settings / Gateway overlay bodies (not the skeletons) mount from the overlay
// registry. A capture probe exposes the workspace + overlay controls inside the
// same provider stack the App mounts, so these drive the real contexts.

import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { ChatIntentProvider } from "../core/ChatIntentContext.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { InputFocusProvider } from "../core/InputFocusContext.tsx";
import {
	OverlayHost,
	OverlayProvider,
	useOverlay,
} from "../overlays/OverlayHost.tsx";
// Side-effect import: swaps the skeleton overlay bodies for the real ones.
import "../overlays/register.ts";
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

// The canonical path each surface owns (deep-link aliases own a different path
// than their id — store-models owns /models, etc.).
const CANONICAL_PATH: Record<string, string> = {
	home: "/home",
	chat: "/chat",
	agents: "/agents",
	teams: "/teams",
	store: "/store",
	"store-models": "/models",
	"store-skills": "/skills",
	"store-engines": "/engines",
	"store-finetune": "/finetune",
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
};

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
				<InputFocusProvider>
					<ToastProvider>
						<ChatIntentProvider>
							<WorkspaceProvider>
								<OverlayProvider>
									<Capture />
									<box flexDirection="column" height="100%" width="100%">
										<TabStrip />
										<SplitView />
										<OverlayHost />
										<ToastHost />
									</box>
								</OverlayProvider>
							</WorkspaceProvider>
						</ChatIntentProvider>
					</ToastProvider>
				</InputFocusProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
	testSetup?.renderer.destroy();
	testSetup = null;
	ws = null;
	ov = null;
});

async function flush(
	setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await setup.renderOnce();
}

test("every registered surface opens as a tab and resolves through the router", async () => {
	testSetup = await testRender(<Harness />, { width: 140, height: 40 });
	await testSetup.renderOnce();

	const surfaces = listSurfaces();
	// Foundation Chat + all 6 builder bundles must be registered.
	expect(surfaces.length).toBeGreaterThanOrEqual(17);

	for (const surface of surfaces) {
		const path = CANONICAL_PATH[surface.id];
		expect(path).toBeDefined();
		// The router owns the path with no earlier-registered collision.
		expect(resolveSurface(path)?.id).toBe(surface.id);

		ws?.openTab(path);
		await flush(testSetup);
		const frame = testSetup.captureCharFrame();
		expect(frame).not.toContain("No surface registered");
		expect(frame).not.toContain("Error:");
	}
});

test("a tab can be pinned and shows the pin glyph in the tab strip", async () => {
	testSetup = await testRender(<Harness />, { width: 140, height: 40 });
	await testSetup.renderOnce();
	// Before pinning, the Agents chip carries no leading pin glyph.
	expect(testSetup.captureCharFrame()).not.toContain("*Agents");

	const id = ws?.openTab("/agents");
	await flush(testSetup);
	expect(id).toBeDefined();

	if (id) {
		ws?.pinTab(id);
	}
	await flush(testSetup);

	const pinned = ws?.tabs.find((tab) => tab.id === id);
	expect(pinned?.pinned).toBe(true);
	// The strip renders the pin glyph immediately before the tab title.
	expect(testSetup.captureCharFrame()).toContain("*Agents");
});

test("Settings overlay mounts the real grouped body (not the skeleton)", async () => {
	testSetup = await testRender(<Harness />, { width: 140, height: 40 });
	await testSetup.renderOnce();

	ov?.openOverlay("settings");
	await flush(testSetup);
	const frame = testSetup.captureCharFrame();
	expect(frame).not.toContain("Error:");
	expect(frame).toContain("Settings");
	// The real body renders its grouped nav (skeleton renders nothing).
	expect(frame).toContain("General");
});

test("Gateway overlay mounts the real grouped body (not the skeleton)", async () => {
	testSetup = await testRender(<Harness />, { width: 140, height: 40 });
	await testSetup.renderOnce();

	ov?.openOverlay("gateway");
	await flush(testSetup);
	const frame = testSetup.captureCharFrame();
	expect(frame).not.toContain("Error:");
	expect(frame).toContain("Gateway");
	// The real body renders its Overview section (skeleton renders nothing).
	expect(frame).toContain("Overview");
});

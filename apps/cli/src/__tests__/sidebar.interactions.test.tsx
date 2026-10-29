/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import type { appRequestValueSchema } from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { InputFocusProvider } from "../core/InputFocusContext.tsx";
import {
	OverlayHost,
	OverlayProvider,
	useOverlay,
} from "../overlays/OverlayHost.tsx";
import { registerOverlay, resolveOverlay } from "../overlays/registry.ts";
import { Sidebar } from "../sidebar/Sidebar.tsx";
import { TerminalThemeProvider } from "../ui/TerminalThemeProvider.tsx";
import { ryuTheme } from "../ui/theme.ts";
import {
	useWorkspace,
	WorkspaceProvider,
} from "../workspace/WorkspaceContext.tsx";
import { testRender } from "./cli-test-render.ts";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;

type WorkspaceState = ReturnType<typeof useWorkspace>;
type OverlayState = ReturnType<typeof useOverlay>;

let workspace: WorkspaceState | null = null;
let overlay: OverlayState | null = null;
let nodePickerOpens = 0;
let paletteOpens = 0;
let focusReleases = 0;
let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;
let previousSettingsOverlay: ReturnType<typeof resolveOverlay>;

function CaptureState() {
	workspace = useWorkspace();
	overlay = useOverlay();
	return null;
}

const LONG_AGENT_NAME = "Sidebar Agent With An Extremely Long Name";

function Harness({ focused = false }: { focused?: boolean }) {
	return (
		<ThemeProvider theme={ryuTheme}>
			<CoreProvider initial={LOCAL_TARGET}>
				<TerminalThemeProvider>
					<InputFocusProvider>
						<WorkspaceProvider>
							<OverlayProvider>
								<CaptureState />
								<box flexDirection="row" height="100%" width="100%">
									<Sidebar
										focused={focused}
										onOpenPalette={() => {
											paletteOpens += 1;
										}}
										onReleaseFocus={() => {
											focusReleases += 1;
										}}
										onSwitchNode={() => {
											nodePickerOpens += 1;
										}}
									/>
									<box flexGrow={1} />
								</box>
								<OverlayHost />
							</OverlayProvider>
						</WorkspaceProvider>
					</InputFocusProvider>
				</TerminalThemeProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

// Preserve the original callback's string-versus-Request .url observation.
// Ordinary URL objects deliberately keep their original undefined .url result.
const nativeFetchStringSchema = z.string();
const nativeFetchRequestSchema = z.object({ url: z.string().optional() });
function nativeFetchUrlObservation(
	input: Parameters<typeof realFetch>[0]
): string | undefined {
	const stringInput = nativeFetchStringSchema.safeParse(input);
	if (stringInput.success) {
		return stringInput.data;
	}
	const requestInput = nativeFetchRequestSchema.safeParse(input);
	return requestInput.success ? requestInput.data.url : undefined;
}
function stubSidebarApi(): void {
	globalThis.fetch = Object.assign(
		(input: Parameters<typeof realFetch>[0]) => {
			const url = String(nativeFetchUrlObservation(input));
			let body: z.infer<typeof appRequestValueSchema> = {};
			if (url.endsWith("/api/health")) {
				body = { status: "ok" };
			} else if (url.endsWith("/api/agents")) {
				body = {
					agents: [
						{ id: "agent-1", name: "Sidebar Agent" },
						{ id: "agent-2", name: LONG_AGENT_NAME },
					],
				};
			} else if (url.endsWith("/api/teams")) {
				body = { teams: [{ id: "team-1", name: "Sidebar Group" }] };
			} else if (url.endsWith("/api/spaces")) {
				body = {
					spaces: [
						{
							id: "space-1",
							name: "Sidebar Space",
							created_at: 0,
							document_count: 0,
							updated_at: 0,
						},
					],
				};
			} else if (url.endsWith("/api/meetings")) {
				// A complete native Meeting row; core-client validates every field.
				body = {
					meetings: [
						{
							id: "meeting-1",
							title: "Sidebar Meeting",
							source: "manual",
							status: "done",
							started_at: "2026-01-01T09:00:00Z",
							participants: [],
							created_at: "2026-01-01T09:00:00Z",
							updated_at: "2026-01-01T09:30:00Z",
						},
					],
				};
			} else if (url.endsWith("/workflows")) {
				body = { workflows: [{ id: "workflow-1", name: "Sidebar Workflow" }] };
			} else if (url.endsWith("/api/conversations")) {
				body = {
					conversations: [
						{ id: "pinned-1", title: "Pinned Conversation", pinned: true },
						{
							id: "project-1",
							title: "Project Conversation",
							folder: "Atlas",
						},
						{ id: "chat-1", title: "Sidebar Conversation" },
						{
							id: "archived-1",
							title: "Archived Conversation",
							archived: true,
						},
					],
				};
			}
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			);
		},
		{ preconnect: realFetch.preconnect }
	);
}

afterEach(async () => {
	globalThis.fetch = realFetch;
	if (previousSettingsOverlay) {
		registerOverlay(previousSettingsOverlay);
		previousSettingsOverlay = undefined;
	}
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	workspace = null;
	overlay = null;
	nodePickerOpens = 0;
	paletteOpens = 0;
	focusReleases = 0;
});

async function boot(height = 64, focused = false): Promise<void> {
	// This harness verifies the sidebar's open/close wiring, not Settings' body.
	// App imports elsewhere in the serial suite replace the registry skeleton, so
	// restore a deliberately inert body before asserting Escape behavior here.
	previousSettingsOverlay = resolveOverlay("settings");
	registerOverlay({
		id: "settings",
		title: "Settings",
		Body: () => null,
	});
	stubSidebarApi();
	await act(async () => {
		testSetup = await testRender(<Harness focused={focused} />, {
			height,
			width: 140,
		});
		for (let pass = 0; pass < 8; pass += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await testSetup?.renderOnce();
		}
	});
	await testSetup?.flush({ maxPasses: 12 });
	const requiredRows = [
		"Sidebar Agent",
		"Sidebar Group",
		"Sidebar Space",
		"Sidebar Meeting",
		"Sidebar Workflow",
		"Pinned Conversation",
		"Project Conversation",
		"Sidebar Conversation",
		"Archived Conversation",
	];
	for (let pass = 0; pass < 20; pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await act(async () => {
			await testSetup?.renderOnce();
		});
		if (requiredRows.every((row) => frame().includes(row))) {
			return;
		}
	}
	throw new Error(`Sidebar fixture rows did not load:\n${frame()}`);
}

function frame(): string {
	if (!testSetup) {
		throw new Error("sidebar renderer is not mounted");
	}
	return testSetup.captureCharFrame();
}

function findText(text: string, occurrence = 0) {
	let found = 0;
	for (const [y, row] of frame().split("\n").entries()) {
		const x = row.indexOf(text);
		if (x >= 0) {
			if (found === occurrence) {
				return { x, y };
			}
			found += 1;
		}
	}
	throw new Error(`Could not find ${JSON.stringify(text)} in:\n${frame()}`);
}

async function clickText(text: string, occurrence = 0): Promise<void> {
	if (!testSetup) {
		throw new Error("sidebar renderer is not mounted");
	}
	const { x, y } = findText(text, occurrence);
	await act(async () => {
		await testSetup?.mockMouse.click(x, y);
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	await testSetup.flush({ maxPasses: 12 });
}

async function clickPlusOnRow(text: string): Promise<void> {
	const rowIndex = frame()
		.split("\n")
		.findIndex((row) => row.includes(text));
	if (rowIndex < 0) {
		throw new Error(
			`Could not find row ${JSON.stringify(text)} in:\n${frame()}`
		);
	}
	const x = frame().split("\n")[rowIndex]?.indexOf("+") ?? -1;
	if (x < 0) {
		throw new Error(
			`Could not find create control on ${text} row:\n${frame()}`
		);
	}
	if (!testSetup) {
		throw new Error("sidebar renderer is not mounted");
	}
	await act(async () => {
		await testSetup?.mockMouse.click(x, rowIndex);
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	await testSetup.flush({ maxPasses: 12 });
}

async function pressEscape(): Promise<void> {
	if (!testSetup) {
		throw new Error("sidebar renderer is not mounted");
	}
	await act(async () => {
		testSetup?.mockInput.pressEscape();
		await new Promise((resolve) => setTimeout(resolve, 100));
	});
	await testSetup.flush({ maxPasses: 12 });
}

function sectionHasItem(section: string, item: string): boolean {
	const rows = frame().split("\n");
	const start = rows.findIndex((row) => row.includes(section));
	if (start < 0) {
		return false;
	}
	const nextSection = rows.findIndex(
		(row, index) =>
			index > start &&
			/^\s*[▾▸]\s+(AGENTS|GROUPS|SPACES|MEETINGS|WORKFLOWS|PINNED|PROJECTS|CHATS|ARCHIVED)\b/.test(
				row
			)
	);
	return rows
		.slice(start + 1, nextSection < 0 ? undefined : nextSection)
		.some((row) => row.includes(item));
}

function activePath(): string | undefined {
	const state = workspace;
	const focusedPane = state?.panes.find(
		(pane) => pane.id === state.focusedPaneId
	);
	return state?.tabs.find((tab) => tab.id === focusedPane?.activeTabId)?.path;
}

test("sidebar navigation, search, node picker, and account destinations respond to clicks", async () => {
	await boot();

	await clickText("127.0.0.1:7980");
	expect(nodePickerOpens).toBe(1);

	await clickText("Home");
	expect(activePath()).toBe("/home");

	const tabsBeforeNewChat = workspace?.tabs.length ?? 0;
	await clickText("New chat");
	expect(activePath()).toBe("/chat");
	expect(workspace?.tabs.length).toBe(tabsBeforeNewChat + 1);

	await clickText("Search (Ctrl+K)");
	expect(paletteOpens).toBe(1);

	await clickText("Library");
	expect(activePath()).toBe("/library");
	await clickText("Customize");
	expect(activePath()).toBe("/store");
	await clickText("Tasks");
	expect(activePath()).toBe("/tasks");
	await clickText("Timeline");
	expect(activePath()).toBe("/timeline");

	await clickText("Sidebar Agent");
	expect(activePath()).toBe("/agents");
	await clickText("Sidebar Group");
	expect(activePath()).toBe("/teams");
	await clickText("Sidebar Space");
	expect(activePath()).toBe("/spaces");
	await clickText("Sidebar Meeting");
	expect(activePath()).toBe("/meetings");
	await clickText("Sidebar Workflow");
	expect(activePath()).toBe("/workflows");

	await clickText("Pinned Conversation");
	expect(activePath()).toBe("/chat");
	await clickText("Project Conversation");
	expect(activePath()).toBe("/chat");
	await clickText("Sidebar Conversation");
	expect(activePath()).toBe("/chat");
	await clickText("Archived Conversation");
	expect(activePath()).toBe("/chat");

	await clickText("Inbox");
	expect(activePath()).toBe("/inbox");
	await clickText("Downloads");
	expect(activePath()).toBe("/downloads");
	await clickText("Account");
	expect(overlay?.openId).toBe("settings");
	await pressEscape();
	expect(overlay?.openId).toBeNull();
	await clickText("⚙", 0);
	expect(overlay?.openId).toBe("settings");
});

test("sidebar section headers collapse and restore their own content", async () => {
	await boot();

	const sections = [
		["AGENTS", "Sidebar Agent"],
		["GROUPS", "Sidebar Group"],
		["SPACES", "Sidebar Space"],
		["MEETINGS", "Sidebar Meeting"],
		["WORKFLOWS", "Sidebar Workflow"],
		["PINNED", "Pinned Conversation"],
		["PROJECTS", "Project Conversation"],
		["CHATS", "Sidebar Conversation"],
		["ARCHIVED", "Archived Conversation"],
	] as const;

	for (const [heading, item] of sections) {
		expect(sectionHasItem(heading, item), `${heading} expanded`).toBe(true);
		await clickText(heading);
		expect(
			sectionHasItem(heading, item),
			`${heading} failed to collapse:\n${frame()}`
		).toBe(false);
		await clickText(heading);
		expect(sectionHasItem(heading, item)).toBe(true);
	}
});

test("each sidebar create control opens its section destination", async () => {
	await boot();

	const actions = [
		["AGENTS", "/agents"],
		["GROUPS", "/teams"],
		["SPACES", "/spaces"],
		["MEETINGS", "/meetings"],
		["WORKFLOWS", "/workflows"],
		["PINNED", "/chat"],
		["CHATS", "/chat"],
		["ARCHIVED", "/chat"],
	] as const;

	for (const [heading, path] of actions) {
		await clickPlusOnRow(heading);
		expect(activePath()).toBe(path);
	}
});

async function pressKeys(
	...keys: ("up" | "down" | "left" | "right" | "return")[]
): Promise<void> {
	if (!testSetup) {
		throw new Error("sidebar renderer is not mounted");
	}
	for (const key of keys) {
		await act(async () => {
			if (key === "return") {
				testSetup?.mockInput.pressEnter();
			} else {
				testSetup?.mockInput.pressArrow(key);
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await testSetup.flush({ maxPasses: 6 });
	}
}

/** The background color under the first cell of `text`. */
function backgroundAt(text: string): RGBA | undefined {
	if (!testSetup) {
		throw new Error("sidebar renderer is not mounted");
	}
	const { y } = findText(text);
	const line = testSetup.captureSpans().lines[y];
	return line?.spans.find((span) => span.text.includes(text))?.bg;
}

function sameColor(color: RGBA | undefined, hex: string): boolean {
	return (
		color?.toInts().slice(0, 3).join() ===
		RGBA.fromHex(hex).toInts().slice(0, 3).join()
	);
}

test("focus mode walks rows with arrows, folds sections, and Enter opens an item", async () => {
	await boot(64, true);

	// Rows: node, mode, seven nav buttons, then the AGENTS header (index 9).
	expect(
		sameColor(backgroundAt("127.0.0.1:7980"), ryuTheme.colors.selection)
	).toBe(true);
	await pressKeys(...Array.from({ length: 9 }, () => "down" as const));
	expect(sameColor(backgroundAt("AGENTS"), ryuTheme.colors.selection)).toBe(
		true
	);

	// Left folds the section, Right unfolds it, Enter on a header folds in place.
	await pressKeys("left");
	expect(sectionHasItem("AGENTS", "Sidebar Agent")).toBe(false);
	await pressKeys("right");
	expect(sectionHasItem("AGENTS", "Sidebar Agent")).toBe(true);
	await pressKeys("return");
	expect(sectionHasItem("AGENTS", "Sidebar Agent")).toBe(false);
	await pressKeys("return");
	expect(sectionHasItem("AGENTS", "Sidebar Agent")).toBe(true);
	expect(focusReleases).toBe(0);

	// Left on an item folds its section and moves focus back to the header.
	await pressKeys("down", "left");
	expect(sectionHasItem("AGENTS", "Sidebar Agent")).toBe(false);
	expect(sameColor(backgroundAt("AGENTS"), ryuTheme.colors.selection)).toBe(
		true
	);
	await pressKeys("right", "down", "return");
	expect(activePath()).toBe("/agents");
	expect(focusReleases).toBe(1);

	// Up from the first row wraps to the footer.
	await pressKeys(...Array.from({ length: 11 }, () => "up" as const));
	expect(sameColor(backgroundAt("Downloads"), ryuTheme.colors.selection)).toBe(
		true
	);
});

test("rows highlight under the pointer and long labels end with an ellipsis", async () => {
	await boot();

	const frameText = frame();
	expect(frameText).not.toContain(LONG_AGENT_NAME);
	const cut = frameText
		.split("\n")
		.find((row) => row.includes("Sidebar Agent With"));
	expect(cut?.trim().endsWith("…")).toBe(true);
	// The cut label stays inside the 24-column sidebar.
	expect(cut?.indexOf("…")).toBeLessThan(24);

	expect(sameColor(backgroundAt("Library"), ryuTheme.colors.muted)).toBe(false);
	const { x, y } = findText("Library");
	await act(async () => {
		await testSetup?.mockMouse.moveTo(x, y);
	});
	await testSetup?.flush({ maxPasses: 6 });
	expect(sameColor(backgroundAt("Library"), ryuTheme.colors.muted)).toBe(true);
	await act(async () => {
		await testSetup?.mockMouse.moveTo(100, 2);
	});
	await testSetup?.flush({ maxPasses: 6 });
	expect(sameColor(backgroundAt("Library"), ryuTheme.colors.muted)).toBe(false);
});

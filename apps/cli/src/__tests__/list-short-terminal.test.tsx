/* @jsxImportSource @opentui/react */
// Regression: list windows used to draw a fixed 16 rows whatever the terminal
// height. In 24 lines with a 4-line header, 16 two-line rows did not fit, so the
// rows flex-shrank and subtitles overwrote titles. The window now follows the
// measured space, so every visible row stays readable.

import { afterEach, expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { App } from "../App.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import type { ListRow } from "../core/featureList.ts";
import { InputFocusProvider } from "../core/InputFocusContext.tsx";
import type { ListLoader } from "../ui/ListTab.tsx";
import { ListTab } from "../ui/ListTab.tsx";
import { ryuTheme } from "../ui/theme.ts";
import { rowsThatFit, windowStart } from "../ui/useListWindow.ts";
import { testRender } from "./cli-test-render.ts";
import { MIN_TEXT_CONTRAST, renderedContrast } from "./color-contrast.ts";

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const PROVIDER_COUNT = 30;
const SUBTITLE_MARKER = "subtitle-text";
const TITLE_PATTERN = /provider-name-(\d+)/g;
const POSITION_PATTERN = /\b\d+\/30\b/;

const STEP_LINE = "1 Dependencies [2 Providers] 3 Tools 4 Agents";
const realFetch = globalThis.fetch;

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
});

const providers: ListRow[] = Array.from({ length: PROVIDER_COUNT }, (_, i) => ({
	id: `provider-${i + 1}`,
	title: `provider-name-${i + 1}`,
	subtitle: `${SUBTITLE_MARKER} ${"a long provider description that is much wider than the terminal ".repeat(3)}`,
	badge: i % 3 === 0 ? "recommended" : undefined,
}));

const loadProviders: ListLoader = async () => providers;

function Harness() {
	return (
		<ThemeProvider theme={ryuTheme}>
			<CoreProvider initial={LOCAL_TARGET}>
				<InputFocusProvider>
					<box flexDirection="column" flexGrow={1}>
						<box flexDirection="column">
							<text>Setup</text>
							<text>1 Dependencies [2 Providers] 3 Tools 4 Agents</text>
							<text>local inference engines · Enter install</text>
							<text>header line four</text>
						</box>
						<ListTab active load={loadProviders} />
					</box>
				</InputFocusProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

function frame(): string {
	if (!testSetup) {
		throw new Error("list renderer is not mounted");
	}
	return testSetup.captureCharFrame();
}

async function settle(): Promise<void> {
	for (let pass = 0; pass < 6; pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await act(async () => {
			await testSetup?.renderOnce();
		});
	}
}

async function pressDown(): Promise<void> {
	await act(async () => {
		testSetup?.mockInput.pressArrow("down");
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await testSetup?.flush({ maxPasses: 12 });
}

interface FrameRows {
	/** Lines that hold more than one title (rows drawn over each other). */
	crowdedLines: string[];
	/** Lines where a title shares the line with subtitle text. */
	mixedLines: string[];
	/** Lines that mention an `N/30` position. */
	positionLines: string[];
	/** Provider numbers of the visible titles, top to bottom. */
	titles: number[];
}

/** Reads the drawn rows out of a frame so the test can check none overlap. */
function readFrameRows(current: string): FrameRows {
	const rows: FrameRows = {
		crowdedLines: [],
		mixedLines: [],
		positionLines: [],
		titles: [],
	};
	for (const line of current.split("\n")) {
		if (POSITION_PATTERN.test(line)) {
			rows.positionLines.push(line.trim());
		}
		const matches = [...line.matchAll(TITLE_PATTERN)];
		if (matches.length === 0) {
			continue;
		}
		if (matches.length > 1) {
			rows.crowdedLines.push(line);
		}
		if (line.includes(SUBTITLE_MARKER)) {
			rows.mixedLines.push(line);
		}
		rows.titles.push(Number(matches[0]?.[1]));
	}
	return rows;
}

/** The provider numbers a window of `length` rows starting at `first` shows. */
function consecutive(first: number, length: number): number[] {
	return Array.from({ length }, (_, i) => first + i);
}

test("a long provider list stays readable in an 80x24 terminal", async () => {
	testSetup = await testRender(<Harness />, { width: 80, height: 24 });
	await settle();
	const initial = frame();
	expect(initial).toContain("provider-name-1");
	const first = readFrameRows(initial);
	expect(first.crowdedLines).toEqual([]);
	expect(first.mixedLines).toEqual([]);
	expect(first.titles.length).toBeGreaterThan(1);
	expect(first.titles).toEqual(consecutive(1, first.titles.length));
	expect(first.positionLines).toEqual(["1/30"]);
	// The selected row's title and badge stay legible on the selection
	// background (the badge's own tone is tuned for the page background).
	const spans = testSetup.captureSpans();
	expect(renderedContrast(spans, "provider-name-1")).toBeGreaterThanOrEqual(
		MIN_TEXT_CONTRAST
	);
	expect(renderedContrast(spans, "recommended")).toBeGreaterThanOrEqual(
		MIN_TEXT_CONTRAST
	);

	for (let press = 0; press < 20; press += 1) {
		await pressDown();
	}
	await settle();
	const moved = frame();
	const after = readFrameRows(moved);
	expect(after.crowdedLines).toEqual([]);
	expect(after.mixedLines).toEqual([]);
	expect(after.titles).toEqual(
		consecutive(after.titles[0] ?? 0, after.titles.length)
	);
	expect(after.titles).toContain(21);
	expect(after.positionLines).toEqual(["21/30"]);
	const selectedLine = moved
		.split("\n")
		.find((line) => line.includes("provider-name-21"));
	expect(selectedLine).toContain("›");
});

test("window math fills the measured space and stays centred on the selection", () => {
	expect(rowsThatFit(18, 2)).toBe(9);
	expect(rowsThatFit(18, 1, 1)).toBe(17);
	expect(rowsThatFit(1, 2)).toBe(1);
	expect(rowsThatFit(40, 1, 0, 16)).toBe(16);
	expect(windowStart(0, 30, 9)).toBe(0);
	expect(windowStart(20, 30, 9)).toBe(16);
	expect(windowStart(29, 30, 9)).toBe(21);
	expect(windowStart(3, 5, 9)).toBe(0);
});

async function pressKey(name: string, ctrl = false): Promise<void> {
	await act(async () => {
		testSetup?.renderer.keyInput.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name.length === 1 ? name : "",
				ctrl,
				shift: false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: name.length === 1 ? name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await testSetup?.renderOnce();
}

async function waitForFrameText(predicate: (current: string) => boolean) {
	for (let pass = 0; pass < 35 && !predicate(frame()); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await testSetup?.renderOnce();
	}
	const current = frame();
	if (!predicate(current)) {
		throw new Error(`Setup render did not match: ${current}`);
	}
	return current;
}

test("the Setup providers step keeps its header intact at 80x24", async () => {
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0]) => {
			const url = new URL(String(input));
			if (url.pathname !== "/api/catalog") {
				return Response.json({});
			}
			return Response.json({
				sidecars: Array.from({ length: PROVIDER_COUNT }, (_, i) => ({
					name: `provider-name-${i + 1}`,
					category: "provider",
					description: `${SUBTITLE_MARKER} a long provider description that is much wider than an eighty column terminal`,
					install_state: "not_installed",
				})),
			});
		},
		{ preconnect: realFetch.preconnect }
	);
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width: 80,
		height: 24,
	});
	await pressKey("k", true);
	for (const character of "setup") {
		await pressKey(character);
	}
	await waitForFrameText((current) => current.includes("Go to Setup"));
	await pressKey("return");
	await waitForFrameText((current) => current.includes("Dependencies"));
	await pressKey("right");
	await waitForFrameText((current) => current.includes("provider-name-1"));
	await settle();

	const current = frame();
	// The step strip and hint keep their own lines instead of being squeezed
	// together by an over-tall list window.
	expect(current).toContain(STEP_LINE);
	expect(current).toContain("local inference engines · Enter install");
	const rows = readFrameRows(current);
	expect(rows.crowdedLines).toEqual([]);
	expect(rows.mixedLines).toEqual([]);
	expect(rows.titles.length).toBeGreaterThan(1);
	expect(rows.titles).toEqual(consecutive(1, rows.titles.length));
	// The position footer still fits under the window (the sidebar shares the
	// terminal line, so match the end of it).
	expect(rows.positionLines).toHaveLength(1);
	expect(rows.positionLines[0]).toEndWith("1/30");
});

/* @jsxImportSource @opentui/react */
// Overlays render through the shared Modal: a bordered panel floating over the
// surface instead of an in-flow card that the transcript and composer squeeze.
// At small, default and large terminal sizes the keymap, the shell product-mode
// overlay and the /model picker must show their title inside an intact border,
// keep the composer out of the panel, and scroll content that does not fit.

import { afterEach, describe, expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { App } from "../App.tsx";
import { keymapGroups } from "../core/keymap.ts";
import { Modal, modalRowId, modalSize } from "../ui/Modal.tsx";
import { testRender } from "./cli-test-render.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const COMPOSER_PLACEHOLDER = "Message ·";
const SIZES: { height: number; width: number }[] = [
	{ width: 60, height: 20 },
	{ width: 80, height: 24 },
	{ width: 120, height: 36 },
];
const realFetch = globalThis.fetch;
let testSetup: Setup | null = null;

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
});

const MODEL_COUNT = 30;

/** One agent whose ACP config offers more models than a small panel fits. */
function installResponses(): void {
	const respond = (input: Parameters<typeof realFetch>[0]) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/agents") {
			return Response.json({
				agents: [{ id: "agent-alpha", name: "Alpha Agent", model: "m-0" }],
			});
		}
		if (url.pathname === "/api/agents/agent-alpha/acp-config") {
			return Response.json({
				modes: null,
				models: {
					currentModelId: "m-0",
					availableModels: Array.from({ length: MODEL_COUNT }, (_, i) => ({
						modelId: `m-${i}`,
						name: `Model ${i}`,
					})),
				},
				configOptions: null,
			});
		}
		return Response.json({});
	};
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0]) => respond(input),
		{ preconnect: realFetch.preconnect }
	);
}

interface KeyOverride {
	ctrl?: boolean;
	name: string;
	shift?: boolean;
}

async function press(setup: Setup, key: KeyOverride): Promise<void> {
	await act(async () => {
		setup.renderer.keyInput.emit(
			"keypress",
			new KeyEvent({
				name: key.name,
				sequence: key.name.length === 1 ? key.name : "",
				ctrl: key.ctrl ?? false,
				shift: key.shift ?? false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: key.name.length === 1 ? key.name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await setup.renderOnce();
}

async function waitForFrame(
	setup: Setup,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = setup.captureCharFrame();
	const deadline = performance.now() + 2000;
	while (!predicate(frame) && performance.now() < deadline) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
		});
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Frame did not match:\n${frame}`);
	}
	return frame;
}

/** Type a bare slash command and run it, waiting for `expected` to render. */
async function runSlash(
	setup: Setup,
	command: string,
	expected: string
): Promise<void> {
	await act(async () => {
		await setup.mockInput.typeText(command);
	});
	await setup.flush({ maxPasses: 12 });
	// The first Enter may only accept the slash completion; the next runs it.
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (setup.captureCharFrame().includes(expected)) {
			break;
		}
		await act(async () => {
			setup.mockInput.pressEnter();
		});
		await setup.renderOnce();
	}
	await waitForFrame(setup, (frame) => frame.includes(expected));
}

async function settle(setup: Setup): Promise<string> {
	for (let pass = 0; pass < 3; pass += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await setup.renderOnce();
		});
	}
	return setup.captureCharFrame();
}

interface PanelBounds {
	bottom: number;
	left: number;
	right: number;
	rows: string[];
	top: number;
}

/** Locate the Modal panel around the title row: its rounded top and bottom
 * border rows and its left and right border columns (null when the title is
 * missing). */
function panelAround(frame: string, title: string): PanelBounds | null {
	const rows = frame.split("\n");
	const titleRow = rows.findIndex((row) => row.includes(title));
	const titleLine = rows[titleRow];
	if (titleRow < 1 || titleLine === undefined) {
		return null;
	}
	const left = titleLine.lastIndexOf("│", titleLine.indexOf(title));
	if (left < 0) {
		return null;
	}
	let top = titleRow - 1;
	while (top >= 0 && rows[top]?.[left] !== "╭") {
		top -= 1;
	}
	let bottom = titleRow + 1;
	while (bottom < rows.length && rows[bottom]?.[left] !== "╰") {
		bottom += 1;
	}
	const right = rows[top]?.indexOf("╮", left) ?? -1;
	return { bottom, left, right, rows, top };
}

/** Everything wrong with the panel around `title`: a missing, open or
 * overwritten border (e.g. a footer drawn onto the bottom edge), another glyph
 * over a side edge, or the composer inside it. */
function panelProblems(frame: string, title: string): string[] {
	const panel = panelAround(frame, title);
	if (!panel) {
		return [`no bordered panel titled ${title}`];
	}
	const problems: string[] = [];
	if (panel.top < 0 || panel.right < 0) {
		return ["missing top border ╭…╮"];
	}
	if (panel.bottom >= panel.rows.length) {
		return ["missing bottom border ╰…╯"];
	}
	const edge = (row: number) =>
		(panel.rows[row] ?? "").slice(panel.left + 1, panel.right);
	if (!/^─+$/.test(edge(panel.top))) {
		problems.push("the top border is overwritten");
	}
	const bottomLine = panel.rows[panel.bottom] ?? "";
	if (bottomLine[panel.right] !== "╯" || !/^─+$/.test(edge(panel.bottom))) {
		problems.push("the bottom border is overwritten");
	}
	for (let row = panel.top + 1; row < panel.bottom; row += 1) {
		const line = panel.rows[row] ?? "";
		if (line[panel.left] !== "│") {
			problems.push(`row ${row} overlaps the left border`);
		}
		if (line[panel.right] !== "│") {
			problems.push(`row ${row} overlaps the right border`);
		}
		if (line.includes(COMPOSER_PLACEHOLDER)) {
			problems.push(`row ${row} shows the composer inside the panel`);
		}
	}
	return problems;
}

/** The panel around `title`; throws with every problem when it is not intact. */
function intactPanel(frame: string, title: string): PanelBounds {
	const problems = panelProblems(frame, title);
	const panel = panelAround(frame, title);
	if (problems.length > 0 || !panel) {
		throw new Error(`${problems.join("; ")}:\n${frame}`);
	}
	return panel;
}

async function renderApp(width: number, height: number): Promise<Setup> {
	installResponses();
	testSetup = await testRender(<App target={LOCAL_TARGET} />, {
		width,
		height,
	});
	await testSetup.renderOnce();
	await waitForFrame(testSetup, (frame) =>
		frame.includes(COMPOSER_PLACEHOLDER)
	);
	return testSetup;
}

test("modalSize clamps the panel to the terminal with a margin", () => {
	expect(modalSize(200, 50, 60)).toEqual({
		maxBodyRows: 42,
		maxHeight: 46,
		width: 60,
	});
	expect(modalSize(50, 20, 60, true)).toEqual({
		maxBodyRows: 10,
		maxHeight: 16,
		width: 46,
	});
	// Tiny terminals still get a usable panel instead of zero/negative sizes.
	expect(modalSize(3, 4, 60)).toEqual({
		maxBodyRows: 2,
		maxHeight: 6,
		width: 1,
	});
});

test("a Modal opened on a row below the fold scrolls it into view", async () => {
	const rows = Array.from({ length: 30 }, (_, i) => `Row ${i}`);
	testSetup = await testRender(
		<box height="100%" width="100%">
			<Modal
				activeRowId={modalRowId(25)}
				footer="footer"
				onClose={() => undefined}
				title="Rows"
				width={30}
			>
				{rows.map((label, i) => (
					<box id={modalRowId(i)} key={label}>
						<text>{label}</text>
					</box>
				))}
			</Modal>
		</box>,
		{ width: 40, height: 16 }
	);
	const frame = await settle(testSetup);
	expect(frame).toContain("Row 25");
	expect(frame).not.toContain("Row 0 ");
	intactPanel(frame, "Rows");
});

const lastKeymapEntry = (() => {
	const groups = keymapGroups();
	const entries = groups.at(-1)?.entries ?? [];
	const last = entries.at(-1);
	if (!last) {
		throw new Error("The chat keymap has no entries");
	}
	// The keys column never wraps (labels may, in a narrow pane).
	return last.keys;
})();

describe.each(SIZES)("overlay modals at $width x $height", ({
	width,
	height,
}) => {
	test("the keymap floats in a bordered panel and scrolls to its last entry", async () => {
		const setup = await renderApp(width, height);
		await press(setup, { name: "?", ctrl: true });
		const opened = await waitForFrame(setup, (frame) =>
			frame.includes("Keyboard shortcuts")
		);
		intactPanel(await settle(setup), "Keyboard shortcuts");
		if (width === 60) {
			// The small terminal cannot fit every shortcut, so the body scrolls.
			expect(opened).not.toContain(lastKeymapEntry);
		}
		for (let step = 0; step < 12; step += 1) {
			await press(setup, { name: "pagedown" });
		}
		const scrolled = await waitForFrame(setup, (frame) =>
			frame.includes(lastKeymapEntry)
		);
		intactPanel(scrolled, "Keyboard shortcuts");
		await press(setup, { name: "escape" });
		expect(
			await waitForFrame(
				setup,
				(frame) => !frame.includes("Keyboard shortcuts")
			)
		).toContain(COMPOSER_PLACEHOLDER);
	});

	test("the product-mode overlay renders inside an intact panel and keeps the selected card shown", async () => {
		const setup = await renderApp(width, height);
		await press(setup, { name: "m", ctrl: true, shift: true });
		await waitForFrame(setup, (frame) => frame.includes("Ryu product mode"));
		intactPanel(await settle(setup), "Ryu product mode");
		// Move to the last card: in a short terminal the body scrolls to it.
		await press(setup, { name: "down" });
		await press(setup, { name: "down" });
		const moved = await waitForFrame(
			setup,
			(frame) => frame.includes("›OS") || frame.includes("› OS")
		);
		intactPanel(moved, "Ryu product mode");
	});

	test("the /model picker floats over the transcript and the backdrop closes it", async () => {
		const setup = await renderApp(width, height);
		await runSlash(setup, "/agent", "Select agent");
		intactPanel(await settle(setup), "Select agent");
		await press(setup, { name: "return" });
		await waitForFrame(setup, (frame) => frame.includes("agent:agent-alpha"));
		await runSlash(setup, "/model", "Select model");
		// Walking past the visible rows keeps the selection on screen.
		for (let step = 0; step < MODEL_COUNT; step += 1) {
			await press(setup, { name: "down" });
		}
		await waitForFrame(setup, (frame) =>
			frame.includes(`Model ${MODEL_COUNT - 1}`)
		);
		const panel = intactPanel(await settle(setup), "Select model");
		await act(async () => {
			// The dimmed backdrop beside the panel closes the picker.
			await setup.mockMouse.click(panel.left - 1, panel.top + 1);
		});
		expect(
			await waitForFrame(setup, (frame) => !frame.includes("Select model"))
		).toContain(COMPOSER_PLACEHOLDER);
	});
});

test("the release of the click that opens a modal does not close it", async () => {
	// Wide enough that the sidebar (auto-hidden below 100 columns) is shown.
	const setup = await renderApp(120, 30);
	const rows = setup.captureCharFrame().split("\n");
	const row = rows.findIndex((line) => line.includes("127.0.0.1:7980 ⌄"));
	const column = (rows[row] ?? "").indexOf("127.0.0.1");
	// A real click: sidebar rows activate on release (so a drag-select never
	// navigates), and the picker that release opens must survive it.
	await act(async () => {
		await setup.mockMouse.pressDown(column + 2, row);
	});
	await act(async () => {
		await setup.mockMouse.release(column + 2, row);
	});
	await waitForFrame(setup, (frame) => frame.includes("Switch node"));
	const panel = intactPanel(await settle(setup), "Switch node");
	// A click that starts on the backdrop still closes it.
	await act(async () => {
		await setup.mockMouse.click(panel.left - 1, panel.top + 1);
	});
	await waitForFrame(setup, (frame) => !frame.includes("Switch node"));
});

import { expect, test } from "bun:test";
import type { KeyHint } from "../core/keymap.ts";
import {
	cellWidth,
	fitLeftText,
	fitStatusBar,
	hintWidth,
	middleTruncate,
} from "../ui/StatusBar.tsx";

const SHELL_HINTS: KeyHint[] = [
	{ keys: "^K", label: "palette", priority: 0 },
	{ keys: "^N", label: "node", priority: 4 },
	{ keys: "^⇧M", label: "mode", priority: 5 },
	{ keys: "^T", label: "new", priority: 2 },
	{ keys: "^W", label: "close", priority: 3 },
	{ keys: "^C×2", label: "quit", priority: 1 },
];

/** Total rendered cells: padding + segments + 2-cell gaps. */
function renderedWidth(fit: ReturnType<typeof fitStatusBar>): number {
	const segments = [
		...(fit.busy ? [cellWidth(fit.busy)] : []),
		...(fit.left ? [cellWidth(fit.left)] : []),
		...fit.hints.map(hintWidth),
	];
	const gaps = Math.max(0, segments.length - 1) * 2;
	return 2 + gaps + segments.reduce((sum, width) => sum + width, 0);
}

test("at width 60 the bar keeps only whole hints and fits the width", () => {
	const fit = fitStatusBar({
		hints: SHELL_HINTS,
		left: "CONSOLE · http://127.0.0.1:8980",
		width: 60,
	});
	expect(renderedWidth(fit)).toBeLessThanOrEqual(60);
	// Every kept hint is one of the inputs, unmodified (dropped whole, never cut).
	for (const hint of fit.hints) {
		expect(SHELL_HINTS).toContainEqual(hint);
	}
	expect(fit.hints.map((hint) => hint.keys)).toContain("^K");
	expect(fit.hints.map((hint) => hint.keys)).toContain("^C×2");
	expect(fit.hints.length).toBeLessThan(SHELL_HINTS.length);
});

test("kept hints stay in display order even when ranked by priority", () => {
	const fit = fitStatusBar({ hints: SHELL_HINTS, width: 200 });
	expect(fit.hints).toEqual(SHELL_HINTS);
});

test("hints are dropped from the highest priority number first", () => {
	const widths = [80, 70, 60, 50, 40];
	let previous = SHELL_HINTS.length + 1;
	for (const width of widths) {
		const kept = fitStatusBar({ hints: SHELL_HINTS, width }).hints;
		expect(kept.length).toBeLessThanOrEqual(previous);
		previous = kept.length;
		const keptPriorities = kept.map((hint) => hint.priority ?? 50);
		const dropped = SHELL_HINTS.filter((hint) => !kept.includes(hint));
		for (const hint of dropped) {
			// Nothing kept is less important than something dropped.
			expect(Math.max(...keptPriorities)).toBeLessThanOrEqual(
				hint.priority ?? 50
			);
		}
	}
	expect(fitStatusBar({ hints: SHELL_HINTS, width: 30 }).hints).toEqual([
		SHELL_HINTS[0],
		SHELL_HINTS[5],
	]);
});

test("an over-long url is middle-truncated, keeping the scheme and port", () => {
	const left =
		"CONSOLE · https://very-long-managed-node-hostname.cloud.example.com:8980";
	const fit = fitStatusBar({ hints: SHELL_HINTS.slice(0, 1), left, width: 50 });
	expect(fit.left).toContain("…");
	expect(fit.left.startsWith("CONSOLE · https")).toBe(true);
	expect(fit.left.endsWith(".com:8980")).toBe(true);
	expect(renderedWidth(fit)).toBeLessThanOrEqual(50);
});

test("the left text is dropped before a priority-0 hint", () => {
	const fit = fitStatusBar({
		hints: SHELL_HINTS.slice(0, 1),
		left: "CONSOLE · http://127.0.0.1:8980",
		width: 20,
	});
	expect(fit.left).toBe("");
	expect(fit.hints).toEqual(SHELL_HINTS.slice(0, 1));
});

test("the busy segment claims space before every hint", () => {
	const busy = "⠋ Esc interrupt · 4s";
	const fit = fitStatusBar({
		busy,
		hints: SHELL_HINTS,
		left: "CONSOLE · http://127.0.0.1:8980",
		width: 40,
	});
	expect(fit.busy).toBe(busy);
	expect(renderedWidth(fit)).toBeLessThanOrEqual(40);
});

test("middleTruncate measures wide glyphs by cell width", () => {
	expect(middleTruncate("short", 10)).toBe("short");
	const cut = middleTruncate("模型模型模型模型", 7);
	expect(cellWidth(cut)).toBeLessThanOrEqual(7);
	expect(cut).toContain("…");
	expect(hintWidth({ keys: "^⇧M", label: "mode" })).toBe(
		cellWidth("^⇧M") + 1 + 4
	);
});

test("a leftPriority lets the left text show in full ahead of lower hints", () => {
	const left = "CONSOLE · http://127.0.0.1:7980";
	const leftover = fitStatusBar({ hints: SHELL_HINTS, left, width: 60 });
	expect(leftover.left).toContain("…");
	const ranked = fitStatusBar({
		hints: SHELL_HINTS,
		left,
		leftPriority: 1.9,
		width: 60,
	});
	expect(ranked.left).toBe(left);
	// Palette and quit outrank the left text; ^T (2) and below yield to it.
	expect(ranked.hints).toEqual([SHELL_HINTS[0], SHELL_HINTS[5]]);
	expect(renderedWidth(ranked)).toBeLessThanOrEqual(60);
	// With room to spare the lower hints still follow the full left text.
	const wide = fitStatusBar({
		hints: SHELL_HINTS,
		left,
		leftPriority: 1.9,
		width: 80,
	});
	expect(wide.left).toBe(left);
	expect(wide.hints.map((hint) => hint.keys)).toContain("^T");
	// Too narrow for the full text: it is truncated and lower hints stay dropped.
	const narrow = fitStatusBar({
		hints: SHELL_HINTS,
		left,
		leftPriority: 1.9,
		width: 40,
	});
	expect(narrow.left).toContain("…");
	expect(narrow.hints).toEqual([SHELL_HINTS[0], SHELL_HINTS[5]]);
	expect(renderedWidth(narrow)).toBeLessThanOrEqual(40);
});

test("a focused-region suffix stays whole while the text before it is trimmed", () => {
	const url = "CONSOLE · http://127.0.0.1:7980";
	expect(fitLeftText(url, 80, "Right")).toBe(`${url} · Right`);
	// 24 cells: " · Right" keeps 8, the node text gets the other 16.
	const trimmed = fitLeftText(url, 24, "Right");
	expect(trimmed.endsWith(" · Right")).toBe(true);
	expect(trimmed.startsWith("CONSOLE")).toBe(true);
	expect(trimmed).toContain("…");
	expect(cellWidth(trimmed)).toBe(24);
	// Too narrow for any node text: the region name alone, trimmed if it must be.
	expect(fitLeftText(url, 6, "Bottom")).toBe("Bottom");
	expect(cellWidth(fitLeftText(url, 4, "Bottom"))).toBeLessThanOrEqual(4);
	expect(fitLeftText("", 20, "Right")).toBe("Right");
});

test("the bar keeps the focused region when it trims the left text", () => {
	const left = "CONSOLE · http://127.0.0.1:7980";
	const fit = fitStatusBar({
		hints: SHELL_HINTS,
		left,
		leftPriority: 1.9,
		leftSuffix: "Bottom",
		width: 60,
	});
	expect(fit.left.endsWith(" · Bottom")).toBe(true);
	expect(fit.left).toContain("…");
	expect(renderedWidth(fit)).toBeLessThanOrEqual(60);
	const wide = fitStatusBar({
		hints: SHELL_HINTS,
		left,
		leftPriority: 1.9,
		leftSuffix: "Bottom",
		width: 120,
	});
	expect(wide.left).toBe(`${left} · Bottom`);
	expect(wide.hints).toEqual(SHELL_HINTS);
});

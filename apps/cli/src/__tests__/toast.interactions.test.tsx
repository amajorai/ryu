/* @jsxImportSource @opentui/react */

import { afterEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { StatusBar } from "../ui/StatusBar.tsx";
import { ryuLightTheme, ryuTheme } from "../ui/theme.ts";
import {
	TOAST_TTL_MS,
	ToastHost,
	ToastProvider,
	useToast,
} from "../ui/toast.tsx";
import { testRender } from "./cli-test-render.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;
type TtlOverrides = Parameters<typeof ToastProvider>[0]["ttl"];

let setup: Setup | null = null;
let toastApi: ReturnType<typeof useToast> | null = null;

afterEach(async () => {
	jest.useRealTimers();
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
	toastApi = null;
});

function CaptureToast() {
	toastApi = useToast();
	return null;
}

function Harness({
	theme = ryuTheme,
	ttl,
}: {
	theme?: typeof ryuTheme;
	ttl?: TtlOverrides;
}) {
	return (
		<ThemeProvider reducedMotion theme={theme}>
			<ToastProvider ttl={ttl}>
				<CaptureToast />
				<box flexDirection="column" height="100%" width="100%">
					<box flexDirection="column" flexGrow={1} minHeight={0}>
						<text>pane first row</text>
						<text>pane second row</text>
					</box>
					<StatusBar hints={[]} left="footer status" />
					<ToastHost />
				</box>
			</ToastProvider>
		</ThemeProvider>
	);
}

async function mount(
	ttl?: TtlOverrides,
	options: { height?: number; theme?: typeof ryuTheme; width?: number } = {}
): Promise<Setup> {
	const { height = 20, theme, width = 80 } = options;
	setup = await testRender(<Harness theme={theme} ttl={ttl} />, {
		height,
		width,
	});
	return setup;
}

async function settle(renderer: Setup): Promise<string[]> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await renderer.renderOnce();
	return renderer
		.captureCharFrame()
		.split("\n")
		.slice(0, renderer.renderer.height);
}

async function notify(
	renderer: Setup,
	...calls: Parameters<ReturnType<typeof useToast>["notify"]>[]
): Promise<string[]> {
	await act(async () => {
		for (const call of calls) {
			toastApi?.notify(...call);
		}
	});
	return settle(renderer);
}

function rowOf(rows: string[], needle: string): number {
	return rows.findIndex((row) => row.includes(needle));
}

async function sleep(ms: number): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

test("a toast floats top-right without moving the pane or the status bar", async () => {
	const renderer = await mount();
	const before = await settle(renderer);
	const paneRow = rowOf(before, "pane first row");
	const footerRow = rowOf(before, "footer status");
	expect(paneRow).toBe(0);
	expect(footerRow).toBeGreaterThan(paneRow);

	const after = await notify(renderer, ["saved settings", "success"]);
	expect(rowOf(after, "pane first row")).toBe(paneRow);
	expect(rowOf(after, "pane second row")).toBe(paneRow + 1);
	expect(rowOf(after, "footer status")).toBe(footerRow);

	const toastRow = rowOf(after, "saved settings");
	expect(toastRow).toBeGreaterThanOrEqual(1);
	expect(toastRow).toBeLessThanOrEqual(3);
	expect(after[toastRow]).toContain("┃");
	// Right-anchored: the toast sits in the right half of the 80-column frame.
	expect(after[toastRow]?.indexOf("saved settings")).toBeGreaterThan(40);
});

test("identical notifications merge into one line with a count", async () => {
	const renderer = await mount();
	const rows = await notify(
		renderer,
		["sync failed", "error"],
		["sync failed", "error"]
	);
	const matches = rows.filter((row) => row.includes("sync failed"));
	expect(matches).toHaveLength(1);
	expect(matches[0]).toContain("×2");
});

test("shows the newest three toasts first and summarises the rest", async () => {
	const renderer = await mount();
	const rows = await notify(
		renderer,
		["note one"],
		["note two"],
		["note three"],
		["note four"]
	);
	expect(rowOf(rows, "note one")).toBe(-1);
	expect(rowOf(rows, "note four")).toBe(1);
	expect(rowOf(rows, "note three")).toBe(2);
	expect(rowOf(rows, "note two")).toBe(3);
	expect(rowOf(rows, "+1 more")).toBe(4);
});

test("clicking a toast dismisses it", async () => {
	const renderer = await mount();
	const rows = await notify(renderer, ["click to clear", "warning"]);
	const row = rowOf(rows, "click to clear");
	const column = rows[row]?.indexOf("click to clear") ?? 0;
	await act(async () => {
		await renderer.mockMouse.click(column, row);
	});
	const after = await settle(renderer);
	expect(rowOf(after, "click to clear")).toBe(-1);
});

test("severity sets the lifetime: errors outlast warnings outlast info", async () => {
	expect(TOAST_TTL_MS.error).toBeGreaterThan(TOAST_TTL_MS.warning);
	expect(TOAST_TTL_MS.warning).toBeGreaterThan(TOAST_TTL_MS.info);
	expect(TOAST_TTL_MS.success).toBe(TOAST_TTL_MS.info);

	const renderer = await mount();
	jest.useFakeTimers();
	await act(async () => {
		toastApi?.notify("quick info", "info");
		toastApi?.notify("careful now", "warning");
		toastApi?.notify("lasting error", "error");
	});
	await renderer.renderOnce();
	const shown = renderer.captureCharFrame();
	expect(shown).toContain("quick info");
	expect(shown).toContain("careful now");
	expect(shown).toContain("lasting error");

	const advance = async (ms: number): Promise<string> => {
		await act(async () => {
			jest.advanceTimersByTime(ms);
		});
		await renderer.renderOnce();
		return renderer.captureCharFrame();
	};

	// Just past the info lifetime: info is gone, the problems remain.
	const afterInfo = await advance(TOAST_TTL_MS.info + 1);
	expect(afterInfo).not.toContain("quick info");
	expect(afterInfo).toContain("careful now");
	expect(afterInfo).toContain("lasting error");

	// Past the warning lifetime: only the error is still up.
	const afterWarning = await advance(TOAST_TTL_MS.warning - TOAST_TTL_MS.info);
	expect(afterWarning).not.toContain("careful now");
	expect(afterWarning).toContain("lasting error");

	const afterError = await advance(TOAST_TTL_MS.error - TOAST_TTL_MS.warning);
	expect(afterError).not.toContain("lasting error");
});

test("a repeat restarts the merged toast's lifetime", async () => {
	const renderer = await mount();
	jest.useFakeTimers();
	await act(async () => {
		toastApi?.notify("retrying", "warning");
	});
	await act(async () => {
		jest.advanceTimersByTime(TOAST_TTL_MS.warning - 100);
		toastApi?.notify("retrying", "warning");
	});
	await act(async () => {
		jest.advanceTimersByTime(TOAST_TTL_MS.warning - 100);
	});
	await renderer.renderOnce();
	expect(renderer.captureCharFrame()).toContain("retrying ×2");
	await act(async () => {
		jest.advanceTimersByTime(200);
	});
	await renderer.renderOnce();
	expect(renderer.captureCharFrame()).not.toContain("retrying");
});

test("ttl overrides shorten lifetimes for callers that need it", async () => {
	const renderer = await mount({ info: 20, error: 400 });
	const shown = await notify(
		renderer,
		["quick info", "info"],
		["lasting error", "error"]
	);
	expect(rowOf(shown, "quick info")).toBeGreaterThan(-1);
	expect(rowOf(shown, "lasting error")).toBeGreaterThan(-1);

	await sleep(80);
	const later = await settle(renderer);
	expect(rowOf(later, "quick info")).toBe(-1);
	expect(rowOf(later, "lasting error")).toBeGreaterThan(-1);
});

test("long messages wrap inside the toast instead of being cut off", async () => {
	const renderer = await mount();
	const rows = await notify(renderer, [
		"the gateway rejected the request because the session token expired",
		"error",
	]);
	const first = rowOf(rows, "the gateway rejected");
	expect(first).toBeGreaterThan(-1);
	expect(rows.slice(first, first + 3).join(" ")).toContain("expired");
	// Every wrapped row keeps the severity bar.
	expect(rows[first + 1]).toContain("┃");
});

test("on a short terminal the stack stops above the status bar", async () => {
	const renderer = await mount(undefined, { height: 4, width: 80 });
	const before = await settle(renderer);
	const footerRow = rowOf(before, "footer status");
	const rows = await notify(
		renderer,
		["alpha"],
		["bravo"],
		["charlie"],
		["delta"]
	);
	expect(rowOf(rows, "footer status")).toBe(footerRow);
	expect(rowOf(rows, "delta")).toBe(1);
	expect(rowOf(rows, "charlie")).toBe(2);
	expect(rowOf(rows, "bravo")).toBe(-1);
});

test("toast text and icons stay legible on the light theme", async () => {
	const renderer = await mount(undefined, { theme: ryuLightTheme });
	const rows = await notify(renderer, ["queued for later", "pending"]);
	const row = rowOf(rows, "queued for later");
	const spans = renderer.captureSpans().lines[row]?.spans ?? [];
	const textSpan = spans.find((span) => span.text.includes("queued"));
	const iconSpan = spans.find((span) => span.text.includes("○"));
	expect(textSpan).toBeDefined();
	expect(iconSpan).toBeDefined();
	for (const span of [textSpan, iconSpan]) {
		expect(span?.fg.toString()).not.toBe(span?.bg.toString());
	}
	// Message text uses the theme foreground, not the renderer's white default.
	expect(textSpan?.fg.toString()).not.toBe("rgba(1.00, 1.00, 1.00, 1.00)");
});

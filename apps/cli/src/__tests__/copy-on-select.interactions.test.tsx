/* @jsxImportSource @opentui/react */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { InputFocusProvider } from "../core/InputFocusContext.tsx";
import { OverlayProvider } from "../overlays/OverlayHost.tsx";
import { Sidebar } from "../sidebar/Sidebar.tsx";
import {
	CLIPBOARD_UNAVAILABLE_MESSAGE,
	COPIED_MESSAGE,
	COPY_TOAST_TTL_MS,
	copySelectionToClipboard,
	type PointerEvent,
	recordPress,
	shouldActivate,
	useCopyOnSelect,
} from "../ui/clipboard.ts";
import { TerminalThemeProvider } from "../ui/TerminalThemeProvider.tsx";
import { ryuTheme } from "../ui/theme.ts";
import { ToastHost, ToastProvider, useToast } from "../ui/toast.tsx";
import {
	useWorkspace,
	WorkspaceProvider,
} from "../workspace/WorkspaceContext.tsx";
import { testRender } from "./cli-test-render.ts";

type TestSetup = Awaited<ReturnType<typeof testRender>>;

const LINE = "alpha beta gamma";

function CopyHarness() {
	useCopyOnSelect();
	return (
		<box flexDirection="column" height="100%" width="100%">
			<text selectable>{LINE}</text>
			<ToastHost />
		</box>
	);
}

let setup: TestSetup | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
	setup?.renderer.destroy();
	setup = null;
});

async function renderHarness(osc52Result: boolean) {
	setup = await testRender(
		<ThemeProvider>
			<ToastProvider>
				<CopyHarness />
			</ToastProvider>
		</ThemeProvider>,
		{ width: 80, height: 12 }
	);
	const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockImplementation(
		() => osc52Result
	);
	// Lay the text out before pointing at it; hit-testing needs a painted frame.
	await setup.renderOnce();
	return { setup, copy };
}

describe("copy-on-select", () => {
	test("dragging across text copies the selection and confirms with a toast", async () => {
		const { setup: s, copy } = await renderHarness(true);
		await s.mockMouse.drag(0, 0, 5, 0);
		await s.renderOnce();
		expect(copy).toHaveBeenCalledTimes(1);
		expect(copy).toHaveBeenCalledWith("alpha");
		const frame = await s.waitForFrame((f) => f.includes(COPIED_MESSAGE));
		expect(frame).toContain("✓");
	});

	test("warns when the terminal cannot take an OSC 52 write", async () => {
		const { setup: s, copy } = await renderHarness(false);
		await s.mockMouse.drag(0, 0, 5, 0);
		await s.renderOnce();
		expect(copy).toHaveBeenCalledTimes(1);
		const frame = await s.waitForFrame((f) => f.includes("Clipboard"));
		expect(frame).toContain("⚠");
		expect(frame).not.toContain(COPIED_MESSAGE);
	});

	test("a plain click without a drag does not touch the clipboard", async () => {
		const { setup: s, copy } = await renderHarness(true);
		await s.mockMouse.click(2, 0);
		await s.renderOnce();
		expect(copy).not.toHaveBeenCalled();
		expect(s.captureCharFrame()).not.toContain(COPIED_MESSAGE);
	});
});

describe("sidebar activation during a selection", () => {
	const SIDEBAR_WIDTH = 24;
	let workspace: ReturnType<typeof useWorkspace> | null = null;

	function CaptureWorkspace() {
		workspace = useWorkspace();
		return null;
	}

	function activePath(): string | undefined {
		const pane = workspace?.panes.find(
			(candidate) => candidate.id === workspace?.focusedPaneId
		);
		return workspace?.tabs.find((tab) => tab.id === pane?.activeTabId)?.path;
	}

	function locate(s: TestSetup, text: string): { x: number; y: number } {
		const rows = s.captureCharFrame().split("\n");
		const y = rows.findIndex((row) => row.includes(text));
		if (y < 0) {
			throw new Error(`Could not find ${text}:\n${rows.join("\n")}`);
		}
		return { x: rows[y]?.indexOf(text) ?? 0, y };
	}

	async function renderShell() {
		// Sidebar sections load over HTTP; empty bodies keep them collapsed.
		globalThis.fetch = Object.assign(
			() =>
				Promise.resolve(
					new Response("{}", {
						status: 200,
						headers: { "content-type": "application/json" },
					})
				),
			{ preconnect: realFetch.preconnect }
		);
		setup = await testRender(
			<ThemeProvider theme={ryuTheme}>
				<CoreProvider initial={{ url: "http://127.0.0.1:7980", token: null }}>
					<TerminalThemeProvider>
						<InputFocusProvider>
							<WorkspaceProvider>
								<OverlayProvider>
									<ToastProvider>
										<CaptureWorkspace />
										<SidebarCopyHarness />
									</ToastProvider>
								</OverlayProvider>
							</WorkspaceProvider>
						</InputFocusProvider>
					</TerminalThemeProvider>
				</CoreProvider>
			</ThemeProvider>,
			{ exitOnCtrlC: false, width: 80, height: 24 }
		);
		const copy = spyOn(
			setup.renderer,
			"copyToClipboardOSC52"
		).mockImplementation(() => true);
		await setup.flush({ maxPasses: 8 });
		return { setup, copy };
	}

	function SidebarCopyHarness() {
		useCopyOnSelect();
		return (
			<box flexDirection="row" height="100%" width="100%">
				<Sidebar
					onOpenPalette={() => undefined}
					onSwitchNode={() => undefined}
				/>
				<box flexDirection="column" flexGrow={1}>
					<text selectable>{LINE}</text>
					<ToastHost />
				</box>
			</box>
		);
	}

	test("a click on a row while text is highlighted only clears the highlight", async () => {
		const { setup: s, copy } = await renderShell();
		const before = activePath();
		await s.mockMouse.drag(SIDEBAR_WIDTH, 0, SIDEBAR_WIDTH + 5, 0);
		await s.renderOnce();
		expect(copy).toHaveBeenCalledWith("alpha");
		expect(s.renderer.getSelection()?.getSelectedText()).toBe("alpha");

		const library = locate(s, "Library");
		await s.mockMouse.click(library.x, library.y);
		await s.flush({ maxPasses: 4 });
		expect(activePath()).toBe(before);
		expect(s.renderer.getSelection()).toBeNull();

		await s.mockMouse.click(library.x, library.y);
		await s.flush({ maxPasses: 4 });
		expect(activePath()).toBe("/library");
	});

	test("a drag-select released over a row copies without navigating", async () => {
		const { setup: s, copy } = await renderShell();
		const before = activePath();
		const tasks = locate(s, "Tasks");
		await s.mockMouse.drag(SIDEBAR_WIDTH + 6, 0, tasks.x, tasks.y);
		await s.flush({ maxPasses: 4 });
		expect(activePath()).toBe(before);
		expect(copy).toHaveBeenCalledTimes(1);
		await s.waitForFrame((f) => f.includes(COPIED_MESSAGE));
	});

	test("sidebar labels cannot start a selection", async () => {
		const { setup: s, copy } = await renderShell();
		const home = locate(s, "Home");
		const timeline = locate(s, "Timeline");
		await s.mockMouse.drag(home.x, home.y, timeline.x + 4, timeline.y);
		await s.flush({ maxPasses: 4 });
		expect(copy).not.toHaveBeenCalled();
		// The press was dragged off "Home", so it does not activate either.
		expect(activePath()).not.toBe("/home");
	});

	test("a keypress clears a lingering highlight", async () => {
		const { setup: s } = await renderShell();
		await s.mockMouse.drag(SIDEBAR_WIDTH, 0, SIDEBAR_WIDTH + 5, 0);
		await s.renderOnce();
		expect(s.renderer.getSelection()).not.toBeNull();
		await s.mockInput.pressKeys(["x"]);
		await s.renderOnce();
		expect(s.renderer.getSelection()).toBeNull();
	});

	test("Ctrl+C leaves the highlight for the shell to copy", async () => {
		const { setup: s } = await renderShell();
		await s.mockMouse.drag(SIDEBAR_WIDTH, 0, SIDEBAR_WIDTH + 5, 0);
		await s.renderOnce();
		await s.mockInput.pressKey("c", { ctrl: true });
		await s.renderOnce();
		expect(s.renderer.getSelection()?.getSelectedText()).toBe("alpha");
	});
});

describe("shouldActivate", () => {
	const target = { screenX: 2, screenY: 3, width: 10, height: 1 };
	const other = { screenX: 2, screenY: 4, width: 10, height: 1 };
	const host = (text: string | null) => ({
		getSelection: () =>
			text === null ? null : { getSelectedText: () => text },
	});
	const at = (x: number, y: number, extra: Partial<PointerEvent> = {}) => ({
		target,
		x,
		y,
		...extra,
	});

	test("a plain press and release on the target activates", () => {
		expect(shouldActivate(recordPress(host(null), at(4, 3)), at(5, 3))).toBe(
			true
		);
		// An empty selection (a previous plain click) does not block activation.
		expect(shouldActivate(recordPress(host(""), at(4, 3)), at(5, 3))).toBe(
			true
		);
	});

	test("a press made while text is highlighted only dismisses it", () => {
		const press = recordPress(host("copied text"), at(4, 3));
		expect(press.dismissesSelection).toBe(true);
		expect(shouldActivate(press, at(4, 3))).toBe(false);
	});

	test("drag releases, foreign targets and drag-offs do not activate", () => {
		const press = recordPress(host(null), at(4, 3));
		expect(shouldActivate(null, at(4, 3))).toBe(false);
		expect(shouldActivate(press, at(4, 3, { isDragging: true }))).toBe(false);
		expect(shouldActivate(press, at(4, 4, { target: other }))).toBe(false);
		expect(shouldActivate(press, at(12, 3))).toBe(false);
	});
});

describe("copySelectionToClipboard", () => {
	test("copies non-empty text and flashes a short success toast", () => {
		const writer = { copyToClipboardOSC52: mock(() => true) };
		const notify = mock();
		const outcome = copySelectionToClipboard(
			writer,
			{ getSelectedText: () => "hello" },
			notify
		);
		expect(outcome).toBe("copied");
		expect(writer.copyToClipboardOSC52).toHaveBeenCalledWith("hello");
		expect(notify).toHaveBeenCalledWith(COPIED_MESSAGE, "success", {
			ttlMs: COPY_TOAST_TTL_MS,
		});
	});

	test("reports an unavailable clipboard as a warning", () => {
		const writer = { copyToClipboardOSC52: mock(() => false) };
		const notify = mock();
		const outcome = copySelectionToClipboard(
			writer,
			{ getSelectedText: () => "hello" },
			notify
		);
		expect(outcome).toBe("unavailable");
		expect(notify).toHaveBeenCalledWith(
			CLIPBOARD_UNAVAILABLE_MESSAGE,
			"warning"
		);
	});

	test("ignores empty, whitespace-only and missing selections", () => {
		const writer = { copyToClipboardOSC52: mock(() => true) };
		const notify = mock();
		for (const selection of [
			{ getSelectedText: () => "" },
			{ getSelectedText: () => "  \n" },
			null,
		]) {
			expect(copySelectionToClipboard(writer, selection, notify)).toBe("empty");
		}
		expect(writer.copyToClipboardOSC52).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("notify ttlMs", () => {
	test("a per-call lifetime overrides the severity default", async () => {
		let notifyRef: ReturnType<typeof useToast>["notify"] | null = null;
		function Capture() {
			notifyRef = useToast().notify;
			return <ToastHost />;
		}
		setup = await testRender(
			<ThemeProvider>
				<ToastProvider>
					<Capture />
				</ToastProvider>
			</ThemeProvider>,
			{ width: 80, height: 12 }
		);
		await act(async () => {
			notifyRef?.("short flash", "warning", { ttlMs: 30 });
			notifyRef?.("long lived", "warning");
			await Promise.resolve();
		});
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("short flash");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 80));
		});
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		expect(frame).not.toContain("short flash");
		expect(frame).toContain("long lived");
	});
});

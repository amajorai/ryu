// In-view controls that are also settings: each one saves through
// `InterfacePort.updateSettings` and follows the live params afterwards.
// Popups need happy-dom before React and Base UI load (board-test-dom.ts).
import "./board-test-dom.ts";
import { describe, expect, test } from "bun:test";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfacePort,
	type InterfaceSettingValue,
	type InterfaceSnapshot,
	type InterfaceThread,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { BoardInterface } from "./board-interface.tsx";
import { CalendarInterface } from "./calendar-interface.tsx";
import { CanvasInterface } from "./canvas-interface.tsx";
import { TimelineInterface } from "./timeline-interface.tsx";
import { useInterfaceSetting } from "./use-interface-setting.ts";

function thread(id: string): InterfaceThread {
	return {
		agentIds: ["agent-ada"],
		id,
		lastMessage: `Latest from ${id}`,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: `Thread ${id}`,
		updatedAt: new Date().toISOString(),
	};
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
	],
	groups: [],
	threads: [thread("a"), thread("b")],
	version: INTERFACE_PROTOCOL_VERSION,
};

function savingPort(withUpdate = true) {
	const saved: Record<string, InterfaceSettingValue>[] = [];
	const port: InterfacePort = {
		closeThread: () => undefined,
		openThread: () => undefined,
		startThread: () => undefined,
		...(withUpdate
			? { updateSettings: (patch) => saved.push({ ...patch }) }
			: {}),
	};
	return { port, saved };
}

async function mount(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	return {
		container,
		async dispose() {
			await act(async () => root.unmount());
			container.remove();
		},
		async rerender(next: ReactElement) {
			await act(async () => root.render(next));
		},
	};
}

function buttonNamed(scope: ParentNode, name: string): HTMLElement {
	const found = [...scope.querySelectorAll<HTMLElement>("button")].find(
		(item) =>
			item.getAttribute("aria-label") === name ||
			item.textContent?.trim() === name
	);
	if (!found) {
		throw new Error(`no button named ${name}`);
	}
	return found;
}

async function click(element: HTMLElement) {
	await act(async () => element.click());
}

const pressed = (element: HTMLElement) =>
	element.getAttribute("aria-pressed") === "true" ||
	element.getAttribute("data-pressed") !== null;

describe("useInterfaceSetting", () => {
	function Probe({
		onReady,
		param,
		port,
	}: {
		onReady: (api: [string, (next: string) => void]) => void;
		param: string;
		port: InterfacePort;
	}) {
		const api = useInterfaceSetting(port, "scale", param);
		onReady(api);
		return <span data-value={api[0]} />;
	}

	test("saves a change, ignores a no-op, and follows a new param", async () => {
		const { port, saved } = savingPort();
		let api: [string, (next: string) => void] = ["", () => undefined];
		const probe = (param: string) => (
			<Probe
				onReady={(next) => {
					api = next;
				}}
				param={param}
				port={port}
			/>
		);
		const view = await mount(probe("day"));
		await act(async () => api[1]("week"));
		await act(async () => api[1]("week"));
		expect(saved).toEqual([{ scale: "week" }]);
		expect(api[0]).toBe("week");
		// The host echoes the saved value back, then a reset sends the default.
		await view.rerender(probe("week"));
		expect(api[0]).toBe("week");
		await view.rerender(probe("day"));
		expect(api[0]).toBe("day");
		await view.dispose();
	});

	test("a host without updateSettings keeps the change while mounted", async () => {
		const { port } = savingPort(false);
		let api: [string, (next: string) => void] = ["", () => undefined];
		const view = await mount(
			<Probe
				onReady={(next) => {
					api = next;
				}}
				param="day"
				port={port}
			/>
		);
		await act(async () => api[1]("week"));
		expect(api[0]).toBe("week");
		await view.dispose();
	});
});

describe("renderer controls save as settings", () => {
	test("Timeline's scale toggle", async () => {
		const { port, saved } = savingPort();
		const timeline = (scale: "day" | "week") => (
			<TimelineInterface
				activeThreadId={null}
				loading={false}
				params={{ scale }}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const view = await mount(timeline("day"));
		await click(buttonNamed(view.container, "Week"));
		expect(saved).toEqual([{ scale: "week" }]);
		expect(pressed(buttonNamed(view.container, "Week"))).toBe(true);
		await view.rerender(timeline("week"));
		await view.rerender(timeline("day"));
		expect(pressed(buttonNamed(view.container, "Day"))).toBe(true);
		await view.dispose();
	});

	test("Calendar's scale", async () => {
		const { port, saved } = savingPort();
		const calendar = (params: { rail: boolean; scale: "month" | "week" }) => (
			<CalendarInterface
				activeThreadId={null}
				loading={false}
				params={params}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const view = await mount(calendar({ rail: true, scale: "month" }));
		const scales = view.container.querySelector(
			'[aria-label="Calendar scale"]'
		);
		if (!scales) {
			throw new Error("no calendar scale toggle");
		}
		await click(buttonNamed(scales, "Week"));
		expect(saved).toEqual([{ scale: "week" }]);
		expect(pressed(buttonNamed(scales, "Week"))).toBe(true);
		await view.rerender(calendar({ rail: true, scale: "week" }));
		await view.rerender(calendar({ rail: true, scale: "month" }));
		expect(pressed(buttonNamed(scales, "Month"))).toBe(true);
		// The rail toggle saves only on a wide window (inline rail); the test
		// DOM has no width, so the narrow overlay rail stays local here.
		await view.dispose();
	});

	test("Board's layout and grouping from the Display menu", async () => {
		const { port, saved } = savingPort();
		const board = (view: "board" | "list") => (
			<BoardInterface
				activeThreadId={null}
				loading={false}
				params={{ groupBy: "status", view }}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const view = await mount(board("board"));
		await click(buttonNamed(view.container, "Display"));
		await click(buttonNamed(document.body, "List"));
		await click(buttonNamed(document.body, "Agent"));
		expect(saved).toEqual([{ view: "list" }, { groupBy: "agent" }]);
		await view.dispose();
	});

	test("Canvas's arrangement", async () => {
		const { port, saved } = savingPort();
		const params = resolveInterfaceParams("canvas", {});
		const canvas = (arrange: "agent" | "status") => (
			<CanvasInterface
				activeThreadId={null}
				loading={false}
				params={{ ...params, arrange }}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const view = await mount(canvas("status"));
		await click(buttonNamed(view.container, "Agent"));
		expect(saved).toEqual([{ arrange: "agent" }]);
		expect(pressed(buttonNamed(view.container, "Agent"))).toBe(true);
		await view.rerender(canvas("agent"));
		await view.rerender(canvas("status"));
		expect(pressed(buttonNamed(view.container, "Status"))).toBe(true);
		await view.dispose();
	});
});

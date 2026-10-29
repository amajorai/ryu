import { describe, expect, test } from "bun:test";
import {
	type AppAssistantBridge,
	ASSISTANT_LIMITS,
	chunkAssistantContext,
	createAppAssistantSync,
	getAppAssistant,
	openAppAssistant,
} from "./assistant-client.ts";
import { asAssistantContextArg, asAssistantSurfaceArg } from "./rpc.ts";

function recordingBridge() {
	const calls: [string, unknown][] = [];
	const bridge: AppAssistantBridge = {
		clearContext: () => {
			calls.push(["clearContext", null]);
			return Promise.resolve(null);
		},
		clearSurface: () => {
			calls.push(["clearSurface", null]);
			return Promise.resolve(null);
		},
		open: (input) => {
			calls.push(["open", input]);
			return Promise.resolve(null);
		},
		publishContext: (items) => {
			calls.push(["publishContext", items]);
			return Promise.resolve(null);
		},
		registerSurface: (surface) => {
			calls.push(["registerSurface", surface]);
			return Promise.resolve(null);
		},
	};
	return { bridge, calls };
}

describe("assistant client", () => {
	test("short context stays one item under its own id", () => {
		expect(
			chunkAssistantContext({ id: "pr:1", text: "hello", title: "PR #1" })
		).toEqual([{ id: "pr:1", text: "hello", title: "PR #1" }]);
	});

	test("long context splits on line boundaries within the host cap", () => {
		const line = `${"x".repeat(99)}\n`;
		const text = line.repeat(200);
		const items = chunkAssistantContext({ id: "diff", text, title: "Diff" });
		expect(items).toHaveLength(3);
		expect(items.map((item) => item.title)).toEqual([
			"Diff (1/3)",
			"Diff (2/3)",
			"Diff (3/3)",
		]);
		for (const item of items) {
			expect(item.text.length).toBeLessThanOrEqual(
				ASSISTANT_LIMITS.contextText
			);
			expect(item.text.endsWith("\n")).toBe(true);
		}
		expect(items.map((item) => item.text).join("")).toBe(text);
	});

	test("a newline exactly at the cap still yields chunks within it", () => {
		const limit = ASSISTANT_LIMITS.contextText;
		const text = `${"a".repeat(limit)}\n${"b".repeat(10)}`;
		const items = chunkAssistantContext({ id: "edge", text, title: "Edge" });
		for (const item of items) {
			expect(item.text.length).toBeLessThanOrEqual(limit);
		}
		expect(items.map((item) => item.text).join("")).toBe(text);
	});

	test("chunk ids stay unique within the host id cap", () => {
		const items = chunkAssistantContext({
			id: "x".repeat(ASSISTANT_LIMITS.label + 40),
			text: "z".repeat(ASSISTANT_LIMITS.contextText * 2),
			title: "Long",
		});
		const ids = items.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id.length).toBeLessThanOrEqual(ASSISTANT_LIMITS.label);
		}
	});

	test("context past the item budget is cut and marked truncated", () => {
		const text = "y".repeat(ASSISTANT_LIMITS.contextText * 5);
		const items = chunkAssistantContext({
			id: "diff",
			maxItems: 2,
			text,
			title: "Diff",
		});
		expect(items).toHaveLength(2);
		expect(items[1]?.text.endsWith("[truncated]")).toBe(true);
		expect(items[1]?.text.length).toBeLessThanOrEqual(
			ASSISTANT_LIMITS.contextText
		);
	});

	test("client caps match what the host bridge accepts", () => {
		const item = {
			id: "a",
			text: "z".repeat(ASSISTANT_LIMITS.contextText + 50),
			title: "t".repeat(ASSISTANT_LIMITS.label + 50),
		};
		const parsed = asAssistantContextArg({
			items: Array.from(
				{ length: ASSISTANT_LIMITS.contextItems + 3 },
				() => item
			),
		});
		expect(parsed?.items).toHaveLength(ASSISTANT_LIMITS.contextItems);
		expect(parsed?.items[0]?.text).toHaveLength(ASSISTANT_LIMITS.contextText);
		expect(parsed?.items[0]?.title).toHaveLength(ASSISTANT_LIMITS.label);
		const surface = asAssistantSurfaceArg({
			label: "Ask",
			preamble: "p".repeat(ASSISTANT_LIMITS.preamble + 50),
			prompts: Array.from(
				{ length: ASSISTANT_LIMITS.listEntries + 3 },
				(_, index) => `prompt ${index}`
			),
		});
		expect(surface?.preamble).toHaveLength(ASSISTANT_LIMITS.preamble);
		expect(surface?.prompts).toHaveLength(ASSISTANT_LIMITS.listEntries);
	});

	test("over-long surface threads stay distinct after host clamping", () => {
		const base = "t".repeat(ASSISTANT_LIMITS.label + 30);
		const first = asAssistantSurfaceArg({ label: "Ask", thread: `${base}-a` });
		const second = asAssistantSurfaceArg({ label: "Ask", thread: `${base}-b` });
		expect(first?.thread).toHaveLength(ASSISTANT_LIMITS.label);
		expect(second?.thread).toHaveLength(ASSISTANT_LIMITS.label);
		expect(first?.thread).not.toBe(second?.thread);
		expect(
			asAssistantSurfaceArg({ label: "Ask", thread: "pr-1" })?.thread
		).toBe("pr-1");
	});

	test("sync writes only on change and tears down what it published", () => {
		const { bridge, calls } = recordingBridge();
		const sync = createAppAssistantSync(bridge);
		const items = [{ id: "pr:1", text: "body", title: "PR #1" }];
		sync.setContext(items);
		sync.setContext([...items]);
		sync.setSurface({ label: "Ask about this PR" });
		sync.setSurface({ label: "Ask about this PR" });
		expect(calls.map(([method]) => method)).toEqual([
			"publishContext",
			"registerSurface",
		]);
		sync.setContext(null);
		sync.dispose();
		expect(calls.map(([method]) => method)).toEqual([
			"publishContext",
			"registerSurface",
			"clearContext",
			"clearSurface",
		]);
	});

	test("bridge failures go to onError instead of throwing", async () => {
		const { bridge } = recordingBridge();
		const errors: unknown[] = [];
		const failing: AppAssistantBridge = {
			...bridge,
			publishContext: () => Promise.reject(new Error("denied")),
		};
		createAppAssistantSync(failing, (error) => errors.push(error)).setContext([
			{ id: "a", text: "b", title: "c" },
		]);
		await Promise.resolve();
		await Promise.resolve();
		expect(errors).toHaveLength(1);
	});

	test("a refused open reaches onError without throwing", async () => {
		const { bridge } = recordingBridge();
		const errors: unknown[] = [];
		const unfocused: AppAssistantBridge = {
			...bridge,
			open: () =>
				Promise.reject(
					new Error("assistant.open is only available while the app is focused")
				),
		};
		expect(() =>
			openAppAssistant(unfocused, { prompt: "hi" }, (error) =>
				errors.push(error)
			)
		).not.toThrow();
		await Promise.resolve();
		await Promise.resolve();
		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toContain("focused");
	});

	test("a refused open without onError is swallowed", async () => {
		const { bridge } = recordingBridge();
		const rejection = new Error("not focused");
		let settled: Promise<unknown> | null = null;
		const unfocused: AppAssistantBridge = {
			...bridge,
			open: () => {
				settled = Promise.reject(rejection);
				return settled;
			},
		};
		openAppAssistant(unfocused, undefined);
		expect(settled).not.toBeNull();
		await Promise.resolve();
		await Promise.resolve();
	});

	test("no bridge outside a host", () => {
		expect(getAppAssistant()).toBeNull();
	});
});

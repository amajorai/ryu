import { describe, expect, it } from "bun:test";
import { areToolPropsEqual, getToolStatus } from "./format-tool.ts";

// Each test uses a unique toolCallId so the module-level tool-state cache in
// format-tool.ts never leaks state between cases.
let idCounter = 0;
function nextId(): string {
	idCounter += 1;
	return `call-${idCounter}`;
}

describe("getToolStatus", () => {
	it("reports success for an available output with no failure flag", () => {
		const s = getToolStatus({ state: "output-available" });
		expect(s).toEqual({
			isPending: false,
			isError: false,
			isSuccess: true,
			isInterrupted: false,
		});
	});

	it("reports an error for output-error state", () => {
		const s = getToolStatus({ state: "output-error" });
		expect(s.isError).toBe(true);
		expect(s.isSuccess).toBe(false);
	});

	it("treats output.success === false as an error even when available", () => {
		const s = getToolStatus({
			state: "output-available",
			output: { success: false },
		});
		expect(s.isError).toBe(true);
		expect(s.isSuccess).toBe(false);
	});

	it("is pending while streaming and not yet resolved", () => {
		const s = getToolStatus({ state: "input-available" }, "streaming");
		expect(s.isPending).toBe(true);
		expect(s.isInterrupted).toBe(false);
	});

	it("is interrupted when unresolved and the chat is no longer streaming", () => {
		const s = getToolStatus({ state: "input-available" }, "ready");
		expect(s.isPending).toBe(false);
		expect(s.isInterrupted).toBe(true);
	});

	it("is neither pending nor interrupted when chatStatus is undefined", () => {
		const s = getToolStatus({ state: "input-available" });
		expect(s.isPending).toBe(false);
		expect(s.isInterrupted).toBe(false);
	});
});

describe("areToolPropsEqual", () => {
	it("is not equal when toolCallId differs", () => {
		const equal = areToolPropsEqual(
			{ part: { toolCallId: "a", type: "tool-Bash" } },
			{ part: { toolCallId: "b", type: "tool-Bash" } }
		);
		expect(equal).toBe(false);
	});

	it("is not equal when the type differs", () => {
		const id = nextId();
		const equal = areToolPropsEqual(
			{ part: { toolCallId: id, type: "tool-Bash" } },
			{ part: { toolCallId: id, type: "tool-Edit" } }
		);
		expect(equal).toBe(false);
	});

	it("detects a changed input for the same tool call", () => {
		const id = nextId();
		// prime the cache
		areToolPropsEqual(
			{ part: { toolCallId: id, type: "tool-Bash", input: { a: 1 } } },
			{ part: { toolCallId: id, type: "tool-Bash", input: { a: 1 } } }
		);
		const equal = areToolPropsEqual(
			{ part: { toolCallId: id, type: "tool-Bash", input: { a: 1 } } },
			{ part: { toolCallId: id, type: "tool-Bash", input: { a: 2 } } }
		);
		expect(equal).toBe(false);
	});

	it("short-circuits to equal once the tool has completed output", () => {
		const id = nextId();
		const part = { toolCallId: id, type: "tool-Bash", output: { ok: true } };
		// Prime the state cache (a cold cache always reports a change).
		areToolPropsEqual(
			{ part, chatStatus: "streaming" },
			{ part, chatStatus: "streaming" }
		);
		// Even with a changing chatStatus, a completed tool stays memo-equal.
		const equal = areToolPropsEqual(
			{ part, chatStatus: "streaming" },
			{ part, chatStatus: "ready" }
		);
		expect(equal).toBe(true);
	});

	it("re-renders an in-flight tool when chatStatus changes", () => {
		const id = nextId();
		const part = { toolCallId: id, type: "tool-Bash", input: { a: 1 } };
		// prime cache with an identical snapshot
		areToolPropsEqual({ part, chatStatus: "streaming" }, { part, chatStatus: "streaming" });
		const equal = areToolPropsEqual(
			{ part, chatStatus: "streaming" },
			{ part, chatStatus: "ready" }
		);
		expect(equal).toBe(false);
	});
});

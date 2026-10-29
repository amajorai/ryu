import "./setup-dom.ts";

import { afterEach, describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	type WorkflowResumeHandler,
	WorkflowRunProgressCard,
} from "../../../../packages/blocks/src/desktop/agent-elements/workflow-run-part.tsx";

// The installed ReactDOM act environment reads this native boolean global.
declare global {
	var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const message = {
	id: "workflow-resume-message",
	role: "assistant",
	parts: [
		{
			data: {
				id: "workflow-run",
				nodes: [{ id: "approval", status: "completed" as const }],
				runId: "run-1",
				status: "awaiting_input" as const,
				workflowId: "workflow-1",
				workflowName: "Review",
			},
			type: "data-ryu-workflow" as const,
		},
	],
} satisfies UIMessage;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(onResume: WorkflowResumeHandler): Promise<HTMLDivElement> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			createElement(WorkflowRunProgressCard, {
				msg: message,
				onResume,
			})
		);
	});
	return container;
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root?.unmount();
		});
	}
	root = null;
	container?.remove();
	container = null;
});

describe("workflow resume UI wiring", () => {
	it("submits the run id and response, guards while pending, then confirms success", async () => {
		let resolveResume: (() => void) | undefined;
		const calls: [string, string][] = [];
		const onResume = (runId: string, payload: string) => {
			calls.push([runId, payload]);
			return new Promise<void>((resolve) => {
				resolveResume = resolve;
			});
		};
		const view = await mount(onResume);
		const input = view.querySelector<HTMLInputElement>(
			"input[aria-label='Workflow response']"
		);
		const form = view.querySelector<HTMLFormElement>("form");
		const button = view.querySelector<HTMLButtonElement>(
			"button[type='submit']"
		);
		if (!(input && form && button)) {
			throw new Error("workflow resume form did not render");
		}

		await act(async () => {
			const setInputValue = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value"
			)?.set;
			input.focus();
			input.dispatchEvent(new Event("focusin", { bubbles: true }));
			setInputValue?.call(input, "approved");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(
				new KeyboardEvent("keyup", { bubbles: true, key: "d" })
			);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		});

		await act(async () => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
			await Promise.resolve();
		});

		// The callback receives the stable run id and the response entered above.
		expect(calls).toEqual([["run-1", "approved"]]);
		expect(button.textContent).toBe("Resuming…");
		expect(button.disabled).toBe(true);
		expect(input.disabled).toBe(true);

		await act(async () => {
			resolveResume?.();
			await Promise.resolve();
		});

		expect(view.textContent).toContain("Response sent.");
		expect(view.querySelector("form")).toBeNull();
	});

	it("shows the rejection message and allows a retry", async () => {
		let attempts = 0;
		const onResume = async () => {
			attempts += 1;
			throw new Error("The run expired");
		};
		const view = await mount(onResume);
		const form = view.querySelector<HTMLFormElement>("form");
		if (!form) {
			throw new Error("workflow resume form did not render");
		}

		await act(async () => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
			await Promise.resolve();
		});

		expect(attempts).toBe(1);
		expect(view.textContent).toContain("The run expired");
		expect(view.querySelector("form")).not.toBeNull();
	});
});

// Widget state persistence: a ui.render widget saves its state through the
// injected host as the user interacts, and a fresh mount (reopening the chat)
// restores it, including a submitted form staying locked.

import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type {
	AgentUiSavedState,
	AgentUiStateHost,
} from "./state-host-context.tsx";

// Suites share one process: release the DOM so later files see their own globals.
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { AgentUI } = await import("./agent-ui.tsx");
const { AgentUiStateHostContext } = await import("./state-host-context.tsx");

const checklistSpec = {
	root: "stack",
	state: { done: false, note: "" },
	elements: {
		stack: {
			type: "Stack",
			props: {},
			children: ["box", "status", "send"],
		},
		box: {
			type: "Button",
			props: { label: "Mark packed" },
			on: {
				press: {
					action: "setState",
					params: { statePath: "/done", value: true },
				},
			},
			children: [],
		},
		status: {
			type: "Text",
			props: {
				text: {
					$cond: { $state: "/done" },
					$then: "all packed",
					$else: "still packing",
				},
			},
			children: [],
		},
		send: {
			type: "Button",
			props: { label: "Send" },
			on: {
				press: { action: "submit", params: { value: { $state: "/done" } } },
			},
			children: [],
		},
	},
};

function memoryHost(initial?: Map<string, AgentUiSavedState>) {
	const saved = new Map(initial);
	const host: AgentUiStateHost = {
		version: 1,
		read: (toolCallId) => saved.get(toolCallId),
		write: (toolCallId, next) => {
			saved.set(toolCallId, next);
		},
	};
	return { host, saved };
}

async function mount(
	host: AgentUiStateHost,
	onSubmit?: () => void,
	persistTitle?: string
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<AgentUiStateHostContext.Provider value={host}>
				<AgentUI
					onSubmit={onSubmit}
					persistKey="call-1"
					persistTitle={persistTitle}
					spec={checklistSpec}
				/>
			</AgentUiStateHostContext.Provider>
		);
	});
	return {
		container,
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

function buttonLabeled(
	container: HTMLElement,
	label: string
): HTMLButtonElement {
	const button = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === label
	);
	if (!button) {
		throw new Error(`${label} button not rendered`);
	}
	return button;
}

function sendButton(container: HTMLElement): HTMLButtonElement {
	return buttonLabeled(container, "Send");
}

describe("AgentUI state persistence", () => {
	test("saves an edit and restores it on the next mount", async () => {
		const { host, saved } = memoryHost();
		const first = await mount(host);
		expect(first.container.textContent).toContain("still packing");

		await act(async () => {
			buttonLabeled(first.container, "Mark packed").click();
		});
		expect(first.container.textContent).toContain("all packed");
		// Unmounting flushes the debounced save immediately.
		await first.unmount();
		expect(saved.get("call-1")?.state).toMatchObject({ done: true });

		const second = await mount(host);
		expect(second.container.textContent).toContain("all packed");
		await second.unmount();
	});

	test("a submitted widget reopens locked", async () => {
		const { host, saved } = memoryHost();
		let submissions = 0;
		const first = await mount(host, () => {
			submissions++;
		});
		await act(async () => {
			sendButton(first.container).click();
		});
		expect(submissions).toBe(1);
		expect(saved.get("call-1")?.submitted).toBe(true);
		await first.unmount();

		const second = await mount(host, () => {
			submissions++;
		});
		expect(second.container.textContent).toContain("Submitted");
		expect(sendButton(second.container).disabled).toBe(true);
		await second.unmount();
	});

	test("a widget whose card draws the title still saves it", async () => {
		// Turn-end cards render the title in their own header, not through AgentUI.
		const { host, saved } = memoryHost();
		const card = await mount(host, undefined, "Packing list");
		expect(card.container.textContent).not.toContain("Packing list");
		await act(async () => {
			buttonLabeled(card.container, "Mark packed").click();
		});
		await card.unmount();
		expect(saved.get("call-1")).toMatchObject({
			state: { done: true },
			title: "Packing list",
		});
	});

	test("without a host the widget starts from its spec every time", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(<AgentUI persistKey="call-1" spec={checklistSpec} />);
		});
		expect(container.textContent).toContain("still packing");
		await act(async () => root.unmount());
		container.remove();
	});
});

import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { InputBar } = await import("./input-bar.tsx");

test("a live call morphs into the composer and keeps the + menu", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const render = (inCall: boolean) =>
		root.render(
			<InputBar
				leftActions={<span data-testid="left-action" />}
				liveCall={
					inCall
						? {
								actions: <button type="button">End call</button>,
								frame: (card) => <div data-testid="call-glow">{card}</div>,
								content: <span data-testid="call">On a call</span>,
								header: <div data-testid="call-header" />,
							}
						: undefined
				}
				onAttach={() => undefined}
				onSend={() => undefined}
				onStop={() => undefined}
				rightActions={<span data-testid="right-action" />}
				status="ready"
				suggestions={[{ id: "s", label: "Suggested" }]}
				value="Kept draft"
			/>
		);
	await act(async () => render(true));
	try {
		// The glow frames exactly one card: the composer itself, not a second
		// call card stacked over it. (CSS-module class names are not available
		// under bun test, so the card is located through its frame.)
		const glow = container.querySelector('[data-testid="call-glow"]');
		expect(glow?.childElementCount).toBe(1);
		const card = glow?.firstElementChild;
		expect(container.querySelectorAll('[data-testid="call"]')).toHaveLength(1);
		expect(card?.querySelector('[data-testid="call"]')).not.toBeNull();
		expect(card?.querySelector('[data-testid="call-header"]')).not.toBeNull();
		expect(card?.querySelector('[aria-label="Add"]')).not.toBeNull();
		expect(container.querySelector("textarea")).toBeNull();
		expect(container.querySelector('[data-testid="left-action"]')).toBeNull();
		expect(container.querySelector('[data-testid="right-action"]')).toBeNull();
		expect(container.textContent).not.toContain("Suggested");
		expect(container.textContent).toContain("End call");

		await act(async () => render(false));
		expect(container.querySelector('[data-testid="call"]')).toBeNull();
		expect(container.querySelector('[data-testid="call-glow"]')).toBeNull();
		expect(container.querySelector("textarea")?.value).toBe("Kept draft");
		expect(
			container.querySelector('[data-testid="right-action"]')
		).not.toBeNull();
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

const liveCallFixture = {
	actions: <button type="button">End call</button>,
	content: <span data-testid="call">On a call</span>,
	frame: (card: ReactNode) => <div data-testid="call-glow">{card}</div>,
};

async function mount(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(node));
	return {
		container,
		async unmount() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

test("a composer prompt keeps the call row and End button on screen", async () => {
	const view = await mount(
		<InputBar
			composerPrompt={{
				content: <div data-testid="permission-prompt">Allow tool?</div>,
				id: "permission-1",
			}}
			liveCall={liveCallFixture}
			onSend={() => undefined}
			onStop={() => undefined}
			status="ready"
			value="Kept draft"
		/>
	);
	try {
		const { container } = view;
		expect(
			container.querySelector('[data-testid="permission-prompt"]')
		).not.toBeNull();
		const row = container.querySelector('[data-slot="composer-live-call-row"]');
		expect(row).not.toBeNull();
		expect(row?.querySelector('[data-testid="call"]')).not.toBeNull();
		expect(row?.textContent).toContain("End call");
		expect(container.querySelector('[data-testid="call-glow"]')).not.toBeNull();
	} finally {
		await view.unmount();
	}
});

test("a pending question keeps the call row and End button on screen", async () => {
	const view = await mount(
		<InputBar
			liveCall={liveCallFixture}
			onSend={() => undefined}
			onStop={() => undefined}
			questionBar={{
				id: "question-1",
				onSubmit: () => undefined,
				questions: [{ kind: "text", title: "Which branch?" }],
			}}
			status="ready"
		/>
	);
	try {
		const { container } = view;
		expect(
			container.querySelector('[data-composer-prompt="question"]')
		).not.toBeNull();
		expect(container.textContent).toContain("Which branch?");
		const row = container.querySelector('[data-slot="composer-live-call-row"]');
		expect(row?.textContent).toContain("End call");
	} finally {
		await view.unmount();
	}
});

test("no call row is added to a composer prompt without a live call", async () => {
	const view = await mount(
		<InputBar
			composerPrompt={{ content: <div>Allow tool?</div>, id: "permission-1" }}
			onSend={() => undefined}
			onStop={() => undefined}
			status="ready"
		/>
	);
	try {
		expect(
			view.container.querySelector('[data-slot="composer-live-call-row"]')
		).toBeNull();
	} finally {
		await view.unmount();
	}
});

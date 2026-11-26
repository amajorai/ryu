import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FeedbackAttachment } from "./feedback-tool.ts";

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

const { AttachedDetails } = await import("./feedback-attached-details.tsx");

const LINES: FeedbackAttachment[] = [
	{
		group: "environment",
		id: "appVersion",
		label: "App version",
		value: "0.5.2",
	},
	{
		group: "error",
		id: "error-1",
		label: "Recent error 1",
		value: "Bash: failed in ~/project",
	},
];

async function mount(node: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root: Root = createRoot(container);
	await act(async () => root.render(node));
	return {
		container,
		async unmount() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

function toggleOf(container: HTMLElement) {
	return container.querySelector<HTMLButtonElement>("button[aria-expanded]");
}

describe("what is attached", () => {
	test("starts open, shows every line as it will be sent, and collapses", async () => {
		const view = await mount(
			<AttachedDetails attachments={LINES} onRemove={() => undefined} />
		);
		try {
			const toggle = toggleOf(view.container);
			expect(toggle?.textContent).toContain("What is attached");
			expect(
				view.container.querySelector('[data-testid="feedback-attached-count"]')
					?.textContent
			).toBe("2");
			expect(toggle?.getAttribute("aria-expanded")).toBe("true");
			const list = view.container.ownerDocument.getElementById(
				toggle?.getAttribute("aria-controls") ?? ""
			);
			expect(list?.hidden).toBe(false);
			const shown = [...view.container.querySelectorAll("li span")].map(
				(line) => line.textContent
			);
			expect(shown).toEqual([
				"App version: 0.5.2",
				"Recent error 1: Bash: failed in ~/project",
			]);
			// Report text is data, not interface copy: it is never translated.
			expect(
				view.container.querySelectorAll('li span[data-ryu-i18n="off"]')
			).toHaveLength(2);
			await act(async () => toggle?.click());
			expect(toggle?.getAttribute("aria-expanded")).toBe("false");
			expect(list?.hidden).toBe(true);
		} finally {
			await view.unmount();
		}
	});

	test("every line has its own remove button", async () => {
		const removed: string[] = [];
		const view = await mount(
			<AttachedDetails
				attachments={LINES}
				onRemove={(id) => {
					removed.push(id);
				}}
			/>
		);
		try {
			const buttons = [
				...view.container.querySelectorAll<HTMLButtonElement>("li button"),
			];
			expect(
				buttons.map((button) => button.getAttribute("aria-label"))
			).toEqual(["Remove App version", "Remove Recent error 1"]);
			await act(async () => buttons[1]?.click());
			expect(removed).toEqual(["error-1"]);
		} finally {
			await view.unmount();
		}
	});

	test("says so while reading and when nothing is attached", async () => {
		const reading = await mount(
			<AttachedDetails attachments={null} onRemove={() => undefined} />
		);
		expect(reading.container.textContent).toContain("Reading app details");
		expect(reading.container.querySelectorAll("li")).toHaveLength(0);
		await reading.unmount();
		const empty = await mount(
			<AttachedDetails attachments={[]} onRemove={() => undefined} />
		);
		expect(empty.container.textContent).toContain("Nothing is attached.");
		expect(
			empty.container.querySelector('[data-testid="feedback-attached-count"]')
				?.textContent
		).toBe("0");
		await empty.unmount();
	});
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SuggestedTask } from "./suggested-task.ts";

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

const { SuggestedTaskCard } = await import("./suggested-task-card.tsx");

const task: SuggestedTask = {
	id: "call-1",
	title: "Answer step-up email cooldown with 429, not 500",
	description: "The cooldown error escapes as a 500.",
	prompt: "Map the cooldown error to a 429.",
};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

function render(node: React.ReactNode): HTMLElement {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() => root?.render(node));
	return host;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(element) =>
			element.textContent?.trim() === label ||
			element.getAttribute("aria-label") === label
	);
	if (!match) {
		throw new Error(`no button "${label}"`);
	}
	return match;
}

describe("SuggestedTaskCard", () => {
	test("shows the task and its full prompt", () => {
		const container = render(
			<SuggestedTaskCard onDismiss={() => {}} onStart={() => {}} task={task} />
		);
		expect(container.textContent).toContain("Suggested task");
		expect(container.textContent).toContain(task.title);
		expect(container.textContent).toContain(task.description);
		expect(container.textContent).toContain(task.prompt);
	});

	test("Start and Dismiss report the task", () => {
		const started: string[] = [];
		const dismissed: string[] = [];
		const container = render(
			<SuggestedTaskCard
				onDismiss={(t) => dismissed.push(t.id)}
				onStart={(t, mode) => started.push(`${t.id}:${mode}`)}
				task={task}
			/>
		);
		act(() => button(container, "Start").click());
		act(() => button(container, "Dismiss suggested task").click());
		expect(started).toEqual(["call-1:chat"]);
		expect(dismissed).toEqual(["call-1"]);
	});

	test("offers Save to Drafts only when the host can save", async () => {
		const withoutDrafts = render(
			<SuggestedTaskCard onDismiss={() => {}} onStart={() => {}} task={task} />
		);
		expect(withoutDrafts.textContent).not.toContain("Save to Drafts");
		act(() => root?.unmount());
		withoutDrafts.remove();

		const saved: string[] = [];
		const container = render(
			<SuggestedTaskCard
				onDismiss={() => {}}
				onSaveDraft={async (t) => {
					saved.push(t.prompt);
				}}
				onStart={() => {}}
				task={task}
			/>
		);
		await act(async () => {
			button(container, "Save to Drafts").click();
		});
		expect(saved).toEqual([task.prompt]);
	});

	test("says so when saving fails", async () => {
		const container = render(
			<SuggestedTaskCard
				onDismiss={() => {}}
				onSaveDraft={() => Promise.reject(new Error("offline"))}
				onStart={() => {}}
				task={task}
			/>
		);
		await act(async () => {
			button(container, "Save to Drafts").click();
		});
		expect(container.querySelector("[role=alert]")?.textContent).toBe(
			"Could not save draft"
		);
	});
});

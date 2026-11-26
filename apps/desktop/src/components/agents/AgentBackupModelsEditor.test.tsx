// The backup model list of an agent: entries keep their order, move up and
// down, are removed, and a new one is added at the end, at most `max`.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { BackupModel } from "@/src/lib/api/account-pools.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { AgentBackupModelsEditor } = await import(
	"./AgentBackupModelsEditor.tsx"
);

const PROVIDERS = [
	{
		id: "claude-pro-max",
		label: "Claude (Pro/Max)",
		models: ["claude-opus-4-7"],
	},
	{ id: "chatgpt", label: "ChatGPT", models: [] },
];
const OPUS: BackupModel = {
	model: "claude-opus-4-7",
	providerId: "claude-pro-max",
};
const SONNET: BackupModel = {
	model: "claude-sonnet-4-6",
	providerId: "claude-pro-max",
};
const GPT: BackupModel = { model: "gpt-5.5", providerId: "chatgpt" };

let root: Root;
let container: HTMLDivElement;
let changes: BackupModel[][];

async function mount(backups: BackupModel[], max = 8): Promise<void> {
	await act(async () =>
		root.render(
			<AgentBackupModelsEditor
				backups={backups}
				busy={false}
				disabled={false}
				max={max}
				onChange={(next) => changes.push(next)}
				providers={PROVIDERS}
			/>
		)
	);
}

function byLabel(label: string): HTMLButtonElement {
	const found = container.querySelector<HTMLButtonElement>(
		`button[aria-label="${label}"]`
	);
	if (!found) {
		throw new Error(`${label} absent: ${container.textContent}`);
	}
	return found;
}

async function typeModel(value: string): Promise<void> {
	const input = container.querySelector<HTMLInputElement>("input[list]");
	if (!input) {
		throw new Error("model input absent");
	}
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function addButton(): HTMLButtonElement | undefined {
	return [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === "Add"
	);
}

beforeEach(() => {
	changes = [];
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

test("lists the backups in their order with their provider", async () => {
	await mount([OPUS, GPT]);
	const items = [...container.querySelectorAll("li")].map(
		(item) => item.textContent
	);
	expect(items[0]).toContain("1. claude-opus-4-7");
	expect(items[0]).toContain("Claude (Pro/Max)");
	expect(items[1]).toContain("2. gpt-5.5");
	expect(items[1]).toContain("ChatGPT");
});

test("says so when the agent has no backups", async () => {
	await mount([]);
	expect(container.textContent).toContain("No backup models yet.");
});

test("moves an entry up and down and removes it", async () => {
	await mount([OPUS, SONNET, GPT]);
	expect(byLabel("Move claude-opus-4-7 up").disabled).toBe(true);
	expect(byLabel("Move gpt-5.5 down").disabled).toBe(true);
	await act(async () => byLabel("Move gpt-5.5 up").click());
	await act(async () => byLabel("Move claude-opus-4-7 down").click());
	await act(async () => byLabel("Remove claude-sonnet-4-6").click());
	expect(changes).toEqual([
		[OPUS, GPT, SONNET],
		[SONNET, OPUS, GPT],
		[OPUS, GPT],
	]);
});

test("adds a model on the first provider at the end", async () => {
	await mount([OPUS]);
	expect(addButton()?.disabled).toBe(true);
	await typeModel("  claude-sonnet-4-6 ");
	expect(addButton()?.disabled).toBe(false);
	await act(async () => addButton()?.click());
	expect(changes).toEqual([[OPUS, SONNET]]);
});

test("refuses a model that is in the list already", async () => {
	await mount([OPUS]);
	await typeModel("claude-opus-4-7");
	expect(addButton()?.disabled).toBe(true);
	expect(container.textContent).toContain("This model is in the list already.");
});

test("hides the add form when the list is full", async () => {
	await mount([OPUS, GPT], 2);
	expect(addButton()).toBeUndefined();
	expect(container.textContent).toContain(
		"An agent has at most 2 backup models."
	);
});

test("names a limit of one in the singular", async () => {
	await mount([OPUS], 1);
	expect(addButton()).toBeUndefined();
	expect(container.textContent).toContain(
		"An agent has at most 1 backup model."
	);
});

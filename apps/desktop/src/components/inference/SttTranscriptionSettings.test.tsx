import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

import type { ApiTarget } from "@/src/lib/api/client.ts";

const ACTIVE_NODE: ApiTarget = {
	url: "https://node.example",
	token: "node-token",
	userJwt: "user-jwt",
};
const readCalls: { key: string; target: ApiTarget }[] = [];
const writeCalls: { key: string; target: ApiTarget; value: string }[] = [];
let readResults: (string | null | Error)[] = [];
let writeResults: (boolean | Error)[] = [];

async function getPreference(
	target: ApiTarget,
	key: string
): Promise<string | null> {
	readCalls.push({ key, target });
	const result = readResults.shift() ?? null;
	if (result instanceof Error) {
		throw result;
	}
	return result;
}

async function setPreference(
	target: ApiTarget,
	key: string,
	value: string
): Promise<boolean> {
	writeCalls.push({ key, target, value });
	const result = writeResults.shift() ?? true;
	if (result instanceof Error) {
		throw result;
	}
	return result;
}

mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => ACTIVE_NODE,
}));
mock.module("@/src/lib/api/preferences.ts", () => ({
	getPreference,
	setPreference,
}));
// The unit-test DOM sends input events for typing. Bridge those events to the
// field callbacks while keeping the app's Base UI controls outside this test.
mock.module("@ryu/ui/components/input", () => ({
	Input: ({ onChange, ...props }: ComponentProps<"input">) => (
		<input
			{...props}
			onChange={onChange}
			onInput={(event) =>
				// Forward the same native React event with its actual rendered field as target; Object.assign retains the event prototype/methods and the optional callback return.
				onChange?.(Object.assign(event, { target: event.currentTarget }))
			}
		/>
	),
}));
mock.module("@ryu/ui/components/textarea", () => ({
	Textarea: ({ onChange, ...props }: ComponentProps<"textarea">) => (
		<textarea
			{...props}
			onChange={onChange}
			onInput={(event) =>
				// Forward the same native React event with its actual rendered field as target; Object.assign retains the event prototype/methods and the optional callback return.
				onChange?.(Object.assign(event, { target: event.currentTarget }))
			}
		/>
	),
}));
mock.module("@ryu/ui/components/switch", () => ({
	Switch: ({
		checked,
		disabled,
		id,
		onCheckedChange,
	}: {
		checked: boolean;
		disabled?: boolean;
		id?: string;
		onCheckedChange?: (checked: boolean) => void;
	}) => (
		<input
			aria-checked={checked}
			checked={checked}
			disabled={disabled}
			id={id}
			onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
			onClick={(event) => onCheckedChange?.(event.currentTarget.checked)}
			role="switch"
			type="checkbox"
		/>
	),
}));

const { SttTranscriptionSettings } = await import(
	"./SttTranscriptionSettings.tsx"
);

let container: HTMLDivElement;
let queryClient: QueryClient;
let root: Root | null;

beforeEach(() => {
	readCalls.length = 0;
	writeCalls.length = 0;
	readResults = [];
	writeResults = [];
	queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				gcTime: 0,
				refetchOnWindowFocus: false,
				retry: false,
			},
		},
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	if (root) {
		await act(async () => root?.unmount());
		root = null;
	}
	queryClient.clear();
	container.remove();
});

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitForCondition(
	predicate: () => boolean,
	description: string
): Promise<void> {
	await act(async () => {
		for (let attempt = 0; attempt < 40 && !predicate(); attempt += 1) {
			await new Promise<void>((resolve) => setTimeout(resolve, 2));
		}
	});
	if (!predicate()) {
		throw new Error(
			`Timed out waiting for ${description}. Current UI: ${container.textContent}`
		);
	}
}

async function renderSettings(
	props: {
		adapterNote?: string;
		adapterSupported?: boolean;
		engineId?: string;
	} = {}
): Promise<void> {
	await act(async () => {
		root?.render(
			<QueryClientProvider client={queryClient}>
				<SttTranscriptionSettings engineId="whispercpp" {...props} />
			</QueryClientProvider>
		);
		await tick();
	});
	await waitForCondition(
		() =>
			Boolean(container.querySelector('[role="alert"]')) ||
			Array.from(container.querySelectorAll("button")).some((button) =>
				button.textContent?.includes("Save transcription settings")
			),
		"transcription settings to load"
	);
}

function buttonNamed(name: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim().includes(name)
	);
	if (!button) {
		throw new Error(`Could not find button: ${name}`);
	}
	return button;
}

function fieldNamed(name: string): HTMLInputElement | HTMLTextAreaElement {
	const label = Array.from(container.querySelectorAll("label")).find(
		(candidate) => candidate.textContent?.trim() === name
	);
	if (!label?.htmlFor) {
		throw new Error(`Could not find field label: ${name}`);
	}
	const field = document.getElementById(label.htmlFor);
	if (
		!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
	) {
		throw new Error(`Label does not point to a text field: ${name}`);
	}
	return field;
}

function switchNamed(name: string): HTMLInputElement {
	const field = fieldNamed(name);
	if (!(field instanceof HTMLInputElement) || field.type !== "checkbox") {
		throw new Error(`Label does not point to a switch: ${name}`);
	}
	return field;
}

function setFieldValue(
	field: HTMLInputElement | HTMLTextAreaElement,
	value: string
): void {
	const prototype =
		field instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	if (!setter) {
		throw new Error("Could not find native value setter");
	}
	field.focus();
	setter.call(field, value);
	field.dispatchEvent(new InputEvent("input", { bubbles: true }));
	field.blur();
}

async function fillField(name: string, value: string): Promise<void> {
	await act(async () => {
		setFieldValue(fieldNamed(name), value);
		await Promise.resolve();
	});
}

async function setSwitchState(name: string, checked: boolean): Promise<void> {
	const toggle = switchNamed(name);
	if (toggle.checked !== checked) {
		await act(async () => {
			toggle.click();
			await Promise.resolve();
		});
	}
}

async function clickButton(name: string): Promise<void> {
	await act(async () => {
		buttonNamed(name).click();
		await tick();
	});
}

function alertText(): string {
	return container.querySelector('[role="alert"]')?.textContent?.trim() ?? "";
}

test("retries a failed settings read and shows the adapter support note", async () => {
	const supportNote =
		"These values are saved for Parakeet, but the current in-process runtime does not consume request options yet.";
	readResults = [
		new Error("Core is temporarily unavailable"),
		JSON.stringify({ language: "en", temperature: 0.25 }),
	];

	await renderSettings({ adapterSupported: false, engineId: "parakeet" });

	expect(readCalls).toHaveLength(1);
	expect(alertText()).toContain("Couldn't load transcription settings.");
	expect(buttonNamed("Retry").disabled).toBe(false);

	await clickButton("Retry");
	await waitForCondition(
		() =>
			readCalls.length === 2 &&
			container.textContent?.includes(supportNote) === true,
		"retry response and support note"
	);

	expect(readCalls).toHaveLength(2);
	expect(readCalls[0]).toEqual({
		key: "engine.transcription.parakeet",
		target: ACTIVE_NODE,
	});
	expect(container.textContent).toContain(supportNote);
	expect(container.textContent).toContain("Save transcription settings");
	expect(fieldNamed("Language").value).toBe("en");
	expect(alertText()).toBe("");
});

test("invalid additional fields keep Save disabled and make no preference write", async () => {
	readResults = [JSON.stringify({ language: "auto" })];
	await renderSettings();

	const saveButton = buttonNamed("Save transcription settings");
	await fillField("Extra fields (JSON)", "{not json");
	expect(fieldNamed("Extra fields (JSON)").value).toBe("{not json");
	expect(alertText()).toContain("Invalid JSON");
	expect(saveButton.disabled).toBe(true);
	await clickButton("Save transcription settings");
	expect(writeCalls).toHaveLength(0);

	await fillField("Extra fields (JSON)", '{"vad": true}');
	expect(alertText()).toContain("Use a JSON object with string values.");
	expect(buttonNamed("Save transcription settings").disabled).toBe(true);
	await clickButton("Save transcription settings");
	expect(writeCalls).toHaveLength(0);
});

test("preserves and retries a valid save, then refetches the engine preference", async () => {
	const supportNote = "Only supported options reach this adapter.";
	const savedConfig = {
		language: "fr",
		temperature: 0.45,
		temperature_inc: 0.1,
		best_of: 3,
		beam_size: 5,
		max_context: -1,
		max_len: 128,
		translate: true,
		no_context: true,
		suppress_nst: true,
		prompt: "Project names and places.",
		extra: { vad: "true" },
	};
	readResults = [
		JSON.stringify({ language: "auto", temperature: 0.2 }),
		JSON.stringify(savedConfig),
	];
	writeResults = [new Error("Core write failed; try again."), true];

	await renderSettings({ adapterNote: supportNote });
	await fillField("Language", "fr");
	await fillField("Temperature", "0.45");
	await fillField("Temperature increment", "0.1");
	await fillField("Best of", "3");
	await fillField("Beam size", "5");
	await fillField("Max context", "-1");
	await fillField("Max segment length", "128");
	await setSwitchState("Translate to English", true);
	await setSwitchState("Disable previous audio context", true);
	await setSwitchState("Suppress non-speech tokens", true);
	await fillField("Prompt", "Project names and places.");
	await fillField("Extra fields (JSON)", '{"vad":"true"}');

	expect(switchNamed("Translate to English").checked).toBe(true);
	expect(switchNamed("Disable previous audio context").checked).toBe(true);
	expect(switchNamed("Suppress non-speech tokens").checked).toBe(true);
	expect(fieldNamed("Language").value).toBe("fr");
	expect(fieldNamed("Temperature").value).toBe("0.45");
	expect(fieldNamed("Temperature increment").value).toBe("0.1");
	expect(fieldNamed("Best of").value).toBe("3");
	expect(fieldNamed("Beam size").value).toBe("5");
	expect(fieldNamed("Max context").value).toBe("-1");
	expect(fieldNamed("Max segment length").value).toBe("128");
	expect(fieldNamed("Prompt").value).toBe("Project names and places.");
	expect(alertText()).toBe("");
	expect(buttonNamed("Save transcription settings").disabled).toBe(false);

	await clickButton("Save transcription settings");
	await waitForCondition(
		() => alertText().includes("Couldn't save transcription settings."),
		"save error"
	);

	expect(writeCalls).toHaveLength(1);
	expect(writeCalls[0]).toEqual({
		key: "engine.transcription.whispercpp",
		target: ACTIVE_NODE,
		value: JSON.stringify(savedConfig),
	});
	// The raw cause stays behind "Copy details".
	expect(alertText()).not.toContain("Core write failed; try again.");
	expect(readCalls).toHaveLength(1);
	expect(fieldNamed("Language").value).toBe("fr");
	expect(fieldNamed("Prompt").value).toBe("Project names and places.");

	await clickButton("Save transcription settings");
	await waitForCondition(
		() =>
			readCalls.length === 2 &&
			container.textContent?.includes("Saved for this engine") === true,
		"successful save and preference refetch"
	);

	expect(writeCalls).toHaveLength(2);
	expect(writeCalls[1]).toEqual(writeCalls[0]);
	expect(readCalls).toHaveLength(2);
	expect(readCalls[1]).toEqual(readCalls[0]);
	expect(
		queryClient.getQueryData<typeof savedConfig>([
			"engine",
			"transcription-settings",
			ACTIVE_NODE.url,
			"whispercpp",
		])
	).toEqual(savedConfig);
	expect(container.textContent).toContain("Saved for this engine");
	expect(container.textContent).toContain(supportNote);
	expect(fieldNamed("Language").value).toBe("fr");
	expect(fieldNamed("Temperature").value).toBe("0.45");
	expect(fieldNamed("Extra fields (JSON)").value).toBe('{"vad":"true"}');
	expect(alertText()).toBe("");
});

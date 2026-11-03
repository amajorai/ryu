import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
	armed,
	calls,
	DICTATION_PATH,
	NODE_TOKEN,
	nativeFetch,
	releaseHeld,
	resetHeldPut,
	server,
	store,
	unexpected,
} from "./DictationSettings.coverage-peer.test-support.ts";

const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
export const {
	DEFAULT_DICTATION_PREFS,
	DEFAULT_DICTATION_ASK_PROMPT,
	DEFAULT_DICTATION_POSTPROCESS_PROMPT,
	VOICE_ENGINES,
} = await import("@/src/lib/api/preferences.ts");
export const { parseDictationPrefs } = await import(
	"../../../../island/src/shared/dictation.ts"
);
const { DictationSettings } = await import("./DictationSettings.tsx");

const initialNodeState = useNodeStore.getState();
let root: Root | null = null;
export let container: HTMLDivElement;

export async function until(predicate: () => boolean, label: string) {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	throw new Error(`${label} did not settle: ${container.textContent}`);
}

export async function mount() {
	root = createRoot(container);
	await act(async () =>
		root!.render(
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<DictationSettings />
				</EntitlementProvider>
			</QueryClientProvider>
		)
	);
}

async function unmount() {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
	}
	root = null;
}

export async function mountLoaded() {
	await mount();
	await until(
		() => labelled("Set dictation shortcut") !== null,
		"Dictation preferences load"
	);
}

export async function remount() {
	await unmount();
	await mountLoaded();
}

export function labelled<T extends HTMLElement = HTMLElement>(
	label: string
): T | null {
	return container.querySelector<T>(`[aria-label="${label}"]`);
}

export function required<T extends HTMLElement = HTMLElement>(
	label: string
): T {
	const found = labelled<T>(label);
	if (!found) {
		throw new Error(`Missing control ${label}: ${container.textContent}`);
	}
	return found;
}

export function text(element: Element | null | undefined) {
	return element?.textContent?.replace("▼", "").replace(/\s+/g, " ").trim();
}

export function rowTitles() {
	return [...container.querySelectorAll('[data-slot="item-title"]')].map(
		(title) => text(title)
	);
}

/** The muted caption a settings group prints under the row with this title. */
export function captionFor(title: string) {
	const heading = [
		...container.querySelectorAll('[data-slot="item-title"]'),
	].find((candidate) => text(candidate) === title);
	if (!heading) {
		throw new Error(`Missing row ${title}: ${rowTitles().join(" | ")}`);
	}
	if (heading.closest('[data-slot="item"]')) {
		// A flush settings row renders its description under its own title.
		return text(heading.nextElementSibling);
	}
	// A bare row renders its own description beneath its control.
	return text(heading.parentElement?.parentElement?.lastElementChild);
}

export function stored(key = "dictation") {
	const raw = store.get(key);
	if (raw === undefined) {
		throw new Error(`Core has no ${key} preference`);
	}
	return JSON.parse(raw);
}

export function puts(path = DICTATION_PATH) {
	return calls.filter((call) => call.method === "PUT" && call.path === path);
}

export function putValues(path = DICTATION_PATH) {
	return puts(path).map(
		(call) => JSON.parse(JSON.parse(call.body ?? "{}").value) as unknown
	);
}

/** The listbox of the one select that is open now (closed popups linger). */
function openOptions() {
	const listbox = [
		...document.querySelectorAll<HTMLElement>('[role="listbox"]'),
	]
		.filter(
			(box) =>
				!(box.hasAttribute("data-closed") || box.closest("[data-closed]"))
		)
		.at(-1);
	return [...(listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
}

export async function openSelect(label: string) {
	const combo = required(label);
	await act(async () => combo.click());
	await until(() => openOptions().length > 0, `${label} options`);
	return openOptions().map((option) => text(option));
}

export async function choose(label: string, option: string) {
	await openSelect(label);
	const match = openOptions().find((candidate) => text(candidate) === option);
	if (!match) {
		throw new Error(`Missing option ${option} in ${label}`);
	}
	await act(async () => match.click());
	await until(
		() => required(label).getAttribute("aria-expanded") === "false",
		`${label} close`
	);
}

export async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
}

export async function type(
	element: HTMLInputElement | HTMLTextAreaElement,
	value: string
) {
	const prototype =
		element instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	await act(async () => {
		Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
			element,
			value
		);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

export async function press(
	element: HTMLElement,
	key: string,
	modifiers: { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}
) {
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key,
				...modifiers,
			})
		);
	});
}

/** Wait for the writes queued so far to reach Core. */
export async function settled(count: number, path = DICTATION_PATH) {
	await until(
		() => puts(path).filter((call) => call.status !== 0).length >= count,
		`${count} ${path} writes`
	);
}

/** The message of the tab's one alert, without its action button. */
export function alertMessage() {
	return text(container.querySelector('[role="alert"] > span'));
}

export function keycaps(label: string) {
	return [...required(label).querySelectorAll("kbd")].map((cap) => text(cap));
}

export function seed(prefs: Record<string, unknown>) {
	store.set(
		"dictation",
		JSON.stringify({ ...DEFAULT_DICTATION_PREFS, ...prefs })
	);
}

export async function pickCustomModel(fieldLabel: string, model: string) {
	await click(required(fieldLabel));
	await until(
		() => document.querySelector('[aria-label="Custom model id"]') !== null,
		"custom model row"
	);
	const input = document.querySelector<HTMLInputElement>(
		'[aria-label="Custom model id"]'
	)!;
	await type(input, model);
	await click(
		document.querySelector<HTMLElement>('[aria-label="Use this model"]')!
	);
	await until(
		() => document.querySelector('[aria-label="Custom model id"]') === null,
		"picker close"
	);
}

export async function pickAgent(fieldLabel: string, agentName: string) {
	await click(required(fieldLabel));
	await until(
		() =>
			[...document.querySelectorAll<HTMLElement>("[cmdk-item]")].some(
				(item) => text(item) === agentName
			),
		`${agentName} picker row`
	);
	const row = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
		(item) => text(item) === agentName
	)!;
	await click(row);
	await until(
		() => document.querySelector('[aria-label="Custom model id"]') === null,
		"picker close"
	);
}

export function agentReads(id: string) {
	return calls.filter(
		(call) => call.method === "GET" && call.path === `/api/agents/${id}`
	);
}

/** Registers the per-case setup and closure checks every split file shares. */
export function registerDictationCoverageHooks() {
	beforeEach(() => {
		store.clear();
		calls.length = 0;
		unexpected.length = 0;
		armed.clear();
		resetHeldPut();
		queryClient.clear();
		localStorage.clear();
		localStorage.setItem("dictation-coverage-unrelated", "kept");
		useNodeStore.setState({
			autoSelect: false,
			defaultNode: "dictation-coverage",
			nodes: [
				{
					name: "dictation-coverage",
					token: NODE_TOKEN,
					url: server.url.origin,
				},
			],
			tabOverrides: {},
		});
		container = document.createElement("div");
		document.body.append(container);
	});

	afterEach(async () => {
		releaseHeld?.();
		await unmount();
		container.remove();
		document.body.replaceChildren();
		useNodeStore.setState(initialNodeState, true);
		// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
		expect(localStorage.getItem("dictation-coverage-unrelated")).toBe("kept");
		// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects unauthenticated, undeclared or off-fixture requests.
		expect(unexpected.join("\n")).toBe("");
	});

	afterAll(() => {
		server.stop(true);
		globalThis.fetch = nativeFetch;
	});
}

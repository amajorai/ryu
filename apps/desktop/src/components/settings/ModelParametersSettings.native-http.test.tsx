import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Mounts the shipping per-model parameter editor (preset bar + sampling form)
// for a cloud model against an owned native Core peer that keeps a real preset
// store, so apply / save / overwrite / delete are proven by what that store and
// the model's saved sampling config hold afterwards, not by a mocked client.
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Object.assign(globalThis, { Response: NativeResponse, fetch: nativeFetch });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface StoredPreset {
	builtin: boolean;
	created_at: number;
	description?: string;
	id: string;
	name: string;
	sampling: Record<string, unknown>;
	target: "any" | "local" | "cloud";
	updated_at: number;
}
interface Call {
	body: unknown;
	method: string;
	path: string;
}

const MODEL_ID = "claude-x";
const SAMPLING_PATH = `/api/models/${MODEL_ID}/sampling-config`;
const PRESETS_PATH = "/api/inference/presets";
const calls: Call[] = [];
const unknownRequests: string[] = [];
const refuse = new Set<string>();
let presets: StoredPreset[] = [];
let modelSampling: Record<string, unknown> = {};
let nextId = 1;

function seedPresets(): StoredPreset[] {
	return [
		{
			builtin: true,
			created_at: 1,
			id: "builtin-precise",
			name: "Precise",
			sampling: { temperature: 0.2, top_p: 0.9, top_k: 40 },
			target: "any",
			updated_at: 1,
		},
		{
			builtin: false,
			created_at: 2,
			id: "user-local",
			name: "Local only",
			sampling: { temperature: 0.4 },
			target: "local",
			updated_at: 2,
		},
		{
			builtin: false,
			created_at: 3,
			id: "user-cloud",
			name: "Cloud creative",
			sampling: { temperature: 1.1 },
			target: "cloud",
			updated_at: 3,
		},
	];
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const raw = await request.text();
		const call: Call = {
			method: request.method,
			path: `${url.pathname}${url.search}`,
			body: raw === "" ? null : JSON.parse(raw),
		};
		calls.push(call);
		const key = `${call.method} ${call.path}`;
		if (refuse.delete(key)) {
			return NativeResponse.json(
				{ error: "Preset store unavailable" },
				{
					status: 503,
				}
			);
		}
		if (key === "GET /api/inference/sampling-fields?provider=anthropic") {
			return NativeResponse.json({
				fields: ["temperature", "top_p"],
				local: false,
			});
		}
		if (key === `GET ${SAMPLING_PATH}`) {
			return NativeResponse.json(modelSampling);
		}
		if (key === `PUT ${SAMPLING_PATH}`) {
			modelSampling = call.body as Record<string, unknown>;
			return NativeResponse.json({ ok: true, id: MODEL_ID });
		}
		if (key === `GET ${PRESETS_PATH}`) {
			return NativeResponse.json({ presets });
		}
		if (key === `POST ${PRESETS_PATH}`) {
			const body = call.body as Omit<StoredPreset, "builtin" | "id">;
			const preset: StoredPreset = {
				...body,
				builtin: false,
				created_at: 10,
				id: `saved-${nextId++}`,
				updated_at: 10,
			};
			presets = [...presets, preset];
			return NativeResponse.json({ preset });
		}
		const id = call.path.startsWith(`${PRESETS_PATH}/`)
			? decodeURIComponent(call.path.slice(PRESETS_PATH.length + 1))
			: null;
		const existing = presets.find((preset) => preset.id === id);
		if (existing && (call.method === "PUT" || call.method === "DELETE")) {
			if (existing.builtin) {
				return NativeResponse.json(
					{ error: "Built-in preset" },
					{
						status: 403,
					}
				);
			}
			if (call.method === "DELETE") {
				presets = presets.filter((preset) => preset.id !== existing.id);
				return NativeResponse.json({ ok: true });
			}
			const updated: StoredPreset = {
				...existing,
				...(call.body as Partial<StoredPreset>),
				updated_at: existing.updated_at + 1,
			};
			presets = presets.map((preset) =>
				preset.id === existing.id ? updated : preset
			);
			return NativeResponse.json({ preset: updated });
		}
		unknownRequests.push(key);
		return NativeResponse.json(
			{ error: "Undeclared contract" },
			{
				status: 404,
			}
		);
	},
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { sileo } = await import("sileo");
const { ModelParameterEditor, presetFitsKind } = await import(
	"./ModelParametersSettings.tsx"
);

const target = {
	url: server.url.toString().replace(/\/$/, ""),
	token: "presets-token",
	userJwt: null,
};
const cloudModel = {
	id: MODEL_ID,
	kind: "cloud" as const,
	label: "Claude X",
	provider: "anthropic",
};

let client: InstanceType<typeof QueryClient>;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;

async function pause() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
}
async function until(predicate: () => boolean, reason: string) {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(reason);
		}
		await pause();
	}
}
async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			createElement(
				QueryClientProvider,
				{ client },
				createElement(ModelParameterEditor, { model: cloudModel, target })
			)
		)
	);
	await until(
		() => buttonNamed("Apply") !== undefined,
		"preset bar did not load"
	);
}
function buttonNamed(label: string): HTMLButtonElement | undefined {
	return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent?.trim() === label
	);
}
function requireButton(label: string): HTMLButtonElement {
	const button = buttonNamed(label);
	if (!button) {
		throw new Error(`No ${label} button`);
	}
	return button;
}
function presetTrigger(): HTMLElement {
	const trigger = document.querySelector<HTMLElement>('[aria-label="Preset"]');
	if (!trigger) {
		throw new Error("Preset select not mounted");
	}
	return trigger;
}
async function openPresetOptions(): Promise<string[]> {
	await act(async () => presetTrigger().click());
	await pause();
	return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
		(option) => option.textContent?.trim() ?? ""
	);
}
async function choosePreset(label: string) {
	await openPresetOptions();
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((item) => item.textContent?.trim() === label);
	if (!option) {
		throw new Error(`No preset option ${label}`);
	}
	await act(async () => option.click());
	await until(
		() => presetTrigger().textContent?.includes(label.split(" (")[0]) === true,
		`preset ${label} not selected`
	);
}
async function typeInto(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function callsTo(method: string, path: string) {
	return calls.filter((call) => call.method === method && call.path === path);
}

beforeEach(() => {
	calls.length = 0;
	unknownRequests.length = 0;
	refuse.clear();
	presets = seedPresets();
	modelSampling = { temperature: 0.7, top_p: 0.95 };
	nextId = 1;
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	errorToast = spyOn(sileo, "error");
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	client.clear();
	errorToast.mockRestore();
	// Per-case closure: every exchange must hit a declared Core contract.
	if (unknownRequests.length > 0) {
		throw new Error(`undeclared requests: ${unknownRequests.join("; ")}`);
	}
});
afterAll(async () => {
	await server.stop(true);
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

describe("presetFitsKind", () => {
	test("an any-target preset fits both kinds; a scoped one only its own", () => {
		const base = seedPresets();
		const [anyPreset, localPreset, cloudPreset] = base;
		if (!(anyPreset && localPreset && cloudPreset)) {
			throw new Error("seed presets missing");
		}
		expect(presetFitsKind(anyPreset, "local")).toBe(true);
		expect(presetFitsKind(anyPreset, "cloud")).toBe(true);
		expect(presetFitsKind(localPreset, "local")).toBe(true);
		expect(presetFitsKind(localPreset, "cloud")).toBe(false);
		expect(presetFitsKind(cloudPreset, "cloud")).toBe(true);
		expect(presetFitsKind(cloudPreset, "local")).toBe(false);
	});
});

test("a cloud model is offered only any/cloud presets, and applying a built-in saves only the fields the model accepts", async () => {
	await mount();
	expect(await openPresetOptions()).toEqual([
		"Precise (built-in)",
		"Cloud creative",
	]);
	await act(async () => presetTrigger().click());
	await choosePreset("Precise (built-in)");

	// Built-in presets are read-only: no overwrite or delete is offered.
	expect(buttonNamed("Update from current")).toBeUndefined();
	expect(buttonNamed("Delete")).toBeUndefined();

	await act(async () => requireButton("Apply").click());
	await until(
		() => callsTo("PUT", SAMPLING_PATH).length === 1,
		"apply did not save the model's sampling"
	);
	// top_k is not a field Anthropic accepts, so it is dropped.
	expect(callsTo("PUT", SAMPLING_PATH)[0]?.body).toEqual({
		temperature: 0.2,
		top_p: 0.9,
	});
	expect(modelSampling).toEqual({ temperature: 0.2, top_p: 0.9 });
	expect(presets.find((p) => p.id === "builtin-precise")?.sampling).toEqual({
		temperature: 0.2,
		top_p: 0.9,
		top_k: 40,
	});
});

test("save as preset persists the current values for this model kind, update overwrites it, delete removes it", async () => {
	await mount();
	await act(async () => requireButton("Save as preset").click());
	const nameInput = document.querySelector<HTMLInputElement>(
		'[aria-label="Preset name"]'
	);
	if (!nameInput) {
		throw new Error("Preset name input missing");
	}
	await typeInto(nameInput, "My cloud");
	await act(async () => requireButton("Save").click());
	await until(
		() => presets.some((preset) => preset.name === "My cloud"),
		"preset was not stored"
	);
	expect(callsTo("POST", PRESETS_PATH)[0]?.body).toEqual({
		name: "My cloud",
		sampling: { temperature: 0.7, top_p: 0.95 },
		target: "cloud",
	});
	// The saved preset becomes the selection and, being the user's, editable.
	await until(
		() => buttonNamed("Update from current") !== undefined,
		"saved preset not selected"
	);
	expect(presetTrigger().textContent).toContain("My cloud");

	await act(async () => requireButton("Update from current").click());
	await until(
		() => callsTo("PUT", `${PRESETS_PATH}/saved-1`).length === 1,
		"overwrite not sent"
	);
	expect(callsTo("PUT", `${PRESETS_PATH}/saved-1`)[0]?.body).toEqual({
		name: "My cloud",
		sampling: { temperature: 0.7, top_p: 0.95 },
		target: "cloud",
	});
	await until(
		() => presets.find((p) => p.id === "saved-1")?.updated_at === 11,
		"overwrite not stored"
	);

	await until(
		() => buttonNamed("Delete")?.disabled === false,
		"overwrite still pending"
	);
	await act(async () => requireButton("Delete").click());
	await until(
		() => !presets.some((preset) => preset.id === "saved-1"),
		"preset not deleted"
	);
	await until(
		() => buttonNamed("Delete") === undefined,
		"deleted preset still selected"
	);
	expect(await openPresetOptions()).toEqual([
		"Precise (built-in)",
		"Cloud creative",
	]);
	// No call ever targeted the built-in preset.
	expect(calls.some((call) => call.path.endsWith("/builtin-precise"))).toBe(
		false
	);
});

test("a refused save is reported and stores nothing", async () => {
	await mount();
	refuse.add(`POST ${PRESETS_PATH}`);
	await act(async () => requireButton("Save as preset").click());
	const nameInput = document.querySelector<HTMLInputElement>(
		'[aria-label="Preset name"]'
	);
	if (!nameInput) {
		throw new Error("Preset name input missing");
	}
	await typeInto(nameInput, "Refused");
	await act(async () => requireButton("Save").click());
	await until(() => errorToast.mock.calls.length > 0, "no error surfaced");
	expect(errorToast.mock.calls[0]?.[0]).toMatchObject({
		title: "Could not save preset",
	});
	// Nothing phantom is selected or listed after the refusal.
	expect(buttonNamed("Update from current")).toBeUndefined();
	expect(await openPresetOptions()).toEqual([
		"Precise (built-in)",
		"Cloud creative",
	]);
	await act(async () => presetTrigger().click());
	// The form stays open (still mounted) with the name so the user can retry.
	expect(
		document.querySelector<HTMLInputElement>('[aria-label="Preset name"]')
			?.value
	).toBe("Refused");
	expect(buttonNamed("Save")).toBeDefined();
});

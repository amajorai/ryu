import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type Subprocess, spawn } from "bun";
import { act } from "react";
import type { Root } from "react-dom/client";

// Control-level coverage for the shipping Quests settings tab: the judge-model
// field and the check-interval field. Every read and write crosses real
// loopback HTTP through the production quests SDK to a Core-style ext-proxy
// owned by this file. The proxy checks the node bearer and user JWT, can refuse
// a write, and forwards `/api/quests/*` with the sidecar's own bearer, as Core's
// generic ext-proxy does.
//
// Behind the proxy sits either:
// - by default, an in-file model of `set_detection_config` in
//   `apps-store/quests/backend/src/api.rs`, including humantime 2.4.0's unit
//   table, which the sidecar uses to validate the interval; or
// - with `RYU_QUESTS_SIDECAR_BIN=<path to a built ryu-quests>`, the REAL quests
//   sidecar process, with a scratch data directory. Every case runs unchanged.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
window.fetch = nativeFetch;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(60_000);

const NODE_TOKEN = "quests-coverage-node-token";
const USER_JWT = "quests-coverage-user-jwt";
const EXT_TOKEN = "quests-coverage-ext-token";
const CONFIG_PATH = "/api/quests/detection-config";
const DEFAULTS = {
	effort: "",
	interval: "2m",
	mode: "auto_high",
	model: "",
} as const;
const SIDECAR_BIN = process.env.RYU_QUESTS_SIDECAR_BIN ?? "";

interface Config {
	effort: string;
	interval: string;
	mode: string;
	model: string;
}

interface ProxyCall {
	body: Record<string, unknown> | null;
	method: string;
	status: number;
}

// ── Default backend: a model of the sidecar's detection-config handlers ─────

// humantime 2.4.0 `Unit::from_str`, verbatim and case-sensitive.
const HUMANTIME_UNITS = new Set([
	"nanos",
	"nsec",
	"ns",
	"usec",
	"us",
	"µs",
	"millis",
	"msec",
	"ms",
	"seconds",
	"second",
	"secs",
	"sec",
	"s",
	"minutes",
	"minute",
	"min",
	"mins",
	"m",
	"hours",
	"hour",
	"hr",
	"hrs",
	"h",
	"days",
	"day",
	"d",
	"weeks",
	"week",
	"wk",
	"wks",
	"w",
	"months",
	"month",
	"M",
	"years",
	"year",
	"yr",
	"yrs",
	"y",
]);

// humantime keeps each number and the running total of whole seconds in a
// `u64` with checked arithmetic, and refuses an overflow (`NumberOverflow`).
const U64_MAX = 18_446_744_073_709_551_615n;
const SECONDS_PER_UNIT: Record<string, bigint> = {
	d: 86_400n,
	day: 86_400n,
	days: 86_400n,
	h: 3600n,
	hour: 3600n,
	hours: 3600n,
	hr: 3600n,
	hrs: 3600n,
	m: 60n,
	M: 2_630_016n,
	min: 60n,
	mins: 60n,
	minute: 60n,
	minutes: 60n,
	month: 2_630_016n,
	months: 2_630_016n,
	s: 1n,
	sec: 1n,
	second: 1n,
	seconds: 1n,
	secs: 1n,
	w: 604_800n,
	week: 604_800n,
	weeks: 604_800n,
	wk: 604_800n,
	wks: 604_800n,
	y: 31_557_600n,
	year: 31_557_600n,
	years: 31_557_600n,
	yr: 31_557_600n,
	yrs: 31_557_600n,
};

const NANOS_PER_SUBSECOND_UNIT: Record<string, bigint> = {
	millis: 1_000_000n,
	ms: 1_000_000n,
	msec: 1_000_000n,
	nanos: 1n,
	ns: 1n,
	nsec: 1n,
	us: 1000n,
	usec: 1000n,
	µs: 1000n,
};

function humantimeParses(value: string): boolean {
	const parts = value.trim().match(/\d+(?:\.\d+)?\s*[A-Za-zµ]+|\S+/g) ?? [];
	if (parts.length === 0) {
		return false;
	}
	let seconds = 0n;
	for (const part of parts) {
		const match = /^(\d+)(?:\.\d+)?\s*([A-Za-zµ]+)$/.exec(part);
		const unit = match?.[2] ?? "";
		if (!(match && HUMANTIME_UNITS.has(unit))) {
			return false;
		}
		const amount = BigInt(match[1] ?? "0");
		seconds += amount * (SECONDS_PER_UNIT[unit] ?? 0n);
		if (
			amount > U64_MAX ||
			amount * (NANOS_PER_SUBSECOND_UNIT[unit] ?? 0n) > U64_MAX ||
			seconds > U64_MAX
		) {
			return false;
		}
	}
	return true;
}

const modelled: Config = { ...DEFAULTS };

function modelledSidecar(method: string, body: Record<string, unknown>) {
	if (method === "GET") {
		return { body: { ...modelled }, status: 200 };
	}
	if (typeof body.mode === "string") {
		const mode = body.mode.trim().toLowerCase().replace("-", "_");
		modelled.mode = ["off", "auto_high", "auto_all"].includes(mode)
			? mode
			: "suggest";
	}
	if (typeof body.model === "string") {
		modelled.model = body.model.trim();
	}
	if (typeof body.effort === "string") {
		modelled.effort = body.effort.trim();
	}
	if (typeof body.interval === "string") {
		const interval = body.interval.trim();
		if (interval && !humantimeParses(interval)) {
			return {
				body: {
					error: `interval '${interval}' is not a valid duration (e.g. 2m)`,
				},
				status: 400,
			};
		}
		modelled.interval = interval || DEFAULTS.interval;
	}
	return { body: { ok: true }, status: 200 };
}

// ── Optional backend: the real sidecar process ──────────────────────────────

let sidecar: Subprocess | null = null;
let sidecarOrigin = "";
let sidecarDir = "";

async function freePort(): Promise<number> {
	const probe = Bun.serve({
		fetch: () => new NativeResponse(""),
		hostname: "127.0.0.1",
		port: 0,
	});
	const port = probe.port;
	probe.stop(true);
	return port ?? 0;
}

async function startSidecar() {
	sidecarDir = mkdtempSync(path.join(tmpdir(), "quests-coverage-"));
	const port = await freePort();
	sidecarOrigin = `http://127.0.0.1:${port}`;
	sidecar = spawn([SIDECAR_BIN], {
		env: {
			...process.env,
			RUST_LOG: "warn",
			RYU_DIR: sidecarDir,
			RYU_EXT_TOKEN: EXT_TOKEN,
			RYU_QUESTS_PORT: String(port),
		},
		stderr: "ignore",
		stdout: "ignore",
	});
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			const health = await nativeFetch(`${sidecarOrigin}/health`);
			if (health.ok) {
				return;
			}
		} catch {
			// Not listening yet.
		}
		await Bun.sleep(50);
	}
	throw new Error(`ryu-quests at ${SIDECAR_BIN} never became healthy`);
}

async function sidecarRequest(method: string, body: string | null) {
	const response = await nativeFetch(`${sidecarOrigin}${CONFIG_PATH}`, {
		body,
		headers: {
			authorization: `Bearer ${EXT_TOKEN}`,
			"content-type": "application/json",
		},
		method,
	});
	return {
		body: (await response.json()) as Record<string, unknown>,
		status: response.status,
	};
}

/** The node's saved detection config, read straight from the backend. */
async function saved(): Promise<Config> {
	if (sidecar) {
		const { body } = await sidecarRequest("GET", null);
		const { effort, interval, mode, model } = body;
		if (
			typeof effort !== "string" ||
			typeof interval !== "string" ||
			typeof mode !== "string" ||
			typeof model !== "string"
		) {
			throw new Error(`Unexpected detection config ${JSON.stringify(body)}`);
		}
		return { effort, interval, mode, model };
	}
	return { ...modelled };
}

async function resetBackend() {
	if (sidecar) {
		const reset = await sidecarRequest("PUT", JSON.stringify(DEFAULTS));
		if (reset.status !== 200) {
			throw new Error(`Could not reset ryu-quests: ${reset.status}`);
		}
		return;
	}
	Object.assign(modelled, DEFAULTS);
}

// ── The Core-style ext-proxy the UI talks to ────────────────────────────────

const calls: ProxyCall[] = [];
const unexpected: string[] = [];
const refusals: number[] = [];

const core = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (
			request.headers.get("authorization") !== `Bearer ${NODE_TOKEN}` ||
			request.headers.get("x-ryu-user-jwt") !== USER_JWT
		) {
			unexpected.push(`${request.method} ${url.pathname} without node auth`);
			return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		if (url.pathname !== CONFIG_PATH) {
			unexpected.push(`Undeclared ${request.method} ${url.pathname}`);
			return NativeResponse.json({ error: "undeclared" }, { status: 404 });
		}
		const raw = request.method === "PUT" ? await request.text() : null;
		const call: ProxyCall = {
			body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
			method: request.method,
			status: 0,
		};
		calls.push(call);
		if (request.method === "PUT" && refusals.length > 0) {
			call.status = refusals.shift() ?? 503;
			return NativeResponse.json(
				{ error: "Quests coverage refusal" },
				{ status: call.status }
			);
		}
		const answer = sidecar
			? await sidecarRequest(request.method, raw)
			: modelledSidecar(request.method, call.body ?? {});
		call.status = answer.status;
		return NativeResponse.json(answer.body, { status: answer.status });
	},
});

process.env.VITE_APP_BACKEND_URL = core.url.origin;
let inFlight = 0;
const ownedFetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (new URL(url).origin !== core.url.origin) {
			unexpected.push(`Unowned origin ${url}`);
			return Promise.reject(new Error(`Unowned origin ${url}`));
		}
		// Counted until the whole body has arrived, so a case can tell a read
		// the client is still receiving from one it already has.
		inFlight += 1;
		return (async () => {
			try {
				const response = await nativeFetch(input, init);
				const body = await response.arrayBuffer();
				return new NativeResponse(body, {
					headers: response.headers,
					status: response.status,
					statusText: response.statusText,
				});
			} finally {
				inFlight -= 1;
			}
		})();
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = ownedFetch;
window.fetch = ownedFetch;

const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { QuestsSettings } = await import("./QuestsSettings.tsx");

const initialNodeState = useNodeStore.getState();
let root: Root | null = null;
let container: HTMLDivElement;

beforeAll(async () => {
	if (SIDECAR_BIN) {
		await startSidecar();
	}
});

beforeEach(async () => {
	await resetBackend();
	calls.length = 0;
	unexpected.length = 0;
	refusals.length = 0;
	localStorage.clear();
	localStorage.setItem("quests-coverage-unrelated", "kept");
	await act(async () => sileo.clear());
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "quests-coverage",
		nodes: [
			{
				name: "quests-coverage",
				token: NODE_TOKEN,
				url: core.url.origin,
				userJwt: USER_JWT,
			},
		],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await unmount();
	await act(async () => sileo.clear());
	container.remove();
	document.body.replaceChildren();
	useNodeStore.setState(initialNodeState, true);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem("quests-coverage-unrelated")).toBe("kept");
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects unauthenticated, undeclared or off-fixture requests.
	expect(unexpected).toEqual([]);
});

afterAll(() => {
	core.stop(true);
	sidecar?.kill();
	if (sidecarDir) {
		rmSync(sidecarDir, { force: true, recursive: true });
	}
	globalThis.fetch = nativeFetch;
});

async function until(predicate: () => boolean, label: string) {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	throw new Error(`${label} did not settle: ${document.body.textContent}`);
}

async function mount() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<>
				<QuestsSettings />
				<Toaster position="bottom-right" />
			</>
		)
	);
	await until(
		() =>
			calls.some((call) => call.method === "GET" && call.status === 200) &&
			inFlight === 0,
		"Quest settings read"
	);
	// The form renders defaults while the read is in flight, and the node's
	// values can equal them, so the fields alone cannot show the read landed:
	// the proxy answering is not the client receiving. Let the received read
	// commit before a case types, or it would overwrite what was typed.
	await act(async () => {
		await Bun.sleep(5);
	});
	const expected = await saved();
	await until(
		() =>
			container.querySelector<HTMLInputElement>("#quest-model")?.value ===
				expected.model &&
			container.querySelector<HTMLInputElement>("#quest-interval")?.value ===
				expected.interval,
		"Quest settings applied"
	);
}

async function unmount() {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
	}
	root = null;
}

async function remount() {
	await unmount();
	calls.length = 0;
	await mount();
}

function field(label: string): HTMLInputElement {
	const labelElement = [...container.querySelectorAll("label")].find(
		(candidate) => candidate.textContent?.trim() === label
	);
	const found = labelElement?.htmlFor
		? container.querySelector<HTMLInputElement>(`#${labelElement.htmlFor}`)
		: null;
	if (!found) {
		throw new Error(`Missing labelled field ${label}`);
	}
	return found;
}

const model = () => field("Model");
const interval = () => field("Check interval");

/**
 * Type into a field the way a browser delivers it: the input event is
 * dispatched outside `act`, so React flushes the field's own state update
 * before it restores the controlled value, exactly as in a real webview. Inside
 * `act` that flush is deferred, and an `onChange` that reads `e.target.value`
 * lazily (as the judge-model field does) would see the restored old value.
 */
async function type(element: HTMLInputElement, value: string) {
	await act(async () => {
		element.focus();
	});
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	try {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	} finally {
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	}
	await act(async () => {
		await Bun.sleep(0);
	});
}

/** Move focus off the field, as Tab or a click elsewhere does. */
async function leave(element: HTMLElement) {
	await act(async () => {
		element.blur();
	});
}

function writes() {
	return calls
		.filter((call) => call.method === "PUT")
		.map((call) => ({ body: call.body, status: call.status }));
}

async function settledWrites(count: number) {
	await until(
		() =>
			writes().length >= count &&
			writes().every((write) => write.status !== 0) &&
			!model().disabled,
		`${count} writes`
	);
}

function intervalError() {
	return container.querySelector("#quest-interval-error");
}

test("the judge model trims on leave, saves only the model, reloads, and a blank model restores the default", async () => {
	await mount();
	expect(model().value).toBe("");
	expect(model().placeholder).toBe("Using the system default…");

	await type(model(), "  local/quest-judge-v2  ");
	expect(writes()).toEqual([]);
	await leave(model());
	await settledWrites(1);
	expect(writes()).toEqual([
		{ body: { model: "local/quest-judge-v2" }, status: 200 },
	]);
	expect(await saved()).toEqual({ ...DEFAULTS, model: "local/quest-judge-v2" });

	await remount();
	expect(model().value).toBe("local/quest-judge-v2");
	expect(interval().value).toBe("2m");

	await type(model(), "   ");
	await leave(model());
	await settledWrites(1);
	expect(writes()).toEqual([{ body: { model: "" }, status: 200 }]);
	expect(await saved()).toEqual({ ...DEFAULTS });
	await remount();
	expect(model().value).toBe("");
	expect(model().placeholder).toBe("Using the system default…");
});

// 503 is a node that could not save; 429 and 408 ask the client to try again
// later. None of them refuses the value, so the change is kept for Retry save.
for (const transient of [503, 429, 408]) {
	test(`a model save that failed with ${transient} keeps the change, locks every field, and Retry save persists it`, async () => {
		await mount();
		refusals.push(transient);
		await type(model(), "local/judge-retry");
		await leave(model());
		await until(
			() =>
				container.textContent?.includes(
					"Couldn't save quest settings. Your change is still here."
				) === true,
			"save failure"
		);
		expect(model().value).toBe("local/judge-retry");
		expect(model().disabled).toBe(true);
		expect(interval().disabled).toBe(true);
		expect(await saved()).toEqual({ ...DEFAULTS });

		const retry = [...container.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Retry save"
		);
		if (!retry) {
			throw new Error("Missing Retry save");
		}
		await act(async () => retry.click());
		await settledWrites(2);
		expect(writes()).toEqual([
			{ body: { model: "local/judge-retry" }, status: transient },
			{ body: { model: "local/judge-retry" }, status: 200 },
		]);
		expect(container.textContent).not.toContain("Couldn't save quest settings");
		expect(interval().disabled).toBe(false);
		expect(await saved()).toEqual({ ...DEFAULTS, model: "local/judge-retry" });
	});
}

function button(label: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === label
	);
}

function editable() {
	return {
		effort:
			container.querySelector<HTMLButtonElement>("#quest-effort")?.disabled,
		interval: interval().disabled,
		mode: container.querySelector<HTMLButtonElement>("#quest-mode")?.disabled,
		model: model().disabled,
	};
}

const ALL_EDITABLE = {
	effort: false,
	interval: false,
	mode: false,
	model: false,
};
// humantime refuses this with NumberOverflow, so the node answers 400 even
// though the field's own grammar check accepts it.
const OVERFLOWING = "99999999999999999999s";
const OVERFLOW_REASON = `interval '${OVERFLOWING}' is not a valid duration (e.g. 2m)`;

function refusalAlert() {
	return container.querySelector("#quest-refusal");
}

/** Types and leaves an interval the node refuses; returns the write it made. */
async function refuseOverflowingInterval() {
	const before = writes().length;
	await type(interval(), OVERFLOWING);
	await leave(interval());
	// Settled either way: the refusal notice, or the locked Retry save state.
	await until(
		() =>
			writes().length === before + 1 &&
			writes().every((write) => write.status !== 0) &&
			(refusalAlert() !== null || button("Retry save") !== undefined),
		"refused interval write"
	);
	return writes().at(-1);
}

const REFUSED_WRITE = { body: { interval: OVERFLOWING }, status: 400 };

test("a node's 400 for an interval shows its reason, keeps every field editable, never resends it, and Discard change restores the saved interval", async () => {
	await mount();
	await type(interval(), "30s");
	await leave(interval());
	await settledWrites(1);
	calls.length = 0;

	expect(await refuseOverflowingInterval()).toEqual(REFUSED_WRITE);
	expect(refusalAlert()?.textContent).toBe(
		`The node refused this change: ${OVERFLOW_REASON}`
	);
	expect(refusalAlert()?.closest("[role=alert]")).not.toBeNull();
	expect(editable()).toEqual(ALL_EDITABLE);
	expect(interval().value).toBe(OVERFLOWING);
	expect(interval().getAttribute("aria-invalid")).toBe("true");
	expect(interval().getAttribute("aria-describedby")).toBe("quest-refusal");
	expect(button("Retry save")).toBeUndefined();
	expect(container.textContent).not.toContain("Couldn't save quest settings");
	expect(await saved()).toEqual({ ...DEFAULTS, interval: "30s" });

	// Leaving the refused value again does not send it again.
	await act(async () => interval().focus());
	await leave(interval());
	await act(async () => Bun.sleep(30));
	expect(writes()).toHaveLength(1);

	const discard = button("Discard change");
	if (!discard) {
		throw new Error("Missing Discard change");
	}
	await act(async () => discard.click());
	expect(interval().value).toBe("30s");
	expect(interval().getAttribute("aria-invalid")).toBe("false");
	expect(interval().getAttribute("aria-describedby")).toBeNull();
	expect(refusalAlert()).toBeNull();
	expect(button("Discard change")).toBeUndefined();
	await act(async () => Bun.sleep(30));
	expect(writes()).toHaveLength(1);
	expect(await saved()).toEqual({ ...DEFAULTS, interval: "30s" });

	await remount();
	expect(interval().value).toBe("30s");
	expect(refusalAlert()).toBeNull();
});

test("after a node's 400 the refusal survives an unrelated save, and a corrected interval saves and clears it", async () => {
	await mount();
	expect(await refuseOverflowingInterval()).toEqual(REFUSED_WRITE);

	await type(model(), "local/judge-after-refusal");
	await leave(model());
	await settledWrites(2);
	expect(writes()[1]).toEqual({
		body: { model: "local/judge-after-refusal" },
		status: 200,
	});
	expect(refusalAlert()?.textContent).toBe(
		`The node refused this change: ${OVERFLOW_REASON}`
	);
	expect(interval().value).toBe(OVERFLOWING);
	expect(interval().getAttribute("aria-invalid")).toBe("true");

	await type(interval(), "45s");
	await leave(interval());
	await settledWrites(3);
	expect(writes()[2]).toEqual({ body: { interval: "45s" }, status: 200 });
	expect(refusalAlert()).toBeNull();
	expect(interval().getAttribute("aria-invalid")).toBe("false");
	expect(editable()).toEqual(ALL_EDITABLE);
	expect(await saved()).toEqual({
		...DEFAULTS,
		interval: "45s",
		model: "local/judge-after-refusal",
	});

	await remount();
	expect(interval().value).toBe("45s");
	expect(model().value).toBe("local/judge-after-refusal");
});

test("two refused changes in a row both stay discardable: Discard change restores every refused field", async () => {
	await mount();
	expect(await refuseOverflowingInterval()).toEqual(REFUSED_WRITE);

	// The node also refuses the next edit, a different field.
	refusals.push(422);
	await type(model(), "local/refused-judge");
	await leave(model());
	await settledWrites(2);
	expect(writes()[1]).toEqual({
		body: { model: "local/refused-judge" },
		status: 422,
	});
	expect(refusalAlert()).not.toBeNull();
	expect(interval().getAttribute("aria-invalid")).toBe("true");

	const discard = button("Discard change");
	if (!discard) {
		throw new Error("Missing Discard change");
	}
	await act(async () => discard.click());
	// Neither value the node never stored is left on screen.
	expect(interval().value).toBe(DEFAULTS.interval);
	expect(model().value).toBe(DEFAULTS.model);
	expect(refusalAlert()).toBeNull();
	expect(writes()).toHaveLength(2);
	expect(await saved()).toEqual(DEFAULTS);
});

test("a node's 400 for the judge model is not sent again when the field is left again, and a different model still saves and clears it", async () => {
	await mount();
	refusals.push(400);
	await type(model(), "local/refused-judge");
	await leave(model());
	await until(
		() =>
			writes().length === 1 &&
			writes().every((write) => write.status !== 0) &&
			refusalAlert() !== null,
		"refused model write"
	);
	expect(writes()).toEqual([
		{ body: { model: "local/refused-judge" }, status: 400 },
	]);
	expect(refusalAlert()?.textContent).toBe(
		"The node refused this change: Quests coverage refusal"
	);
	expect(editable()).toEqual(ALL_EDITABLE);
	expect(model().value).toBe("local/refused-judge");

	// Leaving the refused value again does not send it again.
	await act(async () => model().focus());
	await leave(model());
	await act(async () => Bun.sleep(30));
	expect(writes()).toHaveLength(1);

	await type(model(), "local/accepted-judge");
	await leave(model());
	await settledWrites(2);
	expect(writes()[1]).toEqual({
		body: { model: "local/accepted-judge" },
		status: 200,
	});
	expect(refusalAlert()).toBeNull();
	expect(await saved()).toEqual({ ...DEFAULTS, model: "local/accepted-judge" });
});

test("restoring the model the node holds after a refusal saves it and clears the notice", async () => {
	await mount();
	await type(model(), "local/quest-judge-v2");
	await leave(model());
	await settledWrites(1);
	refusals.push(400);
	await type(model(), "local/refused-judge");
	await leave(model());
	await until(
		() =>
			writes().length === 2 &&
			writes().every((write) => write.status !== 0) &&
			refusalAlert() !== null,
		"refused model write"
	);

	await type(model(), "local/quest-judge-v2");
	await leave(model());
	await settledWrites(3);
	expect(writes()[2]).toEqual({
		body: { model: "local/quest-judge-v2" },
		status: 200,
	});
	expect(refusalAlert()).toBeNull();
	expect(await saved()).toEqual({ ...DEFAULTS, model: "local/quest-judge-v2" });
});

test("leaving the judge model without changing it sends nothing", async () => {
	await mount();
	await act(async () => model().focus());
	await leave(model());
	await act(async () => Bun.sleep(30));
	expect(writes()).toEqual([]);

	await type(model(), "local/quest-judge-v2");
	await leave(model());
	await settledWrites(1);
	await act(async () => model().focus());
	await leave(model());
	await act(async () => Bun.sleep(30));
	expect(writes()).toEqual([
		{ body: { model: "local/quest-judge-v2" }, status: 200 },
	]);
});

for (const accepted of [
	"90s",
	"2 minutes",
	"1h 30m",
	"1h30m",
	"3 hrs",
	"500 millis",
	"1 wk",
]) {
	test(`check interval "${accepted}" is accepted by the field and saved by the node`, async () => {
		await mount();
		await type(interval(), ` ${accepted} `);
		await leave(interval());
		await settledWrites(1);
		expect(intervalError()).toBeNull();
		expect(interval().getAttribute("aria-invalid")).toBe("false");
		expect(writes()).toEqual([{ body: { interval: accepted }, status: 200 }]);
		expect(await saved()).toEqual({ ...DEFAULTS, interval: accepted });
		expect(container.textContent).not.toContain("Couldn't save");

		await remount();
		expect(interval().value).toBe(accepted);
	});
}

for (const refused of [
	"500 milliseconds",
	"3 microseconds",
	"2H",
	"1 μs",
	"two minutes",
	"2m 30",
]) {
	test(`check interval "${refused}", which the node would refuse, is caught inline and never sent`, async () => {
		await mount();
		await type(interval(), refused);
		await leave(interval());
		await until(() => intervalError() !== null, "inline interval error");
		expect(intervalError()?.getAttribute("role")).toBe("alert");
		expect(intervalError()?.textContent).toBe(
			"Enter a valid duration such as 30s, 2m, or 1h."
		);
		expect(interval().getAttribute("aria-invalid")).toBe("true");
		expect(interval().getAttribute("aria-describedby")).toBe(
			"quest-interval-error"
		);
		expect(writes()).toEqual([]);
		// The field stays editable so the user can correct it.
		expect(interval().disabled).toBe(false);
		expect(model().disabled).toBe(false);

		await type(interval(), "45s");
		expect(intervalError()).toBeNull();
		await leave(interval());
		await settledWrites(1);
		expect(writes()).toEqual([{ body: { interval: "45s" }, status: 200 }]);
		expect(await saved()).toEqual({ ...DEFAULTS, interval: "45s" });
	});
}

test("an emptied interval falls back to 2m and a value equal to the saved one sends nothing", async () => {
	await mount();
	await type(interval(), "30s");
	await leave(interval());
	await settledWrites(1);
	expect(await saved()).toEqual({ ...DEFAULTS, interval: "30s" });

	await type(interval(), "   ");
	await leave(interval());
	await settledWrites(2);
	expect(interval().value).toBe("2m");
	expect(writes().at(-1)).toEqual({ body: { interval: "2m" }, status: 200 });
	expect(await saved()).toEqual({ ...DEFAULTS });

	await type(interval(), " 2m ");
	await leave(interval());
	await act(async () => Bun.sleep(30));
	expect(writes()).toHaveLength(2);
	expect(interval().value).toBe("2m");
});

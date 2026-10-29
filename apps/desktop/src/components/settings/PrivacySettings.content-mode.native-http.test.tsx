import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { sileo } from "sileo";
import { z } from "zod";
import type { Node } from "@/src/store/useNodeStore.ts";

// The REAL Privacy tab, its real preference SDK and its real test-span client
// against loopback Bun "Cores" that answer the OTLP content-mode preference and
// `POST /api/diagnostics/otlp/test-span` the way Core does. Nothing in the app is
// replaced: only the loopback origins are reachable, a node switch is a real
// node-store change, and the transport failure is a real connection refused from
// a Core that was stopped. A live OTLP collector round trip is not claimed here.
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
const nativeFetch = globalThis.fetch;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const ownedOrigins = new Set<string>();
const rejectedEgress: string[] = [];
let inFlight = 0;
const guardedFetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(new NativeRequest(input, init).url);
		if (!ownedOrigins.has(url.origin)) {
			rejectedEgress.push(url.href);
			throw new Error("Content-mode proof refuses unowned HTTP egress");
		}
		inFlight++;
		try {
			return await nativeFetch(input, init);
		} finally {
			inFlight--;
		}
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = guardedFetch;
window.fetch = guardedFetch;

const ipc: Array<{ args: unknown; command: string }> = [];
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: (command: string, args: unknown) => {
		ipc.push({ args, command });
		return Promise.resolve(null);
	},
	transformCallback: () => 0,
});

const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { PrivacySettings } = await import("./PrivacySettings.tsx");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { requestSettingReveal, clearSettingReveal } = await import(
	"@/src/lib/settings-focus.ts"
);
const { SETTINGS_ENTRIES } = await import("@/src/lib/settings-index.ts");
const {
	blur,
	button,
	choose,
	click,
	comboIn,
	fill,
	flush,
	input,
	isDisabled,
	isOn,
	maybeButton,
	maybeRow,
	row,
	shownValue,
	switchIn,
	toasts,
} = await import("./privacy-security.test-support.ts");

// ── Loopback Core fixture ──────────────────────────────────────────────────
const CONTENT_MODE_KEY = "diagnostics-otlp-content-mode";
const EXPORT_KEY = "diagnostics-export-enabled";
const ENDPOINT_KEY = "diagnostics-otlp-endpoint";
const COLLECTOR = "https://collector.example.test";
const WARNING_TEXT =
	"Your prompts, model responses, and tool data will leave this device";
const SPAN_FAILED = "Couldn't send the test span";
const MODE_FAILED = "Couldn't save the diagnostics content mode";
const NO_CONNECTION = "Check your connection and try again.";
const EXPORT_OFF_MESSAGE =
	"diagnostics export is off (or the endpoint changed; restart Core to apply it)";
const DEFAULT_PREFS = {
	"product-analytics-enabled": "true",
	"community-stats-enabled": "true",
	"crash-reports-enabled": "true",
	[EXPORT_KEY]: "false",
	[ENDPOINT_KEY]: "",
	[CONTENT_MODE_KEY]: "metadata_only",
	"support-access-local-enabled": "false",
	"support-access-local-expiry": "0",
};
const DEFAULT_HEALING = {
	auto_decide: false,
	cooldown_secs: 300,
	diagnose_effort: "low",
	diagnose_model: "fixture-model",
	enabled: true,
	max_attempts: 2,
};
const preferenceBody = z.object({ value: z.string() });
const ROUTE =
	/^\/(first|second)\/api\/(preferences\/([^/]+)|healing\/config|diagnostics\/otlp\/test-span)$/;

interface Call {
	body: unknown;
	key: string;
	method: string;
	node: string;
	token: string;
}
interface Gate {
	/** A JSON reply; `null` answers with an empty body. */
	body?: unknown;
	hold?: Promise<void>;
	key: string;
	method: string;
	node: string;
	status: number;
}
interface CoreState {
	prefs: Map<string, string>;
	tokens: Set<string>;
}
interface Fixture {
	node: Node;
	nodeKey: string;
}
const states = new Map<string, CoreState>();
let calls: Call[] = [];
let gates: Gate[] = [];
let releases: Array<() => void> = [];
let unexpected: string[] = [];

async function handle(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const route = ROUTE.exec(url.pathname);
	if (!route) {
		unexpected.push(`${request.method} ${url.pathname}`);
		return NativeResponse.json({ error: "Unknown route" }, { status: 404 });
	}
	const nodeKey = `${url.origin}/${route[1]}`;
	const state = states.get(nodeKey);
	const token = (request.headers.get("authorization") ?? "").replace(
		/^Bearer /,
		""
	);
	if (!(state?.tokens.has(token) && request.headers.get("x-ryu-user-jwt"))) {
		unexpected.push(`unauthenticated ${request.method} ${url.pathname}`);
		return NativeResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const key = route[3]
		? decodeURIComponent(route[3])
		: route[2].startsWith("healing")
			? "healing"
			: "test-span";
	const body = request.method === "GET" ? null : await readJson(request);
	calls.push({ body, key, method: request.method, node: nodeKey, token });
	const gate = gates.find(
		(candidate) =>
			candidate.node === nodeKey &&
			candidate.key === key &&
			candidate.method === request.method
	);
	if (gate) {
		gates = gates.filter((candidate) => candidate !== gate);
		await gate.hold;
		if (gate.body === null) {
			return new NativeResponse(null, { status: gate.status });
		}
		if (gate.body !== undefined) {
			return NativeResponse.json(gate.body, { status: gate.status });
		}
		if (gate.status !== 200) {
			return NativeResponse.json(
				{ error: "Fixture refusal" },
				{ status: gate.status }
			);
		}
	}
	if (key === "healing") {
		return NativeResponse.json(DEFAULT_HEALING);
	}
	if (key === "test-span") {
		return coreTestSpan(state);
	}
	if (request.method === "GET") {
		return NativeResponse.json({ key, value: state.prefs.get(key) ?? null });
	}
	const parsed = preferenceBody.safeParse(body);
	if (request.method !== "PUT" || !parsed.success) {
		unexpected.push(`bad preference ${request.method} ${key}`);
		return NativeResponse.json({ error: "Bad body" }, { status: 400 });
	}
	state.prefs.set(key, parsed.data.value);
	return NativeResponse.json({ ok: true });
}
async function readJson(request: Request): Promise<unknown> {
	const text = await request.text();
	return text ? JSON.parse(text) : null;
}
// Core's own gate (`send_test_span`): refuses while consent is off or no
// endpoint is active, otherwise answers the configured endpoint.
function coreTestSpan(state: CoreState): Response {
	if (state.prefs.get(EXPORT_KEY) !== "true") {
		return NativeResponse.json(
			{ ok: false, error: EXPORT_OFF_MESSAGE },
			{ status: 409 }
		);
	}
	const endpoint = (state.prefs.get(ENDPOINT_KEY) ?? "").trim();
	if (!endpoint) {
		return NativeResponse.json(
			{ ok: false, error: "no OTLP endpoint is configured" },
			{ status: 409 }
		);
	}
	return NativeResponse.json({ ok: true, span: "ryu.test", endpoint });
}

function startCore() {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
	ownedOrigins.add(server.url.origin);
	return server;
}
const server = startCore();

function fixture(
	origin: string,
	prefix: "first" | "second",
	token: string,
	userJwt: string,
	name: string
): Fixture {
	return {
		node: { name, token, url: `${origin}/${prefix}`, userJwt },
		nodeKey: `${origin}/${prefix}`,
	};
}
function registerState(nodeKey: string, tokens: string[], seed: object) {
	states.set(nodeKey, {
		prefs: new Map(Object.entries({ ...DEFAULT_PREFS, ...seed })),
		tokens: new Set(tokens),
	});
}
const first = fixture(
	server.url.origin,
	"first",
	"first-token",
	"first-jwt",
	"first"
);
// Same physical Core as `first`, a different credential.
const rotated = fixture(
	server.url.origin,
	"first",
	"rotated-token",
	"first-jwt",
	"rotated"
);
// A different Core (URL) with its own preferences.
const other = fixture(
	server.url.origin,
	"second",
	"second-token",
	"second-jwt",
	"other"
);
function resetStates(seedFirst: object = {}, seedOther: object = {}): void {
	states.clear();
	registerState(first.nodeKey, ["first-token", "rotated-token"], seedFirst);
	registerState(other.nodeKey, ["second-token"], seedOther);
}
const EXPORT_ON = { [EXPORT_KEY]: "true", [ENDPOINT_KEY]: COLLECTOR };

function stateOf(fx: Fixture): CoreState {
	const state = states.get(fx.nodeKey);
	if (!state) {
		throw new Error(`No fixture state for ${fx.nodeKey}`);
	}
	return state;
}
function stored(fx: Fixture, key: string): string | undefined {
	return stateOf(fx).prefs.get(key);
}
function writes(fx: Fixture) {
	return calls
		.filter((call) => call.node === fx.nodeKey && call.method !== "GET")
		.filter((call) => call.key !== "test-span")
		.map((call) => ({ body: call.body, key: call.key }));
}
function spans(fx: Fixture) {
	return calls.filter(
		(call) => call.node === fx.nodeKey && call.key === "test-span"
	);
}
function reads(fx: Fixture, key: string) {
	return calls.filter(
		(call) =>
			call.node === fx.nodeKey && call.method === "GET" && call.key === key
	).length;
}
/** Answer the next matching request, after `release()` when it is held. */
function plan(
	fx: Fixture,
	method: string,
	key: string,
	options: { body?: unknown; held?: boolean; status?: number } = {}
): () => void {
	let release: () => void = () => undefined;
	const hold = options.held
		? new Promise<void>((resolve) => {
				release = () => resolve();
			})
		: undefined;
	gates.push({
		body: options.body,
		hold,
		key,
		method,
		node: fx.nodeKey,
		status: options.status ?? 200,
	});
	releases.push(release);
	return release;
}

let root: Root | null = null;
const savedNodeState = useNodeStore.getState();

function selectNode(node: Node) {
	useNodeStore.setState({
		nodes: [node],
		localNodes: [],
		defaultNode: node.name,
		autoSelect: false,
	});
}
async function render() {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<>
				<PrivacySettings />
				<Toaster />
			</>
		)
	);
}
const DIAGNOSTICS_PAGE = "Diagnostics & support";
async function openDiagnostics() {
	await click(button(DIAGNOSTICS_PAGE));
	await waitFor(
		() => maybeRow("Content mode") !== null,
		"Diagnostics & support page"
	);
}
async function waitReady(fx: Fixture, expiryBefore: number) {
	await waitFor(
		() => reads(fx, "support-access-local-expiry") > expiryBefore,
		"privacy preference reads"
	);
	await flush();
}
/** Mount on `fx`, wait for its privacy reads, and open Diagnostics & support. */
async function mount(fx: Fixture = first) {
	selectNode(fx.node);
	const before = reads(fx, "support-access-local-expiry");
	await render();
	await waitReady(fx, before);
	await openDiagnostics();
}
async function unmount() {
	for (const release of releases) {
		release();
	}
	releases = [];
	await waitFor(() => inFlight === 0, "content-mode HTTP drained");
	if (root) {
		const current = root;
		await act(async () => current.unmount());
		root = null;
	}
	document.body.replaceChildren();
}
async function switchTo(fx: Fixture) {
	await act(async () => selectNode(fx.node));
	await flush(4);
}

const contentMode = () => comboIn("Content mode");
const testButton = () => {
	const found = row("Test destination").querySelector("button");
	if (!found) {
		throw new Error("Missing the Test destination button");
	}
	return found;
};
const testLabel = () => (testButton().textContent ?? "").trim();
const warningShown = () => toasts().includes(WARNING_TEXT);
const exportSwitch = () => switchIn("Export local diagnostics over OTLP");
const endpointInput = () => input('input[aria-label="OTLP endpoint"]');
// Fails inside the test's own 5 s budget: a loop that outlived the timeout would
// keep driving `act` into the next case and turn one failure into many.
async function waitFor(predicate: () => boolean, label: string) {
	const deadline = Date.now() + 2500;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error(
				`${label} did not settle: ${calls.length} Core calls, last ${JSON.stringify(calls.at(-1))}; ${toasts().slice(-260)}`
			);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

beforeEach(() => {
	sileo.clear();
	calls = [];
	gates = [];
	releases = [];
	unexpected = [];
	ipc.length = 0;
	localStorage.clear();
	resetStates();
});
afterEach(async () => {
	clearSettingReveal();
	await unmount();
	sileo.clear();
	useNodeStore.setState(savedNodeState);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must keep to the owned Core contract.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must refuse foreign egress.
	expect(rejectedEgress).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

// ── Content mode ───────────────────────────────────────────────────────────
test("Content mode defaults to Metadata only, is named by its aria-label, and choosing Full content issues exactly one content write and the warning", async () => {
	stateOf(first).prefs.delete(CONTENT_MODE_KEY);
	await mount();
	expect(contentMode().getAttribute("aria-label")).toBe("Content mode");
	expect(shownValue(contentMode())).toContain("Metadata only");
	expect(warningShown()).toBe(false);
	expect(isDisabled(contentMode())).toBe(false);

	const offered = await choose(contentMode(), "Full content");
	expect(offered).toEqual(["Metadata only", "Full content"]);
	await waitFor(() => writes(first).length === 1, "content-mode write");
	expect(writes(first)).toEqual([
		{ body: { value: "content" }, key: CONTENT_MODE_KEY },
	]);
	expect(stored(first, CONTENT_MODE_KEY)).toBe("content");
	expect(shownValue(contentMode())).toContain("Full content");
	expect(warningShown()).toBe(true);
	// Content mode is its own consent: it never turns export on.
	expect(isOn(exportSwitch())).toBe(false);
	expect(stored(first, EXPORT_KEY)).toBe("false");
	await flush();
	expect(writes(first)).toHaveLength(1);
});

test("a refused content-mode write reverts the select to Metadata only, clears the warning and toasts the failure", async () => {
	await mount();
	plan(first, "PUT", CONTENT_MODE_KEY, { status: 503 });
	await choose(contentMode(), "Full content");
	await waitFor(() => toasts().includes(MODE_FAILED), "refusal toast");
	await waitFor(
		() => shownValue(contentMode()).includes("Metadata only"),
		"revert to Metadata only"
	);
	expect(warningShown()).toBe(false);
	expect(writes(first)).toEqual([
		{ body: { value: "content" }, key: CONTENT_MODE_KEY },
	]);
	expect(stored(first, CONTENT_MODE_KEY)).toBe("metadata_only");
	expect(isDisabled(contentMode())).toBe(false);
});

test("a refused switch back to Metadata only keeps Full content and its warning", async () => {
	resetStates({ [CONTENT_MODE_KEY]: "content" });
	await mount();
	expect(shownValue(contentMode())).toContain("Full content");
	expect(warningShown()).toBe(true);
	plan(first, "PUT", CONTENT_MODE_KEY, { status: 503 });
	await choose(contentMode(), "Metadata only");
	await waitFor(() => toasts().includes(MODE_FAILED), "refusal toast");
	await waitFor(
		() => shownValue(contentMode()).includes("Full content"),
		"revert to Full content"
	);
	expect(writes(first)).toEqual([
		{ body: { value: "metadata_only" }, key: CONTENT_MODE_KEY },
	]);
	expect(warningShown()).toBe(true);
	expect(stored(first, CONTENT_MODE_KEY)).toBe("content");
});

test("an unreachable Core reverts the content mode and asks the user to check the connection", async () => {
	const flaky = startCore();
	const lost = fixture(
		flaky.url.origin,
		"first",
		"lost-token",
		"lost-jwt",
		"lost"
	);
	registerState(lost.nodeKey, ["lost-token"], {});
	try {
		await mount(lost);
		flaky.stop(true);
		await choose(contentMode(), "Full content");
		await waitFor(() => toasts().includes(MODE_FAILED), "transport toast");
		expect(toasts()).toContain(NO_CONNECTION);
		await waitFor(
			() => shownValue(contentMode()).includes("Metadata only"),
			"revert after a transport failure"
		);
		expect(warningShown()).toBe(false);
		expect(isDisabled(contentMode())).toBe(false);
	} finally {
		flaky.stop(true);
	}
});

test("the content-mode select is disabled until privacy is ready and while its own write is in flight", async () => {
	const releaseLoad = plan(first, "GET", CONTENT_MODE_KEY, { held: true });
	selectNode(first.node);
	await render();
	await openDiagnostics();
	await waitFor(
		() => reads(first, CONTENT_MODE_KEY) === 1,
		"held content-mode read"
	);
	expect(isDisabled(contentMode())).toBe(true);
	expect(isDisabled(exportSwitch())).toBe(true);
	await click(contentMode());
	expect(writes(first)).toEqual([]);

	releaseLoad();
	await waitFor(() => !isDisabled(contentMode()), "ready");
	const releaseWrite = plan(first, "PUT", CONTENT_MODE_KEY, { held: true });
	await choose(contentMode(), "Full content");
	await waitFor(() => writes(first).length === 1, "held write arrived");
	expect(isDisabled(contentMode())).toBe(true);
	expect(stored(first, CONTENT_MODE_KEY)).toBe("metadata_only");
	releaseWrite();
	await waitFor(() => !isDisabled(contentMode()), "write settled");
	expect(shownValue(contentMode())).toContain("Full content");
	expect(stored(first, CONTENT_MODE_KEY)).toBe("content");
	expect(writes(first)).toHaveLength(1);
});

for (const variant of [
	{ label: "another Core", next: other, sameCore: false },
	{
		label: "a rotated credential on the same Core",
		next: rotated,
		sameCore: true,
	},
]) {
	test(`a held content-mode write that lands after a switch to ${variant.label} does not touch the new node`, async () => {
		resetStates({}, { [CONTENT_MODE_KEY]: "metadata_only" });
		await mount();
		const release = plan(first, "PUT", CONTENT_MODE_KEY, { held: true });
		await choose(contentMode(), "Full content");
		await waitFor(() => writes(first).length === 1, "held write arrived");
		const contentReadsBefore = reads(variant.next, CONTENT_MODE_KEY);
		await switchTo(variant.next);
		if (variant.sameCore) {
			// The same physical Core waits for the held write before it re-reads.
			expect(reads(variant.next, CONTENT_MODE_KEY)).toBe(contentReadsBefore);
			expect(isDisabled(contentMode())).toBe(true);
		} else {
			await waitFor(
				() => shownValue(contentMode()).includes("Metadata only"),
				"the other Core's own value"
			);
		}
		release();
		await flush(10);
		await waitFor(() => !isDisabled(contentMode()), "new node ready");
		// A write that succeeded on the old identity is not applied to the new one.
		expect(toasts()).not.toContain(MODE_FAILED);
		expect(shownValue(contentMode())).toContain(
			variant.sameCore ? "Full content" : "Metadata only"
		);
		expect(warningShown()).toBe(variant.sameCore);
		expect(stored(first, CONTENT_MODE_KEY)).toBe("content");
		expect(writes(other)).toEqual([]);
		expect(writes(first)).toHaveLength(1);
	});

	test(`a refused content-mode write that fails after a switch to ${variant.label} neither reverts nor toasts on the new node`, async () => {
		resetStates({}, { [CONTENT_MODE_KEY]: "content" });
		await mount();
		const release = plan(first, "PUT", CONTENT_MODE_KEY, {
			held: true,
			status: 503,
		});
		await choose(contentMode(), "Full content");
		await waitFor(() => writes(first).length === 1, "held write arrived");
		await switchTo(variant.next);
		if (!variant.sameCore) {
			await waitFor(
				() => !isDisabled(contentMode()),
				"the other Core finished loading"
			);
			expect(shownValue(contentMode())).toContain("Full content");
			expect(warningShown()).toBe(true);
		}
		release();
		await flush(10);
		await waitFor(() => !isDisabled(contentMode()), "new node ready");
		expect(toasts()).not.toContain(MODE_FAILED);
		// The other Core stored Full content; the same Core kept Metadata only.
		expect(shownValue(contentMode())).toContain(
			variant.sameCore ? "Metadata only" : "Full content"
		);
		expect(warningShown()).toBe(!variant.sameCore);
		expect(stored(first, CONTENT_MODE_KEY)).toBe("metadata_only");
		expect(stored(other, CONTENT_MODE_KEY)).toBe("content");
		expect(writes(other)).toEqual([]);
	});
}

// ── Send test span ─────────────────────────────────────────────────────────
test("Send test span is enabled only with export on and a non-blank endpoint, and a disabled click sends nothing", async () => {
	resetStates({ [ENDPOINT_KEY]: COLLECTOR });
	await mount();
	expect(testLabel()).toBe("Send test span");
	expect(isOn(exportSwitch())).toBe(false);
	expect(endpointInput().value).toBe(COLLECTOR);
	expect(isDisabled(testButton())).toBe(true);
	await click(testButton());
	expect(spans(first)).toEqual([]);

	await click(exportSwitch());
	await waitFor(() => stored(first, EXPORT_KEY) === "true", "export saved");
	await waitFor(() => !isDisabled(testButton()), "enabled with export on");

	await fill(endpointInput(), "");
	await flush(2);
	expect(isDisabled(testButton())).toBe(true);
	await fill(endpointInput(), "   ");
	await flush(2);
	expect(isDisabled(testButton())).toBe(true);
	await click(testButton());
	expect(spans(first)).toEqual([]);

	await fill(endpointInput(), COLLECTOR);
	await flush(2);
	expect(isDisabled(testButton())).toBe(false);
	await blur(endpointInput());

	await click(exportSwitch());
	await waitFor(() => stored(first, EXPORT_KEY) === "false", "export off");
	expect(isDisabled(testButton())).toBe(true);
	expect(spans(first)).toEqual([]);
});

test("a successful test span posts once with the node's credential, names the endpoint Core answered and writes no preference", async () => {
	resetStates(EXPORT_ON);
	await mount();
	expect(isDisabled(testButton())).toBe(false);
	plan(first, "POST", "test-span", {
		body: {
			ok: true,
			span: "ryu.test",
			endpoint: "https://reply.example.test",
		},
	});
	await click(testButton());
	await waitFor(() => toasts().includes("Test span sent"), "success toast");
	expect(toasts()).toContain("https://reply.example.test");
	expect(toasts()).toContain("Look for a ryu.test span at");
	expect(toasts()).not.toContain(SPAN_FAILED);
	expect(spans(first).map((call) => [call.method, call.token])).toEqual([
		["POST", "first-token"],
	]);
	expect(writes(first)).toEqual([]);
	expect(testLabel()).toBe("Send test span");
	expect(isDisabled(testButton())).toBe(false);
});

test("Core's own answer to a configured destination is shown as the sent endpoint", async () => {
	resetStates(EXPORT_ON);
	await mount();
	await click(testButton());
	await waitFor(() => toasts().includes("Test span sent"), "success toast");
	expect(toasts()).toContain(COLLECTOR);
	expect(spans(first)).toHaveLength(1);
});

test("a Core refusal, a flush failure, an old Core and an unexpected status each show their own message and leave the button usable", async () => {
	resetStates(EXPORT_ON);
	await mount();
	const cases = [
		{
			body: { ok: false, error: EXPORT_OFF_MESSAGE },
			message: EXPORT_OFF_MESSAGE,
			status: 409,
		},
		{
			body: {
				ok: false,
				error: "export to the OTLP endpoint failed: connection refused",
			},
			message: "export to the OTLP endpoint failed: connection refused",
			status: 502,
		},
		{
			body: null,
			message: "This Core is too old to send a test span.",
			status: 404,
		},
		{ body: null, message: "Core answered 500.", status: 500 },
	];
	for (const [index, expected] of cases.entries()) {
		plan(first, "POST", "test-span", {
			body: expected.body,
			status: expected.status,
		});
		await click(testButton());
		await waitFor(
			() => toasts().includes(expected.message),
			`toast for ${expected.status}`
		);
		expect(toasts()).toContain(SPAN_FAILED);
		expect(toasts()).not.toContain("Test span sent");
		expect(spans(first)).toHaveLength(index + 1);
		// The busy flag cleared, so the next click can send.
		await waitFor(
			() => testLabel() === "Send test span" && !isDisabled(testButton()),
			`button usable after ${expected.status}`
		);
	}
	expect(writes(first)).toEqual([]);
});

test("an unreachable Core shows the connection hint and the button becomes usable again", async () => {
	const flaky = startCore();
	const lost = fixture(
		flaky.url.origin,
		"first",
		"lost-token",
		"lost-jwt",
		"lost"
	);
	registerState(lost.nodeKey, ["lost-token"], EXPORT_ON);
	try {
		await mount(lost);
		expect(isDisabled(testButton())).toBe(false);
		flaky.stop(true);
		await click(testButton());
		await waitFor(() => toasts().includes(NO_CONNECTION), "transport toast");
		expect(toasts()).toContain(SPAN_FAILED);
		expect(toasts()).not.toContain("Test span sent");
		await waitFor(
			() => testLabel() === "Send test span" && !isDisabled(testButton()),
			"button usable after a transport failure"
		);
	} finally {
		flaky.stop(true);
	}
});

test("while a test span is in flight the label reads Sending…, the button is disabled and a double click sends one request, then the busy flag clears", async () => {
	resetStates(EXPORT_ON);
	await mount();
	const release = plan(first, "POST", "test-span", { held: true });
	await click(testButton());
	await waitFor(() => spans(first).length === 1, "held request arrived");
	expect(testLabel()).toBe("Sending…");
	expect(isDisabled(testButton())).toBe(true);
	await click(testButton());
	await click(testButton());
	await flush(4);
	expect(spans(first)).toHaveLength(1);
	expect(toasts()).not.toContain("Test span sent");

	release();
	await waitFor(() => toasts().includes("Test span sent"), "success toast");
	await waitFor(() => testLabel() === "Send test span", "label restored");
	expect(isDisabled(testButton())).toBe(false);
	await click(testButton());
	await waitFor(() => spans(first).length === 2, "second send");
});

test("a test span that returns after a switch shows no toast, frees the button and is not sent for the new node; the new node stays disabled until it is ready", async () => {
	resetStates(EXPORT_ON, {
		[ENDPOINT_KEY]: "https://other.example.test",
		[EXPORT_KEY]: "true",
	});
	await mount();
	const releaseSpan = plan(first, "POST", "test-span", { held: true });
	await click(testButton());
	await waitFor(() => spans(first).length === 1, "held request arrived");
	expect(testLabel()).toBe("Sending…");

	// The new node's reads are held, so privacy is not ready for it yet while the
	// previous node's export and endpoint choices are still on screen.
	const releaseLoad = plan(other, "GET", CONTENT_MODE_KEY, { held: true });
	await switchTo(other);
	await waitFor(() => reads(other, CONTENT_MODE_KEY) === 1, "held read");
	releaseSpan();
	await flush(10);
	expect(toasts()).not.toContain("Test span sent");
	expect(toasts()).not.toContain(SPAN_FAILED);
	expect(testLabel()).toBe("Send test span");
	expect(isDisabled(testButton())).toBe(true);
	await click(testButton());
	expect(spans(first)).toHaveLength(1);
	expect(spans(other)).toEqual([]);

	releaseLoad();
	await waitFor(() => !isDisabled(testButton()), "new node ready");
	await click(testButton());
	await waitFor(() => spans(other).length === 1, "send on the new node");
	await waitFor(() => toasts().includes("Test span sent"), "success toast");
	expect(toasts()).toContain("https://other.example.test");
	expect(spans(other).map((call) => call.token)).toEqual(["second-token"]);
});

// ── Settings search ────────────────────────────────────────────────────────
for (const id of [
	"gw.privacy.diagnostics-export.content-mode",
	"gw.privacy.diagnostics-export.test-destination",
]) {
	test(`a settings-search reveal of ${id} opens Diagnostics & support and shows the row`, async () => {
		const entry = SETTINGS_ENTRIES.find((candidate) => candidate.id === id);
		if (!entry) {
			throw new Error(`Missing indexed entry ${id}`);
		}
		selectNode(first.node);
		const before = reads(first, "support-access-local-expiry");
		requestSettingReveal(entry);
		await render();
		await waitReady(first, before);
		await waitFor(
			() => maybeRow(entry.label) !== null,
			`search reveal opened the page holding ${entry.label}`
		);
		const headings = [...document.querySelectorAll("h3")].map(
			(heading) => heading.textContent
		);
		expect(headings).toContain(DIAGNOSTICS_PAGE);
		expect(maybeRow("Content mode")).not.toBeNull();
		expect(maybeRow("Test destination")).not.toBeNull();
		expect(maybeButton("Send test span")).not.toBeNull();
	});
}

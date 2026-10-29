import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
// Only tab-selection boundaries are controlled. The real Zustand node resolver,
// production controls, typed preference SDK, HTTP client and fetch remain live.
let tabId: string | undefined;
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	useCurrentTabId: () => tabId,
}));
mock.module("@/src/hooks/useNodeDisplayMode.ts", () => ({
	useNodeTabOverride: () => true,
}));
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { VoiceInputSettings } = await import("./VoiceInputSettings.tsx");
const { VoiceReadbackSettings } = await import("./VoiceReadbackSettings.tsx");
const initialStore = useNodeStore.getState();
type Kind = "voice-input" | "voice-mode-readback";
type InputPrefs = {
	enabled: boolean;
	engine: string;
	mode: string;
	model: string;
	shortcut: string;
};
type Prefs = InputPrefs | { enabled: boolean };
type Authority = { name: string; url: string; token: string; userJwt: string };
interface Call {
	slot: string;
	key: Kind;
	method: string;
	authorization: string | null;
	jwt: string | null;
	body: unknown;
	completed: boolean;
	status: number;
}
let authorities: Record<string, Authority>;
let saved: Record<string, Record<Kind, Prefs | null>>;
let statuses: Record<string, number>;
let held: { slot: string; method: string } | undefined;
let release: (() => void) | undefined;
const calls: Call[] = [];
const consumed: Array<{
	url: string;
	method: string;
	authorization: string | null;
	jwt: string | null;
}> = [];
// Observe the real client's native Response.text consumption without replacing
// its result or Promise. Server response completion alone is not a UI barrier.
globalThis.fetch = Object.assign(
	async (...args: Parameters<typeof nativeFetch>) => {
		const [input, init] = args;
		const request = new NativeRequest(input, init);
		const response = await nativeFetch(input, init);
		const read = response.text.bind(response);
		response.text = () => {
			const pending = read();
			void pending.then(
				() =>
					consumed.push({
						url: request.url,
						method: request.method,
						authorization: request.headers.get("authorization"),
						jwt: request.headers.get("x-ryu-user-jwt"),
					}),
				() => {}
			);
			return pending;
		};
		return response;
	},
	{ preconnect: nativeFetch.preconnect.bind(nativeFetch) }
);
const unexpected: string[] = [];
const server: Bun.Server<undefined> = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request: Request): Promise<Response> => {
		const path = new URL(request.url).pathname;
		const match =
			/^\/(A|B|C)\/api\/(preferences\/(voice-input|voice-mode-readback)|sidecar\/status)$/.exec(
				path
			);
		const origin = server.url.origin;
		const slot = Object.keys(authorities).find((key) => {
			const a = authorities[key]!;
			return (
				a.url === origin + "/" + match?.[1] &&
				request.headers.get("authorization") === "Bearer " + a.token &&
				request.headers.get("x-ryu-user-jwt") === a.userJwt
			);
		});
		if (
			!match ||
			!slot ||
			!["GET", "PUT"].includes(request.method) ||
			(match[2] === "sidecar/status" && request.method !== "GET")
		) {
			unexpected.push(request.method + " " + path);
			return NativeResponse.json(
				{ error: "Unexpected authority or route" },
				{ status: 503 }
			);
		}
		if (match[2] === "sidecar/status")
			return NativeResponse.json({ sidecars: [] });
		const key = match[3] as Kind;
		const body: unknown =
			request.method === "PUT" ? await request.json() : null;
		const call: Call = {
			slot,
			key,
			method: request.method,
			authorization: request.headers.get("authorization"),
			jwt: request.headers.get("x-ryu-user-jwt"),
			body,
			completed: false,
			status: 0,
		};
		calls.push(call);
		const snapshot = structuredClone(saved[slot]![key]);
		const status = statuses[slot + ":" + request.method] ?? 200;
		const pendingRequest = held;
		if (pendingRequest?.slot === slot && pendingRequest.method === request.method)
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		call.status = status;
		call.completed = true;
		if (status !== 200)
			return NativeResponse.json(
				{ error: "Voice preference refused" },
				{ status }
			);
		if (request.method === "PUT") {
			const value = (body as { value?: unknown }).value;
			if (
				typeof value !== "string" ||
				Object.keys(body as object).join() !== "value"
			) {
				unexpected.push("Invalid preference body");
				return NativeResponse.json({ error: "Invalid body" }, { status: 400 });
			}
			saved[slot]![key] = JSON.parse(value);
		}
		return NativeResponse.json({
			key,
			value: JSON.stringify(
				request.method === "GET" ? snapshot : saved[slot]![key]
			),
		});
	},
});
const authority = (
	name: string,
	path = name,
	token = name + "-token",
	jwt = name + "-jwt"
): Authority => ({
	name,
	url: server.url.origin + "/" + path,
	token,
	userJwt: jwt,
});
const input = (slot: string): InputPrefs => ({
	enabled: slot !== "A",
	engine: slot === "A" ? "whisper" : "audiocpp",
	mode: slot === "A" ? "push-to-talk" : "toggle",
	model: slot === "A" ? "ggml-base.en" : "parakeet-tdt-0.6b-v3-q8_0",
	shortcut: slot === "A" ? "F6" : "F7",
});
let root: Root | undefined;
let container: HTMLDivElement;
let kind: Kind;
beforeEach(() => {
	authorities = {
		A: authority("A"),
		B: authority("B"),
		url: authority("A", "C"),
		token: authority("A", "A", "A-new-token", "A-jwt"),
		jwt: authority("A", "A", "A-token", "A-new-jwt"),
	};
	saved = Object.fromEntries(
		Object.keys(authorities).map((slot) => [
			slot,
			{
				"voice-input": input(slot),
				"voice-mode-readback": { enabled: slot !== "A" },
			},
		])
	);
	statuses = {};
	held = undefined;
	release = undefined;
	tabId = undefined;
	calls.length = unexpected.length = consumed.length = 0;
	useNodeStore.setState({
		nodes: [authorities.A!, authorities.B!],
		defaultNode: "A",
		tabOverrides: {},
		autoSelect: false,
		autoSelectedNode: null,
	});
	container = document.createElement("div");
	document.body.append(container);
});
afterEach(async () => {
	held = undefined;
	release?.();
	await act(async () => root?.unmount());
	root = undefined;
	container.remove();
	useNodeStore.setState(initialStore, true);
	expect(unexpected).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	mock.restore();
	globalThis.fetch = nativeFetch;
});
async function until(predicate: () => boolean) {
	for (let i = 0; i < 120; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
		if (predicate()) return;
	}
	throw new Error(
		"Production voice state did not settle: " + container.textContent
	);
}
async function render(next: Kind) {
	kind = next;
	root ??= createRoot(container);
	await act(async () =>
		root!.render(
			next === "voice-input" ? (
				<VoiceInputSettings />
			) : (
				<VoiceReadbackSettings />
			)
		)
	);
}
const received = (slot: string, method = "GET") =>
	consumed.filter(
		(c) =>
			c.url === authorities[slot]!.url + "/api/preferences/" + kind &&
			c.method === method &&
			c.authorization === "Bearer " + authorities[slot]!.token &&
			c.jwt === authorities[slot]!.userJwt
	);
async function initialA() {
	await until(
		() =>
			received("A").length > 0 &&
			!disabled() &&
			state() === (kind === "voice-input" ? "Whisper" : false)
	);
}
const reads = (slot: string) =>
	calls.filter((c) => c.slot === slot && c.key === kind && c.method === "GET");
const writes = () => calls.filter((c) => c.key === kind && c.method === "PUT");
function control(): HTMLElement {
	const found = container.querySelector<HTMLElement>(
		kind === "voice-input" ? '[role="combobox"]' : '[role="switch"]'
	);
	if (!found) throw Error("Missing production control");
	return found;
}
function disabled(): boolean {
	return (
		control().hasAttribute("disabled") ||
		control().getAttribute("aria-disabled") === "true"
	);
}
function state(): string | boolean {
	return kind === "voice-input"
		? control().querySelector('[data-slot="select-value"]')!.textContent!.trim()
		: control().getAttribute("aria-checked") === "true";
}
async function edit() {
	if (kind === "voice-mode-readback") {
		await act(async () => control().click());
		return;
	}
	await act(async () => control().click());
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((el) => el.textContent?.trim() === "Cloud (via gateway)");
	if (!option)
		throw Error(
			"Missing real Gateway engine option: " + document.body.textContent
		);
	await act(async () => option.click());
}
async function switchAuthority(slot: string) {
	await act(async () =>
		useNodeStore.setState({
			nodes: [authorities[slot]!, authorities.B!],
			defaultNode: authorities[slot]!.name,
		})
	);
	// Mirrors unkeyed parent rerender; never explicitly remount either control.
	await render(kind);
}
for (const next of ["voice-input", "voice-mode-readback"] as const) {
	test(`${next}: same-authority edit reaches authenticated HTTP and saved readback`, async () => {
		await render(next);
		await initialA();
		expect(state()).toBe(next === "voice-input" ? "Whisper" : false);
		await edit();
		await until(() => writes().some((c) => c.completed));
		const expected =
			next === "voice-input"
				? { ...input("A"), engine: "gateway", model: "" }
				: { enabled: true };
		expect(writes()).toEqual([
			expect.objectContaining({
				slot: "A",
				authorization: "Bearer A-token",
				jwt: "A-jwt",
				body: { value: JSON.stringify(expected) },
			}),
		]);
		expect(saved.A![next]).toEqual(expected);
		await act(async () => root!.unmount());
		root = undefined;
		await render(next);
		await until(
			() =>
				received("A").length === 2 &&
				state() === (next === "voice-input" ? "Cloud (via gateway)" : true)
		);
		expect(state()).toBe(next === "voice-input" ? "Cloud (via gateway)" : true);
		expect(writes()).toHaveLength(1);
	});
	test(`${next}: without secure-context randomUUID, mounting and authority handoff use the selected node's saved policy`, async () => {
		const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
		Object.defineProperty(crypto, "randomUUID", {
			configurable: true,
			value: undefined,
		});
		try {
			await render(next);
			await initialA();
			await switchAuthority("B");
			await until(() => received("B").length === 1 && !disabled());
			expect(state()).toBe(next === "voice-input" ? "audio.cpp" : true);
			expect(reads("B")[0]).toMatchObject({
				authorization: "Bearer B-token",
				jwt: "B-jwt",
			});
			expect(writes()).toHaveLength(0);
			expect(saved.B![next]).toEqual(
				next === "voice-input" ? input("B") : { enabled: true }
			);
		} finally {
			if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
			else Reflect.deleteProperty(crypto, "randomUUID");
		}
	});

	test(`${next}: equivalent URL/token/JWT with renamed display metadata does not refetch or reset saved state`, async () => {
		await render(next);
		await initialA();
		const equivalent = { ...authorities.A!, name: "Renamed display" };
		await act(async () =>
			useNodeStore.setState({
				nodes: [equivalent, authorities.B!],
				defaultNode: equivalent.name,
			})
		);
		await render(next);
		await edit();
		await until(() => writes().some((c) => c.completed));
		expect(reads("A")).toHaveLength(1);
		const expected =
			next === "voice-input"
				? { ...input("A"), engine: "gateway", model: "" }
				: { enabled: true };
		expect(saved.A![next]).toEqual(expected);
		expect(writes()).toHaveLength(1);
	});

	test(`${next}: genuinely unset 404 preference permits canonical defaults without an automatic write`, async () => {
		statuses["A:GET"] = 404;
		saved.A![next] = null;
		await render(next);
		await until(() => received("A").length > 0);
		expect(disabled()).toBe(false);
		expect(state()).toBe(next === "voice-input" ? "Parakeet v3" : false);
		expect(writes()).toHaveLength(0);
		expect(saved.A![next]).toBeNull();
	});
	test(`${next}: pending initial GET cannot send a default-based PUT before saved preference is known`, async () => {
		held = { slot: "A", method: "GET" };
		await render(next);
		await until(() => !!release);
		await act(async () => control().click());
		if (next === "voice-input") {
			const option = [
				...document.querySelectorAll<HTMLElement>('[role="option"]'),
			].find((el) => el.textContent?.trim() === "Cloud (via gateway)");
			if (option) await act(async () => option.click());
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		expect(writes()).toHaveLength(0);
		expect(saved.A![next]).toEqual(
			next === "voice-input" ? input("A") : { enabled: false }
		);
		held = undefined;
		await act(async () => release?.());
		await until(() => received("A").length > 0);
		expect(disabled()).toBe(false);
		expect(state()).toBe(next === "voice-input" ? "Whisper" : false);
	});
	test(`${next}: initial per-tab B authority reads B using its exact token/JWT, leaving global A untouched`, async () => {
		tabId = "settings-tab";
		useNodeStore.setState({ tabOverrides: { "settings-tab": "B" } });
		await render(next);
		await until(
			() => received("A").length + received("B").length > 0 && !disabled()
		);
		expect(reads("B")).toHaveLength(1);
		expect(reads("A")).toHaveLength(0);
		expect(reads("B")[0]).toMatchObject({
			authorization: "Bearer B-token",
			jwt: "B-jwt",
		});
		expect(state()).toBe(next === "voice-input" ? "audio.cpp" : true);
	});
	test(`${next}: selecting B while mounted loads its saved preference before editing and preserves B's complete policy`, async () => {
		await render(next);
		await initialA();
		await switchAuthority("B");
		await until(() => !disabled());
		await edit();
		await until(() => writes().some((c) => c.completed));
		const expected =
			next === "voice-input"
				? { ...input("B"), engine: "gateway", model: "" }
				: { enabled: false };
		expect(writes()).toEqual([
			expect.objectContaining({
				slot: "B",
				authorization: "Bearer B-token",
				jwt: "B-jwt",
				body: { value: JSON.stringify(expected) },
			}),
		]);
		expect(saved.B![next]).toEqual(expected);
		expect(saved.A![next]).toEqual(
			next === "voice-input" ? input("A") : { enabled: false }
		);
	});
	for (const slot of ["url", "token", "jwt"] as const)
		test(`${next}: ${slot} rotation is a distinct saved authority, with no stale A preference`, async () => {
			await render(next);
			await initialA();
			await switchAuthority(slot);
			await until(
				() =>
					received(slot).length > 0 &&
					state() === (next === "voice-input" ? "audio.cpp" : true)
			);
			expect(state()).toBe(next === "voice-input" ? "audio.cpp" : true);
			expect(reads(slot)[0]).toMatchObject({
				authorization: "Bearer " + authorities[slot]!.token,
				jwt: authorities[slot]!.userJwt,
			});
			expect(writes()).toHaveLength(0);
		});
	test(`${next}: late A GET cannot replace loaded B state or create a write`, async () => {
		held = { slot: "A", method: "GET" };
		await render(next);
		await until(() => !!release);
		await switchAuthority("B");
		await until(
			() =>
				received("B").length > 0 &&
				state() === (next === "voice-input" ? "audio.cpp" : true)
		);
		expect(state()).toBe(next === "voice-input" ? "audio.cpp" : true);
		held = undefined;
		await act(async () => release?.());
		await until(() => received("A").length > 0);
		expect(state()).toBe(next === "voice-input" ? "audio.cpp" : true);
		expect(writes()).toHaveLength(0);
	});
	test(`${next}: refused PUT keeps acknowledged selection and complete saved policy; explicit Retry saves the identical intended policy`, async () => {
		await render(next);
		await initialA();
		statuses["A:PUT"] = 503;
		await edit();
		await until(() => received("A", "PUT").length === 1);
		expect(state()).toBe(next === "voice-input" ? "Whisper" : false);
		expect(disabled()).toBe(false);
		expect(saved.A![next]).toEqual(
			next === "voice-input" ? input("A") : { enabled: false }
		);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Could not save voice settings"
		);
		const retry = [
			...container.querySelectorAll<HTMLButtonElement>("button"),
		].find((b) => b.textContent?.trim() === "Retry");
		expect(retry).toBeDefined();
		const refused = structuredClone(writes()[0]!.body);
		statuses["A:PUT"] = 200;
		await act(async () => retry!.click());
		await until(() => received("A", "PUT").length === 2 && !disabled());
		expect(writes()).toHaveLength(2);
		expect(writes()[1]!.body).toEqual(refused);
		expect(saved.A![next]).toEqual(
			next === "voice-input"
				? { ...input("A"), engine: "gateway", model: "" }
				: { enabled: true }
		);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		await act(async () => root!.unmount());
		root = undefined;
		await render(next);
		await until(() => received("A").length === 2 && !disabled());
		expect(state()).toBe(next === "voice-input" ? "Cloud (via gateway)" : true);
	});
	for (const outcome of [200, 503])
		test(`${next}: held A PUT ${outcome} cannot alter B selection, emit B writes, or surface A's failure on B`, async () => {
			await render(next);
			await initialA();
			held = { slot: "A", method: "PUT" };
			statuses["A:PUT"] = outcome;
			await edit();
			await until(() => !!release);
			expect(disabled()).toBe(true);
			await act(async () => control().click());
			expect(writes()).toHaveLength(1);
			const pendingBody = structuredClone(writes()[0]!.body);
			await switchAuthority("B");
			await until(() => received("B").length === 1 && !disabled());
			expect(state()).toBe(next === "voice-input" ? "audio.cpp" : true);
			held = undefined;
			await act(async () => release?.());
			await until(() => received("A", "PUT").length === 1);
			expect(state()).toBe(next === "voice-input" ? "audio.cpp" : true);
			expect(container.querySelector('[role="alert"]')).toBeNull();
			expect(writes()).toHaveLength(1);
			expect(writes()[0]!.body).toEqual(pendingBody);
			expect(saved.B![next]).toEqual(
				next === "voice-input" ? input("B") : { enabled: true }
			);
			expect(saved.A![next]).toEqual(
				outcome === 200
					? next === "voice-input"
						? { ...input("A"), engine: "gateway", model: "" }
						: { enabled: true }
					: next === "voice-input"
						? input("A")
						: { enabled: false }
			);
		});

	for (const status of [403, 500])
		test(`${next}: refused ${status} initial GET cannot enable a default-based destructive write; retry reads saved policy`, async () => {
			statuses["A:GET"] = status;
			await render(next);
			await until(() => received("A").length > 0);
			expect(disabled()).toBe(true);
			expect(writes()).toHaveLength(0);
			expect(saved.A![next]).toEqual(
				next === "voice-input" ? input("A") : { enabled: false }
			);
			const retry = [
				...container.querySelectorAll<HTMLButtonElement>("button"),
			].find((b) => b.textContent?.trim() === "Retry");
			expect(retry).toBeDefined();
			statuses["A:GET"] = 200;
			await act(async () => retry!.click());
			await until(() => received("A").length === 2 && !disabled());
			expect(disabled()).toBe(false);
			expect(state()).toBe(next === "voice-input" ? "Whisper" : false);
			expect(writes()).toHaveLength(0);
		});
}

test("voice-mode-readback: two real same-turn toggle events emit one full-policy PUT while its response is held", async () => {
	await render("voice-mode-readback");
	await initialA();
	held = { slot: "A", method: "PUT" };
	await act(async () => {
		control().click();
		control().click();
	});
	await until(() => !!release);
	expect(writes()).toHaveLength(1);
	expect(writes()[0]).toMatchObject({
		slot: "A",
		authorization: "Bearer A-token",
		jwt: "A-jwt",
		body: { value: JSON.stringify({ enabled: true }) },
	});
	expect(saved.A!["voice-mode-readback"]).toEqual({ enabled: false });
	held = undefined;
	await act(async () => release?.());
	await until(() => received("A", "PUT").length === 1 && !disabled());
	expect(saved.A!["voice-mode-readback"]).toEqual({ enabled: true });
	expect(state()).toBe(true);
});

for (const next of ["voice-input", "voice-mode-readback"] as const) {
	test(`${next}: returning A before its old full-policy PUT acknowledgement keeps A locked, then rereads the acknowledged policy before another edit`, async () => {
		await render(next);
		await initialA();
		const initialPolicy = structuredClone(saved.A![next]);
		held = { slot: "A", method: "PUT" };
		await edit();
		await until(() => !!release);
		expect(writes()).toHaveLength(1);
		const oldWrite = structuredClone(writes()[0]!.body);
		expect(saved.A![next]).toEqual(initialPolicy);
		await switchAuthority("B");
		await until(() => received("B").length === 1 && !disabled());
		expect(state()).toBe(next === "voice-input" ? "audio.cpp" : true);
		await switchAuthority("A");
		expect(disabled()).toBe(true);
		await act(async () => control().click());
		expect(writes()).toHaveLength(1);
		expect(saved.A![next]).toEqual(initialPolicy);
		const readsBeforeAck = reads("A").length;
		held = undefined;
		await act(async () => release?.());
		await until(
			() =>
				received("A", "PUT").length === 1 &&
				reads("A").length > readsBeforeAck &&
				received("A").length > readsBeforeAck &&
				!disabled()
		);
		const acknowledged =
			next === "voice-input"
				? { ...input("A"), engine: "gateway", model: "" }
				: { enabled: true };
		expect(saved.A![next]).toEqual(acknowledged);
		expect(state()).toBe(next === "voice-input" ? "Cloud (via gateway)" : true);
		if (next === "voice-input") {
			await act(async () => control().click());
			const option = [
				...document.querySelectorAll<HTMLElement>('[role="option"]'),
			].find((el) => el.textContent?.trim() === "Whisper");
			if (!option)
				throw new Error(
					"Expected actual Whisper engine option after A acknowledgement"
				);
			await act(async () => option.click());
		} else await act(async () => control().click());
		await until(
			() =>
				writes().length === 2 &&
				writes()[1]!.completed &&
				received("A", "PUT").length === 2 &&
				!disabled()
		);
		const finalPolicy =
			next === "voice-input"
				? { ...input("A"), model: "ggml-base.en" }
				: { enabled: false };
		expect(
			writes().map((call) => ({ slot: call.slot, body: call.body }))
		).toEqual([
			{ slot: "A", body: oldWrite },
			{ slot: "A", body: { value: JSON.stringify(finalPolicy) } },
		]);
		expect(saved.A![next]).toEqual(finalPolicy);
		expect(saved.B![next]).toEqual(
			next === "voice-input" ? input("B") : { enabled: true }
		);
		await act(async () => root!.unmount());
		root = undefined;
		await render(next);
		await until(() => received("A").length > readsBeforeAck + 1 && !disabled());
		expect(state()).toBe(next === "voice-input" ? "Whisper" : false);
		expect(saved.A![next]).toEqual(finalPolicy);
	});
}

for (const next of ["voice-input", "voice-mode-readback"] as const) {
	test(`${next}: returning A waits for its held refused write, reloads unchanged saved policy, then unlocks a genuine retry without stale failure UI`, async () => {
		await render(next);
		await initialA();
		const initialPolicy = structuredClone(saved.A![next]);
		held = { slot: "A", method: "PUT" };
		statuses["A:PUT"] = 503;
		await edit();
		await until(() => !!release);
		const intendedBody = structuredClone(writes()[0]!.body);
		await switchAuthority("B");
		await until(() => received("B").length === 1 && !disabled());
		await switchAuthority("A");
		expect(disabled()).toBe(true);
		await act(async () => control().click());
		expect(writes()).toHaveLength(1);
		expect(saved.A![next]).toEqual(initialPolicy);
		const readsBeforeRefusal = reads("A").length;
		held = undefined;
		await act(async () => release?.());
		await until(
			() =>
				received("A", "PUT").length === 1 &&
				received("A").length > readsBeforeRefusal &&
				!disabled()
		);
		expect(writes()[0]!.status).toBe(503);
		expect(saved.A![next]).toEqual(initialPolicy);
		expect(state()).toBe(next === "voice-input" ? "Whisper" : false);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		statuses["A:PUT"] = 200;
		await edit();
		await until(() => received("A", "PUT").length === 2 && !disabled());
		const expected =
			next === "voice-input"
				? { ...input("A"), engine: "gateway", model: "" }
				: { enabled: true };
		expect(
			writes().map((call) => ({
				slot: call.slot,
				status: call.status,
				body: call.body,
			}))
		).toEqual([
			{ slot: "A", status: 503, body: intendedBody },
			{ slot: "A", status: 200, body: intendedBody },
		]);
		expect(saved.A![next]).toEqual(expected);
		expect(saved.B![next]).toEqual(
			next === "voice-input" ? input("B") : { enabled: true }
		);
		const readsBeforeRemount = received("A").length;
		await act(async () => root!.unmount());
		root = undefined;
		await render(next);
		await until(() => received("A").length > readsBeforeRemount && !disabled());
		expect(state()).toBe(next === "voice-input" ? "Cloud (via gateway)" : true);
		expect(saved.A![next]).toEqual(expected);
	});
}

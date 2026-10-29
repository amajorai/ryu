import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// The shipping Shadow client is device-local. Configure its genuine supported
// Core URL before importing it; never rewrite a URL, SDK function or response.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const previousCoreUrl = process.env.VITE_CORE_URL;
const configPath = "/api/shadow/computer-use/config";
const secretListPath = "/api/plugins/%40ryu%2Fshadow/secrets";
const secretPath = `${secretListPath}/SHADOW_JEV_API_KEY`;
const nodeToken = "shadow-test-only-local-bearer";
const dummyKey = "shadow-dummy-key-never-valid";
const initialConfig = {
	applied: false,
	jevApiKeyConfigured: false,
	planner: "jev" as const,
	jevUrl: "https://configured-provider.example.test/decide",
	jevModel: "saved-decision-model",
	layaUrl: "https://preserved-local.example.test/predict",
	localPluginId: "@ryu/saved-local-planner",
	localModelId: "saved-local-model",
	maxSteps: 7,
};
type Config = typeof initialConfig;
interface Call {
	authorization: string | null;
	body: unknown;
	completed: boolean;
	jwt: string | null;
	method: string;
	path: string;
	status: number;
}
let saved: Config = structuredClone(initialConfig);
let secret: string | null = null;
let calls: Call[] = [];
let unexpected: string[] = [];
let nextConfigReadStatus: number | null = null;
let nextConfigWriteStatus: number | null = null;
let nextSecretReadStatus: number | null = null;
let nextSecretWriteStatus: number | null = null;
let nextSecretDeleteStatus: number | null = null;
let heldPath: string | null = null;
let heldMethod: string | null = null;
let releaseHeld: (() => void) | null = null;
let root: Root | null = null;
let client: InstanceType<typeof QueryClient> | null = null;
let container: HTMLDivElement;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const body = ["POST", "PUT"].includes(request.method)
			? await request.json()
			: null;
		const call: Call = {
			path: url.pathname + url.search,
			method: request.method,
			body,
			authorization: request.headers.get("authorization"),
			jwt: request.headers.get("x-ryu-user-jwt"),
			status: 0,
			completed: false,
		};
		calls.push(call);
		const reply = (value: unknown, status = 200) => {
			call.status = status;
			call.completed = true;
			return NativeResponse.json(value, { status });
		};
		if (
			call.authorization !== `Bearer ${nodeToken}` ||
			call.jwt !== null ||
			url.search
		) {
			unexpected.push(
				`${request.method} ${call.path} invalid local authority/query`
			);
			return reply({ error: "Unexpected authority or query" }, 503);
		}
		if (url.pathname === heldPath && request.method === heldMethod) {
			heldPath = null;
			heldMethod = null;
			await new Promise<void>((resolve) => {
				releaseHeld = resolve;
			});
		}
		if (url.pathname === configPath && request.method === "GET") {
			const refusal = nextConfigReadStatus;
			nextConfigReadStatus = null;
			return refusal
				? reply({ error: "Owned saved config unavailable" }, refusal)
				: reply(structuredClone(saved));
		}
		if (url.pathname === configPath && request.method === "POST") {
			const refusal = nextConfigWriteStatus;
			nextConfigWriteStatus = null;
			if (refusal) {
				return reply({ error: "Owned config write refused" }, refusal);
			}
			const expectedKeys = [
				"planner",
				"jevUrl",
				"jevModel",
				"layaUrl",
				"localPluginId",
				"localModelId",
				"maxSteps",
			].sort();
			if (
				!body ||
				typeof body !== "object" ||
				JSON.stringify(Object.keys(body).sort()) !==
					JSON.stringify(expectedKeys)
			) {
				unexpected.push(
					"Config writer sent a malformed/partial full-policy payload"
				);
				return reply({ error: "Exact full config required" }, 503);
			}
			// Canonical Core Settings/Update uses u8 plus validate()'s 1..=20.
			// Refuse invalid values independently of the mounted input implementation.
			const maxSteps = (body as { maxSteps?: unknown }).maxSteps;
			if (
				typeof maxSteps !== "number" ||
				!Number.isInteger(maxSteps) ||
				maxSteps < 1 ||
				maxSteps > 20
			) {
				unexpected.push(
					"Config writer violated canonical integer maxSteps 1..20 contract"
				);
				return reply({ error: "maxSteps must be between 1 and 20" }, 400);
			}
			saved = {
				...saved,
				...(body as Omit<Config, "applied" | "jevApiKeyConfigured">),
			};
			return reply(structuredClone(saved));
		}
		if (url.pathname === secretListPath && request.method === "GET") {
			const refusal = nextSecretReadStatus;
			nextSecretReadStatus = null;
			return refusal
				? reply({ error: "Owned credential metadata unavailable" }, refusal)
				: reply({
						secrets: [
							{
								key: "SHADOW_JEV_API_KEY",
								set: secret !== null,
								readable: true,
								shadowed_by_env: false,
								updated_at: 1_791_500_000_000,
							},
						],
					});
		}
		if (url.pathname === secretPath && request.method === "PUT") {
			const refusal = nextSecretWriteStatus;
			nextSecretWriteStatus = null;
			if (refusal) {
				return reply({ error: "Owned credential write refused" }, refusal);
			}
			if (
				!body ||
				typeof body !== "object" ||
				Object.keys(body).join() !== "value" ||
				typeof (body as { value?: unknown }).value !== "string"
			) {
				unexpected.push("Malformed secret write");
				return reply({ error: "Exact secret payload required" }, 503);
			}
			secret = (body as { value: string }).value;
			return reply({ ok: true });
		}
		if (url.pathname === secretPath && request.method === "DELETE") {
			const refusal = nextSecretDeleteStatus;
			nextSecretDeleteStatus = null;
			if (refusal) {
				return reply({ error: "Owned credential deletion refused" }, refusal);
			}
			secret = null;
			return reply({ ok: true });
		}
		if (
			url.pathname === "/api/plugins/contributions" &&
			request.method === "GET"
		) {
			return reply({ computer_use_planners: [] });
		}
		if (
			url.pathname === "/api/shadow/capture/control" &&
			["GET", "POST"].includes(request.method)
		) {
			// This finite fixture represents the genuine stopped capture sidecar.
			// No OS capture/permission/restart/inference success is synthesized.
			return reply({ error: "Owned Shadow capture is stopped" }, 502);
		}
		unexpected.push(`${request.method} ${call.path}`);
		return reply({ error: "Undeclared Shadow regression request" }, 503);
	},
});
process.env.VITE_CORE_URL = server.url.origin;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const egress: string[] = [];
let inFlight = 0;
interface ClientRead {
	bodyConsumed: boolean;
	headersReceived: boolean;
	method: string;
	path: string;
	status: number | null;
}
let clientReads: ClientRead[] = [];
globalThis.fetch = Object.assign(
	async (...args: Parameters<typeof nativeFetch>) => {
		const input = args[0];
		const url = new URL(
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url
		);
		if (url.origin !== server.url.origin) {
			egress.push(url.origin);
			throw new Error("Shadow regression refuses unowned egress");
		}
		const requestInput =
			typeof input === "string" || input instanceof URL ? null : input;
		const operation: ClientRead = {
			path: url.pathname + url.search,
			method: (args[1]?.method ?? requestInput?.method ?? "GET").toUpperCase(),
			status: null,
			headersReceived: false,
			bodyConsumed: false,
		};
		clientReads.push(operation);
		inFlight += 1;
		try {
			const response = await nativeFetch(...args);
			operation.status = response.status;
			operation.headersReceived = true;
			const json = response.json.bind(response);
			response.json = async () => {
				try {
					return await json();
				} finally {
					operation.bodyConsumed = true;
				}
			};
			const text = response.text.bind(response);
			response.text = async () => {
				try {
					return await text();
				} finally {
					operation.bodyConsumed = true;
				}
			};
			return response;
		} finally {
			inFlight -= 1;
		}
	},
	{
		preconnect: (...args: Parameters<typeof nativeFetch.preconnect>) => {
			const url = new URL(String(args[0]));
			if (url.origin !== server.url.origin) {
				throw new Error("Unowned preconnect");
			}
			return nativeFetch.preconnect(...args);
		},
	}
);
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const componentSource =
	process.env.RYU_SHADOW_SETTINGS_PROOF_SOURCE ??
	new URL("./ShadowSettings.tsx", import.meta.url).pathname;
const { ShadowSettings } = await import(componentSource);
const { getShadowComputerUseConfig } = await import("@/src/lib/api/shadow.ts");
const { listPluginSecrets } = await import("@/src/lib/api/plugin-secrets.ts");
const originalNodeState = useNodeStore.getState();
const target = { url: server.url.origin, token: nodeToken, userJwt: null };

async function until(check: () => boolean, message: string) {
	const deadline = Date.now() + 2500;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		});
	}
}
function computerUseSection() {
	const heading = [...container.querySelectorAll("h3")].find(
		(item) => item.textContent?.trim() === "Computer use"
	);
	const section = heading?.parentElement?.parentElement;
	if (!section) {
		throw new Error("Missing actual Computer use settings section");
	}
	return section;
}
function computerUseAlert() {
	return computerUseSection().querySelector('[role="alert"]');
}
async function retryComputerUse() {
	const retry = [
		...computerUseSection().querySelectorAll<HTMLButtonElement>("button"),
	].find((item) => item.textContent?.trim() === "Retry");
	if (!retry) {
		throw new Error("Missing explicit Computer use Retry action");
	}
	await act(async () => retry.click());
}
function input(name: string) {
	const element = container.querySelector<HTMLInputElement>(
		`input[aria-label="${name}"]`
	);
	if (!element) {
		throw new Error(`Missing shipping input ${name}`);
	}
	return element;
}
function button(name: string) {
	const element = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find((item) => item.textContent?.trim() === name);
	if (!element) {
		throw new Error(`Missing shipping action ${name}`);
	}
	return element;
}
async function edit(name: string, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input(name), value);
		input(name).dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function click(name: string) {
	await act(async () => button(name).click());
}
async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	root = createRoot(container);
	await act(async () =>
		root!.render(
			<QueryClientProvider client={client!}>
				<ShadowSettings />
			</QueryClientProvider>
		)
	);
}
async function unmount() {
	await act(async () => {
		root?.unmount();
		root = null;
	});
	client?.clear();
	client = null;
	container?.remove();
}
async function loaded() {
	await until(() => {
		const configRead = clientReads
			.filter((read) => read.path === configPath && read.method === "GET")
			.at(-1);
		const metadataRead = clientReads
			.filter((read) => read.path === secretListPath && read.method === "GET")
			.at(-1);
		return (
			configRead?.status === 200 &&
			configRead.bodyConsumed &&
			metadataRead?.status === 200 &&
			metadataRead.bodyConsumed &&
			!button("Save computer-use settings").disabled &&
			input("Maximum computer-use steps").value === String(saved.maxSteps)
		);
	}, "Actual saved config and credential metadata bodies did not reach ready UI");
}
function writes(path = configPath, method = "POST") {
	return calls.filter((call) => call.path === path && call.method === method);
}
async function release() {
	const resolve = releaseHeld;
	if (!resolve) {
		throw new Error("No held actual native request");
	}
	releaseHeld = null;
	await act(async () => resolve());
}
async function physicalRead() {
	const response = await nativeFetch(server.url.origin + configPath, {
		headers: { Authorization: `Bearer ${nodeToken}` },
	});
	if (response.status !== 200) {
		throw new Error(`Independent HTTP read refused: ${response.status}`);
	}
	return response.json();
}
function editable(config: Config) {
	const { applied, jevApiKeyConfigured, ...value } = config;
	return value;
}

beforeEach(() => {
	saved = structuredClone(initialConfig);
	secret = null;
	calls = [];
	clientReads = [];
	unexpected = [];
	egress.length = 0;
	nextConfigReadStatus =
		nextConfigWriteStatus =
		nextSecretReadStatus =
		nextSecretWriteStatus =
		nextSecretDeleteStatus =
			null;
	heldPath = heldMethod = null;
	releaseHeld = null;
	const local = { name: "local-regression", ...target };
	const remote = {
		name: "selected-remote",
		url: "https://unowned-selected-remote.example.test",
		token: "remote-only",
		userJwt: null,
	};
	useNodeStore.setState({
		nodes: [local, remote],
		localNodes: [local, remote],
		cloudNodes: [],
		defaultNode: remote.name,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
	if (useNodeStore.getState().getActiveNode().name !== remote.name) {
		throw new Error("Unrelated remote must be selected");
	}
});
afterEach(async () => {
	if (releaseHeld) {
		await release();
	}
	await unmount();
	await until(
		() => inFlight === 0 && calls.every((call) => call.completed),
		"Owned native requests remain during teardown"
	);
	if (unexpected.length > 0) {
		throw new Error(`Unexpected HTTP: ${JSON.stringify(unexpected)}`);
	}
	if (egress.length > 0) {
		throw new Error(`Unexpected egress: ${JSON.stringify(egress)}`);
	}
	if (calls.some((call) => /\/api\/(?:sidecar|setup)/.test(call.path))) {
		throw new Error("Unexpected sidecar/setup operation");
	}
});
afterAll(async () => {
	useNodeStore.setState(originalNodeState);
	globalThis.fetch = nativeFetch;
	if (previousCoreUrl === undefined) {
		delete process.env.VITE_CORE_URL;
	} else {
		process.env.VITE_CORE_URL = previousCoreUrl;
	}
	await server.stop(true);
});

test("actual Shadow full-config save preserves every untouched field and restores independent HTTP storage after remount, while remote node is selected", async () => {
	await mount();
	await loaded();
	await edit("Maximum computer-use steps", "9");
	await click("Save computer-use settings");
	await until(() => {
		const posts = clientReads.filter(
			(read) => read.path === configPath && read.method === "POST"
		);
		return (
			writes().length === 1 &&
			writes()[0].completed &&
			posts.length === 1 &&
			posts.at(-1)?.status === 200 &&
			posts.at(-1)?.bodyConsumed === true &&
			!button("Save computer-use settings").disabled &&
			computerUseSection().textContent?.includes(
				"Computer-use settings saved;"
			) === true
		);
	}, "Actual config POST did not reach consumed acknowledgment and saved UI");
	expect(writes()[0].body).toEqual({ ...editable(initialConfig), maxSteps: 9 });
	expect(await physicalRead()).toEqual({ ...initialConfig, maxSteps: 9 });
	expect(await getShadowComputerUseConfig()).toEqual({
		...initialConfig,
		maxSteps: 9,
	});
	await unmount();
	await mount();
	await loaded();
	expect(input("Jev model identifier").value).toBe(initialConfig.jevModel);
	expect(input("Maximum computer-use steps").value).toBe("9");
	expect(writes()).toHaveLength(1);
});
for (const status of [403, 503]) {
	test(`config POST${status} preserves draft and physical saved fields; same-value retry persists and remount reads it`, async () => {
		await mount();
		await loaded();
		nextConfigWriteStatus = status;
		await edit("Maximum computer-use steps", "9");
		await click("Save computer-use settings");
		await until(
			() =>
				container.textContent?.includes("Owned config write refused") === true,
			"Actual config refusal was not visible"
		);
		expect(input("Maximum computer-use steps").value).toBe("9");
		expect(await physicalRead()).toEqual(initialConfig);
		expect(container.textContent).not.toContain("Computer-use settings saved;");
		await click("Save computer-use settings");
		await until(() => {
			const posts = clientReads.filter(
				(read) => read.path === configPath && read.method === "POST"
			);
			return (
				writes().length === 2 &&
				writes()[1].completed &&
				posts.length === 2 &&
				posts.at(-1)?.status === 200 &&
				posts.at(-1)?.bodyConsumed === true &&
				!button("Save computer-use settings").disabled &&
				computerUseSection().textContent?.includes(
					"Computer-use settings saved;"
				) === true
			);
		}, "Explicit config retry did not reach consumed acknowledgment and saved UI");
		expect(writes().map((call) => call.body)).toEqual([
			{ ...editable(initialConfig), maxSteps: 9 },
			{ ...editable(initialConfig), maxSteps: 9 },
		]);
		await unmount();
		await mount();
		await loaded();
		expect(input("Maximum computer-use steps").value).toBe("9");
	});
	test(`initial config GET${status} cannot unlock a destructive default-based write; explicit Retry loads complete saved policy`, async () => {
		nextConfigReadStatus = status;
		await mount();
		await until(
			() =>
				clientReads.some(
					(read) =>
						read.path === configPath &&
						read.method === "GET" &&
						read.status === status &&
						read.headersReceived
				) &&
				(computerUseAlert() !== null ||
					!(
						button("Save computer-use settings").disabled ||
						container.textContent?.includes("Loading computer-use settings…")
					)),
			"Failed actual config GET never reached a visible terminal state"
		);
		// The original fail-soft SDK intentionally skips reading a failed GET body.
		// Its visible loaded/default state is the terminal barrier for genuine RED;
		// a protected strict caller reaches its error UI only after reading failure.
		await act(async () => {});
		expect(button("Save computer-use settings").disabled).toBe(true);
		expect(writes()).toHaveLength(0);
		expect(computerUseAlert()).not.toBeNull();
		await retryComputerUse();
		await loaded();
		expect(input("Maximum computer-use steps").value).toBe("7");
		expect(await physicalRead()).toEqual(initialConfig);
		expect(writes()).toHaveLength(0);
	});
}
test("pending actual initial GET cannot send a default full config before saved data arrives", async () => {
	heldPath = configPath;
	heldMethod = "GET";
	await mount();
	await until(() => releaseHeld !== null, "Initial actual GET not held");
	expect(button("Save computer-use settings").disabled).toBe(true);
	await click("Save computer-use settings");
	expect(writes()).toHaveLength(0);
	await release();
	await loaded();
	expect(await physicalRead()).toEqual(initialConfig);
});
test("Jev credential PUT503 retains masked draft and unchanged write-only metadata; exact trimmed retry survives remount without starting stopped capture", async () => {
	await mount();
	await loaded();
	nextSecretWriteStatus = 503;
	await edit("Jev API key", `  ${dummyKey}  `);
	await click("Save key");
	await until(
		() =>
			clientReads.some(
				(read) =>
					read.path === secretPath &&
					read.method === "PUT" &&
					read.status === 503 &&
					read.bodyConsumed
			) && computerUseAlert() !== null,
		"Actual credential PUT503 body and visible error alert did not settle"
	);
	// ApiError intentionally keeps its legacy path/status message; Core's
	// native reason is serverMessage. Do not require the fixture reason text.
	expect(computerUseAlert()?.textContent).toContain("503");
	expect(secret).toBeNull();
	expect(input("Jev API key").type).toBe("password");
	expect(input("Jev API key").value).toBe(`  ${dummyKey}  `);
	expect(container.textContent).not.toContain("Jev key saved encrypted.");
	expect((await listPluginSecrets(target, "@ryu/shadow"))[0].set).toBe(false);
	await click("Save key");
	await until(
		() =>
			container.textContent?.includes(
				"Jev key saved encrypted. Shadow will load it when it next starts."
			) === true,
		"Accepted secret did not acknowledge stopped capture"
	);
	expect(writes(secretPath, "PUT").map((call) => call.body)).toEqual([
		{ value: dummyKey },
		{ value: dummyKey },
	]);
	expect(secret).toBe(dummyKey);
	expect(input("Jev API key").value).toBe("");
	expect(
		JSON.stringify(await listPluginSecrets(target, "@ryu/shadow"))
	).not.toContain(dummyKey);
	await unmount();
	await mount();
	await loaded();
	expect(input("Jev API key").value).toBe("");
	expect(input("Jev API key").placeholder).toBe("Saved; enter to replace");
	expect(container.textContent).not.toContain(dummyKey);
});
test("Jev DELETE403 preserves saved secret and Clear action; exact retry removes it and fresh metadata/remount remain unset", async () => {
	secret = dummyKey;
	await mount();
	await loaded();
	nextSecretDeleteStatus = 403;
	await click("Clear");
	await until(
		() =>
			clientReads.some(
				(read) =>
					read.path === secretPath &&
					read.method === "DELETE" &&
					read.status === 403 &&
					read.bodyConsumed
			) && computerUseAlert() !== null,
		"Actual credential DELETE403 body and visible error alert did not settle"
	);
	expect(computerUseAlert()?.textContent).toContain("403");
	expect(secret).toBe(dummyKey);
	expect(button("Clear").disabled).toBe(false);
	expect((await listPluginSecrets(target, "@ryu/shadow"))[0].set).toBe(true);
	await click("Clear");
	await until(
		() => secret === null && writes(secretPath, "DELETE").length === 2,
		"Explicit secret deletion retry missing"
	);
	expect(writes(secretPath, "DELETE").map((call) => call.body)).toEqual([
		null,
		null,
	]);
	await unmount();
	await mount();
	await loaded();
	expect((await listPluginSecrets(target, "@ryu/shadow"))[0].set).toBe(false);
	expect(
		[...container.querySelectorAll("button")].some(
			(item) => item.textContent?.trim() === "Clear"
		)
	).toBe(false);
});
test("failed credential metadata GET cannot be presented as an unset or environment-provided key; Retry reads the real saved state", async () => {
	secret = dummyKey;
	nextSecretReadStatus = 503;
	await mount();
	await until(
		() =>
			clientReads.some(
				(read) =>
					read.path === secretListPath &&
					read.status === 503 &&
					read.bodyConsumed
			),
		"Credential metadata refusal body was not actually consumed"
	);
	await act(async () => {});
	// A readable config remains independent of credential metadata. The unreadable
	// credential must get an honest error and a real metadata retry, not an unset
	// or process-environment claim based on a swallowed response.
	expect(computerUseAlert()).not.toBeNull();
	expect(container.textContent).not.toContain(
		"A Jev key is provided to Shadow by its process environment."
	);
	await until(
		() =>
			clientReads.some(
				(read) =>
					read.path === configPath &&
					read.method === "GET" &&
					read.status === 200 &&
					read.bodyConsumed
			) &&
			!button("Save computer-use settings").disabled &&
			input("Maximum computer-use steps").value === "7",
		"Independent readable saved policy was blocked by credential metadata refusal"
	);
	await edit("Jev API key", "shadow-replacement-dummy-never-valid");
	expect(button("Save key").disabled).toBe(true);
	await click("Save key");
	expect(writes(secretPath, "PUT")).toHaveLength(0);
	await edit("Maximum computer-use steps", "9");
	await click("Save computer-use settings");
	await until(
		() =>
			writes().length === 1 &&
			clientReads
				.filter((read) => read.path === configPath && read.method === "POST")
				.at(-1)?.status === 200 &&
			clientReads
				.filter((read) => read.path === configPath && read.method === "POST")
				.at(-1)?.bodyConsumed === true &&
			!button("Save computer-use settings").disabled,
		"Independent full-policy save did not acknowledge its actual response body"
	);
	expect(writes()[0].body).toEqual({ ...editable(initialConfig), maxSteps: 9 });
	expect(await physicalRead()).toEqual({ ...initialConfig, maxSteps: 9 });
	// An unrelated successful policy save must retain this failed read's recovery.
	expect(computerUseAlert()).not.toBeNull();
	expect(computerUseAlert()?.textContent).toContain("503");
	expect(button("Save key").disabled).toBe(true);
	expect(writes(secretPath, "PUT")).toHaveLength(0);
	expect(secret).toBe(dummyKey);
	const readCount = clientReads.filter(
		(read) => read.path === secretListPath && read.method === "GET"
	).length;
	await retryComputerUse();
	await until(
		() =>
			clientReads.filter(
				(read) => read.path === secretListPath && read.method === "GET"
			).length ===
				readCount + 1 &&
			clientReads
				.filter((read) => read.path === secretListPath && read.method === "GET")
				.at(-1)?.bodyConsumed === true,
		"Actual explicit Retry must consume one fresh credential metadata GET"
	);
	await until(
		() => input("Jev API key").placeholder === "Saved; enter to replace",
		"Fresh saved credential metadata did not reach UI"
	);
	await loaded();
	expect(input("Jev API key").placeholder).toBe("Saved; enter to replace");
	expect(button("Save key").disabled).toBe(false);
	expect(computerUseAlert()).toBeNull();
	expect(await physicalRead()).toEqual({ ...initialConfig, maxSteps: 9 });
	expect(writes()).toHaveLength(1);
	expect(writes(secretPath, "PUT")).toHaveLength(0);
	expect(
		JSON.stringify(await listPluginSecrets(target, "@ryu/shadow"))
	).not.toContain(dummyKey);
});
test("two same-turn save events while the actual POST is held issue one full-policy request and never claim early success", async () => {
	await mount();
	await loaded();
	await edit("Maximum computer-use steps", "9");
	heldPath = configPath;
	heldMethod = "POST";
	await act(async () => {
		const save = button("Save computer-use settings");
		save.click();
		save.click();
	});
	await until(() => releaseHeld !== null, "Actual config POST not held");
	expect(writes()).toHaveLength(1);
	expect(saved).toEqual(initialConfig);
	expect(container.textContent).not.toContain("Computer-use settings saved;");
	await release();
	await until(() => {
		const posts = clientReads.filter(
			(read) => read.path === configPath && read.method === "POST"
		);
		return (
			saved.maxSteps === 9 &&
			writes().length === 1 &&
			posts.length === 1 &&
			posts[0]?.status === 200 &&
			posts[0]?.bodyConsumed === true &&
			!button("Save computer-use settings").disabled &&
			computerUseSection().textContent?.includes(
				"Computer-use settings saved;"
			) === true
		);
	}, "Held config POST did not reach consumed acknowledgment and terminal saved UI");
	expect(await physicalRead()).toEqual({ ...initialConfig, maxSteps: 9 });
});

test("actual step-boundary edits persist only valid canonical integers, retain every other saved field, and survive fresh GET/remount", async () => {
	await mount();
	await loaded();
	for (const [typed, accepted] of [
		["0", 1],
		["21", 20],
		["3.9", 3],
	] as const) {
		const writeCount = writes().length;
		await edit("Maximum computer-use steps", typed);
		expect(input("Maximum computer-use steps").value).toBe(String(accepted));
		expect(writes()).toHaveLength(writeCount);
		expect(await physicalRead()).toEqual({
			...initialConfig,
			maxSteps: writeCount === 0 ? 7 : writeCount === 1 ? 1 : 20,
		});
		await click("Save computer-use settings");
		await until(() => {
			const posts = clientReads.filter(
				(read) => read.path === configPath && read.method === "POST"
			);
			return (
				writes().length === writeCount + 1 &&
				posts.length === writeCount + 1 &&
				posts.at(-1)?.status === 200 &&
				posts.at(-1)?.bodyConsumed === true &&
				!button("Save computer-use settings").disabled
			);
		}, "Actual bounded full-policy POST body did not reach acknowledged UI");
		expect(writes().at(-1)?.body).toEqual({
			...editable(initialConfig),
			maxSteps: accepted,
		});
		expect(await physicalRead()).toEqual({
			...initialConfig,
			maxSteps: accepted,
		});
		expect(await getShadowComputerUseConfig()).toEqual({
			...initialConfig,
			maxSteps: accepted,
		});
	}
	expect(writes()).toHaveLength(3);
	await unmount();
	await mount();
	await loaded();
	expect(input("Maximum computer-use steps").value).toBe("3");
	expect(input("Jev model identifier").value).toBe(initialConfig.jevModel);
	expect(await physicalRead()).toEqual({ ...initialConfig, maxSteps: 3 });
	expect(writes()).toHaveLength(3);
});

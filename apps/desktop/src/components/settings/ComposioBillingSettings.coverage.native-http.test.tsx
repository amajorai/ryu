import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// Component-level coverage for the shipping ComposioBillingSettings surface and
// the ComposioBillingView rows it renders (Gateway → Integrations). The policy
// comes from the active node's real `GET /api/gateway/config` over loopback
// HTTP; two nodes share the fixture and are told apart by their bearer token.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const NODE_A = { name: "composio-node-a", token: "composio-node-a-token" };
const NODE_B = { name: "composio-node-b", token: "composio-node-b-token" };

interface ConfigReply {
	body: unknown;
	status: number;
}
interface ConfigRequest {
	authorization: string | null;
	clientId: string | null;
	method: string;
}

const replies = new Map<string, ConfigReply>();
const holds = new Map<string, Promise<void>>();
const releases = new Map<string, () => void>();
const requests: ConfigRequest[] = [];
const unexpected: string[] = [];

function policy(zeroDataRetention: boolean) {
	return {
		composioBillingActive: {
			baa: false,
			ipAllowlist: false,
			zeroDataRetention,
		},
		providers: {},
	};
}

/** Hold the next config answer for `token` until the case releases it. */
function holdNext(token: string) {
	holds.set(
		token,
		new Promise<void>((resolve) => {
			releases.set(token, resolve);
		})
	);
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const authorization = request.headers.get("authorization");
		if (url.pathname !== "/api/gateway/config" || request.method !== "GET") {
			unexpected.push(`${request.method} ${url.pathname}`);
			return NativeResponse.json({ error: "undeclared" }, { status: 404 });
		}
		requests.push({
			authorization,
			clientId: request.headers.get("x-ryu-client-id"),
			method: request.method,
		});
		const token = authorization?.replace(/^Bearer /u, "") ?? "";
		const reply = replies.get(token);
		if (!reply) {
			unexpected.push(`config read with token ${token || "(none)"}`);
			return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		const hold = holds.get(token);
		if (hold) {
			holds.delete(token);
			await hold;
		}
		return NativeResponse.json(reply.body, { status: reply.status });
	},
});

// Core calls go through Bun's native fetch (happy-dom's would add a CORS
// preflight the real Tauri webview never sends); any other origin is refused.
const rejectedEgress: string[] = [];
function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}
	return input instanceof URL ? input.href : input.url;
}
globalThis.fetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		if (new URL(url).origin !== server.url.origin) {
			rejectedEgress.push(url);
			return Promise.reject(new Error(`Unowned origin ${url}`));
		}
		return nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);
window.fetch = globalThis.fetch;

const { createRoot } = await import("react-dom/client");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { ComposioBillingSettings } = await import(
	"./ComposioBillingSettings.tsx"
);
const { rowAction, settle, settingsRow } = await import(
	"./connections-providers.test-support.ts"
);

let root: Root | null = null;
let container: HTMLDivElement;

function selectNode(name: string) {
	useNodeStore.setState({ defaultNode: name });
}

async function mount() {
	root = createRoot(container);
	await act(async () => root?.render(<ComposioBillingSettings />));
}

async function unmount() {
	const mounted = root;
	root = null;
	if (mounted) {
		await act(async () => mounted.unmount());
	}
}

function zdrRowTitle(): string {
	const title = [
		...container.querySelectorAll('[data-slot="item-title"]'),
	].find((element) =>
		element.textContent?.startsWith("Composio zero data retention")
	);
	return title?.textContent ?? "";
}

function text(): string {
	return container.textContent ?? "";
}

beforeEach(() => {
	replies.clear();
	holds.clear();
	releases.clear();
	requests.length = 0;
	unexpected.length = 0;
	rejectedEgress.length = 0;
	const nodeUrl = server.url.origin;
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: NODE_A.name,
		nodes: [
			{ name: NODE_A.name, token: NODE_A.token, url: nodeUrl },
			{ name: NODE_B.name, token: NODE_B.token, url: nodeUrl },
		],
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	for (const release of releases.values()) {
		release();
	}
	await unmount();
	container.remove();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must stay on the one declared Core route with a node token.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: no request may leave the loopback fixture.
	expect(rejectedEgress).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

test("the active node's enabled Composio ZDR rollout shows On with the $0.70 direct-call total and the shared usage rates", async () => {
	replies.set(NODE_A.token, { body: policy(true), status: 200 });
	await mount();
	await settle(
		() => zdrRowTitle() === "Composio zero data retention · On",
		"rollout on",
		text
	);

	expect(text()).toContain(
		"Enabled globally. Adds $0.10 per 1,000 tool calls for every organization. Direct managed calls total $0.70 per 1,000 before premium charges."
	);
	expect(text()).not.toContain("Pending platform activation");
	// The three fixed usage rows and the OpenRouter ZDR row read the same for
	// every plan; their rates are the user-facing effect of each row.
	for (const title of [
		"Managed tool calls",
		"Delivered trigger events",
		"Premium tools",
		"OpenRouter zero data retention · On",
	]) {
		expect(settingsRow(title, container)).not.toBeNull();
		expect(rowAction(title, container)).toBe("");
	}
	expect(text()).toContain(
		"$0.50 per 1,000 calls. Direct execution outside a Session adds $0.10 per 1,000 calls."
	);
	expect(text()).toContain(
		"$5.00 per 1,000 events. Polling and the number of agents started do not multiply the event charge."
	);
	expect(text()).toContain(
		"The actual Composio charge is passed through. It already includes their provider fee; Ryu does not add another 5%."
	);
	expect(text()).toContain(
		"Required for every plan. Requests use ZDR endpoints and exclude data-collecting providers. Credits use the actual reported provider cost."
	);
	// The surface is read-only: no switch, input or button to change the policy.
	expect(
		container.querySelectorAll('[role="switch"], input, button, select')
	).toHaveLength(0);
	const coverage = container.querySelector<HTMLAnchorElement>(
		'a[href="https://docs.composio.dev/docs/security/zero-data-retention"]'
	);
	expect(coverage?.textContent).toBe("Review Composio ZDR coverage");
	expect(coverage?.target).toBe("_blank");
	expect(coverage?.rel).toContain("noopener");
	expect(requests).toEqual([
		{
			authorization: `Bearer ${NODE_A.token}`,
			clientId: expect.any(String),
			method: "GET",
		},
	]);
});

test("a pending rollout reads Off with no surcharge and the $0.60 direct-call total", async () => {
	replies.set(NODE_A.token, { body: policy(false), status: 200 });
	await mount();
	await settle(
		() => zdrRowTitle() === "Composio zero data retention · Off",
		"rollout off",
		text
	);
	expect(text()).toContain(
		"Pending platform activation. No ZDR surcharge is billed. Direct managed calls total $0.60 per 1,000 before premium charges."
	);
	expect(text()).not.toContain("$0.70 per 1,000");
	expect(text()).not.toContain("Enabled globally");
});

test("until Core answers, and when it cannot report the policy, the row says Checking instead of claiming Off", async () => {
	holdNext(NODE_A.token);
	replies.set(NODE_A.token, { body: policy(false), status: 200 });
	await mount();
	await settle(() => requests.length === 1, "config request", text);
	expect(zdrRowTitle()).toBe("Composio zero data retention · Checking");
	expect(text()).toContain("Checking the shared project's rollout status.");
	releases.get(NODE_A.token)?.();
	await settle(
		() => zdrRowTitle() === "Composio zero data retention · Off",
		"held answer applied",
		text
	);
	await unmount();

	// An older Core whose config has no Composio policy, and a Core that fails
	// the read, both stay on the neutral copy rather than reporting Off.
	for (const reply of [
		{ body: { providers: {} }, status: 200 },
		{ body: { error: "gateway offline" }, status: 502 },
	]) {
		replies.set(NODE_A.token, reply);
		const before = requests.length;
		await mount();
		await settle(() => requests.length === before + 1, "config reread", text);
		await settle(
			() =>
				text().includes("Checking the shared project's rollout status.") &&
				zdrRowTitle() === "Composio zero data retention · Checking",
			`unavailable policy (${reply.status})`,
			text
		);
		expect(text()).not.toContain("Pending platform activation");
		expect(text()).not.toContain("Enabled globally");
		await unmount();
	}
});

test("switching the active node rereads that node and ignores the previous node's late answer", async () => {
	replies.set(NODE_A.token, { body: policy(false), status: 200 });
	replies.set(NODE_B.token, { body: policy(true), status: 200 });
	holdNext(NODE_A.token);
	await mount();
	await settle(() => requests.length === 1, "node A request", text);

	await act(async () => selectNode(NODE_B.name));
	await settle(
		() => zdrRowTitle() === "Composio zero data retention · On",
		"node B policy",
		text
	);
	releases.get(NODE_A.token)?.();
	// Give node A's stale Off answer every chance to land.
	for (let round = 0; round < 20; round += 1) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	expect(zdrRowTitle()).toBe("Composio zero data retention · On");
	expect(text()).toContain("$0.70 per 1,000");
	expect(requests.map((request) => request.authorization)).toEqual([
		`Bearer ${NODE_A.token}`,
		`Bearer ${NODE_B.token}`,
	]);
});

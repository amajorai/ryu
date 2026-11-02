import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

import type { Root } from "react-dom/client";
import type { SecurityKeyRequestsState } from "./useSecurityKeyRequests.ts";

// React DOM decides at load time whether a DOM exists (and which input events
// it can listen to), so it is loaded only after the DOM is registered. A
// static import would be hoisted above the registration and break later test
// files in the same run that type into inputs.
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

/** What this device's Gateway reports for `computer_use.security_key`. */
let localSecurityKey: boolean | undefined = true;
const configTargets: string[] = [];
mock.module("@/src/lib/api/gateway.ts", () => ({
	fetchGatewayConfig: (target: { url: string }) => {
		configTargets.push(target.url);
		return Promise.resolve({
			computer_use: { locked_use: false, security_key: localSecurityKey },
		});
	},
}));

const { useNodeStore, LOCAL_FALLBACK } = await import(
	"@/src/store/useNodeStore.ts"
);
const { useSecurityKeyRequests } = await import("./useSecurityKeyRequests.ts");

const REMOTE = { name: "vm-1", token: "vm-token", url: "http://vm.test:7980" };
const realFetch = globalThis.fetch;
let fetched: Array<{ body: unknown; method: string; url: string }> = [];
let listed: unknown[] = [];
let latest: SecurityKeyRequestsState | null = null;
let root: Root;

function Probe() {
	latest = useSecurityKeyRequests();
	return null;
}

/**
 * A request as the node's Core lists it: `createdAt` and the deadline are on
 * the node's clock, which `clockOffset` puts ahead of (or behind) this one.
 */
function pending(
	id: string,
	createdAt: number,
	window = 60_000,
	clockOffset = 0
) {
	const nodeCreated = Date.now() + clockOffset + createdAt;
	return {
		agent_id: "agent-7",
		client_data_json: "e30",
		created_at_ms: nodeCreated,
		expires_at_ms: nodeCreated + window,
		id,
		kind: "get",
		options: {},
		origin: "https://example.com",
		page_url: "https://example.com/login",
		rp_id: "example.com",
	};
}

async function settle(rounds = 5): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

beforeEach(() => {
	fetched = [];
	configTargets.length = 0;
	listed = [];
	latest = null;
	localSecurityKey = true;
	useNodeStore.setState({
		defaultNode: REMOTE.name,
		localNodes: [LOCAL_FALLBACK, REMOTE],
		nodes: [LOCAL_FALLBACK, REMOTE],
	});
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			fetched.push({
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
				method: init?.method ?? "GET",
				url,
			});
			return Promise.resolve(
				url.endsWith("/response")
					? Response.json({ ok: true })
					: Response.json({ requests: listed })
			);
		},
		{ preconnect: realFetch.preconnect }
	);
	root = createRoot(document.createElement("div"));
});

afterEach(async () => {
	await act(async () => root.unmount());
	globalThis.fetch = realFetch;
});

const requestReads = () =>
	fetched.filter((entry) => entry.url.endsWith("/api/security-key/requests"));

test("reads the gate from this device and polls the active node", async () => {
	listed = [pending("second", 200), pending("first", 100)];
	await act(async () => root.render(<Probe />));
	await settle();
	expect(configTargets[0]).toBe(LOCAL_FALLBACK.url);
	expect(requestReads()[0]?.url).toBe(
		`${REMOTE.url}/api/security-key/requests`
	);
	expect(latest?.enabled).toBe(true);
	expect(latest?.nodeName).toBe(REMOTE.name);
	expect(latest?.request?.id).toBe("first");
});

test("with this device's setting off it never asks for requests", async () => {
	localSecurityKey = false;
	listed = [pending("first", 100)];
	await act(async () => root.render(<Probe />));
	await settle();
	expect(configTargets.length).toBeGreaterThan(0);
	expect(requestReads()).toEqual([]);
	expect(latest?.enabled).toBe(false);
	expect(latest?.request).toBeNull();
});

test("a Gateway that predates the field counts as off", async () => {
	localSecurityKey = undefined;
	await act(async () => root.render(<Probe />));
	await settle();
	expect(requestReads()).toEqual([]);
	expect(latest?.enabled).toBe(false);
});

test("requests whose window has run out are not shown", async () => {
	listed = [pending("stale", 100, 0)];
	await act(async () => root.render(<Probe />));
	await settle();
	expect(requestReads().length).toBeGreaterThan(0);
	expect(latest?.request).toBeNull();
});

test("answering posts the decision and moves to the next request", async () => {
	listed = [pending("first", 100), pending("second", 200)];
	await act(async () => root.render(<Probe />));
	await settle();
	expect(latest?.request?.id).toBe("first");
	await act(async () => {
		await latest?.answer("first", {
			decision: "deny",
			reason: "denied_by_user",
		});
	});
	expect(fetched.at(-1)).toEqual({
		body: { decision: "deny", reason: "denied_by_user" },
		method: "POST",
		url: `${REMOTE.url}/api/security-key/requests/first/response`,
	});
	expect(latest?.request?.id).toBe("second");
});

const HOUR_MS = 3_600_000;

test("a node whose clock runs behind still shows its requests", async () => {
	listed = [pending("behind", 0, 30_000, -HOUR_MS)];
	await act(async () => root.render(<Probe />));
	await settle();
	expect(latest?.request?.id).toBe("behind");
	const left = (latest?.request?.expires_at_ms ?? 0) - Date.now();
	expect(left).toBeGreaterThan(25_000);
	expect(left).toBeLessThanOrEqual(30_000);
});

test("a node whose clock runs ahead gets a deadline on this clock", async () => {
	listed = [pending("ahead", 0, 30_000, HOUR_MS)];
	await act(async () => root.render(<Probe />));
	await settle();
	expect(latest?.request?.id).toBe("ahead");
	const left = (latest?.request?.expires_at_ms ?? 0) - Date.now();
	expect(left).toBeGreaterThan(25_000);
	expect(left).toBeLessThanOrEqual(30_000);
});

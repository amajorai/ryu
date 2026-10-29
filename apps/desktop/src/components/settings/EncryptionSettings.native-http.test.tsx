import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { EncryptionStatus } from "@/src/lib/api/encryption.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

// Native HTTP and the shipping NodeStore/hook/SDK/component; no API or hook aliases.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let ownedOrigin: string | null = null;
const rejectedEgress: string[] = [];
let inFlight = 0;
let decoded = 0;
globalThis.fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new NativeRequest(input, init);
		if (new URL(request.url).origin !== ownedOrigin) {
			rejectedEgress.push(request.url);
			throw new Error("Encryption proof refuses unowned HTTP egress");
		}
		inFlight++;
		try {
			const response = await nativeFetch(input, init);
			const text = response.text.bind(response);
			response.text = async () => {
				const body = await text();
				decoded++;
				return body;
			};
			return response;
		} finally {
			inFlight--;
		}
	},
	{ preconnect: nativeFetch.preconnect }
);
window.fetch = globalThis.fetch;
const { createRoot } = await import("react-dom/client");
const { EncryptionSettings } = await import("./EncryptionSettings.tsx");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { fetchEncryptionStatus } = await import("@/src/lib/api/encryption.ts");
const originalNodeState = useNodeStore.getState();
interface Call {
	jwt: string | null;
	path: string;
	status: number;
	token: string | null;
}
interface Hold {
	arrived: boolean;
	path: string;
	release?: () => void;
	status: number;
}
let calls: Call[] = [];
let holds: Hold[] = [];
let unexpected: string[] = [];
let statuses = new Map<string, EncryptionStatus>();
let admitted = new Set<string>();
let refuseNext = false;
let root: Root;
let container: HTMLDivElement;
let server: ReturnType<typeof Bun.serve>;
function status(
	label: string,
	custody: "keychain" | "file" | "env" | "unavailable"
): EncryptionStatus {
	return {
		dataDir: `/isolated-${label}`,
		key: {
			available: custody !== "unavailable",
			envVar: "RYU_MASTER_KEY",
			error: custody === "unavailable" ? `Missing key ${label}` : null,
			keychainAccount: custody === "keychain" ? `master-${label}` : null,
			keychainService: custody === "keychain" ? "com.ryu.dev" : null,
			keyFile: custody === "file" ? `/isolated-${label}/master.key` : null,
			legacyMemoryKeyPresent: false,
			source: custody === "unavailable" ? null : custody,
		},
		stores:
			custody === "unavailable"
				? []
				: [
						{
							id: "chats",
							label: `Chats ${label}`,
							detail: `Measured ${label}`,
							sealed: custody === "keychain" ? 9 : 2,
							total: 9,
							status: custody === "keychain" ? "sealed" : "partial",
						},
					],
	};
}
function node(
	name: string,
	path = name,
	token = `node-${name}`,
	userJwt = `user-${name}`
): Node {
	return { name, url: `${server.url.origin}/${path}`, token, userJwt };
}
function admit(n: Node) {
	admitted.add(
		JSON.stringify([
			new URL(n.url).pathname.replace(/\/$/, ""),
			`Bearer ${n.token}`,
			n.userJwt ?? null,
		])
	);
}
function select(n: Node) {
	admit(n);
	useNodeStore.setState({
		nodes: [n],
		localNodes: [n],
		cloudNodes: [],
		defaultNode: n.name,
		tabOverrides: {},
		autoSelect: false,
		autoSelectedNode: null,
	});
}
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(
				`Encryption state did not settle: ${container.textContent}; ledger=${JSON.stringify(calls)}`
			);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}
async function choose(n: Node) {
	await act(async () => select(n));
}
async function mount() {
	await act(async () => root.render(<EncryptionSettings />));
}
async function visible(label: string) {
	await until(
		() => container.textContent?.includes(`/isolated-${label}`) === true
	);
}
async function click(name: string) {
	const button = [...container.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === name
	);
	if (!button) {
		throw new Error(`Shipping ${name} button missing`);
	}
	await act(async () => button.click());
}
async function release(h: Hold) {
	if (!h.release) {
		throw new Error("Held native request has not arrived");
	}
	const previous = decoded;
	await act(async () => h.release?.());
	await until(() => decoded > previous);
}
beforeEach(() => {
	calls = [];
	holds = [];
	unexpected = [];
	admitted = new Set();
	statuses = new Map();
	refuseNext = false;
	decoded = 0;
	inFlight = 0;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const match = /^\/([^/]+)\/api\/encryption\/status$/.exec(url.pathname);
			if (request.method !== "GET" || !match || url.search) {
				unexpected.push(`${request.method} ${url.pathname}${url.search}`);
				return NativeResponse.json(
					{ error: "Unknown fixture contract" },
					{ status: 503 }
				);
			}
			const token = request.headers.get("authorization");
			const jwt = request.headers.get("x-ryu-user-jwt");
			if (!admitted.has(JSON.stringify([`/${match[1]}`, token, jwt]))) {
				unexpected.push("Incorrect actual SDK authority");
				return NativeResponse.json(
					{ error: "Incorrect authority" },
					{ status: 401 }
				);
			}
			const snapshot = structuredClone(statuses.get(match[1]!));
			if (!snapshot) {
				unexpected.push("Missing persisted status");
				return NativeResponse.json(
					{ error: "Missing status" },
					{ status: 503 }
				);
			}
			const held = holds.find((h) => h.path === match[1] && !h.arrived);
			const code = held?.status ?? (refuseNext ? 403 : 200);
			refuseNext = false;
			calls.push({ path: url.pathname, token, jwt, status: code });
			if (held) {
				held.arrived = true;
				await new Promise<void>((resolve) => {
					held.release = resolve;
				});
			}
			return code === 200
				? NativeResponse.json(snapshot)
				: NativeResponse.json(
						{ error: "Status read refused" },
						{ status: code }
					);
		},
	});
	ownedOrigin = server.url.origin;
	statuses.set("A", status("A", "keychain"));
	statuses.set("B", status("B", "file"));
	select(node("A"));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	for (const h of holds) {
		h.release?.();
	}
	await until(() => inFlight === 0 && decoded === calls.length);
	await act(async () => root.unmount());
	server.stop(true);
	container.remove();
	ownedOrigin = null;
	useNodeStore.setState(originalNodeState, true);
	// biome-ignore lint/suspicious/noMisplacedAssertion: Every actual test rejects unknown fixture routes and authority.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: Every actual test rejects external network access.
	expect(rejectedEgress).toEqual([]);
});
afterAll(() => {
	globalThis.fetch = nativeFetch;
});
for (const custody of ["keychain", "file", "env", "unavailable"] as const) {
	test(`renders the actual ${custody} response and agrees with independent SDK readback`, async () => {
		statuses.set("A", status("A", custody));
		await mount();
		if (custody === "unavailable") {
			await until(
				() => container.textContent?.includes("Missing key A") === true
			);
		} else {
			await visible("A");
		}
		const readback = await fetchEncryptionStatus(node("A"));
		expect(readback).toEqual(statuses.get("A")!);
		if (custody === "env") {
			expect(container.textContent).toContain("RYU_MASTER_KEY");
			expect(container.textContent).toContain("Held outside your data");
		}
		expect(
			calls.every(
				(call) => call.token === "Bearer node-A" && call.jwt === "user-A"
			)
		).toBe(true);
		expect(container.textContent).toContain(
			custody === "keychain"
				? "All 9 stored items encrypted"
				: custody === "file"
					? "2 of 9 stored items encrypted"
					: custody === "env"
						? "Environment variable"
						: "This node cannot load its encryption key"
		);
	});
}
test("403 exposes a read failure and explicit Retry obtains actual current status", async () => {
	refuseNext = true;
	await mount();
	await until(
		() => container.textContent?.includes("We couldn't read") === true
	);
	expect(container.textContent).not.toContain("System keychain");
	await click("Retry");
	await visible("A");
	expect(calls.map((c) => c.status)).toEqual([403, 200]);
});
for (const dimension of ["URL", "token", "JWT"] as const) {
	for (const code of [200, 403]) {
		test(`retired ${dimension} ${code} read cannot overwrite current weaker custody`, async () => {
			const held: Hold = { path: "A", status: code, arrived: false };
			holds.push(held);
			await mount();
			await until(() => held.arrived);
			const current =
				dimension === "URL"
					? node("B")
					: node(
							"A",
							"A",
							dimension === "token" ? "rotated-token" : "node-A",
							dimension === "JWT" ? "rotated-user" : "user-A"
						);
			const label = dimension === "URL" ? "B" : "current";
			if (dimension !== "URL") {
				statuses.set("A", status(label, "file"));
			}
			await choose(current);
			await visible(label);
			expect(container.textContent).toContain("Stored with your data");
			await release(held);
			expect(container.textContent).toContain(`/isolated-${label}`);
			expect(container.textContent).not.toContain("System keychain");
			expect(container.textContent).not.toContain("We couldn't read");
			expect(calls.at(-1)).toMatchObject({
				token: `Bearer ${current.token}`,
				jwt: current.userJwt,
			});
		});
	}
}
for (const code of [200, 403]) {
	test(`A to B to A does not revive retired ${code} status`, async () => {
		const held: Hold = { path: "A", status: code, arrived: false };
		holds.push(held);
		await mount();
		await until(() => held.arrived);
		await choose(node("B"));
		await visible("B");
		statuses.set("A", status("A-return", "file"));
		await choose(node("A"));
		await visible("A-return");
		await release(held);
		expect(container.textContent).toContain("/isolated-A-return");
		expect(container.textContent).not.toContain("System keychain");
		expect(container.textContent).not.toContain("We couldn't read");
	});
}
for (const code of [200, 403]) {
	test(`older same-authority Refresh ${code} cannot replace a later measured status`, async () => {
		await mount();
		await visible("A");
		const held: Hold = { path: "A", status: code, arrived: false };
		holds.push(held);
		await click("Refresh");
		await until(() => held.arrived);
		statuses.set("A", status("latest", "file"));
		await click("Refresh");
		await visible("latest");
		await release(held);
		expect(container.textContent).toContain("/isolated-latest");
		expect(container.textContent).not.toContain("System keychain");
		expect(container.textContent).not.toContain("We couldn't read");
	});
}

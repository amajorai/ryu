import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { EncryptionStatus, KeyCustody } from "@/src/lib/api/encryption.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

// The REAL Encryption tab, the real node store and the production SDK against a
// loopback Bun "Core" that serves GET /api/encryption/status per node path and
// requires that node's credentials. Each custody row is asserted inside its own
// settings row, so a value rendered under the wrong title fails.
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
const nativeFetch = globalThis.fetch;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let ownedOrigin: string | null = null;
const rejectedEgress: string[] = [];
let inFlight = 0;
const guardedFetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(new NativeRequest(input, init).url);
		if (url.origin !== ownedOrigin) {
			rejectedEgress.push(url.href);
			throw new Error("Encryption coverage refuses unowned HTTP egress");
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

const { createRoot } = await import("react-dom/client");
const { EncryptionSettings } = await import("./EncryptionSettings.tsx");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { button, click, maybeRow, settle } = await import(
	"./privacy-security.test-support.ts"
);

interface Call {
	authorization: string | null;
	jwt: string | null;
	path: string;
}
let statuses = new Map<string, EncryptionStatus>();
let calls: Call[] = [];
let unexpected: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		const match = /^\/(alpha|beta)\/api\/encryption\/status$/.exec(
			url.pathname
		);
		if (request.method !== "GET" || !match) {
			unexpected.push(`${request.method} ${url.pathname}`);
			return NativeResponse.json({ error: "Unknown route" }, { status: 404 });
		}
		const name = match[1]!;
		const authorization = request.headers.get("authorization");
		const jwt = request.headers.get("x-ryu-user-jwt");
		calls.push({ authorization, jwt, path: url.pathname });
		if (authorization !== `Bearer ${name}-token` || jwt !== `${name}-user`) {
			unexpected.push(`wrong authority for ${name}`);
			return NativeResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		const status = statuses.get(name);
		if (!status) {
			unexpected.push(`no status for ${name}`);
			return NativeResponse.json({ error: "No status" }, { status: 503 });
		}
		return NativeResponse.json(structuredClone(status));
	},
});
ownedOrigin = server.url.origin;

function node(name: "alpha" | "beta"): Node {
	return {
		name,
		url: `${server.url.origin}/${name}`,
		token: `${name}-token`,
		userJwt: `${name}-user`,
	};
}
function custody(overrides: Partial<KeyCustody>): KeyCustody {
	return {
		available: true,
		envVar: "RYU_MASTER_KEY",
		error: null,
		keychainAccount: null,
		keychainService: null,
		keyFile: null,
		legacyMemoryKeyPresent: false,
		source: "keychain",
		...overrides,
	};
}
function status(dataDir: string, key: KeyCustody): EncryptionStatus {
	return {
		dataDir,
		key,
		stores: [
			{
				detail: "Messages are sealed before they reach disk.",
				id: "conversations",
				label: "Chats",
				sealed: 4,
				status: "sealed",
				total: 4,
			},
		],
	};
}
function select(name: "alpha" | "beta") {
	useNodeStore.setState({
		nodes: [node(name)],
		localNodes: [],
		defaultNode: name,
		autoSelect: false,
	});
}
const savedNodeState = useNodeStore.getState();
let root: Root | null = null;

async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<EncryptionSettings />));
	await settle(() => maybeRow("Location") !== null, "encryption status");
}
async function refresh(until: () => boolean, label: string) {
	const before = calls.length;
	await click(button("Refresh"));
	await settle(() => calls.length > before && until(), label);
}
/** The text a row shows beside its title; empty while the row is absent. */
function valueIn(title: string) {
	return maybeRow(title)?.textContent?.replace(title, "").trim() ?? "";
}

beforeEach(() => {
	calls = [];
	unexpected = [];
	statuses = new Map();
	select("alpha");
});
afterEach(async () => {
	await settle(() => inFlight === 0, "encryption HTTP drained");
	if (root) {
		const current = root;
		await act(async () => current.unmount());
		root = null;
	}
	document.body.replaceChildren();
	useNodeStore.setState(savedNodeState);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case keeps to the owned status contract and node authority.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case refuses foreign egress.
	expect(rejectedEgress).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

test("Keychain entry shows the exact service/account Core reports, follows a rotated account on Refresh, and is absent without an account", async () => {
	statuses.set(
		"alpha",
		status(
			"/data/alpha",
			custody({ keychainAccount: "master-key", keychainService: "com.ryu" })
		)
	);
	await mount();
	expect(valueIn("Keychain entry")).toBe("com.ryu/master-key");
	expect(valueIn("System keychain")).toBe("Held outside your data");
	expect(maybeRow("Provided by")).toBeNull();
	expect(maybeRow("Key file")).toBeNull();
	expect(maybeRow("Older memory.key still in the data folder")).toBeNull();

	statuses.set(
		"alpha",
		status(
			"/data/alpha",
			custody({
				keychainAccount: "master-key-dev",
				keychainService: "com.ryu.dev",
			})
		)
	);
	await refresh(
		() => valueIn("Keychain entry") === "com.ryu.dev/master-key-dev",
		"rotated keychain entry"
	);

	statuses.set(
		"alpha",
		status(
			"/data/alpha",
			custody({ keychainAccount: null, keychainService: "com.ryu.dev" })
		)
	);
	await refresh(
		() => maybeRow("Keychain entry") === null,
		"keychain entry without account"
	);
	expect(valueIn("System keychain")).toBe("Held outside your data");
	expect(calls.map((call) => call.path)).toEqual([
		"/alpha/api/encryption/status",
		"/alpha/api/encryption/status",
		"/alpha/api/encryption/status",
	]);
});

test("Provided by names the environment variable Core consulted and appears only for environment custody", async () => {
	statuses.set(
		"alpha",
		status(
			"/srv/ryu",
			custody({ envVar: "RYU_MASTER_KEY_PROD", source: "env" })
		)
	);
	await mount();
	expect(valueIn("Provided by")).toBe("RYU_MASTER_KEY_PROD");
	expect(valueIn("Environment variable")).toBe("Held outside your data");
	expect(maybeRow("Keychain entry")).toBeNull();
	expect(maybeRow("Key file")).toBeNull();
	expect(document.body.textContent).toContain("never written to disk by Ryu");

	statuses.set(
		"alpha",
		status(
			"/srv/ryu",
			custody({
				keychainAccount: "master-key",
				keychainService: "com.ryu",
				source: "keychain",
			})
		)
	);
	await refresh(() => maybeRow("Provided by") === null, "custody moved");
	expect(valueIn("Keychain entry")).toBe("com.ryu/master-key");
});

test("Key file shows the fallback path with a stored-with-data warning, Older memory.key is marked Superseded, and both clear when custody recovers", async () => {
	statuses.set(
		"alpha",
		status(
			"/home/me/.ryu",
			custody({
				keyFile: "/home/me/.ryu/master.key",
				legacyMemoryKeyPresent: true,
				source: "file",
			})
		)
	);
	await mount();
	expect(valueIn("Key file")).toBe("/home/me/.ryu/master.key");
	expect(valueIn("Key file in the data folder")).toBe("Stored with your data");
	expect(valueIn("Older memory.key still in the data folder")).toBe(
		"Superseded"
	);
	expect(document.body.textContent).toContain(
		"Anyone who copies the data folder gets both."
	);

	statuses.set(
		"alpha",
		status(
			"/home/me/.ryu",
			custody({
				keyFile: "/home/me/.ryu/master.key",
				legacyMemoryKeyPresent: false,
				source: "file",
			})
		)
	);
	await refresh(
		() => maybeRow("Older memory.key still in the data folder") === null,
		"legacy key removed"
	);
	expect(valueIn("Key file")).toBe("/home/me/.ryu/master.key");

	statuses.set(
		"alpha",
		status(
			"/home/me/.ryu",
			custody({
				keychainAccount: "master-key",
				keychainService: "com.ryu",
				source: "keychain",
			})
		)
	);
	await refresh(() => maybeRow("Key file") === null, "file custody cleared");
	expect(maybeRow("Key file in the data folder")).toBeNull();
	expect(valueIn("System keychain")).toBe("Held outside your data");
});

test("Location shows the active node's data folder and follows a node switch with that node's credentials", async () => {
	statuses.set(
		"alpha",
		status(
			"/Users/alpha/.ryu",
			custody({ keychainAccount: "a", keychainService: "svc" })
		)
	);
	statuses.set(
		"beta",
		status(
			"/Volumes/beta/.ryu",
			custody({ keychainAccount: "b", keychainService: "svc" })
		)
	);
	await mount();
	expect(valueIn("Location")).toBe("/Users/alpha/.ryu");
	await act(async () => select("beta"));
	await settle(
		() => valueIn("Location") === "/Volumes/beta/.ryu",
		"beta data folder"
	);
	expect(valueIn("Keychain entry")).toBe("svc/b");
	expect(calls.at(-1)).toEqual({
		authorization: "Bearer beta-token",
		jwt: "beta-user",
		path: "/beta/api/encryption/status",
	});
	statuses.set(
		"beta",
		status(
			"/Volumes/beta-moved/.ryu",
			custody({ keychainAccount: "b", keychainService: "svc" })
		)
	);
	await refresh(
		() => valueIn("Location") === "/Volumes/beta-moved/.ryu",
		"moved data folder"
	);
	expect(calls.filter((call) => call.path.startsWith("/alpha"))).toHaveLength(
		1
	);
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type {
	A2aPeer,
	A2aPrincipal,
	A2aScope,
	A2aServerConfig,
} from "@/src/lib/api/a2a.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { sileo } = await import("sileo");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { A2aSettingsView } = await import("./A2aSettings.tsx");

const node: Node = {
	name: "a2a-proof",
	url: "https://a2a.fixture:7980",
	token: "a2a-token",
	userJwt: null,
};

interface Call {
	body: unknown;
	method: string;
	path: string;
}
const originalFetch = globalThis.fetch;
const originalNodes = useNodeStore.getState();
const roots: Root[] = [];
let calls: Call[] = [];
let settings: A2aServerConfig;
let peers: A2aPeer[] = [];
let principals: A2aPrincipal[] = [];
let saveError: { status: number; message: string } | null = null;
let discoverError: { status: number; message: string } | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
let successToast: ReturnType<typeof spyOn<typeof sileo, "success">>;

function peer(overrides: Partial<A2aPeer>): A2aPeer {
	return {
		agentCard: null,
		agentCardUrl: "https://peer.example/.well-known/agent-card.json",
		createdAt: "2026-10-01T00:00:00Z",
		credentialConfigured: false,
		credentialKind: "none",
		enabled: true,
		id: "peer-1",
		lastError: null,
		name: "Peer One",
		tenantId: "tenant",
		trust: "pending",
		updatedAt: "2026-10-01T00:00:00Z",
		...overrides,
	};
}

function respond(call: Call): Response {
	const revoked = /^\/api\/a2a\/principals\/(.+)$/u.exec(call.path)?.[1];
	if (call.method === "DELETE" && revoked) {
		principals = principals.map((principal) =>
			principal.id === revoked
				? { ...principal, revokedAt: "2026-10-26T00:00:00Z" }
				: principal
		);
		return Response.json({ revoked: true });
	}
	switch (`${call.method} ${call.path}`) {
		case "GET /api/a2a/settings":
			return Response.json(settings);
		case "PUT /api/a2a/settings": {
			if (saveError) {
				return Response.json(
					{ error: saveError.message },
					{ status: saveError.status }
				);
			}
			settings = {
				...(call.body as A2aServerConfig),
				updatedAt: `2026-10-26T00:00:0${calls.length % 10}Z`,
			};
			return Response.json(settings);
		}
		case "GET /api/a2a/peers":
			return Response.json(peers);
		case "POST /api/a2a/discover": {
			if (discoverError) {
				return Response.json(
					{ error: discoverError.message },
					{ status: discoverError.status }
				);
			}
			const input = call.body as { name?: string; url: string };
			const created = peer({
				id: `peer-${peers.length + 1}`,
				name: input.name ?? "Discovered",
				agentCardUrl: input.url,
			});
			peers = [...peers, created];
			return Response.json(created);
		}
		case "GET /api/a2a/principals":
			return Response.json(principals);
		case "POST /api/a2a/principals": {
			const input = call.body as { name: string; scopes: A2aScope[] };
			const principal: A2aPrincipal = {
				createdAt: "2026-10-26T00:00:00Z",
				id: `principal-${principals.length + 1}`,
				lastUsedAt: null,
				name: input.name,
				revokedAt: null,
				scopes: input.scopes,
				tenantId: "tenant",
			};
			principals = [...principals, principal];
			return Response.json({ principal, token: "a2a_once_secret" });
		}
		case "GET /api/a2a/published-agents":
		case "GET /api/a2a/tasks":
			return Response.json([]);
		default:
			return Response.json({ error: "undeclared" }, { status: 404 });
	}
}

beforeEach(() => {
	calls = [];
	peers = [];
	principals = [];
	saveError = null;
	discoverError = null;
	settings = {
		description: "Local agents",
		displayName: "Ryu node",
		enabled: false,
		exposeExtendedCard: false,
		maxConcurrentTasks: 4,
		maxPayloadBytes: 4 * 1024 * 1024,
		publicBaseUrl: null,
		requireSignedPeerCards: false,
		tenantId: "tenant",
		updatedAt: "2026-10-01T00:00:00Z",
	};
	useNodeStore.setState({
		nodes: [node],
		defaultNode: node.name,
		autoSelect: false,
	});
	errorToast = spyOn(sileo, "error");
	successToast = spyOn(sileo, "success");
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const call: Call = {
				path: url.pathname,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			calls.push(call);
			return await Promise.resolve(respond(call));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	errorToast.mockRestore();
	successToast.mockRestore();
	globalThis.fetch = originalFetch;
	useNodeStore.setState(originalNodes);
});

async function settle(ms = 10) {
	await act(async () => {
		await Bun.sleep(ms);
	});
}

async function until(predicate: () => boolean, reason: string) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) {
			return;
		}
		await settle();
	}
	throw new Error(reason);
}

async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<A2aSettingsView
					agentRoster={{
						agents: [],
						create: () => Promise.reject(new Error("not used")),
					}}
				/>
			</QueryClientProvider>
		)
	);
	await until(
		() => document.querySelector("#a2a-display-name") !== null,
		"A2A settings never loaded"
	);
}

function input(selector: string): HTMLInputElement {
	const element = document.querySelector<HTMLInputElement>(selector);
	if (!element) {
		throw new Error(`Missing ${selector}`);
	}
	return element;
}

async function type(selector: string, value: string) {
	const element = input(selector);
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function chooseCredential(kind: string) {
	const select = document.querySelector<HTMLSelectElement>(
		"#a2a-peer-credential-kind"
	);
	if (!select) {
		throw new Error("Missing credential picker");
	}
	await act(async () => {
		select.value = kind;
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

function button(name: string): HTMLButtonElement {
	const match = Array.from(document.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === name
	);
	if (!match) {
		throw new Error(`Missing button ${name}`);
	}
	return match;
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
	await settle();
}

function count(method: string, path: string): number {
	return calls.filter((call) => call.method === method && call.path === path)
		.length;
}

function titles(spy: { mock: { calls: unknown[][] } }): unknown[] {
	return spy.mock.calls.map((args) =>
		typeof args[0] === "object" && args[0] !== null
			? Reflect.get(args[0], "title")
			: args[0]
	);
}

function discoverBodies(): unknown[] {
	return calls
		.filter(
			(call) => call.method === "POST" && call.path === "/api/a2a/discover"
		)
		.map((call) => call.body);
}

test("saving the endpoint PUTs the edited config and refetches the stored settings", async () => {
	await mount();
	const readsBefore = count("GET", "/api/a2a/settings");
	const toggle = document.querySelector<HTMLElement>(
		'[role="switch"][aria-label="Accept inbound A2A tasks"]'
	);
	if (!toggle) {
		throw new Error("Missing inbound switch");
	}
	await click(toggle);
	await type("#a2a-display-name", "Team node");
	await type("#a2a-public-base", "https://agent.example.com/");
	expect(document.body.textContent).toContain(
		"https://agent.example.com/.well-known/agent-card.json"
	);

	await click(button("Save endpoint"));
	await until(
		() => count("GET", "/api/a2a/settings") > readsBefore,
		"settings were not refetched after save"
	);

	const put = calls.find(
		(call) => call.method === "PUT" && call.path === "/api/a2a/settings"
	);
	expect(put?.body).toMatchObject({
		enabled: true,
		displayName: "Team node",
		publicBaseUrl: "https://agent.example.com/",
		maxConcurrentTasks: 4,
	});
	expect(titles(successToast)).toContain("A2A endpoint settings saved");
	expect(settings.displayName).toBe("Team node");
	expect(input("#a2a-display-name").value).toBe("Team node");
});

test("a rejected save shows Core's error and does not refetch", async () => {
	saveError = { status: 403, message: "A2A settings are admin-only" };
	await mount();
	await type("#a2a-display-name", "Hijacked");
	const readsBefore = count("GET", "/api/a2a/settings");

	await click(button("Save endpoint"));
	await until(() => errorToast.mock.calls.length > 0, "error never shown");

	expect(titles(errorToast)).toEqual(["A2A settings are admin-only"]);
	expect(successToast).not.toHaveBeenCalled();
	expect(count("GET", "/api/a2a/settings")).toBe(readsBefore);
	expect(settings.displayName).toBe("Ryu node");
});

test("discovery stays disabled until the chosen credential is complete and sends it in wire form", async () => {
	await mount();
	const discover = () => button("Discover peer");
	await type("#a2a-peer-url", "https://peer.example");
	await type("#a2a-peer-name", "OAuth Peer");
	// Bearer is the default kind; a blank or whitespace token is not a credential.
	expect(discover().disabled).toBe(true);
	await type("#a2a-peer-token", "   ");
	expect(discover().disabled).toBe(true);

	await chooseCredential("oauth2_client_credentials");
	await type("#a2a-peer-oauth-url", "https://auth.example/token");
	await type("#a2a-peer-oauth-client", "client-1");
	expect(discover().disabled).toBe(true);
	await type("#a2a-peer-oauth-secret", "secret-1");
	await type("#a2a-peer-oauth-scopes", " a2a.send, a2a.read   extra ");
	expect(discover().disabled).toBe(false);

	await click(discover());
	await until(() => successToast.mock.calls.length > 0, "discovery never ok");

	expect(discoverBodies()).toEqual([
		{
			credential: {
				clientId: "client-1",
				clientSecret: "secret-1",
				kind: "oauth2_client_credentials",
				scopes: ["a2a.send", "a2a.read", "extra"],
				tokenUrl: "https://auth.example/token",
			},
			name: "OAuth Peer",
			url: "https://peer.example",
		},
	]);
	// The peer list is refetched so the discovered peer shows up for review.
	await until(
		() => document.querySelector('[title="OAuth Peer"]') !== null,
		"discovered peer was not listed"
	);
	// The form resets to a blank bearer draft after a successful discovery.
	expect(input("#a2a-peer-url").value).toBe("");
	expect(input("#a2a-peer-name").value).toBe("");
	expect(input("#a2a-peer-token").value).toBe("");

	await type("#a2a-peer-url", "https://open.example");
	await chooseCredential("none");
	expect(discover().disabled).toBe(false);
	await click(discover());
	await until(() => discoverBodies().length === 2, "second discovery missing");
	expect(discoverBodies()[1]).toEqual({ url: "https://open.example" });
});

test("API key and basic credentials need every field before discovery", async () => {
	await mount();
	await type("#a2a-peer-url", "https://peer.example");
	await chooseCredential("api_key");
	await type("#a2a-peer-api-value", "key-1");
	await type("#a2a-peer-api-header", "  ");
	expect(button("Discover peer").disabled).toBe(true);
	await type("#a2a-peer-api-header", "X-Peer-Key");
	expect(button("Discover peer").disabled).toBe(false);

	await chooseCredential("basic");
	await type("#a2a-peer-basic-user", "ada");
	expect(button("Discover peer").disabled).toBe(true);
	await type("#a2a-peer-basic-password", "pw");
	expect(button("Discover peer").disabled).toBe(false);
	await click(button("Discover peer"));
	await until(() => discoverBodies().length === 1, "discovery missing");
	expect(discoverBodies()[0]).toEqual({
		credential: { kind: "basic", password: "pw", username: "ada" },
		url: "https://peer.example",
	});
});

test("a failed discovery surfaces the server message and keeps the draft", async () => {
	discoverError = { status: 422, message: "Agent Card signature is invalid" };
	await mount();
	await type("#a2a-peer-url", "https://peer.example");
	await type("#a2a-peer-token", "tok");
	await click(button("Discover peer"));
	await until(() => errorToast.mock.calls.length > 0, "error never shown");

	expect(titles(errorToast)).toEqual(["Agent Card signature is invalid"]);
	expect(input("#a2a-peer-url").value).toBe("https://peer.example");
	expect(input("#a2a-peer-token").value).toBe("tok");
});

test("each peer's card-signature badge carries the matching detail", async () => {
	peers = [
		peer({
			id: "signed",
			name: "Signed Peer",
			cardSignature: { status: "verified", kid: "key-7" },
		}),
		peer({
			id: "plain",
			name: "Plain Peer",
			cardSignature: { status: "unsigned" },
		}),
		peer({
			id: "bad",
			name: "Bad Peer",
			cardSignature: { status: "invalid", reason: "JWS does not match" },
		}),
		peer({
			id: "unchecked",
			name: "Unchecked Peer",
			cardSignature: { status: "unverifiable", reason: "jku unreachable" },
		}),
		peer({ id: "legacy", name: "Legacy Peer" }),
	];
	await mount();
	await until(
		() => document.body.textContent?.includes("Legacy Peer") === true,
		"peers never listed"
	);

	const badges = new Map(
		Array.from(document.querySelectorAll<HTMLElement>("[title]"))
			.filter((badge) =>
				[
					"signed card",
					"unsigned card",
					"signature invalid",
					"signature unchecked",
				].includes(badge.textContent?.trim() ?? "")
			)
			.map((badge) => [badge.textContent?.trim(), badge.getAttribute("title")])
	);
	expect(Object.fromEntries(badges)).toEqual({
		"signed card": "Agent Card signature verified with key key-7",
		"unsigned card": "The peer's Agent Card carries no signature",
		"signature invalid": "JWS does not match",
		"signature unchecked": "jku unreachable",
	});
});

async function toggleScope(label: string) {
	const box = Array.from(
		document.querySelectorAll<HTMLLabelElement>("fieldset label")
	)
		.find((candidate) => candidate.textContent?.trim() === label)
		?.querySelector("input");
	if (!box) {
		throw new Error(`Missing scope ${label}`);
	}
	await click(box);
}

test("an inbound token is issued with only the checked scopes and can be revoked", async () => {
	await mount();
	const issue = () => button("Issue token");
	expect(issue().disabled).toBe(true);
	await type("#a2a-principal-name", "Hermes");
	expect(issue().disabled).toBe(false);
	await toggleScope("push config");
	await toggleScope("extended card");

	await click(issue());
	await until(
		() => document.querySelector('[title="Hermes"]') !== null,
		"issued principal was not listed"
	);
	expect(
		calls
			.filter(
				(call) => call.method === "POST" && call.path === "/api/a2a/principals"
			)
			.map((call) => call.body)
	).toEqual([
		{ name: "Hermes", scopes: ["send", "read", "cancel", "subscribe"] },
	]);
	expect(document.body.textContent).toContain("Copy this token now");
	expect(input("#a2a-principal-name").value).toBe("");

	const revoke = document.querySelector<HTMLButtonElement>(
		'button[aria-label="Revoke token for Hermes"]'
	);
	if (!revoke) {
		throw new Error("Missing revoke button");
	}
	await click(revoke);
	await until(
		() =>
			document.querySelector<HTMLButtonElement>(
				'button[aria-label="Revoke token for Hermes"]'
			)?.disabled === true,
		"revoked principal still revocable"
	);
	expect(
		calls.filter((call) => call.method === "DELETE").map((call) => call.path)
	).toEqual(["/api/a2a/principals/principal-1"]);
	expect(principals[0]?.revokedAt).not.toBeNull();

	for (const scope of ["send", "read", "cancel", "subscribe"]) {
		await toggleScope(scope);
	}
	await type("#a2a-principal-name", "No scopes");
	expect(issue().disabled).toBe(true);
});

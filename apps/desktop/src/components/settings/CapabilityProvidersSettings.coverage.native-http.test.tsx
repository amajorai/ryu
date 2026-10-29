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

// Control-level coverage for the shipping CapabilityProvidersSettings surface
// (Gateway → Providers, below chat). Every value it shows is read from the
// active node over real loopback HTTP: the gateway's routing config and the
// Replicate / Fal key preferences. The surface is read-only, so the effects
// asserted are what each row reports, what it never leaks, and where its
// buttons hand editing off to.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const NODE = { name: "capability-node", token: "capability-node-token" };
const REPLICATE_SECRET = "r8_capability_secret_value";
const FAL_SECRET = "fal_capability_secret_value";

interface CoreCall {
	authorization: string | null;
	method: string;
	path: string;
}

let preferences: Record<string, string> = {};
let preferenceStatus = 200;
let gatewayReply: { body: unknown; status: number } = {
	body: {},
	status: 200,
};
const calls: CoreCall[] = [];
const unexpected: string[] = [];
const rejectedEgress: string[] = [];

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		const authorization = request.headers.get("authorization");
		calls.push({ authorization, method: request.method, path: url.pathname });
		if (authorization !== `Bearer ${NODE.token}`) {
			unexpected.push(`${request.method} ${url.pathname} without node token`);
			return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		if (request.method !== "GET") {
			unexpected.push(`write ${request.method} ${url.pathname}`);
			return NativeResponse.json({ error: "read-only" }, { status: 405 });
		}
		if (url.pathname === "/api/gateway/config") {
			return NativeResponse.json(gatewayReply.body, {
				status: gatewayReply.status,
			});
		}
		const preference = /^\/api\/preferences\/(.+)$/u.exec(url.pathname);
		if (preference) {
			const key = decodeURIComponent(preference[1] ?? "");
			if (preferenceStatus !== 200) {
				return NativeResponse.json(
					{ error: "preference store locked" },
					{ status: preferenceStatus }
				);
			}
			const value = preferences[key];
			return value === undefined
				? NativeResponse.json({ error: "Unset preference" }, { status: 404 })
				: NativeResponse.json({ key, value });
		}
		unexpected.push(`GET ${url.pathname}`);
		return NativeResponse.json({ error: "undeclared" }, { status: 404 });
	},
});

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
const { useGatewayDialog } = await import("@/src/store/useGatewayDialog.ts");
const { useProductModeStore } = await import("@/src/lib/product-mode.ts");
const { CapabilityProvidersSettings } = await import(
	"./CapabilityProvidersSettings.tsx"
);
const {
	button,
	click,
	maybeButton,
	rowAction,
	settle,
	settingsRow,
	settingsSection,
} = await import("./connections-providers.test-support.ts");

let root: Root | null = null;
let container: HTMLDivElement;

/**
 * A gateway config body: `auth`, `providers` and the routing section's model
 * map and fallback chain are always served.
 */
function servedConfig(routingSection: Record<string, unknown>) {
	return {
		auth: { api_keys: [], require_auth: false },
		providers: {
			anthropic: null,
			core: null,
			genai: null,
			local: null,
			openai: null,
			openrouter: null,
		},
		routing: { fallback_chain: [], model_map: {}, ...routingSection },
	};
}

function routing(modalityMap: Record<string, unknown>, defaultProvider = "") {
	return servedConfig({
		default_provider: defaultProvider,
		modality_map: modalityMap,
	});
}

async function mount() {
	root = createRoot(container);
	await act(async () => root?.render(<CapabilityProvidersSettings />));
}

async function unmount() {
	const mounted = root;
	root = null;
	if (mounted) {
		await act(async () => mounted.unmount());
	}
}

function text(): string {
	return container.textContent ?? "";
}

/** Wait until both Core reads have settled into visible rows. */
async function mountSettled(label: string) {
	await mount();
	await settle(
		() =>
			!text().includes("Reading routing…") &&
			rowAction("Replicate", container) !== "" &&
			rowAction("Replicate", container) !== "—" &&
			rowAction("Fal", container) !== "—",
		label,
		text
	);
}

beforeEach(() => {
	preferences = {};
	preferenceStatus = 200;
	gatewayReply = { body: routing({}, "anthropic"), status: 200 };
	calls.length = 0;
	unexpected.length = 0;
	rejectedEgress.length = 0;
	useGatewayDialog.setState({ open: false, section: "overview" });
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: NODE.name,
		nodes: [{ name: NODE.name, token: NODE.token, url: server.url.origin }],
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await unmount();
	container.remove();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case stays on declared, token-authenticated Core reads.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: no request may leave the loopback fixture.
	expect(rejectedEgress).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

test("Replicate and Fal rows report whether the node holds each key, never the key itself, and follow Core after a remount", async () => {
	preferences = { "replicate-api-key": REPLICATE_SECRET, "fal-api-key": "" };
	await mountSettled("media key rows");

	expect(rowAction("Replicate", container)).toBe("Key set");
	expect(rowAction("Fal", container)).toBe("No key");
	expect(text()).toContain("Image and video generation via Replicate.");
	expect(text()).toContain("Image, video and audio generation via fal.ai.");
	expect(container.innerHTML).not.toContain(REPLICATE_SECRET);
	expect(
		calls
			.filter((call) => call.path.startsWith("/api/preferences/"))
			.map((call) => call.path)
			.sort()
	).toEqual([
		"/api/preferences/fal-api-key",
		"/api/preferences/replicate-api-key",
	]);

	// Core is the authority: rotate which provider holds a key, then remount.
	await unmount();
	preferences = { "fal-api-key": FAL_SECRET };
	await mountSettled("media key rows after Core change");
	expect(rowAction("Replicate", container)).toBe("No key");
	expect(rowAction("Fal", container)).toBe("Key set");
	expect(container.innerHTML).not.toContain(FAL_SECRET);
	expect(calls.every((call) => call.method === "GET")).toBe(true);
});

test("unreadable key preferences leave both media rows neutral while routing still renders", async () => {
	preferenceStatus = 500;
	gatewayReply = {
		body: routing({ image: { provider: "replicate", model: "flux-dev" } }),
		status: 200,
	};
	await mount();
	await settle(
		() => settingsRow("Image generation", container) !== null,
		"routing rows",
		text
	);
	await settle(
		() =>
			calls.filter((call) => call.path.startsWith("/api/preferences/"))
				.length === 2,
		"both preference reads",
		text
	);
	expect(rowAction("Replicate", container)).toBe("—");
	expect(rowAction("Fal", container)).toBe("—");
	expect(text()).not.toContain("Key set");
	expect(text()).not.toContain("No key");
	expect(rowAction("Image generation", container)).toBe("replicate · flux-dev");
});

test("Embeddings and Reranking stay on this node with no selector, and the whole surface issues no writes", async () => {
	preferences = { "replicate-api-key": REPLICATE_SECRET };
	await mountSettled("retrieval rows");

	expect(rowAction("Embeddings", container)).toBe("On this node");
	expect(rowAction("Reranking", container)).toBe("On this node");
	expect(text()).toContain(
		"Turns text into vectors for semantic search over memory, Spaces and tool selection."
	);
	expect(text()).toContain(
		"Re-scores retrieved passages before they reach the model."
	);
	const retrieval = settingsSection("Embeddings and reranking", container);
	expect(retrieval).not.toBeNull();
	expect(settingsRow("Embeddings", retrieval ?? container)).not.toBeNull();
	expect(settingsRow("Reranking", retrieval ?? container)).not.toBeNull();
	// No control in that section can point retrieval at a cloud provider.
	expect(
		retrieval?.querySelectorAll(
			'button, input, select, [role="combobox"], [role="switch"]'
		)
	).toHaveLength(0);
	expect(calls.length).toBeGreaterThanOrEqual(3);
	expect(calls.every((call) => call.method === "GET")).toBe(true);
});

test("each routed capability shows its modality-map provider, falls back to the default provider, or reads Unrouted", async () => {
	gatewayReply = {
		body: routing(
			{
				image: { provider: "replicate", model: "flux-dev" },
				stt: { provider: "openai" },
			},
			"anthropic"
		),
		status: 200,
	};
	await mountSettled("routed capabilities");
	expect(rowAction("Image generation", container)).toBe("replicate · flux-dev");
	expect(rowAction("Voice Recognition", container)).toBe("openai");
	expect(rowAction("Audio", container)).toBe("anthropic (default)");
	expect(rowAction("Video generation", container)).toBe("anthropic (default)");

	await unmount();
	gatewayReply = { body: routing({ tts: { provider: "fal" } }), status: 200 };
	await mountSettled("unrouted capabilities");
	expect(rowAction("Audio", container)).toBe("fal");
	expect(rowAction("Image generation", container)).toBe("Unrouted");
	expect(rowAction("Video generation", container)).toBe("Unrouted");
});

test("a gateway too old to report its modality map, or one that is down, shows no routing rows or editor", async () => {
	gatewayReply = {
		body: servedConfig({ default_provider: "anthropic" }),
		status: 200,
	};
	await mountSettled("too-old gateway");
	expect(text()).toContain(
		"This gateway is too old to report its modality map"
	);
	expect(settingsRow("Image generation", container)).toBeNull();
	expect(maybeButton("Edit capability routing", container)).toBeNull();
	// The key rows still answer from the node's preferences.
	expect(rowAction("Replicate", container)).toBe("No key");

	await unmount();
	gatewayReply = { body: { error: "gateway offline" }, status: 503 };
	await mountSettled("gateway down");
	expect(text()).toContain("This node's gateway did not answer");
	expect(settingsRow("Image generation", container)).toBeNull();
	expect(maybeButton("Edit capability routing", container)).toBeNull();
	expect(text()).not.toContain("too old to report");
});

test("editing is handed to the Gateway dialog: routing for capabilities, API keys for media providers", async () => {
	// The Gateway dialog opens only in the Console realm, for a caller with
	// Console access; Settings is reached from there.
	useProductModeStore.setState({
		consoleAccess: true,
		requestedMode: "console",
	});
	await mountSettled("handoff buttons");
	expect(useGatewayDialog.getState().open).toBe(false);

	await click(button("Edit capability routing", container));
	expect(useGatewayDialog.getState()).toMatchObject({
		open: true,
		section: "routing",
	});

	await act(async () =>
		useGatewayDialog.setState({ open: false, section: "overview" })
	);
	await click(button("Manage media keys", container));
	expect(useGatewayDialog.getState()).toMatchObject({
		open: true,
		section: "keys",
	});
	expect(calls.every((call) => call.method === "GET")).toBe(true);
});

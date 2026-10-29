import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	button,
	click,
	flush,
	maybeButton,
	normalized,
	registerDomWithNativeNetworking,
	text,
	until,
} from "./unswept-b.test-support.ts";

// Coverage for `SpacesSettings`, the Spaces app's settings body (Gateway
// settings → Apps → Spaces). It has no controls of its own: it composes the
// node-scoped editor AI / embedding panel and the node backup panel. What it
// owns is that composition and how it is reached, so the suite mounts the
// shipping `EntitySettings` binder with the Spaces manifest's own declared
// settings tab (read from the manifest Core ships) and asserts:
//   - both panels read from the selected node, and follow a node switch;
//   - a save made through the composed editor panel reaches that node's
//     preferences and survives an independent remount;
//   - the view is bound by owning plugin id, so a third-party plugin declaring
//     the same `view` gets nothing, and a turned-off Spaces shows its notice
//     instead of the panels.
// One native HTTP peer plays two Core nodes (path prefix `/a` or `/b`, each
// with its own bearer) and the control plane the entitlement provider reads.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
registerDomWithNativeNetworking();
setDefaultTimeout(30_000);

const SESSION_TOKEN = "spaces-coverage-session";
const MANIFEST = JSON.parse(
	readFileSync(
		path.resolve(
			import.meta.dirname,
			"../../../../core/src/plugin_manifest/fixtures/spaces.manifest.json"
		),
		"utf8"
	)
) as {
	contributes: {
		settings_tabs: Array<{
			fields: [];
			id: string;
			scope: "node";
			title: string;
			view: string;
		}>;
	};
	id: string;
	name: string;
};

type Owner = "a" | "b";
interface Call {
	body: unknown;
	method: string;
	owner: Owner | null;
	path: string;
}
interface NodeState {
	backups: Record<string, unknown>[];
	embedding: { base_url: string; dims: number; model_id: string };
	preferences: Map<string, string>;
}

const calls: Call[] = [];
const unexpected: string[] = [];
const runtimeErrors: string[] = [];
let nodes: Record<Owner, NodeState>;

function freshNodes(): Record<Owner, NodeState> {
	const destination = (owner: Owner) => ({
		allowedApps: [],
		allowHttp: false,
		bucket: `bucket-${owner}`,
		createdAt: "2026-10-01T00:00:00.000Z",
		endpoint: `https://s3.${owner}.example.test`,
		id: `${owner}-destination`,
		name: `Node ${owner.toUpperCase()} archive`,
		pathStyle: true,
		prefix: "",
		region: "eu-west-1",
	});
	return {
		a: {
			backups: [destination("a")],
			embedding: { base_url: "", dims: 768, model_id: "nomic-embed-node-a" },
			preferences: new Map([
				[
					"editor-ai",
					JSON.stringify({ baseUrl: "", enabled: false, model: "" }),
				],
				["unrelated-node-pref", "kept-a"],
			]),
		},
		b: {
			backups: [destination("b")],
			embedding: { base_url: "", dims: 1024, model_id: "bge-node-b" },
			preferences: new Map([
				[
					"editor-ai",
					JSON.stringify({
						baseUrl: "",
						enabled: true,
						model: "node-b-writer",
					}),
				],
			]),
		},
	};
}

function nodeRoute(owner: Owner, route: string, call: Call, request: Request) {
	const state = nodes[owner];
	if (request.headers.get("authorization") !== `Bearer spaces-${owner}-token`) {
		unexpected.push(`${call.method} /${owner}${route}: wrong node authority`);
		return NativeResponse.json({ error: "forbidden" }, { status: 403 });
	}
	const preference = /^\/api\/preferences\/([^/]+)$/.exec(route);
	if (preference) {
		const key = decodeURIComponent(preference[1] ?? "");
		if (call.method === "GET") {
			const value = state.preferences.get(key);
			return value === undefined
				? NativeResponse.json({ error: "not found" }, { status: 404 })
				: NativeResponse.json({ key, value });
		}
		if (call.method === "PUT") {
			const body = call.body as { value?: unknown };
			if (typeof body?.value !== "string") {
				return NativeResponse.json({ error: "bad value" }, { status: 400 });
			}
			state.preferences.set(key, body.value);
			return NativeResponse.json({ ok: true });
		}
	}
	if (call.method === "GET") {
		switch (route) {
			case "/api/embeddings/model":
				return NativeResponse.json(state.embedding);
			case "/api/embeddings/reindex/status":
				return NativeResponse.json({
					current_dims: state.embedding.dims,
					current_model: state.embedding.model_id,
					pending_chunks: 0,
					running: false,
					total_chunks: 12,
				});
			case "/api/backups":
				return NativeResponse.json({
					destinations: state.backups,
					operations: [],
					policies: [],
				});
			case "/api/spaces":
				return NativeResponse.json({ spaces: [] });
			case "/api/agents":
				return NativeResponse.json({ agents: [] });
			case "/api/engines":
				return NativeResponse.json({ engines: [] });
			case "/api/engine/active":
				return NativeResponse.json({
					active: null,
					available: [],
					running: false,
				});
			case "/api/plugins":
				return NativeResponse.json({ apps: [], plugins: [] });
			case "/api/plugins/contributions":
				return NativeResponse.json({});
			default:
				break;
		}
	}
	if (
		call.method === "PUT" &&
		(route === "/api/preferences/entitlement-active" ||
			route === "/api/preferences/managed-inference-entitled")
	) {
		return NativeResponse.json({ ok: true });
	}
	unexpected.push(`Undeclared Core ${call.method} /${owner}${route}`);
	return NativeResponse.json({ error: "undeclared" }, { status: 404 });
}

function controlPlane(route: string, call: Call, request: Request) {
	const auth = request.headers.get("authorization");
	if (route === "/api/auth/get-session") {
		return NativeResponse.json(
			auth === `Bearer ${SESSION_TOKEN}`
				? {
						session: { activeOrganizationId: null, userId: "owner" },
						user: { email: "owner@example.test", id: "owner", name: "Owner" },
					}
				: null
		);
	}
	if (auth !== `Bearer ${SESSION_TOKEN}`) {
		unexpected.push(`${call.method} ${route} without the session bearer`);
		return NativeResponse.json({ message: "unauthorized" }, { status: 401 });
	}
	if (route === "/api/billing/subscription-status") {
		return NativeResponse.json({
			entitlement: {
				desktopAccess: true,
				managedInference: true,
				marketplaceApps: true,
				monthlyCreditPoolMicroUsd: 0,
				plan: "pro",
				seats: 1,
			},
			organizationId: null,
			plan: "pro",
			scope: "personal",
			subscription: null,
		});
	}
	if (route === "/api/upsell/state") {
		return NativeResponse.json({ lastUpsellShownAt: "2026-10-10T00:00:00Z" });
	}
	if (route === "/api/billing/trial") {
		return NativeResponse.json({ firstLaunchAt: "2026-01-01T00:00:00Z" });
	}
	unexpected.push(`Undeclared control-plane ${call.method} ${route}`);
	return NativeResponse.json({ message: "undeclared" }, { status: 404 });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const prefix = url.pathname.split("/")[1];
		const owner: Owner | null =
			prefix === "a" || prefix === "b" ? prefix : null;
		const route = owner ? url.pathname.slice(owner.length + 1) : url.pathname;
		const raw = await request.text();
		const call: Call = {
			body: raw === "" ? null : JSON.parse(raw),
			method: request.method,
			owner,
			path: route,
		};
		calls.push(call);
		return owner
			? nodeRoute(owner, route, call, request)
			: controlPlane(route, call, request);
	},
});

process.env.VITE_APP_BACKEND_URL = server.url.origin;
const base = server.url.origin;
const ownedFetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (new URL(url).origin !== base) {
			unexpected.push(`Unowned origin ${url}`);
			return Promise.reject(new Error(`Unowned origin ${url}`));
		}
		return nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = ownedFetch;
window.fetch = ownedFetch;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { TOKEN_KEY } = await import("@/lib/auth-client.ts");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { useNodeStore, LOCAL_FALLBACK } = await import(
	"@/src/store/useNodeStore.ts"
);
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { EntitySettings } = await import("./EntitySettings.tsx");

type Root = ReturnType<typeof createRoot>;
type Entity = Parameters<typeof EntitySettings>[0]["entity"];
const initialNodeState = useNodeStore.getState();
let root: Root | null = null;
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(`unhandled rejection: ${String(event.reason)}`);

function spacesEntity(overrides: Partial<Entity> = {}): Entity {
	return {
		enabled: true,
		id: MANIFEST.id,
		label: MANIFEST.name,
		tabs: MANIFEST.contributes.settings_tabs.map((tab) => ({
			enabled: overrides.enabled ?? true,
			fields: tab.fields,
			id: tab.id,
			plugin: overrides.id ?? MANIFEST.id,
			scope: tab.scope,
			title: tab.title,
			view: tab.view,
		})),
		...overrides,
	};
}

async function select(owner: Owner) {
	const node = {
		...LOCAL_FALLBACK,
		name: `spaces-${owner}`,
		token: `spaces-${owner}-token`,
		url: `${base}/${owner}`,
		// A member JWT already minted for this node, so no control-plane
		// token exchange is needed to talk to it.
		userJwt: `spaces-${owner}-jwt`,
	};
	await act(async () => {
		useNodeStore.setState({
			autoSelect: false,
			autoSelectedNode: null,
			cloudNodes: [],
			defaultNode: node.name,
			localNodes: [node],
			nodes: [node],
			tabOverrides: {},
		});
	});
}

async function mount(entity: Entity) {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
	});
	const owner = useNodeStore.getState().defaultNode?.endsWith("-b") ? "b" : "a";
	await act(async () =>
		root?.render(
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<EntitySettings
						entity={entity}
						target={{
							token: `spaces-${owner}-token`,
							url: `${base}/${owner}`,
							userJwt: `spaces-${owner}-jwt`,
						}}
					/>
					<Toaster position="bottom-right" />
				</EntitlementProvider>
			</QueryClientProvider>
		)
	);
}

async function unmount() {
	const mounted = root;
	root = null;
	await act(async () => mounted?.unmount());
	document.body.replaceChildren();
}

function input(id: string): HTMLInputElement {
	const found = document.getElementById(id);
	if (!(found instanceof HTMLInputElement)) {
		throw new Error(`Missing input #${id}: ${text()}`);
	}
	return found;
}

function editorSwitch(): HTMLElement {
	const found = document.querySelector<HTMLElement>(
		'[aria-label="Enable editor AI"]'
	);
	if (!found) {
		throw new Error(`Missing editor AI switch: ${text()}`);
	}
	return found;
}

async function type(field: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function panelsLoaded(owner: Owner) {
	await until(
		() =>
			document.getElementById("embed-model") instanceof HTMLInputElement &&
			input("embed-model").value === nodes[owner].embedding.model_id &&
			text().includes(`Node ${owner.toUpperCase()} archive`) &&
			document.querySelector('[aria-label="Enable editor AI"]') !== null,
		`Spaces panels for node ${owner}`
	);
}

function spacesReads(owner: Owner): string[] {
	return calls
		.filter(
			(call) =>
				call.owner === owner &&
				call.method === "GET" &&
				(call.path.startsWith("/api/embeddings") ||
					call.path === "/api/backups" ||
					call.path === "/api/preferences/editor-ai")
		)
		.map((call) => call.path);
}

beforeEach(async () => {
	calls.length = 0;
	unexpected.length = 0;
	runtimeErrors.length = 0;
	nodes = freshNodes();
	window.addEventListener("unhandledrejection", onRejection);
	localStorage.clear();
	localStorage.setItem(TOKEN_KEY, SESSION_TOKEN);
	localStorage.setItem("spaces-coverage-unrelated", "kept");
	await act(async () => {
		queryClient.clear();
		sileo.clear();
	});
	await select("a");
});

afterEach(async () => {
	await unmount();
	await flush(4);
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
		sileo.clear();
	});
	useNodeStore.setState(initialNodeState, true);
	window.removeEventListener("unhandledrejection", onRejection);
	// biome-ignore lint/suspicious/noMisplacedAssertion: unrelated browser storage must survive every case.
	expect(localStorage.getItem("spaces-coverage-unrelated")).toBe("kept");
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects undeclared or wrong-authority requests.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: no case may leave a render error or unhandled rejection.
	expect(runtimeErrors).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

test("the Spaces tab declared by the Spaces manifest composes the node's editor AI, embedding and backup panels, all read from the selected node", async () => {
	expect(MANIFEST.contributes.settings_tabs).toEqual([
		{
			fields: [],
			id: "spaces.editor",
			scope: "node",
			title: "Spaces",
			view: "spaces",
		},
	]);
	await mount(spacesEntity());
	await panelsLoaded("a");

	expect(text()).toContain("Inline AI editing");
	expect(text()).toContain("S3 backups");
	expect(input("embed-model").value).toBe("nomic-embed-node-a");
	expect(input("embed-dims").value).toBe("768");
	expect(text()).toContain("bucket-a");
	expect(text()).not.toContain("Spaces is turned off");
	// Every Spaces read went to the selected node with its own bearer.
	expect(new Set(spacesReads("a"))).toEqual(
		new Set([
			"/api/preferences/editor-ai",
			"/api/embeddings/model",
			"/api/embeddings/reindex/status",
			"/api/backups",
		])
	);
	expect(spacesReads("b")).toEqual([]);
});

test("switching nodes rereads both composed panels from the newly selected node", async () => {
	await mount(spacesEntity());
	await panelsLoaded("a");
	expect((editorSwitch() as HTMLElement).getAttribute("aria-checked")).toBe(
		"false"
	);

	await select("b");
	await panelsLoaded("b");
	expect(input("embed-model").value).toBe("bge-node-b");
	expect(text()).toContain("bucket-b");
	expect(text()).not.toContain("bucket-a");
	expect(editorSwitch().getAttribute("aria-checked")).toBe("true");
	expect(input("editor-ai-model").value).toBe("node-b-writer");
	expect(new Set(spacesReads("b"))).toEqual(
		new Set([
			"/api/preferences/editor-ai",
			"/api/embeddings/model",
			"/api/embeddings/reindex/status",
			"/api/backups",
		])
	);
});

test("an editor AI save made through the Spaces tab reaches only the selected node's preferences and survives an independent remount", async () => {
	await mount(spacesEntity());
	await panelsLoaded("a");
	await click(editorSwitch());
	await type(input("editor-ai-model"), "gemma-inline");
	await click(button("Save"));
	await until(
		() => text().includes("Editor AI settings saved"),
		"save acknowledgement"
	);

	const writes = calls.filter((call) => call.method === "PUT");
	const editorWrites = writes.filter(
		(call) => call.path === "/api/preferences/editor-ai"
	);
	expect(editorWrites).toHaveLength(1);
	expect(editorWrites[0]?.owner).toBe("a");
	expect(
		JSON.parse((editorWrites[0]?.body as { value: string }).value)
	).toEqual({ baseUrl: "", enabled: true, model: "gemma-inline" });
	expect(nodes.a.preferences.get("unrelated-node-pref")).toBe("kept-a");
	expect(JSON.parse(nodes.b.preferences.get("editor-ai") ?? "{}")).toEqual({
		baseUrl: "",
		enabled: true,
		model: "node-b-writer",
	});

	await unmount();
	await mount(spacesEntity());
	await panelsLoaded("a");
	expect(editorSwitch().getAttribute("aria-checked")).toBe("true");
	expect(input("editor-ai-model").value).toBe("gemma-inline");
});

test("the Spaces view is bound to the Spaces plugin id: a third-party plugin declaring the same view gets no Spaces panels or Spaces reads", async () => {
	await mount(
		spacesEntity({ id: "acme/spaces-lookalike", label: "Lookalike" })
	);
	await flush(20);
	expect(text()).not.toContain("Inline AI editing");
	expect(text()).not.toContain("S3 backups");
	expect(document.getElementById("embed-model")).toBeNull();
	expect(spacesReads("a")).toEqual([]);
});

test("while Spaces is turned off its view is withheld behind the turned-off notice", async () => {
	await mount(spacesEntity({ enabled: false }));
	await until(
		() => text().includes("Spaces is turned off"),
		"turned-off notice"
	);
	expect(maybeButton("Turn on")).not.toBeNull();
	await flush(10);
	expect(normalized(document.body)).not.toContain("Inline AI editing");
	expect(text()).not.toContain("S3 backups");
	expect(spacesReads("a")).toEqual([]);
});

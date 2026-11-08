import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import type { Root } from "react-dom/client";
import {
	button,
	click,
	flush,
	installAnimationApis,
	isDisabled,
	openDialogs,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// The REAL syncs panel and its dialogs against a loopback node that keeps
// stores and destinations as Core does and never returns credentials.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "syncs-node-token";
type Row = Record<string, unknown> & { id: string };

let stores: Row[] = [];
let destinations: Row[] = [];
let writes: { body: unknown; route: string }[] = [];

const GITHUB: Row = {
	address: "https://api.github.com",
	authMethod: "token",
	createdAt: 1,
	id: "xs_1",
	kind: "github-actions",
	mount: "",
	name: "acme-ci",
	pathPrefix: "",
	projectId: "",
	repository: "acme/app",
	updatedAt: 1,
};

const SYNC: Row = {
	dirty: false,
	environment: "prod",
	failures: 1,
	id: "xdst_1",
	intervalSecs: 3600,
	lastCount: 2,
	lastError: "GitHub secret write failed with HTTP 403",
	lastPushAt: 5,
	lastStatus: "error",
	path: "/web",
	remotePath: "WEB_",
	storeId: "xs_1",
};

function json(body: unknown, status = 200): Response {
	return NativeResponse.json(body, { status });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			return json({ error: "Unauthorized" }, 401);
		}
		if (route === "GET /api/vault/external/stores") {
			return json({ stores });
		}
		if (route === "GET /api/vault/external/destinations") {
			return json({ destinations });
		}
		if (route === "GET /api/vault/external/sources") {
			return json({ sources: [] });
		}
		const body =
			request.method === "POST" ? await request.json().catch(() => null) : null;
		writes.push({ body, route });
		if (route === "POST /api/vault/external/stores") {
			const { credentials: _dropped, ...rest } = body as Row;
			const created = {
				address: "https://api.vercel.com",
				...rest,
				id: "xs_2",
				createdAt: 2,
				updatedAt: 2,
			};
			stores.push(created as Row);
			return json({ store: created });
		}
		if (route === "POST /api/vault/external/destinations") {
			const created = {
				...SYNC,
				...(body as Row),
				id: "xdst_2",
				lastPushAt: null,
			};
			destinations.push(created);
			return json({ destination: created });
		}
		if (route === "POST /api/vault/external/destinations/xdst_1/push") {
			return json({ pushed: 2 });
		}
		if (route === "POST /api/vault/external/stores/xs_1/test") {
			return json({
				ok: false,
				error: "GitHub public key failed with HTTP 401",
			});
		}
		return json({ error: `undeclared ${route}` }, 404);
	},
});
const target = {
	token: TOKEN,
	url: `http://127.0.0.1:${server.port}`,
	userJwt: null,
};

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { VaultSyncsPanel } = await import("./VaultSyncsPanel.tsx");
const { VaultSyncDialog } = await import("./VaultSyncDialog.tsx");
const { VaultSyncTargetDialog } = await import("./VaultSyncTargetDialog.tsx");
installAnimationApis();

let root: Root | null = null;

async function mount(): Promise<void> {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<Toaster />
				<VaultSyncsPanel environment="prod" target={target} />
			</QueryClientProvider>
		)
	);
	await flush(4);
}

async function setValue(id: string, value: string): Promise<void> {
	const element = document.getElementById(id) as
		| HTMLInputElement
		| HTMLSelectElement
		| null;
	if (!element) {
		throw new Error(`No #${id}: ${text()}`);
	}
	const setter = Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(element),
		"value"
	)?.set;
	await act(async () => {
		setter?.call(element, value);
		element.dispatchEvent(
			new Event(element instanceof HTMLSelectElement ? "change" : "input", {
				bubbles: true,
			})
		);
	});
	await flush(2);
}

beforeEach(() => {
	stores = [{ ...GITHUB }];
	destinations = [{ ...SYNC }];
	writes = [];
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	window.fetch = nativeFetch;
});

test("targets and syncs list their status, and Push now and Test report back", async () => {
	await mount();
	await until(() => text().includes("acme-ci"), "targets");
	expect(text()).toContain("acme/app");
	expect(text()).toContain("prod:/web");
	expect(text()).toContain("GitHub secret write failed with HTTP 403");
	await click(button("Push prod:/web now"));
	await until(() => text().includes("Pushed 2 keys"), "push toast");
	await click(button("Test acme-ci"));
	await until(() => text().includes("HTTP 401"), "test refusal");
	expect(writes.map((write) => write.route)).toEqual([
		"POST /api/vault/external/destinations/xdst_1/push",
		"POST /api/vault/external/stores/xs_1/test",
	]);
});

test("Connect target sends the platform's settings and the token once", async () => {
	await mount();
	await until(() => text().includes("acme-ci"), "targets");
	await click(button("Connect target"));
	await until(() => openDialogs().length === 1, "dialog");
	await setValue("sync-target-kind", "vercel");
	await setValue("sync-target-name", "web");
	await setValue("sync-target-projectId", "prj_1");
	await setValue("sync-target-token", "vc_secret_token");
	await click(button("Connect", openDialogs()[0]));
	await until(() => writes.length === 1, "posted");
	expect(writes[0]).toEqual({
		route: "POST /api/vault/external/stores",
		body: {
			name: "web",
			kind: "vercel",
			authMethod: "token",
			projectId: "prj_1",
			vercelTargets: ["production", "preview", "development"],
			credentials: { token: "vc_secret_token" },
		},
	});
	await until(() => openDialogs().length === 0, "closed");
	expect(text()).not.toContain("vc_secret_token");
});

test("an incomplete target is explained and nothing is sent; Sync a folder posts the folder", async () => {
	await mount();
	await until(() => text().includes("acme-ci"), "targets");
	await click(button("Connect target"));
	await until(() => openDialogs().length === 1, "dialog");
	await setValue("sync-target-name", "ci");
	await click(button("Connect", openDialogs()[0]));
	await until(() => text().includes("owner/repo"), "problem");
	expect(writes).toEqual([]);
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();

	await mount();
	await until(() => text().includes("acme-ci"), "targets");
	await click(button("Sync a folder"));
	await until(() => openDialogs().length === 1, "sync dialog");
	await setValue("sync-path", "/api");
	await setValue("sync-remote", "API_");
	await click(button("Add sync", openDialogs()[0]));
	await until(() => writes.length === 1, "posted");
	expect(writes[0]).toEqual({
		route: "POST /api/vault/external/destinations",
		body: {
			environment: "prod",
			intervalSecs: 3600,
			path: "/api",
			remotePath: "API_",
			storeId: "xs_1",
		},
	});
	await until(() => text().includes("prod:/api"), "new sync row");
});

test("closed dialogs render nothing, and a sync needs a connected target", async () => {
	await mount();
	await act(async () =>
		root?.render(
			<QueryClientProvider client={new QueryClient()}>
				<VaultSyncTargetDialog
					onOpenChange={() => undefined}
					open={false}
					target={target}
				/>
				<VaultSyncDialog
					environment="prod"
					onOpenChange={() => undefined}
					open
					stores={[]}
					target={target}
				/>
			</QueryClientProvider>
		)
	);
	await flush(4);
	expect(openDialogs().length).toBe(1);
	expect(isDisabled(button("Add sync", openDialogs()[0]))).toBe(true);
});

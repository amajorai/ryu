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
	openDialogs,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// The REAL Items tab, its history dialog, and the folder list's New folder
// control against a loopback node whose timeline carries field names only.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "items-node-token";
let routes: string[] = [];
let posted: unknown[] = [];

const ITEM = {
	environment: "prod",
	fieldCount: 3,
	id: "vi_1",
	key: "github",
	kind: "login",
	path: "/web",
	status: "ready",
	updatedAt: 5,
	version: 2,
};

function event(seq: number, name: string, data: unknown) {
	return {
		actorId: "ada",
		actorKind: "user",
		createdAt: seq * 1000,
		data,
		itemId: "vi_1",
		name,
		seq,
		version: seq < 2 ? 1 : 2,
	};
}

function json(body: unknown, status = 200): Response {
	return NativeResponse.json(body, { status });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}${url.search}`;
		routes.push(route);
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			return json({ error: "Unauthorized" }, 401);
		}
		if (route === "GET /api/vault/items?environment=prod") {
			return json({ items: [ITEM] });
		}
		if (url.pathname === "/api/vault/items/github/events") {
			const after = Number(url.searchParams.get("after") ?? 0);
			const all = [
				event(1, "created", { fieldsSet: ["username", "password"] }),
				event(2, "updated", { fieldsSet: ["password"] }),
				event(3, "revealed", { field: "password" }),
			];
			const events = all.filter((item) => item.seq > after);
			return json({ events, next: events.at(-1)?.seq ?? after });
		}
		if (route === "POST /api/vault/folders") {
			const body = (await request.json()) as { path: string };
			posted.push(body);
			return json({ ok: true, path: body.path });
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
const { VaultItemsPanel } = await import("./VaultItemsPanel.tsx");
const { VaultNewFolder, newFolderPath } = await import("./VaultNewFolder.tsx");
await import("./VaultItemHistoryDialog.tsx");
installAnimationApis();

let root: Root | null = null;

async function mount(node: React.ReactNode): Promise<void> {
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
				{node}
			</QueryClientProvider>
		)
	);
	await flush(4);
}

beforeEach(() => {
	routes = [];
	posted = [];
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

test("items list metadata and History reads the timeline without values", async () => {
	await mount(<VaultItemsPanel environment="prod" target={target} />);
	await until(() => text().includes("github"), "items");
	expect(text()).toContain("/web · version 2 · 3 fields");
	await click(button("History of github"));
	await until(() => text().includes("Revealed password"), "timeline");
	const dialog = openDialogs()[0]?.textContent ?? "";
	expect(dialog).toContain("Created with username, password");
	expect(dialog).toContain("Updated: set password");
	expect(dialog).toContain("Version 2 · user ada");
	expect(routes.filter((route) => route.includes("/events"))).toEqual([
		"GET /api/vault/items/github/events?environment=prod&path=%2Fweb&after=0&limit=100",
	]);
});

test("New folder creates inside the selected folder and selects it", async () => {
	const created: string[] = [];
	await mount(
		<VaultNewFolder
			environment="prod"
			onCreated={(path) => created.push(path)}
			parent="/web"
			target={target}
		/>
	);
	await click(button("New folder"));
	const input = document.getElementById("vault-new-folder") as HTMLInputElement;
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setter?.call(input, "keys");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await click(button("Create"));
	await until(() => created.length === 1, "created");
	expect(posted).toEqual([{ environment: "prod", path: "/web/keys" }]);
	expect(created).toEqual(["/web/keys"]);
	expect(document.getElementById("vault-new-folder")).toBeNull();
});

test("a typed folder is relative to the selection unless it starts at the root", () => {
	expect(newFolderPath("/web", "keys")).toBe("/web/keys");
	expect(newFolderPath("/", "keys/")).toBe("/keys");
	expect(newFolderPath("/web", "/ops/db")).toBe("/ops/db");
});

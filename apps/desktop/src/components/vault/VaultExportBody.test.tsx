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
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// The REAL export dialog against a loopback node: the organization project
// picker appears only when this node maps a folder to a project (P1-15), and
// an export names a project only when one is picked.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "export-node-token";
let mappings: { organizationId: string; projectId: string; root: string }[] =
	[];
let exports: Record<string, unknown>[] = [];

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
		if (route === "GET /api/org-project-mappings") {
			return json({ mappings });
		}
		if (route === "POST /api/vault/export") {
			exports.push((await request.json()) as Record<string, unknown>);
			return json({
				content: "A=1\n",
				contentType: "text/plain",
				count: 1,
				environment: "prod",
				format: "dotenv",
				path: "/",
				sharedError: null,
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
const { VaultTransferDialog } = await import("./VaultTransferDialog.tsx");
// VaultTransferDialog renders the export body from "./VaultExportBody.tsx".
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
				<VaultTransferDialog
					environment="prod"
					folder="/"
					importScopes={["user"]}
					mode="export"
					onOpenChange={() => undefined}
					target={target}
				/>
			</QueryClientProvider>
		)
	);
	await flush(6);
}

beforeEach(() => {
	mappings = [];
	exports = [];
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

test("without a mapped project there is no picker and the export names none", async () => {
	await mount();
	expect(text()).toContain("Export secrets");
	expect(document.getElementById("vault-export-project")).toBeNull();
	await click(button("Export"));
	await until(() => exports.length === 1, "the export request");
	expect(exports[0]).toEqual({
		environment: "prod",
		format: "dotenv",
		path: "/",
	});
});

test("a mapped project is offered, and the default export still names none", async () => {
	mappings = [
		{ organizationId: "org-1", projectId: "proj-1", root: "/work/app" },
	];
	await mount();
	await until(
		() => document.getElementById("vault-export-project") !== null,
		"the project picker"
	);
	expect(text()).toContain("Organization project");
	await click(button("Export"));
	await until(() => exports.length === 1, "the export request");
	expect(exports[0]).not.toHaveProperty("projectId");
});

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

// The REAL Tokens tab and role editor against a loopback node that replaces
// a token role wholesale on PUT, as Core does.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "token-roles-node";
type Role = Record<string, unknown> & { name: string };

let roles: Role[] = [];
let writes: { body: unknown; route: string }[] = [];

const CI: Role = {
	allowedPolicies: ["ci-read"],
	createdAt: 1,
	disallowedPolicies: ["root"],
	maxTtlSecs: 86_400,
	name: "ci",
	orphan: false,
	ttlSecs: 3600,
	updatedAt: 1,
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
		if (route === "GET /api/vault/token-roles") {
			return json({ roles });
		}
		const body = await request.json().catch(() => null);
		writes.push({ body, route });
		const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
		if (request.method === "PUT") {
			const role = { ...(body as object), name, createdAt: 1, updatedAt: 2 };
			roles = [...roles.filter((item) => item.name !== name), role as Role];
			return json({ role });
		}
		if (request.method === "DELETE") {
			roles = roles.filter((item) => item.name !== name);
			return json({ deleted: true });
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
const { VaultTokenRolesPanel } = await import("./VaultTokenRolesPanel.tsx");
await import("./VaultTokenRoleDialog.tsx");
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
				<VaultTokenRolesPanel target={target} />
			</QueryClientProvider>
		)
	);
	await flush(4);
}

async function setValue(id: string, value: string): Promise<void> {
	const element = document.getElementById(id) as HTMLInputElement | null;
	if (!element) {
		throw new Error(`No #${id}: ${text()}`);
	}
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setter?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await flush(2);
}

beforeEach(() => {
	roles = [{ ...CI }];
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

test("a role lists its policies and Edit replaces it with every field", async () => {
	await mount();
	await until(() => text().includes("ci-read"), "roles");
	expect(text()).toContain("TTL 1h");
	await click(button("Edit ci"));
	await until(() => openDialogs().length === 1, "dialog");
	const name = document.getElementById("token-role-name") as HTMLInputElement;
	expect(name.value).toBe("ci");
	expect(isDisabled(name as unknown as HTMLElement) || name.disabled).toBe(
		true
	);
	await setValue("token-role-allowedPolicies", "ci-read, ci-deploy");
	await setValue("token-role-numUses", "10");
	await click(button("Save role", openDialogs()[0]));
	await until(() => writes.length === 1, "saved");
	expect(writes[0]).toEqual({
		route: "PUT /api/vault/token-roles/ci",
		body: {
			allowedPolicies: ["ci-read", "ci-deploy"],
			disallowedPolicies: ["root"],
			orphan: false,
			renewable: true,
			numUses: 10,
			ttlSecs: 3600,
			maxTtlSecs: 86_400,
		},
	});
	await until(() => text().includes("ci-deploy"), "updated row");
});

test("a new role with a bad duration is explained and nothing is sent; Delete removes a role", async () => {
	await mount();
	await until(() => text().includes("ci-read"), "roles");
	await click(button("New role"));
	await until(() => openDialogs().length === 1, "dialog");
	await setValue("token-role-name", "deploy");
	await setValue("token-role-ttl", "an hour");
	await click(button("Save role", openDialogs()[0]));
	await until(() => text().includes("90s, 15m"), "problem");
	expect(writes).toEqual([]);
	await click(button("Close", openDialogs()[0]));
	await until(() => openDialogs().length === 0, "closed");

	await click(button("Delete ci"));
	await until(() => text().includes("No token roles yet."), "deleted");
	expect(writes).toEqual([
		{ route: "DELETE /api/vault/token-roles/ci", body: null },
	]);
});

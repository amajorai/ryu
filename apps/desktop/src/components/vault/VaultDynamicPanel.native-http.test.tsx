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
	maybeButton,
	openDialogs,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// The REAL Leases tab (roles, issue dialog, leases) against a loopback node
// that keeps roles and leases as Core does and lists only redacted summaries.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "dynamic-node-token";
const SECRET = "pw-issued-once-1234";
type Row = Record<string, unknown> & { id?: string; name?: string };

let roles: Row[] = [];
let leases: Row[] = [];
let writes: { body: unknown; route: string }[] = [];

const ROLE: Row = {
	createdAt: 1,
	defaultTtlSecs: 3600,
	maxTtlSecs: 86_400,
	name: "db-ro",
	provider: "postgres",
	summary: { connectionUrl: "postgres://***@db/app" },
	updatedAt: 1,
};

const LEASE: Row = {
	createdAt: 1,
	expiresAt: Date.now() + 3_600_000,
	id: "dl_live",
	issuedTo: "user:ada",
	maxExpiresAt: Date.now() + 86_400_000,
	provider: "postgres",
	renewable: true,
	revokedAt: null,
	role: "db-ro",
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
		if (route === "GET /api/vault/dynamic/roles") {
			return json({ roles });
		}
		if (route === "GET /api/vault/leases") {
			const all = url.searchParams.get("includeRevoked") === "true";
			return json({
				leases: leases.filter((lease) => all || lease.revokedAt === null),
			});
		}
		const body = await request.json().catch(() => null);
		writes.push({ body, route });
		if (route === "PUT /api/vault/dynamic/roles/db-rw") {
			const { provider, ...rest } = body as { provider: { kind: string } };
			const role = {
				...ROLE,
				...rest,
				name: "db-rw",
				provider: provider.kind,
				summary: {},
			};
			roles.push(role);
			return json({ role });
		}
		if (route === "POST /api/vault/dynamic/issue/db-ro") {
			const lease = { ...LEASE, id: "dl_new" };
			leases.push(lease);
			return json({
				credential: { data: { username: "v_ada", password: SECRET }, lease },
			});
		}
		if (route === "POST /api/vault/leases/dl_live/revoke") {
			const lease = leases.find((item) => item.id === "dl_live") as Row;
			lease.revokedAt = Date.now();
			return json({ lease });
		}
		if (route === "POST /api/vault/leases/dl_live/renew") {
			return json({ lease: LEASE });
		}
		if (route === "POST /api/vault/dynamic/roles/db-ro/revoke-all") {
			return json({ revoked: 2 });
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
const { VaultDynamicPanel } = await import("./VaultDynamicPanel.tsx");
const { leaseState } = await import("./VaultLeasesSection.tsx");
await import("./VaultDynamicRoleDialog.tsx");
await import("./VaultDynamicIssueDialog.tsx");
await import("./VaultListRow.tsx");
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
				<VaultDynamicPanel target={target} />
			</QueryClientProvider>
		)
	);
	await flush(4);
}

async function setValue(id: string, value: string): Promise<void> {
	const element = document.getElementById(id) as
		| HTMLInputElement
		| HTMLSelectElement
		| HTMLTextAreaElement
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
	roles = [{ ...ROLE }];
	leases = [{ ...LEASE }];
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

test("roles and live leases list without credentials; a new Postgres role sends its provider", async () => {
	await mount();
	await until(() => text().includes("db-ro"), "roles");
	expect(text()).toContain("PostgreSQL");
	expect(text()).toContain("Default 1h · maximum 1d");
	await until(() => text().includes("dl_live"), "leases");
	expect(text()).toContain("user:ada");

	await click(button("New role"));
	await until(() => openDialogs().length === 1, "role dialog");
	await setValue("dynamic-role-name", "db-rw");
	await setValue("dynamic-role-connectionUrl", "postgres://admin:pw@db/app");
	await setValue(
		"dynamic-role-creationStatements",
		"CREATE ROLE \"{{name}}\" LOGIN PASSWORD '{{password}}';"
	);
	await setValue("dynamic-role-defaultTtl", "15m");
	await click(button("Save role", openDialogs()[0]));
	await until(() => writes.length === 1, "role saved");
	expect(writes[0]).toEqual({
		route: "PUT /api/vault/dynamic/roles/db-rw",
		body: {
			defaultTtlSecs: 900,
			maxTtlSecs: 86_400,
			provider: {
				kind: "postgres",
				connectionUrl: "postgres://admin:pw@db/app",
				creationStatements: [
					"CREATE ROLE \"{{name}}\" LOGIN PASSWORD '{{password}}';",
				],
			},
		},
	});
	await until(() => openDialogs().length === 0, "closed");
	await until(() => text().includes("db-rw"), "new role row");
	expect(text()).not.toContain("admin:pw");
});

test("Issue shows the credential once and closing drops it", async () => {
	await mount();
	await until(() => text().includes("db-ro"), "roles");
	await click(button("Issue from db-ro"));
	await until(() => openDialogs().length === 1, "issue dialog");
	await setValue("dynamic-issue-ttl", "10m");
	await click(button("Issue", openDialogs()[0]));
	await until(() => text().includes("Credential issued"), "issued");
	expect(writes[0]).toEqual({
		route: "POST /api/vault/dynamic/issue/db-ro",
		body: { ttlSecs: 600 },
	});
	const password = document.getElementById(
		"dynamic-issued-password"
	) as HTMLInputElement;
	expect(password.value).toBe(SECRET);
	expect(text()).toContain("dl_new");
	await click(button("Close", openDialogs()[0]));
	await until(() => openDialogs().length === 0, "closed");
	await flush(4);
	expect(document.body.innerHTML).not.toContain(SECRET);
	await until(() => text().includes("dl_new"), "new lease listed");
});

test("Renew and Revoke post to the lease; Revoke all asks first", async () => {
	await mount();
	await until(() => text().includes("dl_live"), "leases");
	await click(button("Renew dl_live"));
	await until(() => writes.length === 1, "renewed");
	await click(button("Revoke dl_live"));
	await until(() => writes.length === 2, "revoked");
	await until(
		() => maybeButton("Revoke dl_live") === null,
		"revoked lease hidden"
	);

	await click(button("Revoke all leases of db-ro"));
	await until(() => text().includes("Revoke every lease of db-ro?"), "confirm");
	expect(writes.length).toBe(2);
	await click(button("Revoke leases"));
	await until(() => text().includes("Revoked 2 leases"), "toast");
	expect(writes.map((write) => write.route)).toEqual([
		"POST /api/vault/leases/dl_live/renew",
		"POST /api/vault/leases/dl_live/revoke",
		"POST /api/vault/dynamic/roles/db-ro/revoke-all",
	]);
});

test("a lease is active, expired or revoked", () => {
	const now = 10_000;
	const base = { ...LEASE, expiresAt: 20_000 } as never;
	expect(leaseState(base, now)).toBe("active");
	expect(
		leaseState({ ...(base as object), expiresAt: 5000 } as never, now)
	).toBe("expired");
	expect(leaseState({ ...(base as object), revokedAt: 1 } as never, now)).toBe(
		"revoked"
	);
});

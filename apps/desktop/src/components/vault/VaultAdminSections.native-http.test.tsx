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

// The REAL audit-device and control-group sections against a loopback node
// that answers as Core does: devices with health, and control-group requests
// without tokens or values.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "admin-sections-token";
const T = "2030-01-01T00:00:00Z";

let forbidDevices = false;
let groups: Record<string, unknown>[] = [];
let writes: string[] = [];

function group(id: string, requester: string, status = "pending") {
	return {
		id,
		requester,
		policyKey: `prod/payments/${id.toUpperCase()}`,
		target: { coords: { name: id }, version: 1 },
		factors: [{ name: "leads", approvers: ["team:security"], approvals: 2 }],
		approvals: [{ factor: "leads", approver: "user:bob", approvedAt: T }],
		status,
		createdAt: T,
		expiresAt: T,
	};
}

function json(body: unknown, status = 200): Response {
	return NativeResponse.json(body, { status });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			return json({ error: "Unauthorized" }, 401);
		}
		if (route === "GET /api/vault/audit/devices") {
			if (forbidDevices) {
				return json(
					{ error: { code: "vault_forbidden", message: "admin required" } },
					403
				);
			}
			return json({
				devices: [
					{
						id: "local",
						kind: "file",
						enabled: true,
						description: "",
						hmacFields: true,
						options: { path: "/var/lib/ryu/audit/vault.log" },
						source: "api",
						health: { failing: false, lastOkAt: T },
					},
					{
						id: "siem",
						kind: "http",
						enabled: false,
						description: "",
						hmacFields: true,
						options: { url: "https://siem.example/ingest" },
						source: "declarative",
						health: { failing: true, lastError: "HTTP 503", lastErrorAt: T },
					},
				],
				failClosed: true,
			});
		}
		if (route === "GET /api/vault/control-groups") {
			return json({ controlGroups: groups });
		}
		writes.push(route);
		if (route === "POST /api/vault/control-groups/cg_bob/authorize") {
			groups = groups.map((row) =>
				row.id === "cg_bob" ? { ...row, status: "approved" } : row
			);
			return json({ ok: true, controlGroup: groups[0] });
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
const { VaultAuditDevices } = await import("./VaultAuditDevices.tsx");
const { VaultControlGroups } = await import("./VaultControlGroups.tsx");
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
				<VaultControlGroups callerSubject="user:alice" target={target} />
				<VaultAuditDevices target={target} />
			</QueryClientProvider>
		)
	);
	await flush(4);
}

beforeEach(() => {
	forbidDevices = false;
	groups = [
		group("cg_bob", "user:bob"),
		group("cg_mine", "user:alice"),
		group("cg_done", "user:dan", "redeemed"),
	];
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

test("audit devices show their target, health and the fail-closed note", async () => {
	await mount();
	await until(() => text().includes("siem"), "devices");
	expect(text()).toContain("/var/lib/ryu/audit/vault.log");
	expect(text()).toContain("https://siem.example/ingest");
	expect(text()).toContain("HTTP 503");
	expect(text()).toContain("Failing");
	expect(text()).toContain("Disabled");
	expect(text()).toContain("Fail-closed is on");
});

test("a non-admin sees no audit-device section", async () => {
	forbidDevices = true;
	groups = [];
	await mount();
	await flush(8);
	expect(text()).not.toContain("Audit devices");
	expect(text()).not.toContain("Could not load");
});

test("open control groups list progress; others' requests can be approved", async () => {
	await mount();
	await until(() => text().includes("prod/payments/CG_BOB"), "groups");
	expect(text()).toContain("leads: 1/2 approvals");
	expect(text()).toContain("Waiting");
	expect(text()).not.toContain("CG_DONE");
	expect(text()).not.toContain("vcg_");
	await click(button("Approve"));
	await until(() => writes.length === 1, "authorized");
	expect(writes).toEqual(["POST /api/vault/control-groups/cg_bob/authorize"]);
	await until(() => text().includes("Approved"), "approved badge");
});

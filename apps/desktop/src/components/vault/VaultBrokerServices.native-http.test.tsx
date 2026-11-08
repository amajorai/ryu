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

// The REAL broker services section with its editor and delete confirmation,
// against a loopback node that stores services as Core does (by name) and
// refuses a write the caller may not make.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "broker-services-node-token";
type Stored = Record<string, unknown> & { name: string };

let services: Stored[] = [];
let writes: { body: unknown; route: string }[] = [];
let refuseWrites = false;

const STRIPE: Stored = {
	allowInsecureHttp: false,
	auth: { token: "secret:STRIPE_KEY", type: "bearer" },
	createdAt: "2026-10-01T00:00:00+00:00",
	description: "Payments",
	enabled: true,
	environment: "prod",
	host: "api.stripe.com",
	name: "stripe",
	notes: "rotate monthly",
	pathPrefix: "/v1",
	substitutions: [
		{ in: ["body"], placeholder: "__ACCOUNT__", ref: "secret:STRIPE_ACCOUNT" },
	],
	updatedAt: "2026-10-01T00:00:00+00:00",
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
		if (route === "GET /api/vault/broker/services") {
			return json({ services });
		}
		if (route === "GET /api/vault/broker/catalog") {
			return json({ templates: [] });
		}
		const body = request.method === "DELETE" ? null : await request.json();
		writes.push({ body, route });
		if (refuseWrites) {
			return json(
				{
					error: "vault_denied: the `use` capability is required on `secret:X`",
				},
				403
			);
		}
		const stamp = {
			createdAt: "2026-10-02T00:00:00+00:00",
			updatedAt: "2026-10-02T00:00:00+00:00",
		};
		if (route === "POST /api/vault/broker/services") {
			const created = { ...(body as Stored), ...stamp };
			services.push(created);
			return json({ service: created });
		}
		const named = /^(PUT|DELETE) \/api\/vault\/broker\/services\/(.+)$/.exec(
			route
		);
		if (named?.[1] === "PUT") {
			const replaced = { ...(body as Stored), ...stamp };
			services = services.map((item) =>
				item.name === named[2] ? replaced : item
			);
			return json({ service: replaced });
		}
		if (named?.[1] === "DELETE") {
			const before = services.length;
			services = services.filter((item) => item.name !== named[2]);
			return json({ deleted: services.length < before });
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
const { BrokerServices, upstream } = await import("./VaultBrokerServices.tsx");
const { VaultBrokerServiceDialog } = await import(
	"./VaultBrokerServiceDialog.tsx"
);
const { BrokerAuthFields } = await import("./VaultBrokerAuthFields.tsx");
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

async function setValue(
	element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
	value: string
): Promise<void> {
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

function field<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (!found) {
		throw new Error(`No #${id}: ${text()}`);
	}
	return found as T;
}

beforeEach(() => {
	services = [{ ...STRIPE }];
	writes = [];
	refuseWrites = false;
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

test("Add service builds a custom API-key service in the panel's environment", async () => {
	await mount(<BrokerServices environment="staging" target={target} />);
	await until(() => text().includes("stripe"), "list");
	await click(button("Add service"));
	await until(() => openDialogs().length === 1, "editor");
	await setValue(field("broker-service-name"), "internal");
	await setValue(field("broker-service-host"), "Internal.Example.com");
	await setValue(field("broker-service-port"), "8443");
	await setValue(field("broker-service-auth"), "api_key");
	await setValue(field("broker-service-header"), "x-token");
	await setValue(field("broker-service-value"), "secret:INTERNAL_TOKEN");
	await click(button("Add service", openDialogs()[0]));
	await until(() => writes.length === 1, "posted");
	expect(writes[0]).toEqual({
		body: {
			auth: {
				header: "x-token",
				type: "api_key",
				value: "secret:INTERNAL_TOKEN",
			},
			description: "",
			enabled: true,
			environment: "staging",
			host: "internal.example.com",
			name: "internal",
			pathPrefix: "/",
			port: 8443,
		},
		route: "POST /api/vault/broker/services",
	});
	await until(() => text().includes("internal.example.com:8443"), "new row");
});

test("an invalid form is explained and nothing is sent", async () => {
	await mount(<BrokerServices environment="prod" target={target} />);
	await until(() => text().includes("stripe"), "list");
	await click(button("Add service"));
	await setValue(field("broker-service-name"), "Bad Name");
	await click(button("Add service", openDialogs()[0]));
	await until(() => text().includes("lowercase letters"), "problem");
	expect(writes).toEqual([]);
});

test("Edit keeps placeholders, notes and plain-HTTP opt-in, and a refusal is shown", async () => {
	await mount(<BrokerServices environment="prod" target={target} />);
	await until(() => text().includes("stripe"), "list");
	await click(button("Edit stripe"));
	await until(() => openDialogs().length === 1, "editor");
	expect(field<HTMLInputElement>("broker-service-token").value).toBe(
		"secret:STRIPE_KEY"
	);
	await setValue(field("broker-service-token"), "secret:STRIPE_RESTRICTED");
	await click(button("Save"));
	await until(() => writes.length === 1, "put");
	expect(writes[0]?.route).toBe("PUT /api/vault/broker/services/stripe");
	expect(writes[0]?.body).toMatchObject({
		allowInsecureHttp: false,
		auth: { token: "secret:STRIPE_RESTRICTED", type: "bearer" },
		name: "stripe",
		notes: "rotate monthly",
		substitutions: STRIPE.substitutions,
	});

	await until(() => openDialogs().length === 0, "closed");
	refuseWrites = true;
	await click(button("Edit stripe"));
	await click(button("Save"));
	await until(() => text().includes("capability is required"), "refusal shown");
	expect(openDialogs().length).toBe(1);
});

test("Delete asks first, then removes the service", async () => {
	await mount(<BrokerServices environment="prod" target={target} />);
	await until(() => text().includes("stripe"), "list");
	await click(button("Delete stripe"));
	await until(() => text().includes("Delete this service?"), "confirm");
	expect(text()).toContain("api.stripe.com/v1");
	expect(writes).toEqual([]);
	await click(button("Delete"));
	await until(() => text().includes("No broker services yet."), "gone");
	expect(writes).toEqual([
		{ body: null, route: "DELETE /api/vault/broker/services/stripe" },
	]);
});

test("an OAuth service keeps its connection and offers no other scheme to author it", async () => {
	const form = { authType: "oauth" } as never;
	await mount(<BrokerAuthFields form={form} onChange={() => undefined} />);
	const select = field<HTMLSelectElement>("broker-service-auth");
	expect(select.disabled).toBe(true);
	expect(select.value).toBe("oauth");
	expect(upstream({ ...STRIPE, port: 444 } as never)).toBe(
		"api.stripe.com:444/v1"
	);
	await act(async () => root?.unmount());
	root = null;
	await mount(
		<VaultBrokerServiceDialog
			draft={null}
			onOpenChange={() => undefined}
			target={target}
		/>
	);
	expect(openDialogs()).toEqual([]);
});

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

// The REAL Policies tab and JSON editor against a loopback node that replaces
// a policy wholesale on PUT and validates it the way Core does.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "policies-node";
interface Policy {
	description: string;
	name: string;
	rules: Record<string, unknown>[];
}

let policies: Policy[] = [];
let writes: { body: unknown; route: string }[] = [];
let refuseList = false;
let deleteReply = true;

const CI: Policy = {
	name: "ci",
	description: "CI deploys",
	rules: [
		{
			path: "prod/**",
			capabilities: ["write"],
			allowedParameters: { region: ["eu-*"] },
			valueRules: { minLength: 16 },
		},
	],
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
		if (route === "GET /api/vault/policies" && refuseList) {
			return json({ error: "vault_denied: admin on sys/policies" }, 403);
		}
		if (route === "GET /api/vault/policies") {
			return json({
				policies,
				bindings: [{ id: "b1", policy: "ci", subject: "machine:runner" }],
			});
		}
		const body = await request.json().catch(() => null);
		writes.push({ body, route });
		const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
		if (request.method === "PUT") {
			const sent = body as { createOnly?: boolean };
			if (sent.createOnly && policies.some((item) => item.name === name)) {
				return json(
					{ error: `vault_conflict: policy \`${name}\` already exists` },
					409
				);
			}
			const rules = (body as { rules: Record<string, unknown>[] }).rules;
			if (rules.some((rule) => rule.path === "")) {
				return json({ error: "invalid_request: rule path is empty" }, 400);
			}
			const policy = { ...(body as Policy), name };
			policies = [...policies.filter((item) => item.name !== name), policy];
			return json({ ok: true, policy });
		}
		if (request.method === "DELETE") {
			policies = policies.filter((item) => item.name !== name);
			return json({ ok: true, deleted: deleteReply });
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
const { VaultPoliciesPanel } = await import("./VaultPoliciesPanel.tsx");
const { VaultPolicyDialog } = await import("./VaultPolicyDialog.tsx");
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
				<VaultPoliciesPanel target={target} />
			</QueryClientProvider>
		)
	);
	await flush(4);
}

async function setValue(id: string, value: string): Promise<void> {
	const element = document.getElementById(id) as
		| HTMLInputElement
		| HTMLTextAreaElement
		| null;
	if (!element) {
		throw new Error(`No #${id}: ${text()}`);
	}
	const prototype =
		element instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	await act(async () => {
		setter?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await flush(2);
}

beforeEach(() => {
	policies = [structuredClone(CI)];
	writes = [];
	refuseList = false;
	deleteReply = true;
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

test("a policy lists its rules and bindings, and Edit keeps every rule field", async () => {
	await mount();
	await until(() => text().includes("CI deploys"), "policies");
	expect(text()).toContain("1 rule");
	expect(text()).toContain("Bound to machine:runner");
	await click(button("Edit ci"));
	await until(() => openDialogs().length === 1, "dialog");
	const name = document.getElementById("vault-policy-name") as HTMLInputElement;
	expect(name.value).toBe("ci");
	expect(name.disabled).toBe(true);
	const document_ = document.getElementById(
		"vault-policy-document"
	) as HTMLTextAreaElement;
	const edited = JSON.parse(document_.value);
	edited.description = "CI deploys to prod";
	await setValue("vault-policy-document", JSON.stringify(edited));
	await click(button("Save policy", openDialogs()[0]));
	await until(() => writes.length === 1, "saved");
	expect(writes[0]).toEqual({
		route: "PUT /api/vault/policies/ci",
		body: { description: "CI deploys to prod", rules: CI.rules },
	});
	await until(() => text().includes("CI deploys to prod"), "updated row");
});

test("bad JSON is explained and nothing is sent; Core's refusal is shown", async () => {
	await mount();
	await until(() => text().includes("CI deploys"), "policies");
	await click(button("New policy"));
	await until(() => openDialogs().length === 1, "dialog");
	await setValue("vault-policy-name", "Bad Name");
	await click(button("Save policy", openDialogs()[0]));
	await until(() => text().includes("lowercase letters"), "name problem");
	await setValue("vault-policy-name", "deploy");
	await setValue("vault-policy-document", "{ rules: ");
	await click(button("Save policy", openDialogs()[0]));
	await until(() => text().includes("not valid JSON"), "json problem");
	expect(writes).toEqual([]);

	await setValue(
		"vault-policy-document",
		JSON.stringify({ rules: [{ path: "", capabilities: ["read"] }] })
	);
	await click(button("Save policy", openDialogs()[0]));
	await until(() => text().includes("rule path is empty"), "core refusal");
	expect(writes.length).toBe(1);
	expect(openDialogs().length).toBe(1);
});

test("the editor dialog renders nothing while closed", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={new QueryClient()}>
				<VaultPolicyDialog
					onOpenChange={() => undefined}
					open={false}
					policy={null}
					target={target}
				/>
			</QueryClientProvider>
		)
	);
	expect(openDialogs().length).toBe(0);
	expect(document.getElementById("vault-policy-document")).toBeNull();
});

test("Delete asks first, naming the bound subjects, and sends nothing until confirmed", async () => {
	await mount();
	await until(() => text().includes("CI deploys"), "policies");
	await click(button("Delete ci"));
	await until(() => text().includes("Delete ci?"), "confirm");
	expect(text()).toContain("machine:runner");
	expect(writes).toEqual([]);
	await click(button("Cancel"));
	await until(() => !text().includes("Delete ci?"), "cancelled");
	expect(writes).toEqual([]);

	await click(button("Delete ci"));
	await until(() => text().includes("Delete ci?"), "confirm again");
	await click(button("Delete policy"));
	await until(() => text().includes("No policies yet."), "deleted");
	expect(writes).toEqual([
		{ route: "DELETE /api/vault/policies/ci", body: null },
	]);
});

test("a new policy cannot replace an existing one, and a misspelled field is refused", async () => {
	await mount();
	await until(() => text().includes("CI deploys"), "policies");
	await click(button("New policy"));
	await until(() => openDialogs().length === 1, "dialog");
	await setValue("vault-policy-name", "ci");
	await click(button("Save policy", openDialogs()[0]));
	await until(() => text().includes("already exists"), "taken");
	await setValue("vault-policy-name", "deploy");
	await setValue(
		"vault-policy-document",
		JSON.stringify({
			rules: [{ path: "a/**", capabilities: ["write"], valueRule: {} }],
		})
	);
	await click(button("Save policy", openDialogs()[0]));
	await until(() => text().includes("valueRule"), "typo");
	expect(writes).toEqual([]);
});

test("a new policy is sent create-only, so a name taken since the list loaded is refused", async () => {
	await mount();
	await until(() => text().includes("CI deploys"), "policies");
	await click(button("New policy"));
	await until(() => openDialogs().length === 1, "dialog");
	await setValue("vault-policy-name", "deploy");
	// Someone else creates "deploy" after this list loaded.
	policies.push({
		name: "deploy",
		description: "theirs",
		rules: [{ path: "x", capabilities: ["read"] }],
	});
	await click(button("Save policy", openDialogs()[0]));
	await until(() => text().includes("already exists"), "conflict");
	expect(writes[0]?.body).toMatchObject({ createOnly: true });
	expect(policies.find((item) => item.name === "deploy")?.description).toBe(
		"theirs"
	);
	const problem = document.getElementById("vault-policy-problem");
	expect(problem).not.toBeNull();
	expect(
		document
			.getElementById("vault-policy-name")
			?.getAttribute("aria-describedby")
	).toBe("vault-policy-problem");
});

test("a refused list (403) explains itself and New policy stays disabled", async () => {
	refuseList = true;
	await mount();
	await until(
		() => text().toLowerCase().includes("admin on sys/policies"),
		"403 shown"
	);
	const create = button("New policy") as HTMLButtonElement;
	expect(create.disabled).toBe(true);
	expect(writes).toEqual([]);
});

test("a delete the vault reports as already gone says so instead of claiming it", async () => {
	deleteReply = false;
	await mount();
	await until(() => text().includes("CI deploys"), "policies");
	// Toasts from earlier tests linger in the shared toaster: count new ones.
	const claimed = () => text().split("Deleted policy ci").length;
	const before = claimed();
	await click(button("Delete ci"));
	await until(() => text().includes("Delete ci?"), "confirm");
	await click(button("Delete policy"));
	await until(() => text().includes("already gone"), "info toast");
	expect(claimed()).toBe(before);
});

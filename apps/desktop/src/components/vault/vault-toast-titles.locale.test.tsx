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

// Toasts raised by the Machines tab, the shown-once copy button and the broker
// service editor render their titles in the active locale (German here), not
// as the English source, because each title goes through the component's `tl`
// (the DOM localizer is off here, so only `tl` can translate them).
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "toast-titles-node";
const DE: Record<string, string> = {
	Copied: "Kopiert",
	"Could not copy": "Kopieren fehlgeschlagen",
	"Secret ID revoked": "Secret-ID widerrufen",
	"Service added": "Dienst hinzugefügt",
	"Service saved": "Dienst gespeichert",
	"That did not work": "Das hat nicht funktioniert",
	"Token revoked": "Token widerrufen",
};

let refuse = false;
const MACHINE = {
	id: "mid_ci",
	name: "ci",
	auth: { kind: "approle", role_id: "role-ci" },
	policies: ["ci-read"],
	tokenTtlSecs: 3600,
	disabled: false,
	createdAt: 1,
	createdBy: null,
};
const SERVICE = {
	auth: { token: "secret:STRIPE_KEY", type: "bearer" },
	createdAt: "2026-10-01T00:00:00+00:00",
	enabled: true,
	environment: "prod",
	host: "api.stripe.com",
	name: "stripe",
	pathPrefix: "/v1",
	updatedAt: "2026-10-01T00:00:00+00:00",
};

function json(body: unknown, status = 200): Response {
	return NativeResponse.json(body, { status });
}

function read(route: string): Response | null {
	if (route === "GET /api/vault/machines") {
		return json({ machines: [MACHINE] });
	}
	if (route === "GET /api/vault/machines/mid_ci/secret-ids") {
		return json({
			secretIds: [
				{
					accessor: "sid-acc",
					createdAt: 1,
					expiresAt: null,
					usesRemaining: 1,
				},
			],
		});
	}
	if (route === "GET /api/vault/tokens") {
		return json({
			tokens: [
				{
					accessor: "tok-acc",
					identityId: "mid_ci",
					policies: ["ci-read"],
					role: null,
					createdAt: 1,
					expiresAt: 1_900_000_000_000,
					numUsesRemaining: null,
					revokedAt: null,
				},
			],
		});
	}
	if (route === "GET /api/vault/token-roles") {
		return json({ roles: [] });
	}
	if (route === "GET /api/vault/broker/catalog") {
		return json({ templates: [] });
	}
	return null;
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
		const answer = read(route);
		if (answer) {
			return answer;
		}
		if (refuse) {
			return json({ error: "vault_denied: not allowed" }, 403);
		}
		if (
			route.endsWith("/revoke") ||
			route.startsWith("DELETE /api/vault/secret-ids/")
		) {
			return json({ revoked: true });
		}
		if (
			route.startsWith("POST /api/vault/broker/services") ||
			route.startsWith("PUT /api/vault/broker/services/")
		) {
			return json({ service: { ...SERVICE, ...(await request.json()) } });
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
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { VaultMachinesPanel } = await import("./VaultMachinesPanel.tsx");
const { VaultMachineTokens } = await import("./VaultMachineTokens.tsx");
const { VaultMachineSecretIds } = await import("./VaultMachineSecretIds.tsx");
const { VaultShownOnce } = await import("./VaultShownOnce.tsx");
const { VaultBrokerServiceDialog } = await import(
	"./VaultBrokerServiceDialog.tsx"
);
const { serviceFormFrom } = await import("./vault-broker-service-form.ts");
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
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="de"
					initialPackId={null}
				>
					<Toaster />
					{node}
				</I18nProvider>
			</QueryClientProvider>
		)
	);
	await flush(6);
}

function confirms(): HTMLElement[] {
	return [
		...document.querySelectorAll<HTMLElement>('[role="alertdialog"]'),
	].filter((dialog) => !dialog.hasAttribute("data-closed"));
}

function submit(): HTMLButtonElement {
	const found = openDialogs()[0]?.querySelector<HTMLButtonElement>(
		'button[type="submit"]'
	);
	if (!found) {
		throw new Error(`No submit button: ${text()}`);
	}
	return found;
}

async function revoke(name: string): Promise<void> {
	await click(button(name));
	await click(button(`${name} now`));
}

beforeEach(() => {
	refuse = false;
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
});

afterEach(async () => {
	sileo.clear();
	registerLiteralCatalogLoader(null);
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	window.fetch = nativeFetch;
});

const noop = () => undefined;

test("revoking a machine token toasts in German, success and failure", async () => {
	await mount(
		<VaultMachineTokens
			machine={MACHINE}
			onStateChange={noop}
			target={target}
		/>
	);
	await until(() => text().includes("tok-acc"), "token listed");
	await revoke("Revoke token tok-acc");
	await until(() => text().includes("Token widerrufen"), "revoked toast");
	expect(text()).not.toContain("Token revoked");
	refuse = true;
	await revoke("Revoke token tok-acc");
	await until(() => text().includes("Das hat nicht funktioniert"), "failure");
	expect(text()).not.toContain("That did not work");
});

test("revoking a secret ID toasts in German, success and failure", async () => {
	await mount(
		<VaultMachineSecretIds
			machine={MACHINE}
			onStateChange={noop}
			target={target}
		/>
	);
	await until(() => text().includes("sid-acc"), "secret id listed");
	await revoke("Revoke secret ID sid-acc");
	await until(() => text().includes("Secret-ID widerrufen"), "revoked toast");
	expect(text()).not.toContain("Secret ID revoked");
	refuse = true;
	await revoke("Revoke secret ID sid-acc");
	await until(() => text().includes("Das hat nicht funktioniert"), "failure");
});

test("a refused machine change toasts its failure in German", async () => {
	refuse = true;
	await mount(<VaultMachinesPanel target={target} />);
	await until(() => text().includes("ci"), "machines");
	await click(button("Disable ci"));
	await until(() => confirms().length === 1, "confirm");
	await click(button("Disable", confirms()[0]));
	await until(() => text().includes("Das hat nicht funktioniert"), "failure");
	expect(text()).not.toContain("That did not work");
});

test("the shown-once copy button toasts in German", async () => {
	const writes: string[] = [];
	let fail = false;
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: (value: string) => {
				if (fail) {
					return Promise.reject(new Error("denied"));
				}
				writes.push(value);
				return Promise.resolve();
			},
		},
	});
	await mount(
		<VaultShownOnce id="shown" label="Token" onDone={noop} value="rvt_x" />
	);
	await click(button("Copy Token"));
	await until(() => text().includes("Kopiert"), "copied toast");
	expect(writes).toEqual(["rvt_x"]);
	fail = true;
	await click(button("Copy Token"));
	await until(() => text().includes("Kopieren fehlgeschlagen"), "failure");
	expect(text()).not.toContain("Could not copy");
});

test("saving and adding a broker service toast in German", async () => {
	await mount(
		<VaultBrokerServiceDialog
			draft={{ mode: "edit", service: SERVICE } as never}
			onOpenChange={noop}
			target={target}
		/>
	);
	await click(submit());
	await until(() => text().includes("Dienst gespeichert"), "saved toast");
	expect(text()).not.toContain("Service saved");
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
	await mount(
		<VaultBrokerServiceDialog
			draft={{
				environment: "prod",
				mode: "create",
				seed: serviceFormFrom(SERVICE as never),
			}}
			onOpenChange={noop}
			target={target}
		/>
	);
	await click(submit());
	await until(() => text().includes("Dienst hinzugefügt"), "added toast");
	expect(text()).not.toContain("Service added");
});

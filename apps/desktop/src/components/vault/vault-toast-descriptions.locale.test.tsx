import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { join } from "node:path";
import type { Root } from "react-dom/client";
import {
	button,
	click,
	flush,
	installAnimationApis,
	maybeButton,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// A refused vault action toasts its title and its "Try again." fallback in the
// active locale. The node answers every write with a bare 500, so the error
// carries no server sentence and vaultErrorMessage returns the fallback; the
// DOM localizer is off, so only `tl` can translate it. The German text is the
// shipped catalog's own, one panel group per test.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const CATALOG = (await Bun.file(
	join(import.meta.dir, "../../../../../packages/i18n/locales/de.json")
).json()) as Record<string, string>;
const KEYS = [
	"Could not approve the request",
	"Could not revoke the session",
	"Could not seal",
	"Could not update the request",
	"That did not work",
	"Try again.",
];
const DE: Record<string, string> = Object.fromEntries(
	KEYS.map((key) => [key, CATALOG[key] ?? ""])
);

const TOKEN = "toast-descriptions-node";
const T = "2030-01-01T00:00:00Z";
const LISTS: Record<string, unknown> = {
	"/api/vault/broker/sessions": {
		sessions: [
			{
				createdAt: "2026-10-01T00:00:00+00:00",
				environment: "prod",
				expiresAt: "2026-10-01T01:00:00+00:00",
				id: "bs_old",
				label: "",
				mintedBy: "runtime:acp",
				services: ["stripe"],
			},
		],
	},
	"/api/vault/change-requests": {
		changeRequests: [
			{
				approvals: [],
				coords: {
					environment: "prod",
					name: "SECRET_THEIRS",
					path: "/",
					scope: "user",
					scopeId: "user-1",
				},
				decidedAt: null,
				decidedBy: null,
				hasValue: true,
				id: "theirs",
				operation: "write",
				patch: null,
				reason: null,
				requestedAt: T,
				requestedBy: "ada",
				requiredApprovals: 2,
				status: "pending",
			},
		],
	},
	"/api/vault/control-groups": {
		controlGroups: [
			{
				approvals: [],
				createdAt: T,
				expiresAt: T,
				factors: [{ approvals: 1, approvers: ["user:alice"], name: "leads" }],
				id: "cg_bob",
				policyKey: "prod/payments/CG_BOB",
				requester: "user:bob",
				status: "pending",
				target: { coords: { name: "cg_bob" }, version: 1 },
			},
		],
	},
	"/api/vault/leases": {
		leases: [
			{
				createdAt: 1,
				expiresAt: Date.now() + 3_600_000,
				id: "dl_live",
				issuedTo: "user:ada",
				maxExpiresAt: Date.now() + 86_400_000,
				provider: "postgres",
				renewable: true,
				revokedAt: null,
				role: "db-ro",
			},
		],
	},
	"/api/vault/policies": {
		bindings: [],
		policies: [{ description: "", name: "ci", rules: [] }],
	},
	"/api/vault/token-roles": {
		roles: [
			{
				allowedPolicies: ["ci-read"],
				createdAt: 1,
				disallowedPolicies: [],
				maxTtlSecs: 86_400,
				name: "ci",
				orphan: false,
				ttlSecs: 3600,
				updatedAt: 1,
			},
		],
	},
};
let writes: string[] = [];

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			return NativeResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		if (request.method === "GET") {
			const list = LISTS[url.pathname];
			return list
				? NativeResponse.json(list)
				: NativeResponse.json({ error: "undeclared" }, { status: 404 });
		}
		writes.push(`${request.method} ${url.pathname}`);
		// No server sentence: the panel falls back to its own copy.
		return NativeResponse.json({}, { status: 500 });
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
const { VaultSealControl } = await import("./VaultSealControl.tsx");
const { VaultPoliciesPanel } = await import("./VaultPoliciesPanel.tsx");
const { VaultTokenRolesPanel } = await import("./VaultTokenRolesPanel.tsx");
const { VaultLeasesSection } = await import("./VaultLeasesSection.tsx");
const { VaultControlGroups } = await import("./VaultControlGroups.tsx");
const { VaultChangeRequests } = await import("./VaultChangeRequests.tsx");
const { BrokerSessions } = await import("./VaultBrokerSessions.tsx");
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

// A control by its English name or the German catalog's, since the shared
// labels arrive translated.
function control(
	source: string,
	values: Record<string, string> = {}
): HTMLButtonElement {
	const german = Object.entries(values).reduce(
		(name, [key, value]) => name.replace(`{${key}}`, value),
		CATALOG[source] ?? source
	);
	const english = Object.entries(values).reduce(
		(name, [key, value]) => name.replace(`{${key}}`, value),
		source
	);
	return maybeButton(english) ?? button(german);
}

// Waits for the German refusal toast (its title and the fallback description)
// and returns what still reads in English, or that nothing was sent.
async function englishInRefusal(title: string): Promise<string[]> {
	await until(() => text().includes(DE[title] ?? title), `${title} toast`);
	await until(() => text().includes(DE["Try again."] ?? ""), "description");
	const left = [title, "Try again."].filter((source) =>
		text().includes(source)
	);
	return writes.length > 0 ? left : [...left, "no write sent"];
}

beforeEach(() => {
	writes = [];
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

test("the fixture strings are the shipped German catalog's", () => {
	for (const key of KEYS) {
		expect(DE[key]).toBeTruthy();
		expect(DE[key]).not.toBe(key);
	}
});

test("a refused seal toasts in German", async () => {
	await mount(
		<VaultSealControl
			canManage
			seal={{
				activeKeyVersion: 1,
				keyVersions: [1],
				mode: "auto",
				progress: 0,
				sealed: false,
				shares: 0,
				threshold: 0,
			}}
			target={target}
		/>
	);
	await click(control("Seal"));
	await until(() => confirms().length === 1, "confirm");
	await click(control("Seal vault"));
	expect(await englishInRefusal("Could not seal")).toEqual([]);
});

test("refused policy and token-role deletes toast in German", async () => {
	await mount(<VaultPoliciesPanel target={target} />);
	await until(() => text().includes("ci"), "policies");
	await click(control("Delete {name}", { name: "ci" }));
	await until(() => confirms().length === 1, "confirm");
	await click(control("Delete policy"));
	expect(await englishInRefusal("That did not work")).toEqual([]);
	sileo.clear();
	await act(async () => root?.unmount());
	document.body.replaceChildren();
	writes = [];
	await mount(<VaultTokenRolesPanel target={target} />);
	await until(() => text().includes("ci-read"), "token roles");
	await click(control("Delete {name}", { name: "ci" }));
	expect(await englishInRefusal("That did not work")).toEqual([]);
});

test("a refused lease revoke toasts in German", async () => {
	await mount(<VaultLeasesSection target={target} />);
	await until(() => text().includes("dl_live"), "leases");
	await click(control("Revoke {lease}", { lease: "dl_live" }));
	expect(await englishInRefusal("That did not work")).toEqual([]);
});

test("refused control-group and change-request approvals toast in German", async () => {
	await mount(
		<VaultControlGroups callerSubject="user:alice" target={target} />
	);
	await until(() => text().includes("prod/payments/CG_BOB"), "groups");
	await click(control("Approve"));
	expect(await englishInRefusal("Could not approve the request")).toEqual([]);
	sileo.clear();
	await act(async () => root?.unmount());
	document.body.replaceChildren();
	writes = [];
	await mount(<VaultChangeRequests callerSubject="user-me" target={target} />);
	await until(() => text().includes("SECRET_THEIRS"), "requests");
	await click(control("Approve"));
	expect(await englishInRefusal("Could not update the request")).toEqual([]);
});

test("a refused broker session revoke toasts in German", async () => {
	await mount(<BrokerSessions environment="prod" target={target} />);
	await until(() => text().includes("runtime:acp"), "sessions");
	await click(control("Revoke"));
	expect(await englishInRefusal("Could not revoke the session")).toEqual([]);
});

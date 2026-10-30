import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import type { Root } from "react-dom/client";
import { z } from "zod";
import { TauriUnavailableError } from "@/src/lib/tauri-ready.ts";
import { signInVaultAccount } from "./account-billing.native-http.dom.ts";
import { registerDomWithNativeNetworking } from "./unswept-a.test-support.ts";

// The REAL workspace picker at the head of Settings → Services, mounted the way
// SettingsDialog mounts it: inside the dialog's own isolated QueryClient, next
// to a REAL org-scoped consumer from that group (`useCreditGrants`, which keys
// its query by the active org exactly as the Credits surfaces do). The shipping
// Better Auth client, org SDK, billing-status hook and app-wide QueryClient talk
// to a loopback control plane that keeps one durable session row, enforces the
// bearer token and membership on `set-active`, and scopes every org route to
// the session's active org — the server contract the picker relies on.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

// ── Control-plane fixture ───────────────────────────────────────────────────
const TOKEN = "services-picker-session-token";
const USER_ID = "user-ada";
const PERSONAL = "org-personal";
const ACME = "org-acme";
const ZETA = "org-zeta";

interface Org {
	createdAt: string;
	id: string;
	isPersonal: boolean;
	name: string;
	plan: "plus" | "pro" | "max";
	pool: { label: string; micro: number };
	role: string;
}
function seedOrgs(): Map<string, Org> {
	return new Map(
		(
			[
				{
					createdAt: "2026-01-01T00:00:00.000Z",
					id: PERSONAL,
					isPersonal: true,
					name: "Ada's Workspace",
					plan: "plus",
					pool: { label: "Ryu Fast", micro: 5_000_000 },
					role: "owner",
				},
				{
					createdAt: "2026-02-01T00:00:00.000Z",
					id: ACME,
					isPersonal: false,
					name: "Acme Robotics",
					plan: "max",
					pool: { label: "Ryu Frontier", micro: 9_000_000 },
					role: "member",
				},
				{
					createdAt: "2026-03-01T00:00:00.000Z",
					id: ZETA,
					isPersonal: false,
					name: "Zeta Labs",
					plan: "pro",
					pool: { label: "Ryu Fast", micro: 1_250_000 },
					role: "admin",
				},
			] satisfies Org[]
		).map((org) => [org.id, org])
	);
}

interface Exchange {
	active: string | null;
	body: unknown;
	route: string;
}
let orgs = seedOrgs();
/** The ids the user is a member of, in membership (creation) order. */
let members: string[] = [PERSONAL, ACME, ZETA];
/** The durable session row: `set-active` is the only writer. */
let activeOrganizationId: string | null = PERSONAL;
let exchanges: Exchange[] = [];
let unexpected: string[] = [];
let heldSetActive: Promise<void> | null = null;
/** When armed, the first session read after a successful switch waits here. */
let holdSessionAfterSwitch = false;
let sessionGate: { promise: Promise<void>; release: () => void } | null = null;
let pendingSessionRelease: (() => void) | null = null;
const setActiveBody = z.object({ organizationId: z.string() }).strict();
const at = "2026-10-12T00:00:00.000Z";

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		const raw = request.method === "GET" ? "" : await request.text();
		const body: unknown = raw ? JSON.parse(raw) : null;
		exchanges.push({ active: activeOrganizationId, body, route });
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			if (route === "GET /api/auth/get-session") {
				return NativeResponse.json(null);
			}
			unexpected.push(`unauthenticated ${route}`);
			return NativeResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		if (route === "GET /api/auth/get-session") {
			const gate = sessionGate;
			if (gate) {
				sessionGate = null;
				pendingSessionRelease = gate.release;
				await gate.promise;
			}
			return NativeResponse.json({
				session: {
					activeOrganizationId,
					activeTeamId: null,
					createdAt: at,
					expiresAt: "2027-10-12T00:00:00.000Z",
					id: "session-ada",
					token: TOKEN,
					updatedAt: at,
					userId: USER_ID,
				},
				user: {
					createdAt: at,
					email: "ada@services.example.test",
					emailVerified: true,
					id: USER_ID,
					image: null,
					name: "Ada Lovelace",
					updatedAt: at,
				},
			});
		}
		if (route === "GET /api/control-plane/orgs") {
			return NativeResponse.json({
				organizations: members.map((id) => {
					const org = orgs.get(id) as Org;
					return {
						createdAt: org.createdAt,
						id: org.id,
						isPersonal: org.isPersonal,
						logo: null,
						name: org.name,
						role: org.role,
						slug: org.id,
					};
				}),
			});
		}
		if (route === "POST /api/auth/organization/set-active") {
			const parsed = setActiveBody.safeParse(body);
			if (!parsed.success) {
				unexpected.push(`set-active ${raw}`);
				return NativeResponse.json({ message: "Bad body" }, { status: 400 });
			}
			if (heldSetActive) {
				await heldSetActive;
			}
			if (!members.includes(parsed.data.organizationId)) {
				return NativeResponse.json(
					{
						code: "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION",
						message: "You are not a member of this organization",
					},
					{ status: 403 }
				);
			}
			activeOrganizationId = parsed.data.organizationId;
			if (holdSessionAfterSwitch) {
				holdSessionAfterSwitch = false;
				let release: () => void = () => undefined;
				const promise = new Promise<void>((resolve) => {
					release = resolve;
				});
				sessionGate = { promise, release };
			}
			const org = orgs.get(activeOrganizationId) as Org;
			return NativeResponse.json({ id: org.id, name: org.name, slug: org.id });
		}
		// Every org-scoped route resolves the org from the session row, falling
		// back to the earliest membership, exactly as the control plane does.
		const scoped = orgs.get(activeOrganizationId ?? members[0] ?? "");
		if (route === "GET /api/billing/subscription-status") {
			return NativeResponse.json({
				entitlement: null,
				organizationId: scoped?.id ?? null,
				plan: scoped?.plan ?? null,
				scope: "org",
				subscription: null,
			});
		}
		if (route === "GET /api/campaigns/mine") {
			return NativeResponse.json({
				pools: scoped
					? [
							{
								expiresAt: null,
								isFreeProvider: false,
								poolLabel: scoped.pool.label,
								remainingMicroUsd: scoped.pool.micro,
							},
						]
					: [],
			});
		}
		unexpected.push(route);
		return NativeResponse.json({ error: "Undeclared route" }, { status: 404 });
	},
});
process.env.VITE_APP_BACKEND_URL = server.url.origin;
const tauriCalls: string[] = [];
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	configurable: true,
	value: {
		invoke: (command: string) => {
			// This harness has no sealed auth-vault slot: the vault seeded in
			// localStorage below is read as a host without one would.
			if (command.startsWith("desktop_secret_")) {
				return Promise.reject(new TauriUnavailableError(command));
			}
			tauriCalls.push(command);
			return Promise.reject(new Error(`No native bridge for ${command}`));
		},
		transformCallback: () => 0,
	},
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { TOKEN_KEY } = await import("@/lib/auth-client.ts");
const { queryClient: appQueryClient } = await import(
	"@/src/lib/query-client.ts"
);
const { useCreditGrants } = await import("@/src/hooks/useCreditGrants.ts");
const { ServicesOrgSwitcher } = await import("./ServicesOrgSwitcher.tsx");
const { flush, installAnimationApis, isDisabled, press, text, until } =
	await import("./unswept-a.test-support.ts");
installAnimationApis();

// ── Mounting ────────────────────────────────────────────────────────────────
/** Every distinct grants snapshot the org-scoped consumer rendered. */
let grantRenders: string[] = [];

/** An org-scoped Services surface: the real credit-grants hook. */
function GrantsConsumer() {
	const { pools } = useCreditGrants();
	const shown = pools
		.map((pool) => `${pool.label} ${(pool.remainingMicroUsd / 1e6).toFixed(2)}`)
		.join(", ");
	if (grantRenders.at(-1) !== shown) {
		grantRenders.push(shown);
	}
	return <output data-grants>{shown}</output>;
}

let root: Root | null = null;
let dialogClient = new QueryClient();

async function mount(): Promise<void> {
	// SettingsDialog's isolated client; the app-wide one stays shared.
	dialogClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={dialogClient}>
				<Toaster />
				<ServicesOrgSwitcher />
				<GrantsConsumer />
			</QueryClientProvider>
		)
	);
	await flush(4);
}

async function unmount(): Promise<void> {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	document.body.replaceChildren();
}

function maybeTrigger(): HTMLButtonElement | null {
	return document.querySelector<HTMLButtonElement>(
		'[data-slot="dropdown-menu-trigger"]'
	);
}

function trigger(): HTMLButtonElement {
	const found = maybeTrigger();
	if (!found) {
		throw new Error(`No workspace picker: ${text()}`);
	}
	return found;
}

function triggerText(): string {
	return (trigger().textContent ?? "").replace(/\s+/g, " ").trim();
}

function personalReady(): Promise<void> {
	return until(
		() => triggerText() === "Ada's Workspace" && grants() === "Ryu Fast 5.00",
		"personal workspace"
	);
}

function grants(): string {
	return document.querySelector("[data-grants]")?.textContent ?? "";
}

function menuItems(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

function itemFor(name: string): HTMLElement {
	const item = menuItems().find((candidate) =>
		candidate.textContent?.includes(name)
	);
	if (!item) {
		throw new Error(`No menu item ${name}: ${text()}`);
	}
	return item;
}

async function openMenu(): Promise<void> {
	await act(async () => trigger().click());
	await until(() => menuItems().length > 0, "workspace menu");
}

/** Answer the held session read (it is cleared from the fixture on use). */
function gateRelease(): void {
	pendingSessionRelease?.();
	pendingSessionRelease = null;
}

function routesSince(index: number): string[] {
	return exchanges.slice(index).map((exchange) => exchange.route);
}

async function signedInMount(): Promise<void> {
	signInVaultAccount(TOKEN_KEY, TOKEN, USER_ID);
	await mount();
	await until(() => maybeTrigger() !== null, "picker");
	await until(() => grants() !== "", "org-scoped grants");
}

beforeEach(() => {
	orgs = seedOrgs();
	members = [PERSONAL, ACME, ZETA];
	activeOrganizationId = PERSONAL;
	exchanges = [];
	unexpected = [];
	grantRenders = [];
	heldSetActive = null;
	holdSessionAfterSwitch = false;
	sessionGate = null;
	localStorage.clear();
	appQueryClient.clear();
});

afterEach(async () => {
	await unmount();
	sileo.clear();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must keep to the owned control-plane contract.
	expect(unexpected).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	window.fetch = nativeFetch;
});

// ── Cases ───────────────────────────────────────────────────────────────────
test("signed out, the picker renders nothing and never asks the control plane for workspaces", async () => {
	await mount();
	await flush(10);
	expect(maybeTrigger() === null).toBe(true);
	expect(
		exchanges.filter((e) => e.route === "GET /api/control-plane/orgs")
	).toEqual([]);
	expect(
		exchanges.filter(
			(e) => e.route === "POST /api/auth/organization/set-active"
		)
	).toEqual([]);
});

test("a single workspace is named and offers no menu to switch", async () => {
	members = [PERSONAL];
	await signedInMount();
	await personalReady();
	expect(triggerText()).toBe("Ada's Workspace");
	expect(isDisabled(trigger())).toBe(true);
	await act(async () => trigger().click());
	await flush(4);
	expect(menuItems()).toHaveLength(0);
	expect(
		trigger().querySelectorAll("[data-org-switcher-chevron]")
	).toHaveLength(0);
});

test("with no active org on the session the picker shows the earliest membership, checked, and the menu lists every workspace with its role", async () => {
	activeOrganizationId = null;
	await signedInMount();
	await personalReady();
	expect(triggerText()).toBe("Ada's Workspace");
	expect(grants()).toBe("Ryu Fast 5.00");
	expect(isDisabled(trigger())).toBe(false);
	expect(
		trigger().querySelectorAll("[data-org-switcher-chevron]")
	).toHaveLength(1);

	await openMenu();
	await until(
		() => menuItems()[0]?.textContent?.includes("PLUS") ?? false,
		"plan badge in the menu"
	);
	const rows = menuItems().map((item) => ({
		checked: item.querySelector("[data-org-switcher-check]") !== null,
		text: (item.textContent ?? "").replace(/\s+/g, " ").trim(),
	}));
	expect(rows).toEqual([
		{ checked: true, text: "Ada's WorkspacePLUSowner" },
		{ checked: false, text: "Acme Roboticsmember" },
		{ checked: false, text: "Zeta Labsadmin" },
	]);
	// Picking the workspace already in force sends nothing.
	const before = exchanges.length;
	await act(async () => itemFor("Ada's Workspace").click());
	await flush(6);
	expect(routesSince(before)).not.toContain(
		"POST /api/auth/organization/set-active"
	);
	expect(activeOrganizationId).toBeNull();
});

test("switching rescopes the server session, keys org-scoped reads to the new org as soon as the server answers the switch, and never shows the previous org's numbers", async () => {
	await signedInMount();
	await personalReady();
	expect(grants()).toBe("Ryu Fast 5.00");
	const personalKey = ["credit-grants", PERSONAL];
	const personalGrants = dialogClient.getQueryData(personalKey);
	expect(personalGrants).toBeDefined();

	let release: () => void = () => undefined;
	heldSetActive = new Promise<void>((resolve) => {
		release = resolve;
	});
	holdSessionAfterSwitch = true;
	await openMenu();
	const before = exchanges.length;
	await act(async () => itemFor("Acme Robotics").click());
	await until(() => isDisabled(trigger()), "picker locked while switching");
	expect(
		trigger().querySelectorAll("[data-org-switcher-chevron]")
	).toHaveLength(0);
	expect(activeOrganizationId).toBe(PERSONAL);
	release();
	heldSetActive = null;

	// The server has switched. `setActiveOrg` takes the new org from the
	// set-active answer itself (180be3454), so org-scoped surfaces re-key onto
	// Acme without waiting for the active-org re-read, which is still held:
	// nothing may read for Acme under Ada's key, or show Ada's figures once the
	// server answers for Acme.
	await until(
		() => sessionGate === null && activeOrganizationId === ACME,
		"session re-read requested"
	);
	const setActiveAt = exchanges.findIndex(
		(exchange, index) =>
			index >= before &&
			exchange.route === "POST /api/auth/organization/set-active"
	);
	expect(setActiveAt).toBeGreaterThanOrEqual(before);
	await until(() => grants() === "Ryu Frontier 9.00", "Acme grants while held");
	expect(isDisabled(trigger())).toBe(true);
	expect<unknown>(dialogClient.getQueryData(personalKey)).toBe(personalGrants);
	gateRelease();

	await until(() => triggerText() === "Acme Robotics", "switched picker");
	await until(() => grants() === "Ryu Frontier 9.00", "Acme grants");
	await until(() => !isDisabled(trigger()), "picker unlocked");
	expect(activeOrganizationId).toBe(ACME);
	const switchBodies = exchanges
		.filter((e) => e.route === "POST /api/auth/organization/set-active")
		.map((e) => e.body);
	expect(switchBodies).toEqual([{ organizationId: ACME }]);

	// Every org-scoped grants read came after the switch was requested and
	// was served under the new session scope.
	const grantReads = exchanges
		.slice(before)
		.filter((exchange) => exchange.route === "GET /api/campaigns/mine");
	expect(grantReads.length).toBeGreaterThanOrEqual(1);
	expect(
		grantReads.every((read) => exchanges.indexOf(read) > setActiveAt)
	).toBe(true);
	expect(grantReads.every((read) => read.active === ACME)).toBe(true);
	// Only the new org's entry is left in the dialog cache: the previous org's
	// is swept, so a switch back cannot be served from it.
	expect(dialogClient.getQueryData(personalKey)).toBeUndefined();
	expect(
		dialogClient
			.getQueryCache()
			.findAll({ queryKey: ["credit-grants"] })
			.map((query) => query.queryKey)
	).toEqual([["credit-grants", ACME]]);

	// The personal org's balance changes server-side while Acme is active.
	(orgs.get(PERSONAL) as Org).pool.micro = 3_000_000;
	const renderMark = grantRenders.length;
	await openMenu();
	await act(async () => itemFor("Ada's Workspace").click());
	await until(() => grants() === "Ryu Fast 3.00", "personal grants again");
	await until(() => triggerText() === "Ada's Workspace", "picker back");
	// Never a paint of the stale personal figure on the way back.
	expect(grantRenders.slice(renderMark)).not.toContain("Ryu Fast 5.00");
	expect(activeOrganizationId).toBe(PERSONAL);

	// An independent mount reads the persisted session scope from the server.
	await act(async () => {
		activeOrganizationId = ZETA;
	});
	await unmount();
	appQueryClient.clear();
	await mount();
	await until(() => maybeTrigger() !== null, "fresh picker");
	await until(() => triggerText() === "Zeta Labs", "server-scoped picker");
	await until(() => grants() === "Ryu Fast 1.25", "Zeta grants");
});

test("a refused switch keeps the current workspace and its data, explains why, and re-enables the picker", async () => {
	await signedInMount();
	await personalReady();
	// Membership is revoked after the list was read.
	members = [PERSONAL, ZETA];
	await openMenu();
	const before = exchanges.length;
	await act(async () => itemFor("Acme Robotics").click());
	await until(
		() => text().includes("You are not a member of this organization"),
		"refusal toast"
	);
	await until(() => !isDisabled(trigger()), "picker unlocked");
	expect(triggerText()).toBe("Ada's Workspace");
	expect(grants()).toBe("Ryu Fast 5.00");
	expect(activeOrganizationId).toBe(PERSONAL);
	expect(routesSince(before)).toEqual([
		"POST /api/auth/organization/set-active",
	]);
});

test("the picker opens and switches from the keyboard", async () => {
	await signedInMount();
	await personalReady();
	await act(async () => trigger().focus());
	await press("ArrowDown", trigger());
	await until(() => menuItems().length === 3, "menu from keyboard");
	await until(
		() => menuItems().includes(document.activeElement as HTMLElement),
		"focus moved into the menu"
	);
	for (let step = 0; step < 3; step += 1) {
		if (document.activeElement?.textContent?.includes("Zeta Labs")) {
			break;
		}
		await press("ArrowDown");
	}
	expect(document.activeElement?.textContent).toContain("Zeta Labs");
	await press("Enter");
	await until(() => triggerText() === "Zeta Labs", "switched by keyboard");
	expect(activeOrganizationId).toBe(ZETA);
	await until(() => grants() === "Ryu Fast 1.25", "Zeta grants");
});

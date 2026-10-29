import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	spyOn,
	test,
} from "bun:test";
import { TauriUnavailableError } from "@/src/lib/tauri-ready.ts";
import {
	button,
	click,
	dialog,
	hasDialog,
	input,
	installAccountBillingDom,
	maybeButton,
	settle,
	signInVaultAccount,
	text,
	type,
	until as untilPage,
} from "./account-billing.native-http.dom.ts";
import { startNodePeer } from "./account-billing.native-http.helpers.ts";

// Mounts the shipping Billing tab inside the shipping EntitlementProvider with
// the shipping session, orgs, subscription, credits, step-up, preference and
// native-bridge clients. One control-plane peer keeps auto-recharge and alert
// records per organization (resolved from the session, as `credits.ts`
// does), gates card-funded changes behind a billing step-up grant and
// streams the wallet; two Core node peers hold the per-node sandbox budget.
installAccountBillingDom();
setDefaultTimeout(30_000);

type OrgId = "org-north" | "org-south";
interface AutoTopup {
	amountCents: number;
	consecutiveFailures: number;
	cooldownSec: number;
	enabled: boolean;
	lastAttemptAt: string | null;
	lastError: string | null;
	monthChargedMicroUsd: number;
	monthKey: string | null;
	monthlyCapCents: number;
	thresholdCents: number;
}
interface Call {
	body: unknown;
	headers: Record<string, string>;
	method: string;
	org: OrgId;
	path: string;
	status: number;
}

const TOKEN = "billing-owner-session";
const GOOD_CODE = "246810";
const BUDGET_KEY = "sandbox-default-run-budget-micro-usd";
const ENTITLEMENT_MIRROR_PATHS = [
	"/api/preferences/entitlement-active",
	"/api/preferences/managed-inference-entitled",
];
const calls: Call[] = [];
const unknown: string[] = [];
const tauri: Array<{ args: unknown; command: string }> = [];
let activeOrg: OrgId = "org-north";
let grants = 0;
let autoTopups: Partial<Record<OrgId, AutoTopup>> = {};
const refusals = new Map<string, number>();
// When set, GET /api/auth/get-session answers this body verbatim instead of the
// signed-in owner, so a case can send the shapes a degraded auth service returns.
let sessionReply: unknown;

function northRecharge(): AutoTopup {
	return {
		amountCents: 2000,
		consecutiveFailures: 0,
		cooldownSec: 600,
		enabled: true,
		lastAttemptAt: null,
		lastError: null,
		monthChargedMicroUsd: 0,
		monthKey: "2026-10",
		monthlyCapCents: 10_000,
		thresholdCents: 700,
	};
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const raw = request.method === "GET" ? "" : await request.text();
		const call: Call = {
			body: raw ? JSON.parse(raw) : null,
			headers: Object.fromEntries(request.headers.entries()),
			method: request.method,
			org: activeOrg,
			path: url.pathname + url.search,
			status: 0,
		};
		calls.push(call);
		const reply = (payload: unknown, status = 200) => {
			call.status = status;
			return Response.json(payload, { status });
		};
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			unknown.push(`${request.method} ${url.pathname}: unauthenticated`);
			return reply({ error: "Unauthorized" }, 401);
		}
		const route = `${request.method} ${url.pathname}`;
		const refusal = refusals.get(route);
		if (refusal) {
			refusals.delete(route);
			return reply({ message: "Billing service unavailable" }, refusal);
		}
		const at = "2026-10-11T00:00:00.000Z";
		if (route === "GET /api/auth/get-session") {
			if (sessionReply !== undefined) {
				return reply(sessionReply);
			}
			return reply({
				session: {
					activeOrganizationId: activeOrg,
					activeTeamId: null,
					createdAt: at,
					expiresAt: "2027-10-11T00:00:00.000Z",
					id: "billing-session",
					token: TOKEN,
					updatedAt: at,
					userId: "billing-owner",
				},
				user: {
					createdAt: at,
					email: "owner@billing.example.test",
					emailVerified: true,
					id: "billing-owner",
					image: null,
					name: "Billing Owner",
					updatedAt: at,
				},
			});
		}
		if (route === "GET /api/control-plane/orgs") {
			return reply({
				organizations: [
					{ id: "org-north", name: "North Workspace", role: "owner" },
					{ id: "org-south", name: "South Workspace", role: "owner" },
				],
			});
		}
		if (route === "GET /api/billing/subscription-status") {
			return reply({
				entitlement: {
					desktopAccess: true,
					managedInference: true,
					marketplaceApps: true,
					monthlyCreditPoolMicroUsd: 0,
					plan: "pro",
					seats: 1,
				},
				features: {},
				giftSubscription: null,
				hostedAgents: null,
				lifetime: null,
				organizationId: activeOrg,
				plan: "pro",
				scope: "org",
				seats: 1,
				subscription: {
					currentPeriodEnd: "2026-11-11T00:00:00.000Z",
					id: `sub-${activeOrg}`,
					interval: "month",
					status: "active",
				},
			});
		}
		if (route === "GET /api/auth/token") {
			// No realtime JWT is issued here; the wallet's realtime room then
			// joins anonymously, as it does when the jwt plugin refuses.
			return reply({ error: "Realtime tokens are not issued" }, 404);
		}
		if (route === "POST /api/billing/trial") {
			return reply({ firstLaunchAt: "2026-10-01T00:00:00.000Z" });
		}
		if (route === "GET /api/billing/invoices") {
			return reply({ invoices: [] });
		}
		if (route === "GET /api/campaigns/mine") {
			return reply({ pools: [] });
		}
		if (route === "GET /api/credits/wallet") {
			return reply({
				ledger: [],
				wallet: {
					balanceMicroUsd: activeOrg === "org-north" ? 42_500_000 : 7_000_000,
					currency: "usd",
					id: `wallet-${activeOrg}`,
					ownerId: activeOrg,
					ownerType: "org",
					subscriptionBalanceMicroUsd: 0,
					topupBalanceMicroUsd: 0,
					updatedAt: at,
				},
			});
		}
		if (route === "GET /api/credits/wallet/stream") {
			return new Response(new ReadableStream<Uint8Array>({}), {
				headers: { "content-type": "text/event-stream" },
			});
		}
		if (route === "GET /api/credits/alert") {
			return reply({ settings: null });
		}
		if (route === "GET /api/credits/autotopup") {
			return reply({ settings: autoTopups[activeOrg] ?? null });
		}
		if (route === "GET /api/step-up/status") {
			return reply({
				action: "complete this billing action",
				enrolmentRequired: false,
				methods: ["totp"],
				satisfied: grants > 0,
				scope: url.searchParams.get("scope"),
				twoFactorEnabled: true,
				windowMs: 300_000,
			});
		}
		if (route === "POST /api/step-up/verify") {
			const input = call.body as { code?: string; scope?: string };
			if (input?.scope !== "billing") {
				unknown.push(`verify ${raw}`);
				return reply({ error: "Undeclared verification" }, 400);
			}
			if (input.code !== GOOD_CODE) {
				return reply({ error: "That code didn't work." }, 400);
			}
			grants += 1;
			return reply({ ok: true });
		}
		if (route === "PUT /api/credits/autotopup") {
			if (grants === 0) {
				return reply({ error: "STEP_UP_REQUIRED", scope: "billing" }, 403);
			}
			const input = call.body as Partial<AutoTopup>;
			const current = autoTopups[activeOrg];
			autoTopups[activeOrg] = {
				consecutiveFailures: 0,
				cooldownSec: input.cooldownSec ?? current?.cooldownSec ?? 3600,
				lastAttemptAt: null,
				lastError: null,
				monthChargedMicroUsd: 0,
				monthKey: "2026-10",
				amountCents: input.amountCents ?? 0,
				enabled: Boolean(input.enabled),
				monthlyCapCents: input.monthlyCapCents ?? 0,
				thresholdCents: input.thresholdCents ?? 0,
			};
			return reply({ settings: autoTopups[activeOrg] });
		}
		if (route === "POST /api/billing/checkout/lifetime") {
			if (grants === 0) {
				return reply({ error: "STEP_UP_REQUIRED", scope: "billing" }, 403);
			}
			return reply({
				url: `https://checkout.example.test/lifetime/${activeOrg}`,
			});
		}
		unknown.push(route);
		return reply({ error: "Undeclared billing contract" }, 404);
	},
});
const nodes = startNodePeer(["north", "south"]);
process.env.VITE_APP_BACKEND_URL = server.url.origin;
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	configurable: true,
	value: {
		invoke: async (command: string, args: unknown) => {
			// This harness has no sealed auth-vault slot: the vault seeded in
			// localStorage below is read as a host without one would.
			if (command.startsWith("desktop_secret_")) {
				return Promise.reject(new TauriUnavailableError(command));
			}
			tauri.push({ args, command });
			if (command === "open_external") {
				return null;
			}
			// The entitlement store is best-effort and falls back without it.
			throw new Error(`Undeclared native command ${command}`);
		},
		transformCallback: () => 0,
	},
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { sileo } = await import("sileo");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { authClient, TOKEN_KEY } = await import("@/lib/auth-client.ts");
const { ACTIVE_ORG_KEY } = await import("@/src/lib/api/orgs.ts");
const { LOCAL_FALLBACK, useNodeStore } = await import(
	"@/src/store/useNodeStore.ts"
);
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { BillingTab } = await import("./BillingTab.tsx");

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
const runtimeErrors: string[] = [];

function until(predicate: () => boolean, reason: string, ms = 8000) {
	return untilPage(predicate, reason, ms, () =>
		[...calls.slice(-6), ...nodes.calls.slice(-4)]
			.map((call) => `${call.method} ${call.path} ${call.status}`)
			.join("\n")
	);
}
function errorTitles() {
	return errorToast.mock.calls.map((call) => String(call[0]?.title ?? ""));
}
function rechargeSwitch() {
	const found = document.querySelector<HTMLElement>(
		'[role="switch"][aria-label="Automatic recharge"]'
	);
	if (!found) {
		throw new Error(`Automatic recharge switch missing\n${text()}`);
	}
	return found;
}
function rechargeOn() {
	return rechargeSwitch().getAttribute("aria-checked") === "true";
}
function cap() {
	return input('input[placeholder="0 = no limit"]');
}
function budget() {
	return input('input[aria-label="Default sandbox run budget"]');
}
function autoTopupWrites() {
	return calls
		.filter(
			(call) => call.method === "PUT" && call.path === "/api/credits/autotopup"
		)
		.map((call) => ({ body: call.body, org: call.org, status: call.status }));
}
async function blur(element: HTMLElement) {
	await act(async () => {
		element.focus();
		element.blur();
	});
}
function nodeFor(name: string) {
	return {
		...LOCAL_FALLBACK,
		name,
		token: nodes.tokenFor(name),
		url: nodes.urlFor(name),
		userJwt: null,
	};
}
async function selectNode(name: string) {
	const list = [nodeFor("north"), nodeFor("south")];
	await act(async () => {
		useNodeStore.setState({
			autoSelect: false,
			autoSelectedNode: null,
			cloudNodes: [],
			defaultNode: name,
			localNodes: list,
			nodes: list,
			tabOverrides: {},
		});
	});
}
async function switchWorkspace(org: OrgId) {
	activeOrg = org;
	await act(async () => {
		await queryClient.invalidateQueries({ queryKey: ACTIVE_ORG_KEY });
	});
}
async function enterCode(code: string) {
	await until(() => hasDialog("Confirm it's you"), "billing step-up not shown");
	const field = () =>
		input('input[aria-label="Confirmation code"]', dialog("Confirm it's you"));
	// A rejected code re-enables the field once the prompt has reset it.
	await until(() => !field().disabled, "confirmation field stayed busy");
	await settle(20);
	await type(field(), code);
}
async function mount() {
	signInVaultAccount(TOKEN_KEY, TOKEN, "billing-owner");
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () =>
		root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(EntitlementProvider, null, createElement(BillingTab))
			)
		)
	);
}
async function unmount() {
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	document.body.replaceChildren();
}
function settledRecharge() {
	const toggle = document.querySelector<HTMLElement>(
		'[role="switch"][aria-label="Automatic recharge"]'
	);
	return Boolean(
		toggle &&
			toggle.getAttribute("aria-disabled") !== "true" &&
			!toggle.hasAttribute("data-disabled")
	);
}

beforeEach(async () => {
	activeOrg = "org-north";
	grants = 0;
	autoTopups = { "org-north": northRecharge() };
	refusals.clear();
	sessionReply = undefined;
	calls.length = 0;
	unknown.length = 0;
	nodes.calls.length = 0;
	nodes.unknown.length = 0;
	for (const store of Object.values(nodes.preferences)) {
		store.clear();
	}
	tauri.length = 0;
	runtimeErrors.length = 0;
	localStorage.clear();
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
	});
	errorToast = spyOn(sileo, "error");
	await selectNode("north");
});

afterEach(async () => {
	await unmount();
	errorToast.mockRestore();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case refuses undeclared routes and wrong authority.
	expect([...unknown, ...nodes.unknown]).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must render without React errors.
	expect(runtimeErrors).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	nodes.stop();
	localStorage.clear();
});

test("Automatic recharge and its 0 = no limit cap belong to the workspace: a switch never carries the previous workspace's ON switch or cap, and enabling it there saves that workspace's own record after the billing code", async () => {
	await mount();
	await until(
		() => settledRecharge() && rechargeOn(),
		"north recharge not shown"
	);
	expect(cap().value).toBe("100");
	expect(input("#autotopup-threshold").value).toBe("7");
	expect(input("#autotopup-amount").value).toBe("20");

	await switchWorkspace("org-south");
	await until(
		() =>
			settledRecharge() &&
			!rechargeOn() &&
			calls.some(
				(call) =>
					call.org === "org-south" && call.path === "/api/credits/autotopup"
			),
		"south recharge not loaded"
	);
	await settle(50);
	expect(rechargeOn()).toBe(false);
	expect(cap().value).toBe("0");
	expect(input("#autotopup-threshold").value).toBe("5");
	expect(input("#autotopup-amount").value).toBe("10");
	expect(autoTopupWrites()).toEqual([]);

	// A negative limit means no limit, never a negative cap.
	await type(cap(), "-25");
	await click(rechargeSwitch());
	await enterCode("111111");
	await until(
		() => text().includes("That code didn't work."),
		"wrong code accepted"
	);
	expect(autoTopupWrites()).toEqual([]);
	await enterCode(GOOD_CODE);
	await until(() => autoTopupWrites().length === 1, "south record not saved");
	expect(autoTopupWrites()).toEqual([
		{
			body: {
				amountCents: 1000,
				enabled: true,
				monthlyCapCents: 0,
				thresholdCents: 500,
			},
			org: "org-south",
			status: 200,
		},
	]);
	await until(() => rechargeOn(), "switch did not stay on");
	expect(autoTopups["org-north"]).toEqual(northRecharge());

	// With the record on, a new limit is saved on blur.
	await type(cap(), "250");
	await blur(cap());
	await until(() => autoTopupWrites().length === 2, "limit not saved");
	expect(autoTopups["org-south"]?.monthlyCapCents).toBe(25_000);
	expect(autoTopups["org-north"]?.monthlyCapCents).toBe(10_000);
});

test("Automatic recharge rolls back when the save is refused, and a disabled card keeps edits local", async () => {
	grants = 1;
	autoTopups = {};
	await mount();
	await until(() => settledRecharge(), "recharge card not ready");
	await type(cap(), "80");
	await blur(cap());
	await settle(50);
	expect(autoTopupWrites()).toEqual([]);

	refusals.set("PUT /api/credits/autotopup", 503);
	await click(rechargeSwitch());
	await until(
		() => autoTopupWrites().length === 1 && errorTitles().length > 0,
		"refusal not surfaced"
	);
	await until(() => !rechargeOn(), "switch did not roll back");
	expect(autoTopups["org-north"]).toBeUndefined();

	await click(rechargeSwitch());
	await until(() => autoTopupWrites().length === 2, "retry not sent");
	expect(autoTopupWrites()[1]?.body).toEqual({
		amountCents: 1000,
		enabled: true,
		monthlyCapCents: 8000,
		thresholdCents: 500,
	});
	await until(() => rechargeOn(), "switch not on after retry");
	expect(autoTopups["org-north"]?.enabled).toBe(true);
});

test("Default sandbox run budget is read from and written to the selected node in micro-USD, survives a remount, and follows a node switch", async () => {
	nodes.preferences.north?.set(BUDGET_KEY, "15000000");
	nodes.preferences.south?.set(BUDGET_KEY, "3000000");
	await mount();
	await until(() => budget().value === "15", "north budget not read");

	await type(budget(), "12.345678");
	await blur(budget());
	await until(
		() => nodes.preferences.north?.get(BUDGET_KEY) === "12345678",
		"budget not written"
	);
	expect(budget().value).toBe("12.345678");
	expect(nodes.preferences.south?.get(BUDGET_KEY)).toBe("3000000");

	// Unedited blur writes nothing. The entitlement provider mirrors its verdict
	// to the selected node once per mount, after its own control-plane reads, so
	// let that best-effort push land first instead of counting it as a write.
	await until(
		() =>
			ENTITLEMENT_MIRROR_PATHS.every((path) =>
				nodes.calls.some(
					(call) =>
						call.node === "north" && call.method === "PUT" && call.path === path
				)
			),
		"entitlement mirror not pushed"
	);
	const writes = nodes.calls.filter((call) => call.method === "PUT").length;
	await blur(budget());
	await settle(50);
	expect(nodes.calls.filter((call) => call.method === "PUT")).toHaveLength(
		writes
	);

	await unmount();
	await mount();
	await until(() => budget().value === "12.345678", "budget not read back");

	// The selected node changes underneath the open tab.
	await selectNode("south");
	await until(() => budget().value === "3", "south budget never shown");
	await type(budget(), "4");
	await blur(budget());
	await until(
		() => nodes.preferences.south?.get(BUDGET_KEY) === "4000000",
		"south budget not written"
	);
	expect(nodes.preferences.north?.get(BUDGET_KEY)).toBe("12345678");
});

test("Default sandbox run budget: an unsaved edit on one node is cleared by a node switch whose read is refused, so a blur saves nothing onto the new node", async () => {
	nodes.preferences.north?.set(BUDGET_KEY, "15000000");
	nodes.preferences.south?.set(BUDGET_KEY, "3000000");
	await mount();
	await until(() => budget().value === "15", "north budget not read");

	// Typed for north, never saved: the field is dirty and still focused.
	await act(async () => budget().focus());
	await type(budget(), "9");
	expect(budget().value).toBe("9");

	nodes.refuseNext("south", "GET", `/api/preferences/${BUDGET_KEY}`, 503);
	await selectNode("south");
	await until(
		() =>
			nodes.calls.some(
				(call) =>
					call.node === "south" &&
					call.method === "GET" &&
					call.path === `/api/preferences/${BUDGET_KEY}` &&
					call.status === 503
			),
		"south budget read was not refused"
	);
	await settle(50);
	// Neither north's unsaved 9 nor north's saved 15 is shown for south.
	expect(budget().value).toBe("0");

	// The cleared field is not dirty, so leaving it writes to no node.
	await blur(budget());
	await settle(100);
	expect(
		nodes.calls.filter(
			(call) =>
				call.method === "PUT" && call.path === `/api/preferences/${BUDGET_KEY}`
		)
	).toEqual([]);
	expect(nodes.preferences.south?.get(BUDGET_KEY)).toBe("3000000");
	expect(nodes.preferences.north?.get(BUDGET_KEY)).toBe("15000000");
	expect(errorTitles()).toEqual([]);
});

test("Default sandbox run budget: a save still in flight for the previous node does not mark the new node's edit as saved", async () => {
	nodes.preferences.north?.set(BUDGET_KEY, "15000000");
	nodes.preferences.south?.set(BUDGET_KEY, "3000000");
	await mount();
	await until(() => budget().value === "15", "north budget not read");

	const releaseNorth = nodes.hold(
		"north",
		"PUT",
		`/api/preferences/${BUDGET_KEY}`
	);
	await act(async () => budget().focus());
	await type(budget(), "12");
	await blur(budget());
	await until(
		() =>
			nodes.calls.some(
				(call) =>
					call.node === "north" &&
					call.method === "PUT" &&
					call.path === `/api/preferences/${BUDGET_KEY}`
			),
		"north save not sent"
	);

	await selectNode("south");
	await until(() => budget().value === "3", "south budget never shown");
	await act(async () => budget().focus());
	await type(budget(), "4");
	// North acknowledges its save while south's edit is still unsaved.
	releaseNorth();
	await until(
		() => nodes.preferences.north?.get(BUDGET_KEY) === "12000000",
		"north save not acknowledged"
	);
	await settle(50);
	await blur(budget());
	await until(
		() => nodes.preferences.south?.get(BUDGET_KEY) === "4000000",
		"south edit was dropped as already saved"
	);
	expect(nodes.preferences.north?.get(BUDGET_KEY)).toBe("12000000");
});

test("Lifetime: Get lifetime access opens the checkout the server issues after the billing code, with a fresh idempotency key", async () => {
	await mount();
	await until(
		() => Boolean(maybeButton("Get lifetime access")),
		"lifetime row missing"
	);
	expect(text()).toContain(
		"Pay once, own it forever. Includes 1 year of updates."
	);
	await click(button("Get lifetime access"));
	await enterCode(GOOD_CODE);
	await until(
		() => tauri.some((call) => call.command === "open_external"),
		"checkout never opened"
	);
	expect(
		tauri
			.filter((call) => call.command === "open_external")
			.map((call) => call.args)
	).toEqual([{ url: "https://checkout.example.test/lifetime/org-north" }]);
	const checkout = calls.filter(
		(call) => call.path === "/api/billing/checkout/lifetime"
	);
	expect(checkout.map((call) => [call.body, call.status])).toEqual([[{}, 200]]);
	expect(checkout[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
});

test("A session reply that carries no user keeps the tab rendering instead of throwing on the account id", async () => {
	await mount();
	await until(
		() => Boolean(maybeButton("Get lifetime access")),
		"signed-in tab missing"
	);
	// The auth client keeps its last answer between cases, so make it ask again
	// and answer with a body that has no user.
	sessionReply = [];
	try {
		await act(async () => authClient.$store.notify("$sessionSignal"));
		await settle(40);
		// The crash unmounted the whole tree, so a surviving tab is the assertion.
		expect(text()).toContain("Automatic recharge");
		expect(runtimeErrors).toEqual([]);
	} finally {
		sessionReply = undefined;
		await act(async () => authClient.$store.notify("$sessionSignal"));
	}
});

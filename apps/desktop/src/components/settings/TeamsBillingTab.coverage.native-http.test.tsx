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
	settle,
	signInVaultAccount,
	text,
	type,
	until as untilPage,
} from "./account-billing.native-http.dom.ts";

// Mounts the shipping Teams billing tab with the shipping teams-billing,
// orgs, credits, campaigns, step-up and SSE clients against one native
// control-plane peer. The peer keeps per-organization seat and plan records,
// resolves the organization from the session (as `billing.ts` does), gates
// seat and portal changes behind a billing step-up grant, and streams
// `billing-status` frames. Every response passes the shipping wire schemas.
installAccountBillingDom();
setDefaultTimeout(30_000);

type OrgId = "org-north" | "org-south";
interface OrgRecord {
	billedSeats: number;
	memberCount: number;
	name: string;
	pendingInvitations: number;
	plan: "business" | "teams" | "teams-lite";
}
interface Call {
	body: unknown;
	method: string;
	org: OrgId | null;
	path: string;
	status: number;
}

const TOKEN = "teams-owner-session";
const GOOD_CODE = "246810";
const calls: Call[] = [];
const unknown: string[] = [];
const tauri: Array<{ args: unknown; command: string }> = [];
/** Open billing streams, tagged with the case that opened them. */
const streamControllers = new Map<
	ReadableStreamDefaultController<Uint8Array>,
	number
>();
const closedStreams: number[] = [];
/** Bumped per case so a late close from an earlier case is never counted. */
let caseNumber = 0;
function openStreamsThisCase() {
	return [...streamControllers.values()].filter((tag) => tag === caseNumber)
		.length;
}
let activeOrg: OrgId = "org-north";
let grants = 0;
let orgs: Record<OrgId, OrgRecord>;

function seed() {
	activeOrg = "org-north";
	grants = 0;
	orgs = {
		"org-north": {
			billedSeats: 5,
			memberCount: 4,
			name: "North Workspace",
			pendingInvitations: 1,
			plan: "teams",
		},
		"org-south": {
			// Same billed count as north, so only a per-workspace remount (not a
			// changed count) can discard a draft typed in north.
			billedSeats: 5,
			memberCount: 3,
			name: "South Workspace",
			pendingInvitations: 0,
			plan: "teams",
		},
	};
}
seed();

function subscription(org: OrgId, plan = orgs[org].plan) {
	return {
		entitlement: {
			desktopAccess: true,
			managedInference: true,
			marketplaceApps: true,
			monthlyCreditPoolMicroUsd: 50_000_000,
			plan,
			seats: orgs[org].billedSeats,
		},
		features: {},
		giftSubscription: null,
		hostedAgents: null,
		lifetime: null,
		organizationId: org,
		plan,
		scope: "org" as const,
		seats: orgs[org].billedSeats,
		subscription: null,
	};
}
function seats(org: OrgId) {
	const record = orgs[org];
	return {
		allocatedSeats: record.memberCount + record.pendingInvitations,
		availableSeats:
			record.billedSeats - record.memberCount - record.pendingInvitations,
		billedSeats: record.billedSeats,
		bonusExpiresAt: null,
		bonusSeats: 0,
		businessEmailBlockedMemberCount: 0,
		businessEmailReason: null,
		businessEmailRequired: false,
		canInvite: true,
		canUpgradeToTeams: false,
		includedCreditPoolMicroUsd: 50_000_000,
		includedSeats: record.billedSeats,
		invitationBlockedReason: null,
		memberCount: record.memberCount,
		minRequired: 5,
		minSeats: 5,
		organizationId: org,
		organizationKind: "team",
		overAllocated: false,
		pendingInvitations: record.pendingInvitations,
		pendingSeatReservations: record.pendingInvitations,
		plan: record.plan,
		teamEmailPolicyPassed: true,
	};
}
const encoder = new TextEncoder();
function pushFrame(payload: unknown) {
	const frame = encoder.encode(
		`event: billing-status\ndata: ${JSON.stringify(payload)}\n\n`
	);
	for (const controller of streamControllers.keys()) {
		controller.enqueue(frame);
	}
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
		if (route === "GET /api/auth/get-session") {
			const at = "2026-10-11T00:00:00.000Z";
			return reply({
				session: {
					activeOrganizationId: activeOrg,
					activeTeamId: null,
					createdAt: at,
					expiresAt: "2027-10-11T00:00:00.000Z",
					id: "teams-session",
					token: TOKEN,
					updatedAt: at,
					userId: "teams-owner",
				},
				user: {
					createdAt: at,
					email: "owner@teams.example.test",
					emailVerified: true,
					id: "teams-owner",
					image: null,
					name: "Teams Owner",
					updatedAt: at,
				},
			});
		}
		if (route === "GET /api/billing/subscription-status") {
			return reply(subscription(activeOrg));
		}
		if (route === "GET /api/credits/wallet") {
			return reply({
				ledger: [],
				wallet: {
					balanceBreakdownAvailable: true,
					balanceMicroUsd: 42_000_000,
					currency: "usd",
					giftBalanceMicroUsd: 0,
					id: `wallet-${activeOrg}`,
					ownerId: activeOrg,
					ownerType: "org",
					providerAllocations: [],
					subscriptionBalanceMicroUsd: 40_000_000,
					topupBalanceMicroUsd: 2_000_000,
					updatedAt: "2026-10-11T00:00:00.000Z",
				},
			});
		}
		if (route === "GET /api/control-plane/orgs") {
			return reply({
				organizations: (Object.keys(orgs) as OrgId[]).map((id) => ({
					id,
					name: orgs[id].name,
					role: "owner",
				})),
			});
		}
		if (
			route === "GET /api/control-plane/me/permissions" &&
			url.searchParams.get("orgId") === activeOrg
		) {
			// The caller owns every workspace here, and the owner tier holds
			// billing management.
			return reply({ permissions: ["billing.manage"] });
		}
		if (route === "GET /api/campaigns/mine") {
			return reply({ pools: [] });
		}
		if (route === "GET /api/billing/seats") {
			return reply(seats(activeOrg));
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
			const input = call.body as {
				code?: string;
				method?: string;
				scope?: string;
			};
			if (input?.scope !== "billing" || input.method !== "totp") {
				unknown.push(`verify ${raw}`);
				return reply({ error: "Undeclared verification" }, 400);
			}
			if (input.code !== GOOD_CODE) {
				return reply({ error: "That code didn't work." }, 400);
			}
			grants += 1;
			return reply({ ok: true });
		}
		if (route === "POST /api/billing/seats") {
			if (grants === 0) {
				return reply({ error: "STEP_UP_REQUIRED", scope: "billing" }, 403);
			}
			const requested = (call.body as { seats?: unknown })?.seats;
			if (typeof requested !== "number" || requested < 5) {
				return reply({ message: "Invalid seat count." }, 422);
			}
			if (requested > 50) {
				return reply(
					{
						message:
							"Teams self-serve covers up to 50 seats. Contact Enterprise for larger organizations.",
						needsUpgrade: true,
					},
					422
				);
			}
			orgs[activeOrg].billedSeats = requested;
			return reply({
				memberCount: orgs[activeOrg].memberCount,
				pendingSeatCount: orgs[activeOrg].pendingInvitations,
				prorationBehavior: "invoice",
				prorationLabel: "Prorated and charged now",
				seats: requested,
			});
		}
		if (route === "GET /api/billing/status/stream") {
			const tag = caseNumber;
			let controllerRef: ReadableStreamDefaultController<Uint8Array> | null =
				null;
			let closed = false;
			// The client hanging up is seen either as the request's abort or as a
			// cancelled body, whichever the socket reports first.
			const close = () => {
				if (closed) {
					return;
				}
				closed = true;
				if (controllerRef) {
					streamControllers.delete(controllerRef);
				}
				closedStreams.push(tag);
			};
			request.signal.addEventListener("abort", close, { once: true });
			call.status = 200;
			const stream = new ReadableStream<Uint8Array>({
				cancel: close,
				start(controller) {
					controllerRef = controller;
					streamControllers.set(controller, tag);
				},
			});
			return new Response(stream, {
				headers: { "content-type": "text/event-stream" },
			});
		}
		unknown.push(route);
		return reply({ error: "Undeclared teams-billing contract" }, 404);
	},
});
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
const { TOKEN_KEY } = await import("@/lib/auth-client.ts");
const { ACTIVE_ORG_KEY } = await import("@/src/lib/api/orgs.ts");
const { TeamsBillingTab } = await import("./TeamsBillingTab.tsx");

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
let successToast: ReturnType<typeof spyOn<typeof sileo, "success">>;
const runtimeErrors: string[] = [];

function until(predicate: () => boolean, reason: string, ms = 8000) {
	return untilPage(predicate, reason, ms, () =>
		calls
			.slice(-8)
			.map((call) => `${call.method} ${call.path} ${call.status}`)
			.join("\n")
	);
}
function seatInput() {
	return input('input[aria-label="Teams seats"]');
}
/** The "Seats" section: the Member seats row and the footer its group renders. */
function memberSeats() {
	const title = [...document.querySelectorAll("div, span, h3, p")].find(
		(item) =>
			item.children.length === 0 && item.textContent?.trim() === "Member seats"
	);
	let section = title?.parentElement ?? null;
	while (section && !section.className.includes("space-y-1.5")) {
		section = section.parentElement;
	}
	return section?.textContent ?? "";
}
function seatWrites() {
	return calls
		.filter(
			(call) => call.method === "POST" && call.path === "/api/billing/seats"
		)
		.map((call) => ({ body: call.body, org: call.org, status: call.status }));
}
async function mount() {
	signInVaultAccount(TOKEN_KEY, TOKEN, "teams-owner");
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
				createElement(TeamsBillingTab)
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
/** The workspace switcher's effect: the session moves, the org key refreshes. */
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

beforeEach(async () => {
	seed();
	calls.length = 0;
	unknown.length = 0;
	tauri.length = 0;
	closedStreams.length = 0;
	caseNumber += 1;
	runtimeErrors.length = 0;
	localStorage.clear();
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
	});
	errorToast = spyOn(sileo, "error");
	successToast = spyOn(sileo, "success");
});

afterEach(async () => {
	await unmount();
	errorToast.mockRestore();
	successToast.mockRestore();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case refuses undeclared routes and unauthenticated calls.
	expect(unknown).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must render without React errors.
	expect(runtimeErrors).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	localStorage.clear();
});

test("Teams seats and Member seats belong to the active workspace: a switch discards an unsaved draft, and Save seats bills only the workspace now active after its authenticator code", async () => {
	await mount();
	await until(
		() => document.querySelector('input[aria-label="Teams seats"]') !== null,
		"seat control never shown"
	);
	expect(seatInput().value).toBe("5");
	expect(memberSeats()).toContain(
		"4 active members and 1 pending invitations reserve seats. 5 allocated of 5 capacity (5 billed)"
	);

	await type(seatInput(), "12");
	await switchWorkspace("org-south");
	await until(
		() =>
			document.querySelector<HTMLInputElement>(
				'input[aria-label="Teams seats"]'
			)?.value === "5" &&
			memberSeats().includes("3 active members and 0 pending invitations"),
		"south workspace seats never shown"
	);
	expect(memberSeats()).toContain(
		"3 active members and 0 pending invitations reserve seats. 3 allocated of 5 capacity (5 billed)"
	);

	await type(seatInput(), "9");
	await click(button("Save seats"));
	await enterCode("111111");
	await until(
		() => text().includes("That code didn't work."),
		"wrong authenticator code was accepted"
	);
	expect(seatWrites()).toEqual([]);

	await enterCode(GOOD_CODE);
	await until(
		() => successTitles().includes("Teams seats updated"),
		"seat change not confirmed"
	);
	expect(seatWrites()).toEqual([
		{ body: { seats: 9 }, org: "org-south", status: 200 },
	]);
	expect(orgs["org-south"].billedSeats).toBe(9);
	expect(orgs["org-north"].billedSeats).toBe(5);
	await until(() => seatInput().value === "9", "seat field not re-read");
	await until(
		() => memberSeats().includes("3 allocated of 9 capacity (9 billed)"),
		"Member seats did not re-read the billed seats"
	);

	// Back in the first workspace its own count is untouched.
	await switchWorkspace("org-north");
	await until(() => seatInput().value === "5", "north seats not restored");
});

test("Teams seats: a count above the self-serve ceiling is refused before any request and a count below the floor is raised to it", async () => {
	grants = 1;
	await mount();
	await until(
		() => document.querySelector('input[aria-label="Teams seats"]') !== null,
		"seat control never shown"
	);
	await type(seatInput(), "51");
	await click(button("Save seats"));
	expect(errorTitles()).toContain("Teams self-serve covers up to 50 seats");
	expect(seatWrites()).toEqual([]);

	await type(seatInput(), "2");
	await click(button("Save seats"));
	await until(
		() => successTitles().includes("Teams seats updated"),
		"floor save not confirmed"
	);
	expect(seatWrites()).toEqual([
		{ body: { seats: 5 }, org: "org-north", status: 200 },
	]);
	expect(orgs["org-north"].billedSeats).toBe(5);
});

test("Member seats follows a live billing snapshot without a refresh, and leaving the tab closes the stream", async () => {
	await mount();
	await until(() => memberSeats().length > 0, "Member seats never shown");
	await until(() => openStreamsThisCase() === 1, "billing stream never opened");
	expect(text()).toContain("Your organization is on Teams");

	// Another surface moved the workspace to Business.
	await act(async () => {
		pushFrame({
			organizationId: "org-north",
			scope: "org",
			seats: seats("org-north"),
			subscription: subscription("org-north", "business"),
		});
	});
	await until(
		() => text().includes("Your organization is on Business"),
		"live snapshot not applied"
	);
	expect(memberSeats()).toContain("4 active members");

	// The tab remounts once its workspace resolves, so count only the close
	// that leaving the tab causes.
	const closedBefore = closedStreams.filter((tag) => tag === caseNumber).length;
	expect(openStreamsThisCase()).toBe(1);
	await unmount();
	await until(
		() =>
			closedStreams.filter((tag) => tag === caseNumber).length ===
				closedBefore + 1 && openStreamsThisCase() === 0,
		"stream left open"
	);
	await settle(50);
	expect(openStreamsThisCase()).toBe(0);
});

function errorTitles() {
	return errorToast.mock.calls.map((call) => String(call[0]?.title ?? ""));
}
function successTitles() {
	return successToast.mock.calls.map((call) => String(call[0]?.title ?? ""));
}

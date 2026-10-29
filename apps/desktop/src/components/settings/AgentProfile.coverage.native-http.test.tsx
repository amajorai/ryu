import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
	click,
	flush,
	installInertWebgl,
	maybeButton,
	normalized,
	pageText,
	settle,
} from "./general-agents-network.test-support.ts";

// Coverage for `AgentProfile`, the per-agent page behind Settings → Stats →
// Your team. It has no settings rows of its own; its controls are the
// "Back to team" action and the agent-specific reads that fill its badge,
// heatmap and lifetime stats. It is reached the way users reach it: the
// shipping `StatsTab` is mounted and a team badge is selected. One native
// server plays the control plane (session bearer: Better-Auth session, the
// `/api/profile/me/*` routes) and Core (node bearer and member JWT: the agent
// roster, engines and the local Gateway audit the passport reads).
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
window.fetch = nativeFetch;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);
const restoreWebgl = installInertWebgl();

const SESSION_TOKEN = "agent-profile-coverage-session";
const NODE_TOKEN = "agent-profile-coverage-node";
const USER_JWT = "agent-profile-coverage-jwt";
const ENTITLEMENT_MIRRORS = new Set([
	"/api/preferences/entitlement-active",
	"/api/preferences/managed-inference-entitled",
]);

interface AgentStatsWire {
	agentId: string;
	hiredAt: string;
	lastActiveDay: string;
	level: number;
	streak: { current: number; longest: number };
	totals: {
		agentSeconds: number;
		costMicroUsd: number;
		inputTokens: number;
		outputTokens: number;
		requestCount: number;
		sessionCount: number;
	};
	xp: number;
}

function agentStats(
	agentId: string,
	overrides: Partial<AgentStatsWire["totals"]> & {
		level: number;
		streak: [number, number];
	}
): AgentStatsWire {
	const { level, streak, ...totals } = overrides;
	return {
		agentId,
		hiredAt: "2026-01-15T00:00:00.000Z",
		lastActiveDay: "2026-10-10",
		level,
		streak: { current: streak[0], longest: streak[1] },
		totals: {
			agentSeconds: 0,
			costMicroUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			requestCount: 0,
			sessionCount: 0,
			...totals,
		},
		xp: level * 100,
	};
}

const STATS = new Map([
	[
		"agent-researcher",
		agentStats("agent-researcher", {
			agentSeconds: 5400,
			inputTokens: 1200,
			level: 4,
			outputTokens: 34,
			requestCount: 77,
			streak: [3, 9],
		}),
	],
	[
		"agent-writer",
		agentStats("agent-writer", {
			agentSeconds: 36_000,
			inputTokens: 400,
			level: 2,
			outputTokens: 100,
			requestCount: 12,
			streak: [1, 5],
		}),
	],
]);

const ROSTER = [
	{
		description: "Finds and cites sources",
		id: "agent-researcher",
		name: "Researcher",
		tools: [],
	},
	{
		description: "Drafts long-form copy",
		id: "agent-writer",
		name: "Writer",
		tools: [],
	},
];

interface Exchange {
	auth: string | null;
	method: string;
	path: string;
	search: string;
	status: number;
}

const exchanges: Exchange[] = [];
const unexpected: string[] = [];
let refusedProfiles = new Set<string>();

function controlPlane(path: string, call: Exchange) {
	if (call.auth !== `Bearer ${SESSION_TOKEN}`) {
		unexpected.push(`${call.method} ${path} without the session bearer`);
		call.status = 401;
		return NativeResponse.json({ message: "unauthorized" }, { status: 401 });
	}
	if (path === "/api/auth/get-session") {
		return NativeResponse.json({
			session: { activeOrganizationId: null, userId: "user-1" },
			user: {
				email: "owner@example.test",
				id: "user-1",
				image: null,
				name: "Owner",
			},
		});
	}
	if (path === "/api/profile/me/profile") {
		return NativeResponse.json({
			image: null,
			joinedAt: "2026-01-01T00:00:00.000Z",
			level: 6,
			name: "Owner",
			plan: "pro",
			pointsBalance: 40,
			profileVisibility: "private",
			streak: { current: 2, longest: 11 },
			totals: {
				agentSeconds: 999_999,
				costMicroUsd: 0,
				inputTokens: 888_888,
				outputTokens: 0,
				requestCount: 555,
				sessionCount: 3,
			},
			userId: "user-1",
			xp: 600,
		});
	}
	if (path === "/api/profile/me/usage/daily") {
		return NativeResponse.json({ days: [] });
	}
	if (path === "/api/profile/me/stats" || path === "/api/profile/me/unlocks") {
		// Owner-level panels outside this item's scope answer as unavailable.
		call.status = 503;
		return NativeResponse.json({ message: "unavailable" }, { status: 503 });
	}
	if (path === "/api/profile/me/agents") {
		return NativeResponse.json({ agents: [...STATS.values()] });
	}
	const agentRoute =
		/^\/api\/profile\/me\/agents\/([^/]+)(\/usage\/daily)?$/.exec(path);
	const stats = agentRoute
		? STATS.get(decodeURIComponent(agentRoute[1] ?? ""))
		: undefined;
	if (agentRoute && stats) {
		if (refusedProfiles.has(stats.agentId) && !agentRoute[2]) {
			call.status = 503;
			return NativeResponse.json(
				{ message: "stats store down" },
				{ status: 503 }
			);
		}
		if (agentRoute[2]) {
			return NativeResponse.json({
				days: [
					{ count: 4, day: "2026-10-09", tokens: 300 },
					{ count: 7, day: "2026-10-10", tokens: 900 },
				],
			});
		}
		return NativeResponse.json(stats);
	}
	unexpected.push(`Undeclared control-plane ${call.method} ${path}`);
	call.status = 404;
	return NativeResponse.json({ message: "undeclared" }, { status: 404 });
}

/**
 * The signed-in shell's entitlement reads: the plan (Pro, desktop access), the
 * idempotent trial anchor and the upsell cadence, all on the control plane.
 */
function billing(path: string, call: Exchange) {
	if (call.auth !== `Bearer ${SESSION_TOKEN}`) {
		unexpected.push(`${call.method} ${path} without the session bearer`);
		call.status = 401;
		return NativeResponse.json({ message: "unauthorized" }, { status: 401 });
	}
	if (path === "/api/billing/subscription-status" && call.method === "GET") {
		return NativeResponse.json({
			entitlement: {
				desktopAccess: true,
				managedInference: true,
				marketplaceApps: true,
				monthlyCreditPoolMicroUsd: 0,
				plan: "pro",
				seats: 1,
			},
			organizationId: null,
			plan: "pro",
			scope: "personal",
			subscription: null,
		});
	}
	if (path === "/api/upsell/state" && call.method === "GET") {
		return NativeResponse.json({
			lastUpsellShownAt: "2026-10-10T00:00:00.000Z",
		});
	}
	if (path === "/api/billing/trial") {
		return NativeResponse.json({ firstLaunchAt: "2026-01-01T00:00:00.000Z" });
	}
	unexpected.push(`Undeclared billing ${call.method} ${path}`);
	call.status = 404;
	return NativeResponse.json({ message: "undeclared" }, { status: 404 });
}

function core(path: string, call: Exchange, request: Request) {
	if (
		call.auth !== `Bearer ${NODE_TOKEN}` ||
		request.headers.get("x-ryu-user-jwt") !== USER_JWT
	) {
		unexpected.push(`${call.method} ${path} without node credentials`);
		call.status = 401;
		return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
	}
	switch (path) {
		case "/api/agents":
			return NativeResponse.json({ agents: ROSTER });
		case "/api/engines":
			return NativeResponse.json({ engines: [] });
		case "/api/engine/active":
			return NativeResponse.json({
				active: null,
				available: [],
				running: false,
			});
		case "/api/gateway/audit":
			return NativeResponse.json({ count: 0, entries: [], reachable: true });
		default: {
			// The passport reads the selected agent's full record.
			const summary = ROSTER.find(
				(entry) => path === `/api/agents/${entry.id}`
			);
			if (summary) {
				return NativeResponse.json({
					agent: {
						built_in: false,
						composio_actions: [],
						description: summary.description,
						engine: null,
						id: summary.id,
						identity_profile_ids: [],
						lifecycle_status: "active",
						locked: false,
						memory: { read_levels: [], space_ids: [], write_enabled: false },
						name: summary.name,
						orchestrator: null,
						safety_profile: "autonomous",
						skills: [],
						system_prompt: null,
						title: "Agent",
						tools: [],
						version: "1.0.0",
					},
				});
			}
		}
	}
	unexpected.push(`Undeclared Core ${call.method} ${path}`);
	call.status = 404;
	return NativeResponse.json({ error: "undeclared" }, { status: 404 });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		const call: Exchange = {
			auth: request.headers.get("authorization"),
			method: request.method,
			path: url.pathname,
			search: url.search,
			status: 200,
		};
		exchanges.push(call);
		if (
			request.method === "PUT" &&
			ENTITLEMENT_MIRRORS.has(url.pathname) &&
			call.auth === `Bearer ${NODE_TOKEN}`
		) {
			// The app shell's EntitlementProvider mirrors its verdict to Core.
			return NativeResponse.json({ ok: true });
		}
		if (
			url.pathname.startsWith("/api/billing/") ||
			url.pathname.startsWith("/api/upsell/")
		) {
			return billing(url.pathname, call);
		}
		if (request.method !== "GET") {
			unexpected.push(`Undeclared ${request.method} ${url.pathname}`);
			call.status = 405;
			return NativeResponse.json({ error: "undeclared" }, { status: 405 });
		}
		if (
			url.pathname.startsWith("/api/profile/") ||
			url.pathname.startsWith("/api/auth/")
		) {
			return controlPlane(url.pathname, call);
		}
		return core(url.pathname, call, request);
	},
});

process.env.VITE_APP_BACKEND_URL = server.url.origin;
const ownedFetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (new URL(url).origin !== server.url.origin) {
			unexpected.push(`Unowned origin ${url}`);
			return Promise.reject(new Error(`Unowned origin ${url}`));
		}
		return nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = ownedFetch;
window.fetch = ownedFetch;

const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { format, subDays } = await import("date-fns");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { TOKEN_KEY } = await import("@/lib/auth-client.ts");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { StatsTab } = await import("./StatsTab.tsx");

const initialNodeState = useNodeStore.getState();
let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(async () => {
	refusedProfiles = new Set();
	exchanges.length = 0;
	unexpected.length = 0;
	localStorage.clear();
	localStorage.setItem("agent-profile-coverage-unrelated", "kept");
	localStorage.setItem(TOKEN_KEY, SESSION_TOKEN);
	await act(async () => {
		queryClient.clear();
		sileo.clear();
	});
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "agent-profile-coverage",
		nodes: [
			{
				name: "agent-profile-coverage",
				token: NODE_TOKEN,
				url: server.url.origin,
				userJwt: USER_JWT,
			},
		],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
	}
	root = null;
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
		sileo.clear();
	});
	container.remove();
	document.body.replaceChildren();
	useNodeStore.setState(initialNodeState, true);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem("agent-profile-coverage-unrelated")).toBe("kept");
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects unauthenticated, undeclared or off-fixture requests.
	expect(unexpected).toEqual([]);
});

afterAll(() => {
	restoreWebgl();
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

async function mountRoster() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<StatsTab />
					<Toaster position="bottom-right" />
				</EntitlementProvider>
			</QueryClientProvider>
		)
	);
	await settle(
		() => badge("Researcher") !== null && badge("Writer") !== null,
		"team roster"
	);
	// The app shell's entitlement check ends by mirroring both verdicts to
	// Core. Until then the tab can still re-render under the case and replace
	// the badges, so an element found now could be detached a moment later.
	await settle(
		() =>
			[...ENTITLEMENT_MIRRORS].every((path) =>
				exchanges.some((call) => call.method === "PUT" && call.path === path)
			),
		"entitlement verdict mirrored"
	);
	await flush(4);
}

/**
 * A short, cheap description of an element ("nothing" for none). Assertions on
 * elements compare these: a failed match on a DOM element makes the matcher
 * print its whole tree, which exhausts memory instead of reporting it.
 */
function describeElement(element: Element | null): string {
	if (!element) {
		return "nothing";
	}
	return `${element.tagName}[role=${element.getAttribute("role")}][aria-label=${element.getAttribute("aria-label")}]${element.isConnected ? "" : " (detached)"}`;
}

/**
 * A team member's name on its roster badge. `EmployeeBadge` handles the click
 * on the card body that holds the name, so clicking the name reaches it the
 * way a pointer does. The keyboard reaches the same card body as a button; see
 * {@link rosterButton}.
 */
function badge(name: string): HTMLElement | null {
	return (
		[...container.querySelectorAll<HTMLElement>("*")].find(
			(element) =>
				element.children.length === 0 &&
				normalized(element) === name &&
				normalized(element.closest(".cursor-pointer")).includes("Tokens")
		) ?? null
	);
}

/**
 * The roster badge a keyboard or assistive technology reaches for `name`: an
 * element exposed as a button, in the tab order, whose accessible name is the
 * agent's name. Null when the badge offers no such element.
 */
function rosterButton(name: string): HTMLElement | null {
	return (
		[...container.querySelectorAll<HTMLElement>('[role="button"]')].find(
			(element) =>
				element.tabIndex === 0 &&
				element.getAttribute("aria-label") === name &&
				normalized(element).includes("Tokens")
		) ?? null
	);
}

/** Press `key` on the focused element the way a keyboard does. */
async function press(key: string): Promise<{ down: KeyboardEvent }> {
	const target = document.activeElement ?? document.body;
	const init = { bubbles: true, cancelable: true, key };
	const down = new KeyboardEvent("keydown", init);
	await act(async () => {
		target.dispatchEvent(down);
		target.dispatchEvent(new KeyboardEvent("keyup", init));
	});
	await flush(4);
	return { down };
}

function profileReads(agentId: string) {
	return exchanges.filter(
		(call) => call.path === `/api/profile/me/agents/${agentId}`
	);
}

function usageReads(agentId: string) {
	return exchanges.filter(
		(call) => call.path === `/api/profile/me/agents/${agentId}/usage/daily`
	);
}

/** The agent profile's "Lifetime stats" section (not the owner's own totals). */
function lifetimeSection(): HTMLElement {
	const heading = [...container.querySelectorAll<HTMLElement>("*")].find(
		(element) =>
			element.children.length === 0 && normalized(element) === "Lifetime stats"
	);
	const section =
		heading?.closest("section") ?? heading?.parentElement?.parentElement;
	if (!section) {
		throw new Error("Missing Lifetime stats section");
	}
	return section;
}

/** The value a lifetime StatCard shows under `title`. */
function statCard(title: string): string {
	const label = [...lifetimeSection().querySelectorAll<HTMLElement>("*")].find(
		(element) => element.children.length === 0 && normalized(element) === title
	);
	const card = label?.parentElement?.parentElement;
	if (!card) {
		throw new Error(`Missing stat card ${title}`);
	}
	return normalized(card).replace(title, "").trim();
}

/**
 * The lifetime stat under `title`, or null while the profile is still loading
 * (its skeleton has no "Lifetime stats" section yet), so a wait can poll it.
 */
function shownStat(title: string): string | null {
	try {
		return statCard(title);
	} catch {
		return null;
	}
}

async function openProfile(name: string) {
	await click(badge(name)!);
	await settle(
		() => maybeButton("Back to team", container) !== null,
		`${name} profile`
	);
}

test("selecting a team member opens that agent's own profile stats and daily usage, and Back to team returns to the roster", async () => {
	await mountRoster();
	await openProfile("Researcher");
	await settle(() => pageText().includes("Lifetime stats"), "lifetime stats");
	expect(profileReads("agent-researcher")).toHaveLength(1);
	expect(profileReads("agent-researcher")[0]?.auth).toBe(
		`Bearer ${SESSION_TOKEN}`
	);
	const [usage] = usageReads("agent-researcher");
	const today = new Date();
	expect(usage?.search).toBe(
		`?from=${format(subDays(today, 364), "yyyy-MM-dd")}&to=${format(today, "yyyy-MM-dd")}`
	);
	expect(statCard("Total tokens")).toBe("1,234");
	expect(statCard("Hours worked")).toBe("1.5");
	expect(statCard("Requests")).toBe("77");
	expect(statCard("Level")).toBe("4");
	expect(statCard("Best streak")).toBe("9d");
	expect(pageText()).toContain("Finds and cites sources");
	expect(describeElement(badge("Writer"))).toBe("nothing");
	// The owner's own totals (shown above the team) never stand in for the agent's.
	expect(normalized(lifetimeSection())).not.toContain("888,888");

	await click(maybeButton("Back to team", container)!);
	await settle(
		() => badge("Researcher") !== null && badge("Writer") !== null,
		"roster after Back"
	);
	expect(describeElement(maybeButton("Back to team", container))).toBe(
		"nothing"
	);
	expect(pageText()).not.toContain("Lifetime stats");

	await openProfile("Writer");
	await settle(() => shownStat("Total tokens") === "500", "writer stats");
	expect(statCard("Hours worked")).toBe("10.0");
	expect(statCard("Requests")).toBe("12");
	expect(statCard("Level")).toBe("2");
	expect(statCard("Best streak")).toBe("5d");
	expect(profileReads("agent-writer")).toHaveLength(1);
	expect(profileReads("agent-researcher")).toHaveLength(1);
});

test("a roster badge is a keyboard button named for its agent: Enter and Space open that agent's profile, other keys do nothing, and a profile badge is not a button", async () => {
	await mountRoster();
	const researcher = rosterButton("Researcher");
	if (!researcher) {
		throw new Error("No roster badge is a focusable button named Researcher");
	}
	expect(describeElement(rosterButton("Writer"))).not.toBe("nothing");
	await act(async () => researcher.focus());
	// Elements are compared as descriptions throughout this case: a failed
	// match on a DOM element makes the matcher print its whole tree, which
	// exhausts memory instead of reporting the failure.
	expect(describeElement(document.activeElement)).toBe(
		describeElement(researcher)
	);
	expect(document.activeElement === researcher).toBe(true);

	// A key that activates nothing leaves the roster as it was.
	await press("a");
	await press("Tab");
	expect(describeElement(maybeButton("Back to team", container))).toBe(
		"nothing"
	);
	expect(profileReads("agent-researcher")).toHaveLength(0);

	await press("Enter");
	await settle(
		() => pageText().includes("Lifetime stats"),
		"Researcher profile"
	);
	expect(statCard("Total tokens")).toBe("1,234");
	expect(profileReads("agent-researcher")).toHaveLength(1);
	expect(describeElement(badge("Writer"))).toBe("nothing");
	// The badge on the profile page itself opens nothing, so it is neither a
	// button nor a tab stop.
	expect(describeElement(rosterButton("Researcher"))).toBe("nothing");
	expect(
		[...container.querySelectorAll<HTMLElement>('[role="button"], [tabindex]')]
			.filter(
				(element) =>
					normalized(element).includes("Researcher") &&
					normalized(element).includes("Tokens")
			)
			.map(describeElement)
	).toEqual([]);

	await click(maybeButton("Back to team", container)!);
	await settle(() => rosterButton("Writer") !== null, "roster after Back");
	const writer = rosterButton("Writer")!;
	await act(async () => writer.focus());
	// Space opens it too, and its press does not scroll the settings pane.
	const space = await press(" ");
	expect(space.down.defaultPrevented).toBe(true);
	await settle(() => shownStat("Total tokens") === "500", "Writer profile");
	expect(profileReads("agent-writer")).toHaveLength(1);
	expect(profileReads("agent-researcher")).toHaveLength(1);
});

test("a refused agent profile read says so with Retry instead of presenting zero usage, and Retry shows the real stats", async () => {
	refusedProfiles.add("agent-researcher");
	await mountRoster();
	await openProfile("Researcher");
	await settle(
		() => pageText().includes("Couldn't load this agent's stats"),
		"profile read error"
	);
	expect(pageText()).not.toContain("Lifetime stats");
	expect(
		profileReads("agent-researcher").every((call) => call.status === 503)
	).toBe(true);

	const alert = [
		...container.querySelectorAll<HTMLElement>('[role="alert"]'),
	].find((candidate) =>
		normalized(candidate).includes("Couldn't load this agent's stats")
	);
	expect(alert).toBeDefined();
	// The passport still renders; only the stats read failed.
	expect(pageText()).toContain("Agent passport");
	expect(maybeButton("Back to team", container)).not.toBeNull();

	refusedProfiles.clear();
	const retry = maybeButton("Retry", alert);
	expect(retry).not.toBeNull();
	await click(retry!);
	await settle(
		() => pageText().includes("Lifetime stats"),
		"stats after retry"
	);
	expect(statCard("Total tokens")).toBe("1,234");
	expect(statCard("Level")).toBe("4");
	expect(pageText()).not.toContain("Couldn't load this agent's stats");
	expect(profileReads("agent-researcher").at(-1)?.status).toBe(200);
});

import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	button,
	click,
	flush,
	installInertWebgl,
	installNativeBridge,
	isDisabled,
	maybeButton,
	normalized,
	registerDomWithNativeNetworking,
	text,
	until,
} from "./unswept-b.test-support.ts";

// Coverage for `StatsTab`, Settings → Stats (and the Profile page's Stats
// section). Its controls are "Share your Ryu Wrapped", "Share as clip" (the
// heatmap clip dialog), every Unlock button in
// the Unlocks grid, the Unlocks Retry, and the team roster. The shipping tab
// is mounted against one owned native HTTP peer that plays the control plane
// (Better-Auth session bearer, `/api/profile/me/*`) and Core (node bearer and
// member JWT: the agent roster). The Unlock endpoint enforces the points
// ledger the way the control plane does, so a purchase is only "done" once the
// server debited it and a fresh read shows it. Opening the Wrapped page crosses
// the recorded native IPC boundary (`open_external`).
const FRONTEND = "https://ryu-frontend.stats.unswept-b.test";
process.env.VITE_APP_FRONTEND_URL = FRONTEND;
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
registerDomWithNativeNetworking();
setDefaultTimeout(30_000);
const restoreWebgl = installInertWebgl();

const SESSION_TOKEN = "stats-coverage-session";
const NODE_TOKEN = "stats-coverage-node";
const USER_JWT = "stats-coverage-jwt";
const USER_ID = "user-ada";
const ENTITLEMENT_MIRRORS = new Set([
	"/api/preferences/entitlement-active",
	"/api/preferences/managed-inference-entitled",
]);

interface CatalogEntry {
	autoUnlockAtLevel?: number;
	description: string;
	key: string;
	pointsCost?: number;
	requiresPlan?: string[];
	tier: "default" | "progressive" | "paid";
	title: string;
}

const CATALOG: CatalogEntry[] = [
	{
		description: "Paint the workspace with your own palette.",
		key: "custom-themes",
		pointsCost: 300,
		tier: "default",
		title: "Custom themes",
	},
	{
		description: "Jump the queue on busy models.",
		key: "priority-queue",
		pointsCost: 5000,
		tier: "default",
		title: "Priority queue",
	},
	{
		description: "Seats for the whole company.",
		key: "team-seats",
		requiresPlan: ["team", "enterprise"],
		tier: "paid",
		title: "Team seats",
	},
	{
		autoUnlockAtLevel: 10,
		description: "Longer agent runs.",
		key: "power-mode",
		tier: "progressive",
		title: "Power mode",
	},
	{
		description: "New features before everyone else.",
		key: "early-access",
		pointsCost: 100,
		tier: "default",
		title: "Early access",
	},
];

interface Exchange {
	auth: string | null;
	method: string;
	path: string;
	search: string;
	status: number;
}

interface Ledger {
	points: number;
	unlocked: string[];
}

const exchanges: Exchange[] = [];
const unexpected: string[] = [];
const runtimeErrors: string[] = [];
let ledger: Ledger = { points: 0, unlocked: [] };
let costMicroUsd = 4_321_000;
let statsAvailable = true;
let refuseUnlocksRead = false;
let unlockRefusal: { body: unknown; status: number } | null = null;
let holdUnlock: Promise<void> | null = null;

function profile() {
	return {
		image: null,
		joinedAt: "2025-03-14T00:00:00.000Z",
		level: 7,
		name: "Ada (profile)",
		plan: "pro",
		pointsBalance: ledger.points,
		profileVisibility: "private",
		streak: { current: 4, longest: 12 },
		totals: {
			agentSeconds: 9000,
			costMicroUsd,
			inputTokens: 1_000_000,
			outputTokens: 234_567,
			requestCount: 8765,
			sessionCount: 31,
		},
		userId: USER_ID,
		xp: 700,
	};
}

const STATS = {
	byFeatureTotals: {
		agentSeconds: 9000,
		chat: 40,
		island: 3,
		predictAccepted: 7,
	},
	insights: {
		activeDays: 42,
		averageRequestsPerActiveDay: 208,
		averageTokensPerActiveDay: 29_394,
		favoriteModel: "claude-opus-coverage",
		peakDay: { day: "2026-10-01", tokens: 98_765 },
		peakHourUtc: "14",
		topModels: [
			{ count: 600, id: "claude-opus-coverage" },
			{ count: 50, id: "gpt-coverage" },
		],
		topPlugins: [],
		topSkills: [{ count: 9, id: "skill-coverage" }],
		transport: { acp: 3, gateway: 90, openAiCompat: 5, other: 2 },
	},
	totals: profile().totals,
};

function controlPlane(path: string, call: Exchange, request: Request) {
	if (path === "/api/auth/get-session" && call.auth === null) {
		// Signed out: Better Auth asks without a bearer and learns there is none.
		return NativeResponse.json(null);
	}
	if (call.auth !== `Bearer ${SESSION_TOKEN}`) {
		unexpected.push(`${call.method} ${path} without the session bearer`);
		call.status = 401;
		return NativeResponse.json({ message: "unauthorized" }, { status: 401 });
	}
	if (path === "/api/auth/get-session") {
		return NativeResponse.json({
			session: { activeOrganizationId: null, userId: USER_ID },
			user: {
				email: "ada@example.test",
				id: USER_ID,
				image: null,
				name: "Ada Lovelace",
			},
		});
	}
	if (path === "/api/profile/me/profile") {
		return NativeResponse.json(profile());
	}
	if (path === "/api/profile/me/usage/daily") {
		return NativeResponse.json({
			days: [
				{ byFeature: {}, count: 3, day: "2026-10-09", tokens: 1200 },
				{ byFeature: {}, count: 5, day: "2026-10-10", tokens: 2400 },
			],
		});
	}
	if (path === "/api/profile/me/stats") {
		if (!statsAvailable) {
			call.status = 503;
			return NativeResponse.json({ message: "down" }, { status: 503 });
		}
		return NativeResponse.json(STATS);
	}
	if (path === "/api/profile/me/agents") {
		return NativeResponse.json({ agents: [] });
	}
	if (path === "/api/profile/me/unlocks" && request.method === "GET") {
		if (refuseUnlocksRead) {
			call.status = 503;
			return NativeResponse.json({ message: "down" }, { status: 503 });
		}
		return NativeResponse.json({
			catalog: CATALOG,
			unlocked: [...ledger.unlocked],
		});
	}
	const unlock = /^\/api\/profile\/me\/unlocks\/([^/]+)$/.exec(path);
	if (unlock && request.method === "POST") {
		return purchase(decodeURIComponent(unlock[1] ?? ""), call);
	}
	unexpected.push(`Undeclared control-plane ${call.method} ${path}`);
	call.status = 404;
	return NativeResponse.json({ message: "undeclared" }, { status: 404 });
}

/** The control plane's points ledger: debit once, refuse what isn't affordable. */
async function purchase(key: string, call: Exchange) {
	if (holdUnlock) {
		await holdUnlock;
	}
	if (unlockRefusal) {
		call.status = unlockRefusal.status;
		return typeof unlockRefusal.body === "string"
			? new NativeResponse(unlockRefusal.body, { status: unlockRefusal.status })
			: NativeResponse.json(unlockRefusal.body, {
					status: unlockRefusal.status,
				});
	}
	const entry = CATALOG.find((candidate) => candidate.key === key);
	const cost = entry?.pointsCost ?? 0;
	if (!entry || cost <= 0 || ledger.unlocked.includes(key)) {
		call.status = 400;
		return NativeResponse.json({ message: "Not unlockable" }, { status: 400 });
	}
	if (ledger.points < cost) {
		call.status = 402;
		return NativeResponse.json(
			{ message: "Not enough points" },
			{ status: 402 }
		);
	}
	ledger = {
		points: ledger.points - cost,
		unlocked: [...ledger.unlocked, key],
	};
	return NativeResponse.json({
		ok: true,
		pointsBalance: ledger.points,
		unlocked: [...ledger.unlocked],
	});
}

/**
 * The signed-in shell's entitlement reads (the agent roster is gated on the
 * plan): Pro with desktop access, the trial anchor and the upsell cadence.
 */
function billing(path: string, call: Exchange) {
	if (call.auth !== `Bearer ${SESSION_TOKEN}`) {
		// Signed out, the entitlement provider asks anyway and is told no.
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
		// Shown just now, so the weekly launch cadence never asks for a pitch
		// (a fixed date here starts failing a week after it was written).
		return NativeResponse.json({
			lastUpsellShownAt: new Date().toISOString(),
		});
	}
	if (path === "/api/upsell/pitch" && call.method === "GET") {
		// The entitlement shell asks for this week's pitch; nothing is ranked.
		return NativeResponse.json({ cards: [] });
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
	if (path === "/api/agents") {
		return NativeResponse.json({
			agents: [
				{
					description: "Has not worked a shift yet",
					id: "agent-new-hire",
					name: "New hire",
					tools: [],
				},
			],
		});
	}
	if (path === "/api/engines") {
		return NativeResponse.json({ engines: [] });
	}
	if (path === "/api/engine/active") {
		return NativeResponse.json({ active: null, available: [], running: false });
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
			// The EntitlementProvider mirrors its verdict to Core.
			return NativeResponse.json({ ok: true });
		}
		if (
			url.pathname.startsWith("/api/billing/") ||
			url.pathname.startsWith("/api/upsell/")
		) {
			return billing(url.pathname, call);
		}
		if (
			url.pathname.startsWith("/api/profile/") ||
			url.pathname.startsWith("/api/auth/")
		) {
			return controlPlane(url.pathname, call, request);
		}
		if (request.method !== "GET") {
			unexpected.push(`Undeclared ${request.method} ${url.pathname}`);
			call.status = 405;
			return NativeResponse.json({ error: "undeclared" }, { status: 405 });
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

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { format, subDays } = await import("date-fns");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { authClient, TOKEN_KEY } = await import("@/lib/auth-client.ts");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { StatsTab } = await import("./StatsTab.tsx");

type Root = ReturnType<typeof createRoot>;
const initialNodeState = useNodeStore.getState();
let root: Root | null = null;
let bridge: ReturnType<typeof installNativeBridge> | null = null;
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(`unhandled rejection: ${String(event.reason)}`);
const onProcessRejection = (reason: unknown) =>
	runtimeErrors.push(`unhandled rejection: ${String(reason)}`);
process.on("unhandledRejection", onProcessRejection);

beforeEach(async () => {
	exchanges.length = 0;
	unexpected.length = 0;
	runtimeErrors.length = 0;
	ledger = { points: 1234, unlocked: ["early-access"] };
	costMicroUsd = 4_321_000;
	statsAvailable = true;
	refuseUnlocksRead = false;
	unlockRefusal = null;
	holdUnlock = null;
	window.addEventListener("unhandledrejection", onRejection);
	localStorage.clear();
	localStorage.setItem("stats-coverage-unrelated", "kept");
	localStorage.setItem(TOKEN_KEY, SESSION_TOKEN);
	bridge = installNativeBridge();
	await act(async () => {
		queryClient.clear();
		sileo.clear();
	});
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "stats-coverage",
		nodes: [
			{
				name: "stats-coverage",
				token: NODE_TOKEN,
				url: server.url.origin,
				userJwt: USER_JWT,
			},
		],
		tabOverrides: {},
	});
});

afterEach(async () => {
	await unmount();
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
		sileo.clear();
	});
	document.body.replaceChildren();
	bridge?.uninstall();
	bridge = null;
	useNodeStore.setState(initialNodeState, true);
	window.removeEventListener("unhandledrejection", onRejection);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem("stats-coverage-unrelated")).toBe("kept");
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects unauthenticated, undeclared or off-fixture requests.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: no case may leave an unhandled rejection behind.
	expect(runtimeErrors).toEqual([]);
});

afterAll(() => {
	process.off("unhandledRejection", onProcessRejection);
	restoreWebgl();
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

/** Mount the shipping tab inside the providers the app shell gives it. */
async function render() {
	const container = document.createElement("div");
	document.body.append(container);
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
}

async function mount() {
	await render();
	await until(
		() => text().includes("Lifetime") && text().includes("Custom themes"),
		"Stats tab with unlocks"
	);
}

async function unmount() {
	const mounted = root;
	root = null;
	await act(async () => mounted?.unmount());
}

/** The value text a StatCard shows under `title` (its title removed). */
function statCard(title: string): string {
	const label = [...document.querySelectorAll<HTMLElement>("*")].find(
		(element) => element.children.length === 0 && normalized(element) === title
	);
	const card = label?.parentElement?.parentElement;
	if (!card) {
		throw new Error(`Missing stat card ${title}: ${text()}`);
	}
	return normalized(card).replace(title, "").trim();
}

/** The settings card that holds the unlock titled `title`. */
function unlockCard(title: string): HTMLElement {
	const heading = [...document.querySelectorAll<HTMLElement>("span")].find(
		(element) => normalized(element) === title
	);
	const card = heading?.parentElement?.parentElement;
	if (!card) {
		throw new Error(`Missing unlock ${title}: ${text()}`);
	}
	return card;
}

function unlockAction(title: string): string {
	const card = unlockCard(title);
	return normalized(card.lastElementChild);
}

function calls(method: string, path: string): Exchange[] {
	return exchanges.filter(
		(call) => call.method === method && call.path === path
	);
}

function wrappedOpens(): unknown[] {
	return (bridge?.calls ?? [])
		.filter((call) => call.command === "open_external")
		.map((call) => (call.args as { url?: unknown }).url);
}

test("the overview, lifetime cards and insights show the control plane's numbers, the heatmap asks for the trailing year, and Share opens this account's Wrapped page", async () => {
	await mount();
	await until(
		() => text().includes("claude-opus-coverage"),
		"insights from /me/stats"
	);

	expect(text()).toContain("Ada Lovelace");
	expect(text()).toContain("Joined Mar 14, 2025");
	expect(text()).toContain("Level 7");
	expect(text()).toContain("4 day streak · best 12");
	// The streak badge says what a streak day is: agent runs count too.
	const streakBadge = [...document.querySelectorAll<HTMLElement>("*")].find(
		(element) =>
			element.tabIndex === 0 && normalized(element).startsWith("4 day streak")
	);
	expect(normalized(streakBadge)).toContain(
		"Days in a row you used Ryu (UTC). Agent runs count too, so a scheduled agent can keep your streak going."
	);
	expect(text()).toContain("1,234 points");
	// 1,234,567 tokens (input + output) in the shared compact number format.
	expect(statCard("Total tokens")).toBe("1.2minput + output");
	expect(statCard("Agent hours")).toBe("2.5agent runtime");
	expect(statCard("Total spend")).toBe("$4.32");
	expect(statCard("Requests")).toBe("8,765");
	expect(statCard("Active days")).toBe("42");
	expect(statCard("Peak day")).toBe("98,7652026-10-01");
	expect(statCard("Peak hour")).toBe("14:00 UTCbest effort");
	expect(statCard("Favourite model")).toBe("claude-opus-coverage");
	expect(text()).toContain("gpt-coverage");
	expect(text()).toContain("skill-coverage");
	expect(text()).toContain("No plugin usage recorded yet.");

	// The heatmap asks for exactly the trailing 364 days, ending today.
	const [usage] = calls("GET", "/api/profile/me/usage/daily");
	const today = new Date();
	expect(usage?.search).toBe(
		`?from=${format(subDays(today, 364), "yyyy-MM-dd")}&to=${format(today, "yyyy-MM-dd")}`
	);

	// A rostered agent with no recorded usage gets zeroed stats, not a hole.
	await until(() => text().includes("New hire"), "team roster");
	const badge = [...document.querySelectorAll<HTMLElement>("*")].find(
		(element) =>
			element.children.length === 0 && normalized(element) === "New hire"
	);
	const badgeText = normalized(badge?.closest(".cursor-pointer"));
	// Each badge stat renders its value above its label.
	expect(badgeText).toContain("Lv 0");
	expect(badgeText).toContain("0Tokens0Requests0dStreak");

	const share = button("Share your Ryu Wrapped");
	expect(isDisabled(share)).toBe(false);
	await click(share);
	await until(() => wrappedOpens().length === 1, "Wrapped open");
	expect(wrappedOpens()).toEqual([`${FRONTEND}/wrapped/${USER_ID}`]);
});

test("signed out there is nothing to share: the overview is anonymous, Share is disabled and no profile read is sent", async () => {
	localStorage.removeItem(TOKEN_KEY);
	// Signing out tells Better Auth's session store to re-read the session, as
	// its own signOut does; a previous case's account must not linger.
	await act(async () => authClient.$store.notify("$sessionSignal"));
	await render();
	await until(
		() => text().includes("Share your Ryu Wrapped"),
		"anonymous overview",
		8000
	);
	expect(text()).toContain("You");
	expect(text()).toContain("Level 0");
	expect(text()).toContain("0 points");
	const share = button("Share your Ryu Wrapped");
	expect(isDisabled(share)).toBe(true);
	expect(isDisabled(button("Share as clip"))).toBe(true);
	await click(share);
	await flush(4);
	expect(wrappedOpens()).toEqual([]);
	// Without a bearer the profile client refuses locally; nothing reached the
	// control plane's profile routes.
	expect(
		exchanges.filter((call) => call.path.startsWith("/api/profile/"))
	).toEqual([]);
});

test("Share as clip opens the heatmap clip dialog with its formats and both downloads, and closing it leaves the tab as it was", async () => {
	// happy-dom has no 2D canvas text metrics or Path2D; the preview draws
	// through these inert stand-ins and nothing it paints is asserted here (the
	// scene itself is covered in @ryu/ui's heatmap-clip tests).
	const prototype = HTMLCanvasElement.prototype;
	const getContext = prototype.getContext;
	const hadPath2D = "Path2D" in globalThis;
	Reflect.set(globalThis, "Path2D", hadPath2D ? globalThis.Path2D : class {});
	Object.defineProperty(prototype, "getContext", {
		configurable: true,
		value(this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
			const context = Reflect.apply(getContext, this, [type, ...rest]);
			if (type !== "2d" || context === null) {
				return context;
			}
			return new Proxy(context, {
				get: (target, property) =>
					property === "measureText"
						? () => ({ width: 0 })
						: Reflect.get(target, property),
				set: () => true,
			});
		},
		writable: true,
	});
	try {
		await mount();
		const share = button("Share as clip");
		expect(isDisabled(share)).toBe(false);
		await click(share);
		await until(
			() => text().includes("Share your activity"),
			"heatmap clip dialog"
		);
		expect(isDisabled(button("Download video"))).toBe(false);
		expect(isDisabled(button("Download GIF"))).toBe(false);
		for (const ratio of ["1:1", "9:16", "16:9"]) {
			expect(maybeButton(ratio)).not.toBeNull();
		}
		expect(document.querySelector("canvas[aria-label]")).not.toBeNull();
		// Opening the clip is local: nothing went to the browser.
		expect(wrappedOpens()).toEqual([]);
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		await until(
			() => !text().includes("Share your activity"),
			"closed clip dialog"
		);
		expect(isDisabled(button("Share as clip"))).toBe(false);
	} finally {
		Object.defineProperty(prototype, "getContext", {
			configurable: true,
			value: getContext,
			writable: true,
		});
		if (!hadPath2D) {
			Reflect.deleteProperty(globalThis, "Path2D");
		}
	}
});

test("a refused Wrapped open stays inside the tab instead of escaping as an unhandled rejection", async () => {
	await mount();
	bridge?.failWith("open_external: no default browser");
	await click(button("Share your Ryu Wrapped"));
	await until(() => wrappedOpens().length === 1, "refused Wrapped open");
	await flush(6);
	expect(wrappedOpens()).toEqual([`${FRONTEND}/wrapped/${USER_ID}`]);
	expect(isDisabled(button("Share your Ryu Wrapped"))).toBe(false);
});

test("spending points: only affordable unlocks are offered, the purchase is debited by the server once, and a fresh mount shows it unlocked", async () => {
	await mount();
	expect(unlockAction("Custom themes")).toBe("Unlock · 300 pts");
	expect(unlockAction("Priority queue")).toBe("Unlock · 5,000 pts");
	expect(isDisabled(button("Unlock · 5,000 pts"))).toBe(true);
	expect(unlockAction("Team seats")).toBe("Requires team, enterprise");
	expect(unlockAction("Power mode")).toBe("Unlocks at level 10");
	expect(unlockAction("Early access")).toBe("Unlocked");

	let release: () => void = () => undefined;
	holdUnlock = new Promise<void>((resolve) => {
		release = resolve;
	});
	await click(button("Unlock · 300 pts"));
	await until(
		() => unlockAction("Custom themes") === "Unlocking…",
		"pending unlock"
	);
	expect(isDisabled(button("Unlocking…"))).toBe(true);
	// Only the clicked entry is pending.
	expect(unlockAction("Priority queue")).toBe("Unlock · 5,000 pts");
	release();
	holdUnlock = null;

	await until(
		() => unlockAction("Custom themes") === "Unlocked",
		"acknowledged unlock"
	);
	await until(() => text().includes("934 points"), "debited balance");
	expect(text()).toContain("Feature unlocked");
	expect(text()).toContain("934 points remaining");
	const purchases = exchanges.filter(
		(call) => call.method === "POST" && call.path.startsWith("/api/profile/")
	);
	expect(purchases).toEqual([
		{
			auth: `Bearer ${SESSION_TOKEN}`,
			method: "POST",
			path: "/api/profile/me/unlocks/custom-themes",
			search: "",
			status: 200,
		},
	]);
	expect(ledger).toEqual({
		points: 934,
		unlocked: ["early-access", "custom-themes"],
	});
	// The acknowledged unlock refetched both the catalog and the balance.
	expect(calls("GET", "/api/profile/me/unlocks").length).toBeGreaterThanOrEqual(
		2
	);
	expect(calls("GET", "/api/profile/me/profile").length).toBeGreaterThanOrEqual(
		2
	);
	// Unrelated entries are conserved.
	expect(unlockAction("Priority queue")).toBe("Unlock · 5,000 pts");
	expect(unlockAction("Team seats")).toBe("Requires team, enterprise");
	expect(unlockAction("Early access")).toBe("Unlocked");

	// An independent reload (fresh cache, fresh mount) reads it back.
	await unmount();
	await act(async () => queryClient.clear());
	document.body.replaceChildren();
	await mount();
	expect(unlockAction("Custom themes")).toBe("Unlocked");
	expect(text()).toContain("934 points");
	expect(maybeButton("Unlock · 300 pts")).toBeNull();
});

test("a refused unlock reports the server's reason, debits nothing, and an explicit retry succeeds", async () => {
	await mount();
	unlockRefusal = {
		body: { message: "Points are frozen during review" },
		status: 409,
	};
	await click(button("Unlock · 300 pts"));
	await until(
		() => text().includes("Points are frozen during review"),
		"refusal toast"
	);
	expect(unlockAction("Custom themes")).toBe("Unlock · 300 pts");
	expect(isDisabled(button("Unlock · 300 pts"))).toBe(false);
	expect(text()).toContain("1,234 points");
	expect(text()).not.toContain("Feature unlocked");
	expect(ledger.points).toBe(1234);

	// A refusal without a JSON reason still says what failed.
	unlockRefusal = { body: "upstream exploded", status: 500 };
	await click(button("Unlock · 300 pts"));
	await until(() => text().includes("Failed to unlock (500)"), "status toast");
	expect(ledger.points).toBe(1234);

	unlockRefusal = null;
	await click(button("Unlock · 300 pts"));
	await until(
		() => unlockAction("Custom themes") === "Unlocked",
		"unlock after retry"
	);
	expect(ledger.points).toBe(934);
	expect(
		exchanges
			.filter(
				(call) =>
					call.method === "POST" && call.path.startsWith("/api/profile/")
			)
			.map((call) => call.status)
	).toEqual([409, 500, 200]);
});

test("an Unlocks read failure says so with Retry instead of spinning forever, and Retry loads the catalog", async () => {
	refuseUnlocksRead = true;
	await render();
	await until(
		() => text().includes("We couldn't load your unlockable features."),
		"unlocks error",
		8000
	);
	expect(text()).not.toContain("Custom themes");
	const failedReads = calls("GET", "/api/profile/me/unlocks");
	expect(failedReads.length).toBeGreaterThanOrEqual(1);
	expect(failedReads.every((call) => call.status === 503)).toBe(true);
	// The rest of the tab still rendered from its own reads.
	expect(text()).toContain("Level 7");

	refuseUnlocksRead = false;
	await click(button("Retry"));
	await until(() => text().includes("Custom themes"), "catalog after Retry");
	expect(text()).not.toContain("We couldn't load your unlockable features.");
	expect(calls("GET", "/api/profile/me/unlocks").at(-1)?.status).toBe(200);
	expect(unlockAction("Custom themes")).toBe("Unlock · 300 pts");
});

test("a tiny spend reads as <$0.01 and a stats outage falls back to empty insights instead of stale or invented numbers", async () => {
	costMicroUsd = 4000;
	statsAvailable = false;
	await mount();
	await flush(10);
	expect(statCard("Total spend")).toBe("<$0.01");
	expect(statCard("Active days")).toBe("0");
	expect(statCard("Peak day")).toBe("0none yet");
	expect(statCard("Peak hour")).toBe("—best effort");
	expect(statCard("Favourite model")).toBe("—");
	expect(text()).toContain("No model usage recorded yet.");
	expect(text()).toContain("No skill usage recorded yet.");
	// Lifetime totals still come from the profile read.
	expect(statCard("Requests")).toBe("8,765");
});

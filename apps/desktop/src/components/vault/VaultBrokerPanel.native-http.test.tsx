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
import {
	flush,
	installAnimationApis,
	isDisabled,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// The REAL `VaultBrokerPanel` (card spend approvals, pending broker proposals,
// broker services), mounted with the shipping desktop client against a
// loopback node. The node enforces the Core contracts the panel relies on: a
// bearer token on every call, strict decision bodies (`{}` to reject, `{grant}`
// or `{}` to approve a proposal, `{mode:"once"}` or the 15-minute session grant
// to approve a card), and decided rows leaving the pending lists. Nothing in
// the panel, the client, React Query or the toaster is replaced.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

// ── Node fixture ────────────────────────────────────────────────────────────
const TOKEN = "vault-broker-panel-node-token";
const PROPOSALS_ROUTE = "GET /api/vault/broker/proposals?status=pending";
const SERVICES_ROUTE = "GET /api/vault/broker/services";
const APPROVALS_ROUTE = "GET /api/vault/cards/approvals?status=pending";
const LIST_ROUTES = [PROPOSALS_ROUTE, SERVICES_ROUTE, APPROVALS_ROUTE];
const EXPIRES = "2026-10-20T12:00:00.000Z";

interface Proposal {
	createdAt: string;
	credentials: { description?: string; ref: string }[];
	credentialUse?: {
		account: string;
		provider: string;
		ref: string;
		subject: string;
	};
	environment: string;
	expiresAt: string;
	id: string;
	message: string;
	requestedBy: string;
	services: { host?: string; name?: string }[];
	status: "approved" | "pending" | "rejected";
}

interface Approval {
	agent: string;
	brand?: string;
	channel: "broker" | "fill" | "reveal";
	environment: string;
	field?: "cvc" | "number";
	id: string;
	key: string;
	last4?: string;
	merchantHost: string;
	requestExpiresAt: string;
	requestedAt: string;
	requester: string;
	status: "approved" | "pending" | "rejected";
}

interface Service {
	createdAt: string;
	description?: string;
	enabled: boolean;
	environment: string;
	host: string;
	name: string;
	pathPrefix: string;
	port?: number;
	updatedAt: string;
}

function plainProposal(id: string, patch: Partial<Proposal> = {}): Proposal {
	return {
		createdAt: "2026-10-03T00:00:00.000Z",
		credentials: [{ ref: "secret:STRIPE_KEY" }],
		environment: "prod",
		expiresAt: EXPIRES,
		id,
		message: `Add the ${id} service`,
		requestedBy: "agent:builder",
		services: [
			{ host: "api.stripe.example", name: "stripe" },
			{ host: "x.example" },
		],
		status: "pending",
		...patch,
	};
}

function managerProposal(id: string, patch: Partial<Proposal> = {}): Proposal {
	return {
		createdAt: "2026-10-03T00:00:00.000Z",
		credentialUse: {
			account: "work",
			provider: "1password",
			ref: `op://Private/${id}/key`,
			subject: "agent:researcher",
		},
		credentials: [],
		environment: "prod",
		expiresAt: EXPIRES,
		id,
		message: `Use ${id}`,
		requestedBy: "agent:researcher",
		services: [],
		status: "pending",
		...patch,
	};
}

function cardApproval(id: string, patch: Partial<Approval> = {}): Approval {
	return {
		agent: "researcher",
		brand: "visa",
		channel: "broker",
		environment: "prod",
		id,
		key: `CARD_${id.toUpperCase()}`,
		last4: "4242",
		merchantHost: "shop.example",
		requestedAt: "2026-10-03T00:00:00.000Z",
		requestExpiresAt: EXPIRES,
		requester: "agent:researcher",
		status: "pending",
		...patch,
	};
}

interface Exchange {
	body: string;
	route: string;
}
interface Refusal {
	body: unknown;
	status: number;
}

let proposals: Proposal[] = [];
let approvals: Approval[] = [];
let services: Service[] = [];
let exchanges: Exchange[] = [];
let unexpected: string[] = [];
/** A scripted refusal for one exact route (`METHOD /path?query`). */
let refusals = new Map<string, Refusal>();
/** Refuse the next decision POSTs (any route) with this reply. */
let decisionRefusal: Refusal | null = null;
/** Hold every list GET until released. */
let listGate: { promise: Promise<void>; release: () => void } | null = null;
/** Hold every decision POST until released. */
let decisionGate: { promise: Promise<void>; release: () => void } | null = null;

function gate() {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const approveProposalBody = z
	.object({ grant: z.enum(["once", "1h", "24h", "30d"]).optional() })
	.strict();
const emptyBody = z.object({}).strict();
const approveCardBody = z.union([
	z.object({ mode: z.literal("once") }).strict(),
	z
		.object({
			mode: z.literal("grant"),
			subject: z.literal("session"),
			ttlSecs: z.literal(900),
		})
		.strict(),
]);

function json(body: unknown, status = 200): Response {
	return NativeResponse.json(body, { status });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}${url.search}`;
		const raw = request.method === "GET" ? "" : await request.text();
		exchanges.push({ body: raw, route });
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			unexpected.push(`unauthenticated ${route}`);
			return json({ error: "Unauthorized" }, 401);
		}
		if (request.method === "GET" && listGate) {
			await listGate.promise;
		}
		const scripted = refusals.get(route);
		if (scripted) {
			return json(scripted.body, scripted.status);
		}
		if (route === PROPOSALS_ROUTE) {
			return json({
				proposals: proposals.filter((p) => p.status === "pending"),
			});
		}
		if (route === SERVICES_ROUTE) {
			return json({ services });
		}
		if (route === APPROVALS_ROUTE) {
			return json({
				approvals: approvals.filter((a) => a.status === "pending"),
			});
		}
		const proposalRoute =
			/^POST \/api\/vault\/broker\/proposals\/([^/?]+)\/(approve|reject)$/.exec(
				route
			);
		const cardRoute =
			/^POST \/api\/vault\/cards\/approvals\/([^/?]+)\/(approve|reject)$/.exec(
				route
			);
		const decision = proposalRoute ?? cardRoute;
		if (!decision) {
			unexpected.push(route);
			return json({ error: "Undeclared route" }, 404);
		}
		const [, encodedId, verb] = decision;
		const id = decodeURIComponent(encodedId ?? "");
		const schema =
			verb === "reject"
				? emptyBody
				: proposalRoute
					? approveProposalBody
					: approveCardBody;
		if (!schema.safeParse(JSON.parse(raw)).success) {
			unexpected.push(`bad body for ${route}: ${raw}`);
			return json({ error: "Bad body" }, 400);
		}
		if (decisionGate) {
			await decisionGate.promise;
		}
		if (decisionRefusal) {
			return json(decisionRefusal.body, decisionRefusal.status);
		}
		const status = verb === "approve" ? "approved" : "rejected";
		const row = (proposalRoute ? proposals : approvals).find(
			(candidate) => candidate.id === id && candidate.status === "pending"
		);
		if (!row) {
			return json({ error: "vault_not_found: no such pending request" }, 404);
		}
		row.status = status;
		return json({ ok: true });
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
const { sileo } = await import("sileo");
const { VaultBrokerPanel } = await import("./VaultBrokerPanel.tsx");
installAnimationApis();

// ── Mounting and DOM helpers ────────────────────────────────────────────────
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
				<VaultBrokerPanel target={target} />
			</QueryClientProvider>
		)
	);
	await flush(4);
}

async function mountSettled(): Promise<void> {
	await mount();
	await until(
		() => document.querySelector('[data-slot="skeleton-rows"]') === null,
		"lists settled"
	);
}

async function unmount(): Promise<void> {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	document.body.replaceChildren();
}

function norm(element: Element | null | undefined): string {
	return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function headings(): string[] {
	return [...document.querySelectorAll("h3")].map((heading) => norm(heading));
}

/** The list row whose title (message, card key or service name) is `title`. */
function rowFor(title: string): HTMLElement {
	const label = [...document.querySelectorAll("span, code")].find(
		(candidate) => norm(candidate) === title
	);
	const row = label?.closest<HTMLElement>("div.px-4, li");
	if (!row) {
		throw new Error(`No row ${title}: ${text()}`);
	}
	return row;
}

function maybeRow(title: string): boolean {
	return [...document.querySelectorAll("span, code")].some(
		(candidate) => norm(candidate) === title
	);
}

function buttonsIn(row: HTMLElement): string[] {
	return [...row.querySelectorAll("button")].map((control) => norm(control));
}

function buttonIn(row: HTMLElement, name: string): HTMLButtonElement {
	const found = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
		(control) => norm(control) === name
	);
	if (!found) {
		throw new Error(`No ${name} button: ${buttonsIn(row).join(", ")}`);
	}
	return found;
}

function selectIn(row: HTMLElement): HTMLSelectElement | null {
	return row.querySelector<HTMLSelectElement>(
		'select[aria-label="Approval lasts"]'
	);
}

function hasSelect(row: HTMLElement): boolean {
	return selectIn(row) !== null;
}

function summaryOf(row: HTMLElement): string {
	return norm(row.querySelector("p.truncate"));
}

async function press(control: HTMLElement): Promise<void> {
	await act(async () => control.click());
	await flush(4);
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
	await act(async () => {
		select.value = value;
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await flush(2);
}

function posts(): { body: unknown; route: string }[] {
	return exchanges
		.filter((exchange) => exchange.route.startsWith("POST "))
		.map((exchange) => ({
			body: JSON.parse(exchange.body) as unknown,
			route: exchange.route,
		}));
}

function count(route: string): number {
	return exchanges.filter((exchange) => exchange.route === route).length;
}

function listCounts(): number[] {
	return LIST_ROUTES.map(count);
}

async function toast(title: string): Promise<void> {
	await until(() => text().includes(title), `toast ${title}`);
}

beforeEach(() => {
	proposals = [];
	approvals = [];
	services = [];
	exchanges = [];
	unexpected = [];
	refusals = new Map();
	decisionRefusal = null;
	listGate = null;
	decisionGate = null;
	localStorage.clear();
});

afterEach(async () => {
	listGate?.release();
	decisionGate?.release();
	await unmount();
	await act(async () => {
		sileo.clear();
	});
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must keep to the owned node contract.
	expect(unexpected).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	window.fetch = nativeFetch;
});

// ── Sections: empty, loading, error ─────────────────────────────────────────
test("with nothing pending the panel stacks Card spend approvals, Pending proposals and Services, each with its empty copy", async () => {
	await mountSettled();
	expect(headings()).toEqual([
		"Card spend approvals",
		"Pending proposals",
		"Services",
	]);
	const copy = text();
	expect(copy).toContain("No card uses are waiting.");
	expect(copy).toContain("No pending proposals.");
	expect(copy).toContain("No broker services yet.");
	expect(copy).toContain("Card numbers are never shown.");
	expect(copy).toContain("Nothing is brokered until someone approves.");
	expect(copy).not.toContain("Broker admins only");
	expect(new Set(exchanges.map((exchange) => exchange.route))).toEqual(
		new Set(LIST_ROUTES)
	);
	expect(posts()).toEqual([]);
});

test("each section shows a Loading placeholder until its list answers, then the rows replace it", async () => {
	proposals = [plainProposal("p-1")];
	approvals = [cardApproval("c-1")];
	listGate = gate();
	await mount();
	await until(
		() => document.querySelectorAll('[data-slot="skeleton-rows"]').length === 3,
		"three placeholders"
	);
	const placeholders = [
		...document.querySelectorAll('[data-slot="skeleton-rows"]'),
	];
	expect(placeholders.map((node) => node.getAttribute("aria-label"))).toEqual([
		"Loading",
		"Loading",
		"Loading",
	]);
	expect(placeholders.map((node) => node.getAttribute("aria-busy"))).toEqual([
		"true",
		"true",
		"true",
	]);
	expect(text()).not.toContain("No pending proposals.");
	expect(maybeRow("Add the p-1 service")).toBe(false);

	listGate.release();
	await until(() => maybeRow("Add the p-1 service"), "proposal row");
	await until(() => maybeRow("CARD_C-1"), "card row");
	expect(document.querySelector('[data-slot="skeleton-rows"]') === null).toBe(
		true
	);
	expect(text()).toContain("No broker services yet.");
});

test("a failed list shows Core's sentence, or the fallback when Core sends none, without hiding the other sections", async () => {
	refusals.set(PROPOSALS_ROUTE, { body: {}, status: 500 });
	refusals.set(SERVICES_ROUTE, {
		body: { error: "vault_sealed: unseal the vault first" },
		status: 503,
	});
	refusals.set(APPROVALS_ROUTE, { body: {}, status: 502 });
	await mountSettled();
	expect(headings()).toEqual([
		"Card spend approvals",
		"Pending proposals",
		"Services",
	]);
	const copy = text();
	expect(copy).toContain("Could not load proposals.");
	expect(copy).toContain("Could not load card approvals.");
	expect(copy).toContain("Unseal the vault first");
	expect(copy).not.toContain("Could not load broker services.");
	expect(copy).not.toContain("Broker admins only");
	expect(copy).not.toContain("No pending proposals.");
	expect(copy).not.toContain("No card uses are waiting.");
});

test("a service with no Core message falls back to the broker services sentence", async () => {
	refusals.set(SERVICES_ROUTE, { body: {}, status: 500 });
	await mountSettled();
	expect(text()).toContain("Could not load broker services.");
	expect(text()).toContain("No pending proposals.");
});

test("a 403 on the proposals list leaves only Card spend approvals and the Broker admins only notice", async () => {
	approvals = [cardApproval("c-1")];
	refusals.set(PROPOSALS_ROUTE, {
		body: {
			error: "vault_denied: the `list` capability is required on `sys/broker`",
		},
		status: 403,
	});
	await mountSettled();
	await until(() => text().includes("Broker admins only"), "admin notice");
	expect(headings()).toEqual(["Card spend approvals"]);
	expect(text()).toContain(
		"Ask a vault admin for access to the credential broker."
	);
	expect(text()).not.toContain("Pending proposals");
	expect(text()).not.toContain("No pending proposals.");
	expect(text()).not.toContain("Services");
	expect(text()).not.toContain("No broker services yet.");
	// The card owner still sees, and can act on, their own approvals.
	expect(maybeRow("CARD_C-1")).toBe(true);
	await press(buttonIn(rowFor("CARD_C-1"), "Approve once"));
	await toast("Card use approved once (within 15 minutes)");
	expect(posts()).toEqual([
		{
			body: { mode: "once" },
			route: "POST /api/vault/cards/approvals/c-1/approve",
		},
	]);
	expect(text()).toContain("Broker admins only");
});

// ── Broker proposals ────────────────────────────────────────────────────────
test("a password-manager proposal shows its provider and an Approval lasts menu that defaults to 30 days", async () => {
	proposals = [managerProposal("pm-1")];
	await mountSettled();
	const row = rowFor("Use pm-1");
	expect(norm(row)).toContain("1password");
	expect(norm(row)).toContain("prod");
	expect(summaryOf(row)).toStartWith(
		"Password manager: op://Private/pm-1/key for agent:researcher (account work) · agent:researcher · expires "
	);
	const select = selectIn(row);
	expect(select === null).toBe(false);
	expect(select?.value).toBe("30d");
	expect(
		[...(select?.options ?? [])].map((option) => [option.value, norm(option)])
	).toEqual([
		["once", "Once"],
		["1h", "1 hour"],
		["24h", "24 hours"],
		["30d", "30 days"],
	]);
	expect(buttonsIn(row)).toEqual(["Reject", "Approve"]);
});

test("approving a password-manager proposal untouched sends the 30 day grant and refetches every list", async () => {
	proposals = [managerProposal("pm-1")];
	await mountSettled();
	const before = listCounts();
	await press(buttonIn(rowFor("Use pm-1"), "Approve"));
	await toast("Proposal approved");
	await until(() => text().includes("No pending proposals."), "row gone");
	expect(posts()).toEqual([
		{
			body: { grant: "30d" },
			route: "POST /api/vault/broker/proposals/pm-1/approve",
		},
	]);
	expect(listCounts()).toEqual(before.map((seen) => seen + 1));
	expect(text()).not.toContain("Proposal rejected");
});

test("each password-manager row keeps its own lifetime and Approve sends the one chosen on that row", async () => {
	proposals = [managerProposal("pm-a"), managerProposal("pm-b")];
	await mountSettled();
	const rowA = rowFor("Use pm-a");
	const rowB = rowFor("Use pm-b");
	await choose(selectIn(rowA) as HTMLSelectElement, "once");
	await choose(selectIn(rowB) as HTMLSelectElement, "24h");
	expect(selectIn(rowFor("Use pm-a"))?.value).toBe("once");
	expect(selectIn(rowFor("Use pm-b"))?.value).toBe("24h");

	await press(buttonIn(rowFor("Use pm-a"), "Approve"));
	await toast("Proposal approved");
	await until(() => !maybeRow("Use pm-a"), "first row gone");
	// The other row kept its own choice through the refetch.
	expect(selectIn(rowFor("Use pm-b"))?.value).toBe("24h");
	await press(buttonIn(rowFor("Use pm-b"), "Approve"));
	await until(() => !maybeRow("Use pm-b"), "second row gone");
	expect(posts()).toEqual([
		{
			body: { grant: "once" },
			route: "POST /api/vault/broker/proposals/pm-a/approve",
		},
		{
			body: { grant: "24h" },
			route: "POST /api/vault/broker/proposals/pm-b/approve",
		},
	]);
});

test("every lifetime in the menu is sent as chosen", async () => {
	proposals = [managerProposal("pm-1h"), managerProposal("pm-30d")];
	await mountSettled();
	await choose(selectIn(rowFor("Use pm-1h")) as HTMLSelectElement, "1h");
	await choose(selectIn(rowFor("Use pm-30d")) as HTMLSelectElement, "24h");
	await choose(selectIn(rowFor("Use pm-30d")) as HTMLSelectElement, "30d");
	await press(buttonIn(rowFor("Use pm-1h"), "Approve"));
	await until(() => !maybeRow("Use pm-1h"), "1h row gone");
	await press(buttonIn(rowFor("Use pm-30d"), "Approve"));
	await until(() => !maybeRow("Use pm-30d"), "30d row gone");
	expect(posts().map((post) => post.body)).toEqual([
		{ grant: "1h" },
		{ grant: "30d" },
	]);
});

test("a plain proposal has no lifetime menu or provider badge, and Approve sends an empty body", async () => {
	proposals = [plainProposal("svc-1")];
	await mountSettled();
	const row = rowFor("Add the svc-1 service");
	expect(hasSelect(row)).toBe(false);
	expect(row.querySelector("select") === null).toBe(true);
	expect(norm(row)).not.toContain("1password");
	expect(summaryOf(row)).toStartWith(
		"Services: stripe, x.example · Credentials: secret:STRIPE_KEY · agent:builder · expires "
	);
	expect(buttonsIn(row)).toEqual(["Reject", "Approve"]);
	const before = listCounts();
	await press(buttonIn(row, "Approve"));
	await toast("Proposal approved");
	await until(() => text().includes("No pending proposals."), "row gone");
	expect(posts()).toEqual([
		{ body: {}, route: "POST /api/vault/broker/proposals/svc-1/approve" },
	]);
	expect(listCounts()).toEqual(before.map((seen) => seen + 1));
});

test("Reject posts an empty body to the reject route, ignoring the lifetime chosen on a password-manager row", async () => {
	proposals = [managerProposal("pm-1"), plainProposal("svc-1")];
	await mountSettled();
	await choose(selectIn(rowFor("Use pm-1")) as HTMLSelectElement, "1h");
	const before = listCounts();
	await press(buttonIn(rowFor("Use pm-1"), "Reject"));
	await toast("Proposal rejected");
	await until(() => !maybeRow("Use pm-1"), "rejected row gone");
	await press(buttonIn(rowFor("Add the svc-1 service"), "Reject"));
	await until(() => text().includes("No pending proposals."), "all gone");
	expect(posts()).toEqual([
		{ body: {}, route: "POST /api/vault/broker/proposals/pm-1/reject" },
		{ body: {}, route: "POST /api/vault/broker/proposals/svc-1/reject" },
	]);
	expect(listCounts()).toEqual(before.map((seen) => seen + 2));
	expect(text()).not.toContain("Proposal approved");
});

test("only the row being decided is disabled while its request is in flight", async () => {
	proposals = [managerProposal("pm-1"), plainProposal("svc-1")];
	approvals = [cardApproval("c-1")];
	await mountSettled();
	decisionGate = gate();
	await press(buttonIn(rowFor("Use pm-1"), "Approve"));
	await until(() => posts().length === 1, "decision request");
	const acted = rowFor("Use pm-1");
	expect(isDisabled(buttonIn(acted, "Approve"))).toBe(true);
	expect(isDisabled(buttonIn(acted, "Reject"))).toBe(true);
	expect(selectIn(acted)?.disabled).toBe(true);
	const other = rowFor("Add the svc-1 service");
	expect(isDisabled(buttonIn(other, "Approve"))).toBe(false);
	expect(isDisabled(buttonIn(other, "Reject"))).toBe(false);
	const card = rowFor("CARD_C-1");
	for (const name of ["Reject", "Allow 15 min", "Approve once"]) {
		expect(isDisabled(buttonIn(card, name))).toBe(false);
	}
	expect(text()).not.toContain("Proposal approved");

	decisionGate.release();
	await toast("Proposal approved");
	await until(() => !maybeRow("Use pm-1"), "acted row gone");
	expect(isDisabled(buttonIn(rowFor("Add the svc-1 service"), "Approve"))).toBe(
		false
	);
});

test("a failed proposal decision names the failure and Core's reason, keeps the row, and does not refetch", async () => {
	proposals = [plainProposal("svc-1")];
	await mountSettled();
	decisionRefusal = {
		body: {
			error: "vault_denied: the `admin` capability is required on `sys/broker`",
		},
		status: 403,
	};
	const before = listCounts();
	await press(buttonIn(rowFor("Add the svc-1 service"), "Approve"));
	await toast("Could not update the proposal");
	await until(
		() => text().includes("The `admin` capability is required on `sys/broker`"),
		"Core's reason"
	);
	expect(text()).not.toContain("Proposal approved");
	expect(maybeRow("Add the svc-1 service")).toBe(true);
	expect(isDisabled(buttonIn(rowFor("Add the svc-1 service"), "Approve"))).toBe(
		false
	);
	expect(listCounts()).toEqual(before);
	expect(proposals[0]?.status).toBe("pending");

	// The same row works again once Core stops refusing.
	await act(async () => {
		sileo.clear();
	});
	decisionRefusal = null;
	await press(buttonIn(rowFor("Add the svc-1 service"), "Approve"));
	await toast("Proposal approved");
	expect(proposals[0]?.status).toBe("approved");
});

test("a proposal decision refused without a message says Try again", async () => {
	proposals = [plainProposal("svc-1")];
	await mountSettled();
	decisionRefusal = { body: {}, status: 500 };
	await press(buttonIn(rowFor("Add the svc-1 service"), "Reject"));
	await toast("Could not update the proposal");
	await until(() => text().includes("Try again."), "fallback reason");
	expect(maybeRow("Add the svc-1 service")).toBe(true);
	expect(text()).not.toContain("Proposal rejected");
});

// ── Card spend approvals ────────────────────────────────────────────────────
test("card rows show the brand, last four, merchant, channel, field and requester without any card number", async () => {
	approvals = [
		cardApproval("c-agent"),
		cardApproval("c-fill", { channel: "fill", requester: "person:ada" }),
		cardApproval("c-reveal", { channel: "reveal", field: "cvc" }),
		cardApproval("c-bare", {
			brand: undefined,
			last4: undefined,
			merchantHost: "",
		}),
	];
	await mountSettled();
	const agent = rowFor("CARD_C-AGENT");
	expect(norm(agent)).toContain("prod");
	expect(summaryOf(agent)).toStartWith(
		"visa •••• 4242 · at shop.example · agent request · agent:researcher · expires "
	);
	expect(summaryOf(rowFor("CARD_C-FILL"))).toStartWith(
		"visa •••• 4242 · at shop.example · fill · person:ada · expires "
	);
	expect(summaryOf(rowFor("CARD_C-REVEAL"))).toStartWith(
		"visa •••• 4242 · at shop.example · reveal · field cvc · agent:researcher · expires "
	);
	expect(summaryOf(rowFor("CARD_C-BARE"))).toStartWith(
		"card · agent request · agent:researcher · expires "
	);
	expect(text()).not.toMatch(/\d{12,}/);
});

test("a reveal row offers only Reject and Approve once, while broker and fill rows also offer Allow 15 min", async () => {
	approvals = [
		cardApproval("c-agent"),
		cardApproval("c-fill", { channel: "fill" }),
		cardApproval("c-reveal", { channel: "reveal", field: "number" }),
	];
	await mountSettled();
	expect(buttonsIn(rowFor("CARD_C-AGENT"))).toEqual([
		"Reject",
		"Allow 15 min",
		"Approve once",
	]);
	expect(buttonsIn(rowFor("CARD_C-FILL"))).toEqual([
		"Reject",
		"Allow 15 min",
		"Approve once",
	]);
	expect(buttonsIn(rowFor("CARD_C-REVEAL"))).toEqual([
		"Reject",
		"Approve once",
	]);
});

test("Approve once sends mode once, toasts the 15 minute window and refetches every list", async () => {
	approvals = [cardApproval("c-1"), cardApproval("c-2")];
	await mountSettled();
	const before = listCounts();
	await press(buttonIn(rowFor("CARD_C-1"), "Approve once"));
	await toast("Card use approved once (within 15 minutes)");
	await until(() => !maybeRow("CARD_C-1"), "approved row gone");
	expect(posts()).toEqual([
		{
			body: { mode: "once" },
			route: "POST /api/vault/cards/approvals/c-1/approve",
		},
	]);
	expect(listCounts()).toEqual(before.map((seen) => seen + 1));
	expect(maybeRow("CARD_C-2")).toBe(true);
	expect(text()).not.toContain("Card use approved for 15 minutes");
});

test("Allow 15 min sends a session grant of 900 seconds and toasts it", async () => {
	approvals = [
		cardApproval("c-1"),
		cardApproval("c-fill", { channel: "fill" }),
	];
	await mountSettled();
	await press(buttonIn(rowFor("CARD_C-1"), "Allow 15 min"));
	await toast("Card use approved for 15 minutes");
	await until(() => !maybeRow("CARD_C-1"), "granted row gone");
	expect(posts()).toEqual([
		{
			body: { mode: "grant", subject: "session", ttlSecs: 900 },
			route: "POST /api/vault/cards/approvals/c-1/approve",
		},
	]);
	expect(text()).not.toContain("Card use approved once");
	expect(approvals.map((approval) => approval.status)).toEqual([
		"approved",
		"pending",
	]);
});

test("Reject on a card row posts an empty body and toasts Card use rejected", async () => {
	approvals = [cardApproval("c-1", { channel: "reveal", field: "cvc" })];
	await mountSettled();
	await press(buttonIn(rowFor("CARD_C-1"), "Reject"));
	await toast("Card use rejected");
	await until(() => text().includes("No card uses are waiting."), "row gone");
	expect(posts()).toEqual([
		{ body: {}, route: "POST /api/vault/cards/approvals/c-1/reject" },
	]);
	expect(approvals[0]?.status).toBe("rejected");
});

test("only the card row being decided is disabled while its request is in flight", async () => {
	approvals = [cardApproval("c-1"), cardApproval("c-2")];
	proposals = [plainProposal("svc-1")];
	await mountSettled();
	decisionGate = gate();
	await press(buttonIn(rowFor("CARD_C-1"), "Allow 15 min"));
	await until(() => posts().length === 1, "decision request");
	for (const name of ["Reject", "Allow 15 min", "Approve once"]) {
		expect(isDisabled(buttonIn(rowFor("CARD_C-1"), name))).toBe(true);
		expect(isDisabled(buttonIn(rowFor("CARD_C-2"), name))).toBe(false);
	}
	expect(isDisabled(buttonIn(rowFor("Add the svc-1 service"), "Approve"))).toBe(
		false
	);
	decisionGate.release();
	await toast("Card use approved for 15 minutes");
	await until(() => !maybeRow("CARD_C-1"), "acted row gone");
});

test("a failed card decision names the failure and Core's reason and keeps the row", async () => {
	approvals = [cardApproval("c-1")];
	await mountSettled();
	decisionRefusal = {
		body: {
			error:
				"vault_denied: the `write` capability is required on `default/CARD_C-1`",
		},
		status: 403,
	};
	const before = listCounts();
	await press(buttonIn(rowFor("CARD_C-1"), "Approve once"));
	await toast("Could not update the card approval");
	await until(
		() =>
			text().includes(
				"The `write` capability is required on `default/CARD_C-1`"
			),
		"Core's reason"
	);
	expect(text()).not.toContain("Card use approved");
	expect(maybeRow("CARD_C-1")).toBe(true);
	expect(isDisabled(buttonIn(rowFor("CARD_C-1"), "Approve once"))).toBe(false);
	expect(listCounts()).toEqual(before);
	expect(approvals[0]?.status).toBe("pending");
});

// ── Services ────────────────────────────────────────────────────────────────
test("services list their upstream, description, environment and a Disabled badge only when off", async () => {
	services = [
		{
			createdAt: "2026-10-01T00:00:00.000Z",
			description: "Payments sandbox",
			enabled: true,
			environment: "prod",
			host: "api.stripe.example",
			name: "stripe",
			pathPrefix: "/v1",
			port: 8443,
			updatedAt: "2026-10-02T00:00:00.000Z",
		},
		{
			createdAt: "2026-10-01T00:00:00.000Z",
			enabled: false,
			environment: "staging",
			host: "files.example",
			name: "files",
			pathPrefix: "/",
			updatedAt: "yesterday",
		},
	];
	await mountSettled();
	const stripe = rowFor("stripe");
	expect(summaryOf(stripe)).toBe(
		"api.stripe.example:8443/v1 · Payments sandbox"
	);
	expect(norm(stripe)).toContain("prod");
	expect(norm(stripe)).not.toContain("Disabled");
	const files = rowFor("files");
	expect(summaryOf(files)).toBe("files.example");
	expect(norm(files)).toContain("staging");
	expect(norm(files)).toContain("Disabled");
	// An unparseable timestamp is shown as Core sent it.
	expect(norm(files)).toEndWith("yesterday");
	expect(text()).not.toContain("No broker services yet.");
});

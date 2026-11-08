import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { Root } from "react-dom/client";
import {
	button,
	click,
	flush,
	installAnimationApis,
	isDisabled,
	openDialogs,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// The REAL broker console (Sessions, Activity, Settings) inside
// `VaultBrokerPanel`, driven against a stateful loopback node that keeps the
// Core contracts: sessions mint and revoke, the request log pages with
// `before`, discovered hosts, and per-environment settings.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "broker-console-node-token";
const MINTED_TOKEN = "rvb_console_once";

interface Session {
	createdAt: string;
	environment: string;
	expiresAt: string;
	id: string;
	label: string;
	mintedBy: string;
	services: string[];
}

let sessions: Session[] = [];
let settings = {
	brokerRunsUnderDeny: false,
	skills: "",
	unmatchedHostPolicy: "deny",
};
let routes: string[] = [];
let bodies: Record<string, unknown> = {};

function json(body: unknown, status = 200): Response {
	return NativeResponse.json(body, { status });
}

function logRow(id: number) {
	return {
		at: "2026-10-01T00:00:00+00:00",
		environment: "prod",
		host: "api.stripe.com",
		id,
		latencyMs: 9,
		method: "POST",
		outcome: id === 1 ? "forbidden" : "intercepted",
		path: `/v1/r${id}`,
		port: 443,
		scheme: "https",
		service: id === 1 ? null : "stripe",
		sessionId: null,
		status: id === 1 ? 403 : 200,
	};
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}${url.search}`;
		routes.push(route);
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			return json({ error: "Unauthorized" }, 401);
		}
		if (request.method !== "GET" && request.method !== "DELETE") {
			bodies[route] = await request.json();
		}
		if (route === "GET /api/vault/broker/proposals?status=pending") {
			return json({ proposals: [] });
		}
		if (route === "GET /api/vault/environments") {
			return json({
				active: "prod",
				environments: [
					{
						name: "Prod",
						position: 0,
						protected: false,
						requiredApprovals: 0,
						slug: "prod",
					},
					{
						name: "Staging",
						position: 1,
						protected: false,
						requiredApprovals: 0,
						slug: "staging",
					},
				],
			});
		}
		if (route.startsWith("GET /api/vault/broker/services")) {
			return json({
				services: [
					{
						createdAt: "2026-10-01T00:00:00+00:00",
						enabled: true,
						environment: "prod",
						host: "api.stripe.com",
						name: "stripe",
						pathPrefix: "/",
						updatedAt: "2026-10-01T00:00:00+00:00",
					},
				],
			});
		}
		if (route === "GET /api/vault/broker/sessions") {
			return json({ sessions });
		}
		if (route === "POST /api/vault/broker/sessions") {
			const session: Session = {
				createdAt: "2026-10-01T00:00:00+00:00",
				environment: "prod",
				expiresAt: "2026-10-01T01:00:00+00:00",
				id: "bs_new",
				label: "ci",
				mintedBy: "user:me",
				services: ["stripe"],
			};
			sessions.push(session);
			return json({
				proxy: {
					caBundlePath: "/ca/bundle.pem",
					caPath: "/ca/ca.pem",
					env: { HTTPS_PROXY: `http://rvb:${MINTED_TOKEN}@127.0.0.1:9` },
					port: 9,
					url: "http://127.0.0.1:9",
				},
				session,
				token: MINTED_TOKEN,
			});
		}
		const revoke = /^DELETE \/api\/vault\/broker\/sessions\/(.+)$/.exec(route);
		if (revoke) {
			const before = sessions.length;
			sessions = sessions.filter((session) => session.id !== revoke[1]);
			return json({ revoked: sessions.length < before });
		}
		if (route.startsWith("GET /api/vault/broker/discovered-hosts")) {
			return json({
				hosts: [
					{
						environment: "prod",
						host: "api.openai.com",
						lastSeen: 0,
						port: 443,
						requests: 4,
						suggestedTemplate: "openai",
					},
				],
			});
		}
		if (route.startsWith("GET /api/vault/broker/logs")) {
			const before = Number(url.searchParams.get("before") ?? "1000");
			const limit = Number(url.searchParams.get("limit"));
			const bucket = url.searchParams.get("statusBucket");
			const ids = Array.from({ length: 60 }, (_, index) => 60 - index)
				.filter((id) => id < before)
				.filter((id) => bucket !== "4xx" || id === 1)
				.slice(0, limit);
			return json({ logs: ids.map(logRow) });
		}
		if (route === "GET /api/vault/broker/catalog") {
			return json({
				templates: [
					{
						auth: { token: "secret:OPENAI_API_KEY", type: "bearer" },
						host: "api.openai.com",
						id: "openai",
						name: "OpenAI",
						pathPrefix: "/",
						suggestedRef: "secret:OPENAI_API_KEY",
					},
				],
			});
		}
		if (route === "POST /api/vault/broker/services") {
			return json({
				service: {
					createdAt: "2026-10-01T00:00:00+00:00",
					enabled: true,
					environment: "prod",
					host: "api.openai.com",
					name: "openai",
					pathPrefix: "/",
					updatedAt: "2026-10-01T00:00:00+00:00",
				},
			});
		}
		if (route === "GET /api/vault/broker/environments/prod") {
			return json({ settings: { environment: "prod", ...settings } });
		}
		if (route === "PUT /api/vault/broker/environments/prod") {
			settings = bodies[route] as typeof settings;
			return json({ settings: { environment: "prod", ...settings } });
		}
		if (route === "GET /api/vault/broker/status") {
			return json({
				broker: {
					caUrl: "/ca.pem",
					listening: true,
					port: 9,
					portEnv: "PORT_ENV",
				},
			});
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
const { VaultBrokerPanel } = await import("./VaultBrokerPanel.tsx");
const { environmentChoices } = await import("./VaultBrokerConsole.tsx");
const { sessionSummary } = await import("./VaultBrokerSessions.tsx");
const { shellExports } = await import("./VaultBrokerMintDialog.tsx");
const { logLine } = await import("./VaultBrokerActivity.tsx");
const { MAX_SKILLS_BYTES } = await import("./VaultBrokerSettings.tsx");
installAnimationApis();

let root: Root | null = null;
let client: InstanceType<typeof QueryClient>;

async function mount(): Promise<void> {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<Toaster />
				<VaultBrokerPanel environment="prod" target={target} />
			</QueryClientProvider>
		)
	);
	await flush(4);
}

async function openView(name: string): Promise<void> {
	const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
		(candidate) => candidate.textContent?.trim() === name
	);
	if (!tab) {
		throw new Error(`No ${name} tab`);
	}
	await click(tab);
}

async function setValue(
	element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
	value: string
): Promise<void> {
	const proto = Object.getPrototypeOf(element) as object;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
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
	sessions = [
		{
			createdAt: "2026-10-01T00:00:00+00:00",
			environment: "prod",
			expiresAt: "2026-10-01T01:00:00+00:00",
			id: "bs_old",
			label: "",
			mintedBy: "runtime:acp",
			services: ["stripe"],
		},
	];
	settings = {
		brokerRunsUnderDeny: false,
		skills: "",
		unmatchedHostPolicy: "deny",
	};
	routes = [];
	bodies = {};
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

test("the console loads nothing until a view is opened", async () => {
	await mount();
	await until(
		() =>
			text().includes("No broker services yet.") || text().includes("stripe"),
		"requests"
	);
	expect(routes.some((route) => route.includes("/sessions"))).toBe(false);
	expect(routes.some((route) => route.includes("/logs"))).toBe(false);
	expect(routes.some((route) => route.includes("/environments"))).toBe(false);
});

test("Sessions lists, mints once with the chosen service, keeps the token out of the cache, and revokes", async () => {
	await mount();
	await openView("Sessions");
	await until(() => text().includes("bs_old"), "session row");
	expect(text()).toContain("runtime:acp");

	await click(button("New session"));
	await until(() => text().includes("New broker session"), "mint dialog");
	const start = button("Start session");
	expect(isDisabled(start)).toBe(true);
	const checkbox =
		openDialogs()[0]?.querySelector<HTMLElement>('[role="checkbox"]');
	if (!checkbox) {
		throw new Error("no service checkbox");
	}
	await click(checkbox);
	await setValue(field<HTMLInputElement>("broker-session-label"), "ci");
	await setValue(field<HTMLSelectElement>("broker-session-ttl"), "900");
	await click(button("Start session"));
	await until(() => text().includes("Session ready"), "minted");
	expect(bodies["POST /api/vault/broker/sessions"]).toEqual({
		environment: "prod",
		label: "ci",
		services: ["stripe"],
		ttlSecs: 900,
	});
	expect(field<HTMLInputElement>("broker-minted-token").value).toBe(
		MINTED_TOKEN
	);
	expect(field<HTMLTextAreaElement>("broker-minted-env").value).toContain(
		`export HTTPS_PROXY='http://rvb:${MINTED_TOKEN}@127.0.0.1:9'`
	);
	const cached = JSON.stringify(
		client
			.getQueryCache()
			.getAll()
			.map((query) => query.state.data)
	);
	expect(cached).not.toContain(MINTED_TOKEN);

	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
	await until(() => !text().includes(MINTED_TOKEN), "token dropped");
	await until(() => text().includes("ci"), "new session listed");

	const row = button("Revoke", document.querySelector("li") ?? document);
	await click(row);
	await until(
		() => routes.includes("DELETE /api/vault/broker/sessions/bs_old"),
		"revoke"
	);
	await until(() => !text().includes("runtime:acp"), "revoked row gone");
});

test("Activity turns a discovered host into a service from its matching template", async () => {
	await mount();
	await openView("Activity");
	await until(() => text().includes("api.openai.com"), "discovered host");
	expect(text()).toContain("4 requests");
	await click(button("Create service"));
	await until(
		() =>
			field<HTMLSelectElement>("broker-service-template").value === "openai",
		"template preselected"
	);
	expect(field<HTMLInputElement>("broker-service-name").value).toBe("openai");
	await setValue(
		field<HTMLInputElement>("broker-service-credential"),
		"secret:WORK_OPENAI"
	);
	await click(button("Add service"));
	await until(
		() => "POST /api/vault/broker/services" in bodies,
		"create posted"
	);
	expect(bodies["POST /api/vault/broker/services"]).toEqual({
		credentialRef: "secret:WORK_OPENAI",
		environment: "prod",
		name: "openai",
		template: "openai",
	});
});

test("the request log pages older rows and filters by status class", async () => {
	await mount();
	await openView("Activity");
	await until(
		() => text().includes("POST api.stripe.com/v1/r60"),
		"newest row"
	);
	expect(text()).not.toContain("/v1/r10 ");
	await click(button("Load older"));
	await until(() => text().includes("/v1/r1"), "older page");
	expect(routes).toContain(
		"GET /api/vault/broker/logs?before=11&environment=prod&limit=50"
	);
	await setValue(
		document.querySelector<HTMLSelectElement>(
			'select[aria-label="Status"]'
		) as HTMLSelectElement,
		"4xx"
	);
	await until(
		() => routes.some((route) => route.includes("statusBucket=4xx")),
		"filtered"
	);
	await until(() => !text().includes("/v1/r60"), "only refusals");
	expect(text()).toContain("forbidden");
});

test("Settings saves the unmatched-host policy and skills for the picked environment", async () => {
	await mount();
	await openView("Settings");
	await until(() => text().includes("listening on 127.0.0.1:9"), "status");
	const save = button("Save");
	expect(isDisabled(save)).toBe(true);
	await setValue(
		field<HTMLSelectElement>("broker-unmatched-policy"),
		"passthrough"
	);
	await setValue(field<HTMLTextAreaElement>("broker-skills"), "Use /v1 only.");
	await click(button("Save"));
	await until(
		() => "PUT /api/vault/broker/environments/prod" in bodies,
		"saved"
	);
	expect(bodies["PUT /api/vault/broker/environments/prod"]).toEqual({
		brokerRunsUnderDeny: false,
		skills: "Use /v1 only.",
		unmatchedHostPolicy: "passthrough",
	});
	// The agent-run opt-in only applies under the refusing policy.
	expect(document.getElementById("broker-runs-under-deny")).toBeNull();

	await setValue(field<HTMLSelectElement>("broker-environment"), "staging");
	await until(
		() => routes.includes("GET /api/vault/broker/environments/staging"),
		"staging settings"
	);
});

test("Settings opts the refusing policy into brokering agent runs", async () => {
	await mount();
	await openView("Settings");
	await until(() => text().includes("listening on 127.0.0.1:9"), "status");
	const toggle = document.querySelector<HTMLElement>('[role="switch"]');
	if (!toggle) {
		throw new Error(`No agent-run switch: ${text()}`);
	}
	expect(toggle.getAttribute("aria-checked")).toBe("false");
	await click(toggle);
	await click(button("Save"));
	await until(
		() => "PUT /api/vault/broker/environments/prod" in bodies,
		"saved"
	);
	expect(bodies["PUT /api/vault/broker/environments/prod"]).toEqual({
		brokerRunsUnderDeny: true,
		skills: "",
		unmatchedHostPolicy: "deny",
	});
});

test("console helpers format sessions, exports, log lines and environment choices", () => {
	expect(
		sessionSummary(
			{ ...sessions[0], services: [] } as Session,
			(message, values) => formatMessage(message, values)
		).startsWith("no services · runtime:acp")
	).toBe(true);
	expect(shellExports({ A: "it's" })).toBe(`export A='it'\\''s'`);
	expect(logLine({ ...logRow(2), port: 8443 })).toBe(
		"POST api.stripe.com:8443/v1/r2"
	);
	expect(environmentChoices(undefined, "prod")).toEqual([
		{ label: "prod", value: "prod" },
	]);
	expect(
		environmentChoices([{ name: "", slug: "dev" }], "prod").map(
			(choice) => choice.value
		)
	).toEqual(["prod", "dev"]);
	expect(MAX_SKILLS_BYTES).toBe(65_536);
});

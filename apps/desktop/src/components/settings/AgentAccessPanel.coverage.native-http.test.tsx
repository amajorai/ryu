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
	isOn,
	maybeByLabel,
	maybeRow,
	pageText,
	settle,
} from "./general-agents-network.test-support.ts";

// Control-level coverage for `AgentAccessPanel`'s "App tools" row: the
// explanation it shows instead of per-app switches when the node has no MCP
// tools to grant (or cannot list them). The panel is mounted unchanged with the
// production agents, Spaces and MCP clients; a Core-shaped native HTTP fixture
// owns `GET/PUT /api/agents/:id`, `GET /api/spaces` and `GET /api/mcp/tools`
// with node-bearer admission, and stores the agent exactly as written so a
// remount reads back what the panel saved.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
window.fetch = nativeFetch;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const NODE_TOKEN = "agent-access-coverage-node-token";
const USER_JWT = "agent-access-coverage-user-jwt";
const AGENT_ID = "agent-access-coverage";
const NO_TOOLS_COPY =
	"No MCP tools are registered yet. Enable apps/plugins that expose tools (Ghost, Spaces, Browser, …) to grant them here.";

interface AgentWire {
	built_in: boolean;
	composio_actions: string[];
	description: string | null;
	engine: string | null;
	id: string;
	identity_profile_ids: string[];
	lifecycle_status: string;
	locked: boolean;
	memory: {
		read_levels: string[];
		space_ids: string[];
		write_enabled: boolean;
	};
	name: string;
	orchestrator: boolean | null;
	safety_profile: string;
	skills: string[];
	system_prompt: string | null;
	title: string;
	tools: string[];
	version: string;
}

interface Exchange {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

function seedAgent(): AgentWire {
	return {
		built_in: false,
		composio_actions: ["GMAIL_SEND"],
		description: "Answers from approved notes only.",
		engine: null,
		id: AGENT_ID,
		identity_profile_ids: [],
		lifecycle_status: "active",
		locked: false,
		memory: { read_levels: [], space_ids: [], write_enabled: true },
		name: "Notes Agent",
		orchestrator: null,
		safety_profile: "autonomous",
		skills: ["summarize"],
		system_prompt: "Cite the note you used.",
		title: "Notes",
		tools: ["__ryu_none__"],
		version: "1.0.0",
	};
}

let agent = seedAgent();
let tools: { description: string; id: string; name: string; server: string }[] =
	[];
let refuse = new Set<string>();
const exchanges: Exchange[] = [];
const unexpected: string[] = [];

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const path = url.pathname;
		const raw = request.method === "PUT" ? await request.text() : "";
		const call: Exchange = {
			body: raw ? JSON.parse(raw) : null,
			method: request.method,
			path,
			status: 200,
		};
		exchanges.push(call);
		if (
			request.headers.get("authorization") !== `Bearer ${NODE_TOKEN}` ||
			request.headers.get("x-ryu-user-jwt") !== USER_JWT
		) {
			unexpected.push(`${request.method} ${path} without node credentials`);
			call.status = 401;
			return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		if (refuse.has(`${request.method} ${path}`)) {
			call.status = 503;
			return NativeResponse.json({ error: "unavailable" }, { status: 503 });
		}
		if (path === `/api/agents/${AGENT_ID}`) {
			if (request.method === "GET") {
				return NativeResponse.json({ agent });
			}
			if (request.method === "PUT") {
				const body = call.body as Partial<AgentWire> | null;
				if (!(body && Array.isArray(body.tools))) {
					unexpected.push(`Malformed agent write ${raw}`);
					call.status = 422;
					return NativeResponse.json({ error: "bad body" }, { status: 422 });
				}
				agent = {
					...agent,
					...(body.memory ? { memory: body.memory } : {}),
					tools: body.tools,
				};
				return NativeResponse.json({ agent });
			}
		}
		if (path === "/api/spaces" && request.method === "GET") {
			return NativeResponse.json({
				spaces: [
					{
						created_at: 1_790_000_000_000,
						document_count: 3,
						id: "space-docs",
						name: "Project Docs",
						retrieval_mode: "vector",
						system: false,
						updated_at: 1_790_000_000_000,
						visibility: "owner",
					},
				],
			});
		}
		if (path === "/api/mcp/tools" && request.method === "GET") {
			return NativeResponse.json({ tools });
		}
		unexpected.push(`Undeclared ${request.method} ${path}`);
		call.status = 404;
		return NativeResponse.json({ error: "undeclared" }, { status: 404 });
	},
});

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
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { AgentAccessPanel } = await import("./AgentAccessPanel.tsx");

const target = {
	token: NODE_TOKEN,
	url: server.url.origin,
	userJwt: USER_JWT,
};
let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(async () => {
	agent = seedAgent();
	tools = [];
	refuse = new Set();
	exchanges.length = 0;
	unexpected.length = 0;
	localStorage.clear();
	localStorage.setItem("agent-access-coverage-unrelated", "kept");
	await act(async () => {
		sileo.clear();
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await unmount();
	await act(async () => {
		sileo.clear();
	});
	container.remove();
	document.body.replaceChildren();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem("agent-access-coverage-unrelated")).toBe("kept");
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects unauthenticated, undeclared or off-fixture requests.
	expect(unexpected).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

async function mount(expectPanel = true) {
	const before = exchanges.length;
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<>
				<AgentAccessPanel agentId={AGENT_ID} target={target} />
				<Toaster position="bottom-right" />
			</>
		)
	);
	await settle(
		() =>
			exchanges.slice(before).filter((call) => call.method === "GET").length ===
				3 && !container.textContent?.includes("Loading…"),
		"agent access reads"
	);
	if (expectPanel) {
		await settle(
			() => container.textContent?.includes("Notes Agent") === true,
			"agent access panel"
		);
	}
}

async function unmount() {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
	}
	root = null;
}

/**
 * The visible Base UI checkbox for a labelled control. Base UI puts the `id`
 * the `<Label htmlFor>` points at on its hidden form input and renders the
 * focusable `role="checkbox"` element right before it.
 */
function checkboxFor(id: string): HTMLElement {
	const visible = container.querySelector(`#${id}`)?.previousElementSibling;
	if (
		!(
			visible instanceof HTMLElement &&
			visible.getAttribute("role") === "checkbox"
		)
	) {
		throw new Error(`Missing checkbox for ${id}`);
	}
	return visible;
}

function spaceCheckbox(): HTMLElement {
	return checkboxFor("dictation-access-space-space-docs");
}

function groupSwitches() {
	return [...container.querySelectorAll<HTMLElement>('[role="switch"]')].map(
		(control) => control.getAttribute("aria-label")
	);
}

function agentWrites() {
	return exchanges
		.filter((call) => call.method === "PUT")
		.map((call) => ({ body: call.body, status: call.status }));
}

test("with no registered MCP tools the App tools row explains how to grant them, offers no group switch, and Space edits still save without touching the tool allowlist", async () => {
	await mount();
	expect(maybeRow("App tools", container)).not.toBeNull();
	expect(pageText()).toContain(NO_TOOLS_COPY);
	expect(groupSwitches()).toEqual([]);
	expect(isOn(spaceCheckbox())).toBe(false);

	await click(spaceCheckbox());
	await settle(() => agentWrites().length === 1, "space write");
	await settle(() => isOn(spaceCheckbox()), "space checked");
	const [write] = agentWrites();
	expect(write?.status).toBe(200);
	expect(write?.body).toMatchObject({
		composio_actions: ["GMAIL_SEND"],
		description: "Answers from approved notes only.",
		memory: { read_levels: [], space_ids: ["space-docs"], write_enabled: true },
		name: "Notes Agent",
		skills: ["summarize"],
		system_prompt: "Cite the note you used.",
		tools: ["__ryu_none__"],
	});
	expect(agent.tools).toEqual(["__ryu_none__"]);
	expect(agent.memory.space_ids).toEqual(["space-docs"]);

	await unmount();
	await mount();
	expect(isOn(spaceCheckbox())).toBe(true);
	expect(maybeRow("App tools", container)).not.toBeNull();

	// Once an app registers tools, the explanation gives way to that app's
	// switch, still off because the agent's allowlist grants nothing.
	tools = [
		{
			description: "Read a Space document.",
			id: "spaces.read",
			name: "read",
			server: "spaces",
		},
	];
	await unmount();
	await mount();
	expect(maybeRow("App tools", container)).toBeNull();
	expect(pageText()).not.toContain(NO_TOOLS_COPY);
	expect(groupSwitches()).toEqual(["Allow Spaces (docs & pages)"]);
	const allow = maybeByLabel("Allow Spaces (docs & pages)", container);
	expect(allow && isOn(allow)).toBe(false);
	expect(pageText()).toContain("1 tool from this app");
	expect(agentWrites()).toHaveLength(1);
});

test("a refused MCP tools read degrades to the App tools explanation and a refused Spaces read to its empty state, while memory levels stay editable", async () => {
	tools = [
		{
			description: "Open a page.",
			id: "browser.open",
			name: "open",
			server: "browser",
		},
	];
	refuse = new Set(["GET /api/mcp/tools", "GET /api/spaces"]);
	await mount();
	expect(
		exchanges
			.filter((call) => call.method === "GET")
			.map((call) => [call.path, call.status])
	).toEqual([
		[`/api/agents/${AGENT_ID}`, 200],
		["/api/spaces", 503],
		["/api/mcp/tools", 503],
	]);
	expect(maybeRow("App tools", container)).not.toBeNull();
	expect(pageText()).toContain(NO_TOOLS_COPY);
	expect(groupSwitches()).toEqual([]);
	expect(pageText()).toContain(
		"No Spaces yet. Create one on the Spaces page to grant access."
	);
	expect(pageText()).not.toContain("Couldn't load agent access");

	const orgLevel = () => checkboxFor("agent-access-memory-level-org");
	expect(isOn(orgLevel())).toBe(false);
	expect(isOn(checkboxFor("agent-access-memory-level-agent"))).toBe(true);
	await click(orgLevel());
	await settle(() => agentWrites().length === 1, "memory level write");
	expect(agentWrites()[0]?.body).toMatchObject({
		memory: {
			read_levels: ["agent", "user", "node", "project", "org"],
			space_ids: [],
			write_enabled: true,
		},
		tools: ["__ryu_none__"],
	});
	await settle(() => isOn(orgLevel()), "org level checked");
});

test("a refused agent read shows the load error and no App tools row or controls", async () => {
	refuse = new Set([`GET /api/agents/${AGENT_ID}`]);
	await mount(false);
	await settle(
		() => pageText().includes("Couldn't load agent access"),
		"agent load error"
	);
	expect(maybeRow("App tools", container)).toBeNull();
	expect(container.querySelector('[role="checkbox"]')).toBeNull();
	expect(container.textContent).not.toContain("Agent access");
	expect(container.textContent).not.toContain("Memory levels");
	expect(agentWrites()).toEqual([]);
});

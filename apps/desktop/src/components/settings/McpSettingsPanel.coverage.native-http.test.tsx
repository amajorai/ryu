// biome-ignore-all lint/suspicious/noMisplacedAssertion: the shared teardown asserts every case left no undeclared Core request.
// McpSettingsPanel against a loopback Core peer that speaks the real
// `/api/agents`, `/api/mcp/tools` and `/api/mcp/tools/call` contracts. The
// panel's agent picker, settings form, action buttons, validation and plugin
// UI dialog are the shipping component; only the peer is a fixture.
import {
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	button,
	type CorePeer,
	click,
	fill,
	flush,
	installAnimationApis,
	isDisabled,
	openDialogs,
	type PeerCall,
	press,
	registerDomWithNativeNetworking,
	selectNative,
	startCorePeer,
	text,
	until,
} from "./models-plugins-settings.test-support.ts";

registerDomWithNativeNetworking();
installAnimationApis();
setDefaultTimeout(30_000);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { McpSettingsPanel } = await import("./McpSettingsPanel.tsx");

const TOKEN = "mcp-settings-token";
const PLUGIN = "@fixture/parts";
const SERVER = "parts";

type Values = Record<string, string | number | boolean>;

interface PluginState {
	/** Next replies for action tools, by tool id. */
	actionReplies: Record<string, unknown>;
	/** Tools each agent may reach, as Core lists them. */
	tools: Record<
		string,
		{ id: string; meta?: unknown; name: string; server: string }[]
	>;
	/** Per-agent settings the plugin holds. */
	values: Record<string, Values>;
}

const schema = {
	type: "object",
	properties: {
		units: { type: "string", title: "Measurement units", enum: ["mm", "in"] },
		lineWidth: {
			type: "integer",
			title: "Line width",
			minimum: 1,
			maximum: 10,
		},
	},
};

let plugin: PluginState;
let peer: CorePeer;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;

function readOutput(agent: string) {
	return {
		content: [],
		structuredContent: {
			schema,
			values: plugin.values[agent],
			layout: [
				{
					kind: "group",
					title: "Drawing",
					items: [
						{ kind: "property", property: "units" },
						{ kind: "property", property: "lineWidth" },
						{
							kind: "tool",
							tool: "settings.verify",
							title: "Verify settings",
							description: "Checks the saved drawing settings.",
						},
						{ kind: "tool", tool: "settings.rebuild", title: "Rebuild index" },
						{ kind: "tool", tool: "settings.designer", title: "Open designer" },
					],
				},
			],
		},
	};
}

function route(call: PeerCall) {
	if (call.authorization !== `Bearer ${TOKEN}`) {
		return { status: 401, body: { error: "unauthorized" } };
	}
	if (call.method === "GET" && call.path === "/api/agents") {
		return {
			body: {
				agents: [
					{ id: "agent-a", name: "Agent A", enabled: true },
					{ id: "agent-b", name: "Agent B", enabled: true },
				],
			},
		};
	}
	if (call.method === "GET" && call.path === "/api/mcp/tools") {
		const agent = new URLSearchParams(call.search).get("agent") ?? "";
		return { body: { tools: plugin.tools[agent] ?? [] } };
	}
	if (call.method === "POST" && call.path === "/api/mcp/tools/call") {
		const input = call.body as {
			agent_id: string;
			arguments: { set?: Values };
			tool: string;
		};
		if (!plugin.values[input.agent_id]) {
			return { status: 403, body: { ok: false, error: "Unknown agent" } };
		}
		if (input.tool === `${SERVER}.settings.read`) {
			return { body: { ok: true, output: readOutput(input.agent_id) } };
		}
		if (input.tool === `${SERVER}.settings.update`) {
			Object.assign(plugin.values[input.agent_id], input.arguments.set ?? {});
			return {
				body: {
					ok: true,
					output: {
						content: [],
						structuredContent: { values: plugin.values[input.agent_id] },
					},
				},
			};
		}
		if (Object.hasOwn(plugin.actionReplies, input.tool)) {
			return { body: { ok: true, output: plugin.actionReplies[input.tool] } };
		}
		return { status: 404, body: { ok: false, error: "Unknown tool" } };
	}
	return;
}

function toolCalls(): { agent: string; arguments: unknown; tool: string }[] {
	return peer.calls
		.filter((call) => call.path === "/api/mcp/tools/call")
		.map((call) => {
			const body = call.body as {
				agent_id: string;
				arguments: unknown;
				tool: string;
			};
			return {
				tool: body.tool,
				agent: body.agent_id,
				arguments: body.arguments,
			};
		});
}

function agentSelect(): HTMLSelectElement {
	const select = container.querySelector<HTMLSelectElement>(
		`select[id="mcp-settings-agent-${PLUGIN}"]`
	);
	if (!select) {
		throw new Error(`Missing agent select: ${text()}`);
	}
	return select;
}

function lineWidth(): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>(
		`input[id="settings-${PLUGIN}-lineWidth"]`
	);
	if (!input) {
		throw new Error(`Missing Line width: ${text()}`);
	}
	return input;
}

function alertText(): string {
	return [...container.querySelectorAll('[role="alert"]')]
		.map((alert) => alert.textContent ?? "")
		.join(" | ");
}

async function mount() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={queryClient}>
				<McpSettingsPanel
					plugin={PLUGIN}
					settings={{
						serverId: SERVER,
						readTool: `${SERVER}.settings.read`,
						updateTool: `${SERVER}.settings.update`,
					}}
					target={{ url: peer.url, token: TOKEN }}
				/>
			</QueryClientProvider>
		)
	);
	await until(() => !isDisabled(agentSelect()), "agents loaded");
}

async function chooseAgent(agent: string) {
	await selectNative(agentSelect(), agent);
	await until(
		() =>
			container.querySelector(`input[id="settings-${PLUGIN}-lineWidth"]`) !==
			null,
		`settings for ${agent}`
	);
}

beforeEach(() => {
	plugin = {
		values: {
			"agent-a": { units: "mm", lineWidth: 2 },
			"agent-b": { units: "in", lineWidth: 7 },
		},
		tools: {
			"agent-a": [
				{
					id: `${SERVER}.settings.verify`,
					name: "settings.verify",
					server: SERVER,
				},
				// Same tool name on another server: never a match for this plugin.
				{
					id: "other.settings.rebuild",
					name: "settings.rebuild",
					server: "other",
				},
				{
					id: `${SERVER}.settings.designer`,
					name: "settings.designer",
					server: SERVER,
					meta: { ui: { resourceUri: "ui://parts/designer" } },
				},
			],
			"agent-b": [
				{
					id: `${SERVER}.settings.verify`,
					name: "settings.verify",
					server: SERVER,
				},
			],
		},
		actionReplies: {
			[`${SERVER}.settings.verify`]: {
				content: [{ type: "text", text: "Drawing settings verified." }],
			},
		},
	};
	peer = startCorePeer(route);
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container.remove();
	document.body.replaceChildren();
	peer.stop();
	expect(peer.unexpected).toEqual([]);
});

test("an action runs the plugin's own server tool for the selected agent and shows its result; a same-named tool on another server is reported unavailable and never called", async () => {
	await mount();
	await chooseAgent("agent-a");
	expect(text()).toContain("Checks the saved drawing settings.");

	await click(button("Verify settings"));
	await until(
		() => text().includes("Drawing settings verified."),
		"plugin's action output"
	);
	await click(button("Rebuild index"));
	await until(
		() =>
			alertText().includes(
				"This settings action is unavailable to the selected agent"
			),
		"unavailable action refusal"
	);
	// The earlier action's output does not linger next to the refusal.
	expect(text()).not.toContain("Drawing settings verified.");
	expect(toolCalls()).toEqual([
		{ tool: `${SERVER}.settings.read`, agent: "agent-a", arguments: {} },
		{ tool: `${SERVER}.settings.verify`, agent: "agent-a", arguments: {} },
	]);
	expect(
		peer.calls
			.filter((call) => call.path === "/api/mcp/tools")
			.map((call) => call.search)
	).toEqual(["?agent=agent-a", "?agent=agent-a"]);
});

test("a plugin-reported action failure is shown as an error, never as a completed action", async () => {
	plugin.actionReplies[`${SERVER}.settings.verify`] = {
		isError: true,
		content: [{ type: "text", text: "Index is locked by another job." }],
	};
	await mount();
	await chooseAgent("agent-a");
	await click(button("Verify settings"));
	await until(
		() => alertText().includes("Index is locked by another job."),
		"plugin failure text"
	);
	expect(text()).not.toContain("Action completed");
	expect(isDisabled(button("Verify settings"))).toBe(false);
});

test("an action that ships its own interface opens it in a dialog instead of calling the tool, and Escape returns to the form", async () => {
	await mount();
	await chooseAgent("agent-a");
	await click(button("Open designer"));
	await until(() => openDialogs().length === 1, "plugin interface dialog");
	const dialog = openDialogs()[0];
	expect(dialog.textContent).toContain("Open designer");
	expect(dialog.textContent).toContain(
		"Configure this plugin using its own interface."
	);
	expect(toolCalls().map((call) => call.tool)).toEqual([
		`${SERVER}.settings.read`,
	]);
	await press("Escape", dialog);
	await until(() => openDialogs().length === 0, "dialog dismissed");
	expect(isDisabled(button("Save settings"))).toBe(true);
	expect(lineWidth().value).toBe("2");
});

test("an out-of-range value is blocked by the schema's bounds before any update reaches the plugin; a valid edit saves only the change and reads it back", async () => {
	await mount();
	await chooseAgent("agent-a");
	await fill(lineWidth(), "42");
	// The schema's bounds reach the input, so the form's own constraint
	// validation stops the submit before the panel calls the plugin.
	expect(lineWidth().max).toBe("10");
	expect(lineWidth().validity.rangeOverflow).toBe(true);
	expect(lineWidth().form?.checkValidity()).toBe(false);
	await click(button("Save settings"));
	await flush();
	expect(text()).not.toContain("Settings saved");
	expect(toolCalls().map((call) => call.tool)).toEqual([
		`${SERVER}.settings.read`,
	]);
	expect(plugin.values["agent-a"].lineWidth).toBe(2);

	await fill(lineWidth(), "9");
	await click(button("Save settings"));
	await until(() => text().includes("Settings saved"), "confirmed save");
	expect(plugin.values["agent-a"]).toEqual({ units: "mm", lineWidth: 9 });
	expect(toolCalls().slice(1)).toEqual([
		{
			tool: `${SERVER}.settings.update`,
			agent: "agent-a",
			arguments: { set: { lineWidth: 9 } },
		},
		{ tool: `${SERVER}.settings.read`, agent: "agent-a", arguments: {} },
	]);
	expect(plugin.values["agent-b"]).toEqual({ units: "in", lineWidth: 7 });
});

test("switching the agent re-reads that agent's settings and never sends the previous agent's unsaved edit", async () => {
	await mount();
	await chooseAgent("agent-a");
	await fill(lineWidth(), "5");
	expect(isDisabled(button("Save settings"))).toBe(false);

	await chooseAgent("agent-b");
	await until(() => lineWidth().value === "7", "agent B's saved width");
	expect(isDisabled(button("Save settings"))).toBe(true);
	await fill(lineWidth(), "8");
	await click(button("Save settings"));
	await until(() => text().includes("Settings saved"), "agent B save");
	await flush();
	expect(plugin.values).toEqual({
		"agent-a": { units: "mm", lineWidth: 2 },
		"agent-b": { units: "in", lineWidth: 8 },
	});
	expect(
		toolCalls().filter((call) => call.tool === `${SERVER}.settings.update`)
	).toEqual([
		{
			tool: `${SERVER}.settings.update`,
			agent: "agent-b",
			arguments: { set: { lineWidth: 8 } },
		},
	]);
});

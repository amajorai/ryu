/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import {
	type FixtureRecord,
	fixtureRecordSchema,
	parseFixtureJson,
} from "../proof/cli-fixture-contract.ts";
import { testRender } from "./cli-test-render.ts";

const TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | null = null;

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let isolatedHome: string | null = null;
beforeEach(() => {
	isolatedHome = mkdtempSync(join(tmpdir(), "ryu-cli-interactions-"));
	process.env.HOME = isolatedHome;
	delete process.env.USERPROFILE;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath(isolatedHome)
	);
});
afterEach(async () => {
	globalThis.fetch = realFetch;
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalUserProfile;
	}
	if (isolatedHome) {
		rmSync(isolatedHome, { recursive: true, force: true });
	}
	isolatedHome = null;
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
});

interface KeyInput {
	ctrl?: boolean;
	name: string;
	shift?: boolean;
}

async function press(render: Setup, key: KeyInput): Promise<void> {
	const keyInput = render.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name: key.name,
				sequence: key.name.length === 1 ? key.name : "",
				ctrl: key.ctrl ?? false,
				shift: key.shift ?? false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: key.name.length === 1 ? key.name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await render.renderOnce();
	});
}

async function waitForFrame(
	render: Setup,
	predicate: (frame: string) => boolean,
	maxPasses = 40
): Promise<string> {
	let frame = render.captureCharFrame();
	for (let pass = 0; pass < maxPasses && !predicate(frame); pass += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await render.renderOnce();
			frame = render.captureCharFrame();
		});
	}
	if (!predicate(frame)) {
		throw new Error(`Agents screen did not reach expected state:\n${frame}`);
	}
	return frame;
}

async function typeFocused(render: Setup, value: string): Promise<void> {
	await act(async () => {
		await render.mockInput.typeText(value);
	});
	await render.flush({ maxPasses: 12 });
}

async function openAgents(render: Setup): Promise<void> {
	await press(render, { name: "k", ctrl: true });
	for (const character of "agents") {
		await press(render, { name: character });
	}
	await press(render, { name: "return" });
	await waitForFrame(render, (frame) => frame.includes("configured"));
}

// A new agent opens on "How should this agent work?" with "Acts as you"
// preselected; Enter continues to the details form.
async function continueIdentityStep(render: Setup): Promise<void> {
	await waitForFrame(render, (frame) =>
		frame.includes("How should this agent work?")
	);
	await press(render, { name: "return" });
}

const agentPersonaSchema = z.object({
	display_name: z.string().nullable(),
	output_style_id: z.string().nullable(),
	tone: z.string().nullable(),
	emoji: z.string(),
});
const agentInferenceSchema = z
	.object({ temperature: z.number() })
	.catchall(z.json());
function agentFixture() {
	return {
		id: "agent-1",
		name: "Existing Agent",
		title: "",
		description: "Existing description",
		system_prompt: "Existing instructions",
		engine: "acp:claude",
		model: "original-model",
		tools: ["mcp.read"],
		skills: ["skill.search"],
		composio_actions: ["GOOGLE_DRIVE_LIST_FILES"],
		inference: { temperature: 0.25 },
		orchestrator: z.boolean().nullable().parse(null),
		can_create_agents: z.boolean().nullable().parse(null),
		persona: agentPersonaSchema.parse({
			display_name: null,
			output_style_id: "style-core",
			tone: null,
			emoji: "🤖",
		}),
		version: "1.2.3",
	};
}

test("Agent editor saves Desktop-shared fields, preserves advanced settings, retries, and reloads", async () => {
	let storedAgent = agentFixture();
	let failFirstWrite = true;
	let failFirstToolsRead = true;
	let failFirstSkillsRead = true;
	const writes: Array<{ body: FixtureRecord; method: string }> = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname === "/api/mcp/tools") {
				if (failFirstToolsRead) {
					failFirstToolsRead = false;
					return Response.json(
						{ error: "temporary tools read failure" },
						{ status: 503 }
					);
				}
				return Response.json({
					tools: [
						{
							id: "mcp.read",
							name: "read",
							server: "mcp",
							description: "Read data",
						},
						{
							id: "files.write",
							name: "write",
							server: "files",
							description: "Write data",
						},
					],
				});
			}
			if (url.pathname === "/api/skills") {
				if (failFirstSkillsRead) {
					failFirstSkillsRead = false;
					return Response.json(
						{ error: "temporary skills read failure" },
						{ status: 503 }
					);
				}
				return Response.json({
					skills: [
						{ id: "skill.search", name: "Search", enabled: true },
						{ id: "skill.format", name: "Format", enabled: true },
						{ id: "skill.disabled", name: "Disabled", enabled: false },
					],
				});
			}
			if (url.pathname === "/api/agents") {
				if (method === "POST") {
					return Response.json({ agent: storedAgent }, { status: 201 });
				}
				return Response.json({
					agents: [
						{
							id: storedAgent.id,
							name: storedAgent.name,
							title: storedAgent.title,
							model: storedAgent.model,
							engine: storedAgent.engine,
							version: storedAgent.version,
						},
					],
				});
			}
			if (url.pathname === "/api/agents/agent-1" && method === "PUT") {
				const body = fixtureRecordSchema.parse(
					parseFixtureJson(String(init?.body))
				);
				writes.push({ body, method });
				if (failFirstWrite) {
					failFirstWrite = false;
					return Response.json(
						{ error: "temporary write failure" },
						{ status: 503 }
					);
				}
				storedAgent = {
					...storedAgent,
					name: String(body.name),
					title: String(body.title),
					engine: String(body.engine),
					model: String(body.model),
					tools: z.array(z.string()).parse(body.tools),
					skills: z.array(z.string()).parse(body.skills),
					persona: agentPersonaSchema.parse(body.persona),
					orchestrator: z.boolean().nullable().parse(body.orchestrator),
					can_create_agents: z
						.boolean()
						.nullable()
						.parse(body.can_create_agents),
					inference: agentInferenceSchema.parse(body.inference),
					version: String(body.version),
				};
				return Response.json({ agent: storedAgent });
			}
			if (url.pathname === "/api/agents/agent-1") {
				return Response.json({ agent: storedAgent });
			}
			return Response.json({});
		},
		realFetch
	);

	setup = await testRender(<App target={TARGET} />, {
		width: 80,
		height: 24,
	});
	await act(async () => {
		await setup?.renderOnce();
	});
	await openAgents(setup);
	await press(setup, { name: "e" });
	await waitForFrame(
		setup,
		(frame) =>
			frame.includes("persona tone") && frame.includes("Existing Agent")
	);

	// Name is unchanged; title, model, and persona use the same Core record that
	// Desktop edits. Existing engine, instructions, tools, skills, and grants must
	// survive this focused update.
	await press(setup, { name: "tab" });
	await typeFocused(setup, "Support lead");
	await press(setup, { name: "tab" }); // engine (keep the existing binding)
	await press(setup, { name: "tab" }); // model
	for (let i = 0; i < "original-model".length; i += 1) {
		await press(setup, { name: "backspace" });
	}
	await typeFocused(setup, "gpt-regression");
	await press(setup, { name: "tab" }); // description
	await press(setup, { name: "tab" }); // system prompt
	await press(setup, { name: "tab" }); // persona display name
	await typeFocused(setup, "Ryu Helper");
	await press(setup, { name: "tab" }); // persona tone
	await typeFocused(setup, "friendly");
	await press(setup, { name: "tab" }); // delegation defaults on
	await press(setup, { name: "return" });
	await press(setup, { name: "tab" }); // creation defaults off
	await press(setup, { name: "return" });
	await press(setup, { name: "tab" }); // tools allowlist
	await press(setup, { name: "return" });
	const toolsFailed = await waitForFrame(setup, (frame) =>
		frame.includes("503")
	);
	expect(toolsFailed).toContain("r retry");
	await press(setup, { name: "r" });
	const toolsLoaded = await waitForFrame(
		setup,
		(frame) => frame.includes("read · mcp") && frame.includes("write · files")
	);
	expect(toolsLoaded).toContain("[x] read · mcp");
	expect(toolsLoaded).toContain("[ ] write · files");
	await press(setup, { name: "space" }); // remove the saved read grant
	await press(setup, { name: "down" });
	await press(setup, { name: "space" }); // add the write grant
	await press(setup, { name: "escape" });
	await press(setup, { name: "tab" }); // skills allowlist
	await press(setup, { name: "return" });
	const skillsFailed = await waitForFrame(setup, (frame) =>
		frame.includes("503")
	);
	expect(skillsFailed).toContain("r retry");
	await press(setup, { name: "r" });
	const skillsLoaded = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Search · enabled") && frame.includes("Format · enabled")
	);
	expect(skillsLoaded).toContain("[x] Search · enabled");
	expect(skillsLoaded).toContain("[ ] Format · enabled");
	await press(setup, { name: "space" }); // remove the saved skill
	await press(setup, { name: "down" });
	await press(setup, { name: "space" }); // add another enabled skill
	await press(setup, { name: "escape" });
	await press(setup, { name: "s", ctrl: true });

	const failed = await waitForFrame(setup, (frame) => frame.includes("503"));
	expect(failed).toContain("503");
	expect(failed).toContain("create agents");
	expect(writes).toHaveLength(1);
	await press(setup, { name: "s", ctrl: true });
	await waitForFrame(setup, (frame) => frame.includes("Enter detail"));
	expect(writes).toHaveLength(2);
	expect(writes[0]).toEqual(writes[1]);
	expect(writes[1]).toEqual({
		body: {
			name: "Existing Agent",
			title: "Support lead",
			description: "Existing description",
			system_prompt: "Existing instructions",
			engine: "acp:claude",
			model: "gpt-regression",
			tools: ["files.write"],
			composio_actions: ["GOOGLE_DRIVE_LIST_FILES"],
			skills: ["skill.format"],
			persona: {
				display_name: "Ryu Helper",
				output_style_id: "style-core",
				tone: "friendly",
				emoji: "🤖",
			},
			orchestrator: false,
			can_create_agents: true,
			inference: { temperature: 0.25 },
			version: "1.2.4",
		},
		method: "PUT",
	});

	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = await testRender(<App target={TARGET} />, {
		width: 80,
		height: 24,
	});
	await act(async () => {
		await setup?.renderOnce();
	});
	await openAgents(setup);
	await press(setup, { name: "e" });
	const persisted = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Support lead") &&
			frame.includes("gpt-regression") &&
			frame.includes("Ryu Helper") &&
			frame.includes("friendly")
	);
	expect(persisted).toContain("● Off");
	expect(persisted).toContain("● On");
	for (let field = 0; field < 10; field += 1) {
		await press(setup, { name: "tab" });
	}
	await press(setup, { name: "return" });
	const persistedTools = await waitForFrame(
		setup,
		(frame) => frame.includes("read · mcp") && frame.includes("write · files")
	);
	expect(persistedTools).toContain("[ ] read · mcp");
	expect(persistedTools).toContain("[x] write · files");
	await press(setup, { name: "escape" });
	await press(setup, { name: "tab" });
	await press(setup, { name: "return" });
	const persistedSkills = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Search · enabled") && frame.includes("Format · enabled")
	);
	expect(persistedSkills).toContain("[ ] Search · enabled");
	expect(persistedSkills).toContain("[x] Format · enabled");
	expect(writes).toHaveLength(2);
});

test("new agent tool and skill pickers save explicit safe selections", async () => {
	const createdBodies: FixtureRecord[] = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname === "/api/agents" && method === "GET") {
				return Response.json({ agents: [] });
			}
			if (url.pathname === "/api/mcp/tools") {
				return Response.json({
					tools: [
						{
							id: "mcp.read",
							name: "read",
							server: "mcp",
							description: "Read data",
						},
						{
							id: "files.write",
							name: "write",
							server: "files",
							description: "Write data",
						},
					],
				});
			}
			if (url.pathname === "/api/skills") {
				return Response.json({
					skills: [
						{ id: "skill.search", name: "Search", enabled: true },
						{ id: "skill.format", name: "Format", enabled: true },
					],
				});
			}
			if (url.pathname === "/api/agents" && method === "POST") {
				const body = fixtureRecordSchema.parse(
					parseFixtureJson(String(init?.body))
				);
				createdBodies.push(body);
				return Response.json(
					{ agent: { ...agentFixture(), ...body } },
					{ status: 201 }
				);
			}
			return Response.json({});
		},
		realFetch
	);

	setup = await testRender(<App target={TARGET} />, {
		width: 80,
		height: 24,
	});
	await act(async () => {
		await setup?.renderOnce();
	});
	await openAgents(setup);
	await press(setup, { name: "n" });
	await continueIdentityStep(setup);
	await waitForFrame(setup, (frame) => frame.includes("Agent name"));
	await typeFocused(setup, "CLI Agent");
	for (let field = 0; field < 10; field += 1) {
		await press(setup, { name: "tab" });
	}
	await press(setup, { name: "return" }); // tools
	const tools = await waitForFrame(setup, (frame) =>
		frame.includes("read · mcp")
	);
	expect(tools).toContain("[ ] read · mcp");
	await press(setup, { name: "return" });
	await press(setup, { name: "escape" });
	await press(setup, { name: "tab" }); // skills
	await press(setup, { name: "return" });
	const skills = await waitForFrame(setup, (frame) =>
		frame.includes("Search · enabled")
	);
	expect(skills).toContain("[x] Search · enabled");
	await press(setup, { name: "space" });
	await press(setup, { name: "escape" });
	await press(setup, { name: "s", ctrl: true });
	await waitForFrame(setup, (frame) => frame.includes("Enter detail"));
	expect(createdBodies).toHaveLength(1);
	expect(createdBodies[0]).toMatchObject({
		name: "CLI Agent",
		tools: ["mcp.read"],
		skills: ["skill.format"],
	});
});

test("agent editor preserves no-access sentinels and legacy all-access values", async () => {
	const storedAgents = [
		{
			...agentFixture(),
			id: "none-agent",
			name: "No access",
			tools: ["__ryu_none__"],
			skills: ["__ryu_none__"],
		},
		{
			...agentFixture(),
			id: "empty-agent",
			name: "Legacy empty",
			tools: [],
			skills: [],
		},
		{
			...agentFixture(),
			id: "wildcard-agent",
			name: "Wildcard tools",
			tools: ["*"],
			skills: [],
		},
	];
	const writes: { body: FixtureRecord; id: string }[] = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname === "/api/mcp/tools") {
				return Response.json({
					tools: [
						{
							id: "mcp.read",
							name: "read",
							server: "mcp",
							description: "Read data",
						},
						{
							id: "files.write",
							name: "write",
							server: "files",
							description: "Write data",
						},
					],
				});
			}
			if (url.pathname === "/api/skills") {
				return Response.json({
					skills: [
						{ id: "skill.search", name: "Search", enabled: true },
						{ id: "skill.format", name: "Format", enabled: true },
					],
				});
			}
			if (url.pathname === "/api/agents" && method === "GET") {
				return Response.json({
					agents: storedAgents.map(
						({ id, name, title, model, engine, version }) => ({
							id,
							name,
							title,
							model,
							engine,
							version,
						})
					),
				});
			}
			const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(url.pathname);
			if (agentMatch) {
				const record = storedAgents.find((agent) => agent.id === agentMatch[1]);
				if (record && method === "PUT") {
					const body = fixtureRecordSchema.parse(
						parseFixtureJson(String(init?.body))
					);
					writes.push({ body, id: record.id });
					record.tools = z.array(z.string()).parse(body.tools);
					record.skills = z.array(z.string()).parse(body.skills);
				}
				return Response.json({ agent: record });
			}
			return Response.json({});
		},
		realFetch
	);

	setup = await testRender(<App target={TARGET} />, {
		width: 80,
		height: 24,
	});
	await act(async () => {
		await setup?.renderOnce();
	});
	await openAgents(setup);
	await press(setup, { name: "e" });
	for (let field = 0; field < 10; field += 1) {
		await press(setup, { name: "tab" });
	}
	await press(setup, { name: "return" });
	const noTools = await waitForFrame(setup, (frame) =>
		frame.includes("read · mcp")
	);
	expect(noTools).toContain("[ ] read · mcp");
	await press(setup, { name: "escape" });
	await press(setup, { name: "tab" });
	await press(setup, { name: "return" });
	const noSkills = await waitForFrame(setup, (frame) =>
		frame.includes("Search · enabled")
	);
	expect(noSkills).toContain("[ ] Search · enabled");
	await press(setup, { name: "escape" });
	await press(setup, { name: "s", ctrl: true });
	await waitForFrame(setup, (frame) => frame.includes("n new"));

	await press(setup, { name: "down" });
	await press(setup, { name: "e" });
	for (let field = 0; field < 10; field += 1) {
		await press(setup, { name: "tab" });
	}
	await press(setup, { name: "return" });
	const emptyTools = await waitForFrame(
		setup,
		(frame) => frame.includes("read · mcp") && frame.includes("write · files")
	);
	expect(emptyTools).toContain("[x] read · mcp");
	expect(emptyTools).toContain("[x] write · files");
	await press(setup, { name: "escape" });
	await press(setup, { name: "tab" });
	await press(setup, { name: "return" });
	const emptySkills = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("Search · enabled") && frame.includes("Format · enabled")
	);
	expect(emptySkills).toContain("[x] Search · enabled");
	expect(emptySkills).toContain("[x] Format · enabled");
	await press(setup, { name: "escape" });
	await press(setup, { name: "s", ctrl: true });
	await waitForFrame(setup, (frame) => frame.includes("n new"));

	await press(setup, { name: "down" });
	await press(setup, { name: "down" });
	await press(setup, { name: "e" });
	for (let field = 0; field < 10; field += 1) {
		await press(setup, { name: "tab" });
	}
	await press(setup, { name: "return" });
	const wildcardTools = await waitForFrame(
		setup,
		(frame) => frame.includes("read · mcp") && frame.includes("write · files")
	);
	expect(wildcardTools).toContain("[x] read · mcp");
	expect(wildcardTools).toContain("[x] write · files");
	await press(setup, { name: "escape" });
	await press(setup, { name: "s", ctrl: true });
	await waitForFrame(setup, (frame) => frame.includes("n new"));

	expect(writes).toHaveLength(3);
	expect(
		writes.map((write) => ({
			id: write.id,
			tools: write.body.tools,
			skills: write.body.skills,
		}))
	).toEqual([
		{
			id: "none-agent",
			tools: ["__ryu_none__"],
			skills: ["__ryu_none__"],
		},
		{ id: "empty-agent", tools: [], skills: [] },
		{ id: "wildcard-agent", tools: ["*"], skills: [] },
	]);
});

test("Agent editor authors per-agent sampling through Core, validates fields, retries, and reloads saved values", async () => {
	let storedAgent = {
		...agentFixture(),
		inference: agentInferenceSchema.parse({
			temperature: 0.25,
			extra: { vendor_flag: true },
		}),
	};
	let failFirstWrite = true;
	const writes: FixtureRecord[] = [];
	let recordReads = 0;
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname === "/api/agents" && method === "GET") {
				return Response.json({
					agents: [
						{
							id: storedAgent.id,
							name: storedAgent.name,
							title: storedAgent.title,
							model: storedAgent.model,
							engine: storedAgent.engine,
							version: storedAgent.version,
						},
					],
				});
			}
			if (url.pathname === "/api/agents/agent-1" && method === "GET") {
				recordReads += 1;
				return Response.json({ agent: storedAgent });
			}
			if (url.pathname === "/api/agents/agent-1" && method === "PUT") {
				const body = fixtureRecordSchema.parse(
					parseFixtureJson(String(init?.body))
				);
				writes.push(body);
				if (failFirstWrite) {
					failFirstWrite = false;
					return Response.json(
						{ error: "temporary agent write failure" },
						{ status: 503 }
					);
				}
				storedAgent = {
					...storedAgent,
					inference: agentInferenceSchema.parse(body.inference),
				};
				return Response.json({ agent: storedAgent });
			}
			return Response.json({});
		},
		realFetch
	);

	setup = await testRender(<App target={TARGET} />, {
		width: 100,
		height: 28,
	});
	await act(async () => {
		await setup?.renderOnce();
	});
	await openAgents(setup);
	await press(setup, { name: "e" });
	await waitForFrame(setup, (frame) => frame.includes("persona tone"));
	for (let field = 0; field < 12; field += 1) {
		await press(setup, { name: "tab" });
	}
	const inferenceField = await waitForFrame(
		setup,
		(frame) =>
			frame.includes("sampling") && frame.includes("2 sampling overrides")
	);
	expect(inferenceField).toContain("Enter to edit");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("Temperature (1/11)"));
	await press(setup, { name: "e" });
	for (let index = 0; index < "0.25".length; index += 1) {
		await press(setup, { name: "backspace" });
	}
	await typeFocused(setup, "0.75");
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("0.75"));

	for (let field = 0; field < 9; field += 1) {
		await press(setup, { name: "down" });
	}
	await waitForFrame(setup, (frame) =>
		frame.includes("Logit bias (JSON) (10/11)")
	);
	await press(setup, { name: "e" });
	await typeFocused(setup, '{"-1":101}');
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) =>
		frame.includes("Token IDs must be non-negative integers.")
	);
	await press(setup, { name: "s", ctrl: true });
	expect(writes).toHaveLength(0);
	await press(setup, { name: "tab" });
	await waitForFrame(setup, (frame) => frame.includes("Edit cancelled."));
	await press(setup, { name: "escape" });
	await press(setup, { name: "s", ctrl: true });
	const failedSave = await waitForFrame(setup, (frame) =>
		frame.includes("503")
	);
	expect(failedSave).toContain("sampling");
	expect(writes).toHaveLength(1);
	expect(writes[0]?.inference).toEqual({
		temperature: 0.75,
		extra: { vendor_flag: true },
	});
	await press(setup, { name: "s", ctrl: true });
	await waitForFrame(setup, (frame) => frame.includes("Enter detail"));
	expect(writes).toHaveLength(2);
	expect(writes[1]).toEqual(writes[0]);

	await press(setup, { name: "e" });
	await waitForFrame(setup, (frame) => frame.includes("persona tone"));
	for (let field = 0; field < 12; field += 1) {
		await press(setup, { name: "tab" });
	}
	await press(setup, { name: "return" });
	const restored = await waitForFrame(
		setup,
		(frame) => frame.includes("Temperature (1/11)") && frame.includes("0.75")
	);
	expect(restored).toContain("0.75");
	for (let field = 0; field < 10; field += 1) {
		await press(setup, { name: "down" });
	}
	const restoredExtra = await waitForFrame(setup, (frame) =>
		frame.includes('{"vendor_flag":true}')
	);
	expect(restoredExtra).toContain('{"vendor_flag":true}');
	expect(recordReads).toBeGreaterThanOrEqual(2);
});

test("new Agent can save a per-agent sampling default through Core's create contract", async () => {
	const createdBodies: FixtureRecord[] = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname === "/api/agents" && method === "GET") {
				return Response.json({ agents: [] });
			}
			if (url.pathname === "/api/agents" && method === "POST") {
				const body = fixtureRecordSchema.parse(
					parseFixtureJson(String(init?.body))
				);
				createdBodies.push(body);
				return Response.json(
					{
						agent: {
							...agentFixture(),
							id: "created-agent",
							name: body.name,
							inference: body.inference,
						},
					},
					{ status: 201 }
				);
			}
			return Response.json({});
		},
		realFetch
	);

	setup = await testRender(<App target={TARGET} />, {
		width: 100,
		height: 28,
	});
	await act(async () => {
		await setup?.renderOnce();
	});
	await openAgents(setup);
	await press(setup, { name: "n" });
	await continueIdentityStep(setup);
	await waitForFrame(setup, (frame) => frame.includes("Agent name"));
	await typeFocused(setup, "New inference agent");
	for (let field = 0; field < 12; field += 1) {
		await press(setup, { name: "tab" });
	}
	await press(setup, { name: "return" });
	await waitForFrame(setup, (frame) => frame.includes("Temperature (1/11)"));
	await press(setup, { name: "e" });
	await typeFocused(setup, "0.4");
	await press(setup, { name: "return" });
	await press(setup, { name: "escape" });
	await press(setup, { name: "s", ctrl: true });
	await waitForFrame(setup, (frame) => frame.includes("Agent created"));
	expect(createdBodies).toHaveLength(1);
	expect(createdBodies[0]?.name).toBe("New inference agent");
	expect(createdBodies[0]?.inference).toEqual({ temperature: 0.4 });
});

interface IdentityFixtureCalls {
	creates: FixtureRecord[];
	launchChecks: FixtureRecord[];
	updates: FixtureRecord[];
}

// Core for the identity tests: launch-check refuses `individual` on any engine
// but Ryu's own (`acp:pi`), as Core does for an engine that signs in as you.
function identityCore(
	stored: FixtureRecord,
	accountRoutes: Record<string, unknown> = {}
): IdentityFixtureCalls {
	const calls: IdentityFixtureCalls = {
		creates: [],
		launchChecks: [],
		updates: [],
	};
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const method = init?.method ?? "GET";
			const body = () =>
				fixtureRecordSchema.parse(parseFixtureJson(String(init?.body)));
			const accountRoute = accountRoutes[url.pathname];
			if (accountRoute !== undefined) {
				return Response.json(accountRoute);
			}
			if (url.pathname === "/api/preferences/terminal-theme") {
				return Response.json({ value: { mode: "system", preset: "ryu" } });
			}
			if (url.pathname === "/api/agents/launch-check") {
				const request = body();
				calls.launchChecks.push(request);
				const refused =
					request.identity_mode === "individual" && request.engine !== "acp:pi";
				return Response.json({
					launchable: !refused,
					reason: refused
						? "Claude Code signs in as you, so it can't run an agent with its own identity."
						: null,
					code: refused ? "provider_access_refused" : null,
					sandbox_supported: true,
					runs_on_managed_pi: false,
				});
			}
			if (url.pathname === "/api/agents" && method === "POST") {
				const request = body();
				calls.creates.push(request);
				return Response.json(
					{ agent: { ...stored, ...request, id: "agent-new" } },
					{ status: 201 }
				);
			}
			if (url.pathname === "/api/agents") {
				return Response.json({
					agents: [{ id: stored.id, name: stored.name, engine: stored.engine }],
				});
			}
			if (url.pathname === "/api/agents/agent-1" && method === "PUT") {
				const request = body();
				calls.updates.push(request);
				return Response.json({ agent: { ...stored, ...request } });
			}
			if (url.pathname === "/api/agents/agent-1") {
				return Response.json({ agent: stored });
			}
			return Response.json({});
		},
		realFetch
	);
	return calls;
}

async function renderAgents(): Promise<Setup> {
	const render = await testRender(<App target={TARGET} />, {
		width: 100,
		height: 30,
	});
	setup = render;
	await act(async () => {
		await render.renderOnce();
	});
	await openAgents(render);
	return render;
}

test("a new agent starts on the identity step and Core's launch refusal blocks the save", async () => {
	const calls = identityCore(fixtureRecordSchema.parse(agentFixture()));
	const render = await renderAgents();
	await press(render, { name: "n" });
	const step = await waitForFrame(render, (frame) =>
		frame.includes("How should this agent work?")
	);
	expect(step).toContain("You can change this later in the agent's settings.");
	expect(step).toContain("Acts as you");
	expect(step).toContain("Its own identity");
	expect(step).toContain("Both");
	expect(step).toContain("● Acts as you");

	await press(render, { name: "right" });
	const individual = await waitForFrame(render, (frame) =>
		frame.includes("● Its own identity")
	);
	expect(individual).toContain("Models Ryu routes for it run on Ryu credits");
	await press(render, { name: "return" });
	await waitForFrame(render, (frame) => frame.includes("Agent name"));
	await typeFocused(render, "Own Agent");
	await press(render, { name: "tab" }); // title
	await press(render, { name: "tab" }); // engine
	await typeFocused(render, "acp:claude");
	for (let field = 2; field < 13; field += 1) {
		await press(render, { name: "tab" });
	}
	const form = await waitForFrame(render, (frame) =>
		frame.includes("works as")
	);
	expect(form).toContain("Enter to change · Its own identity");
	expect(form).toContain("Enter to edit · No limit");

	await press(render, { name: "s", ctrl: true });
	const refused = await waitForFrame(render, (frame) =>
		frame.includes("Nothing was saved")
	);
	expect(refused).toContain("signs in as you");
	expect(calls.creates).toEqual([]);
	expect(calls.launchChecks.at(-1)).toEqual({
		engine: "acp:claude",
		identity_mode: "individual",
		account_access: null,
	});

	// Change the mode back from the editor: Enter reopens the same cards.
	await press(render, { name: "return" });
	await waitForFrame(render, (frame) => frame.includes("● Its own identity"));
	await press(render, { name: "3" });
	await waitForFrame(render, (frame) => frame.includes("● Both"));
	await press(render, { name: "return" });
	await waitForFrame(render, (frame) =>
		frame.includes("Enter to change · Both")
	);
	await press(render, { name: "s", ctrl: true });
	await waitForFrame(render, (frame) => frame.includes("Agent created"));
	expect(calls.creates).toHaveLength(1);
	expect(calls.creates[0]).toMatchObject({
		name: "Own Agent",
		engine: "acp:claude",
		identity_mode: "mixed",
	});
	expect(calls.creates[0]).not.toHaveProperty("account_access");
});

test("Escape on a new agent's identity step leaves without creating anything", async () => {
	const calls = identityCore(fixtureRecordSchema.parse(agentFixture()));
	const render = await renderAgents();
	await press(render, { name: "n" });
	await waitForFrame(render, (frame) =>
		frame.includes("How should this agent work?")
	);
	await press(render, { name: "escape" });
	await waitForFrame(
		render,
		(frame) =>
			frame.includes("Existing Agent") &&
			!frame.includes("How should this agent work?")
	);
	expect(calls.creates).toEqual([]);
});

test("the agent editor changes identity mode and edits account access by key", async () => {
	const calls = identityCore(
		fixtureRecordSchema.parse({
			...agentFixture(),
			identity_mode: "mixed",
			account_access: ["provider:openai", "agent:vault-1"],
			updated_at: "2026-10-01T00:00:00Z",
		})
	);
	const render = await renderAgents();
	await press(render, { name: "e" });
	await waitForFrame(render, (frame) => frame.includes("persona tone"));
	for (let field = 0; field < 13; field += 1) {
		await press(render, { name: "tab" });
	}
	const form = await waitForFrame(render, (frame) =>
		frame.includes("Enter to change · Both")
	);
	expect(form).toContain("Enter to edit · Limited to 2 accounts");

	await press(render, { name: "return" });
	await waitForFrame(render, (frame) => frame.includes("● Both"));
	await press(render, { name: "1" });
	await press(render, { name: "return" });
	await waitForFrame(render, (frame) =>
		frame.includes("Enter to change · Acts as you")
	);

	await press(render, { name: "tab" }); // account access
	await press(render, { name: "return" });
	const panel = await waitForFrame(render, (frame) =>
		frame.includes("provider:openai · Model providers")
	);
	expect(panel).toContain(
		"agent:vault-1 · Its own logins · not used: it acts as you"
	);
	expect(panel).toContain("Limited to 2 accounts · Acts as you");

	// The panel lists the accounts it could be allowed (Treg and Control of
	// your desktop here), then the saved keys it cannot list, which are kept.
	expect(panel).toContain("[ ] Treg · platform:treg");
	expect(panel).toContain("[ ] Control of your desktop · platform:desktop");
	await press(render, { name: "down" });
	await press(render, { name: "down" });
	await press(render, { name: "x" }); // remove provider:openai
	await waitForFrame(render, (frame) =>
		frame.includes("[ ] provider:openai · Model providers")
	);
	await press(render, { name: "a" });
	await typeFocused(render, "bogus");
	await press(render, { name: "return" });
	await waitForFrame(render, (frame) =>
		frame.includes("Not an account key Core accepts")
	);
	await press(render, { name: "escape" });
	await press(render, { name: "a" });
	await typeFocused(render, "platform:treg");
	await press(render, { name: "return" });
	await waitForFrame(render, (frame) =>
		frame.includes("[x] Treg · platform:treg")
	);
	await press(render, { name: "escape" });
	await waitForFrame(render, (frame) =>
		frame.includes("Enter to edit · Limited to 2 accounts")
	);
	await press(render, { name: "s", ctrl: true });
	await waitForFrame(render, (frame) => frame.includes("Enter detail"));
	expect(calls.updates).toHaveLength(1);
	expect(calls.updates[0]).toMatchObject({
		identity_mode: "managed",
		account_access: ["agent:vault-1", "platform:treg"],
	});
	expect(calls.launchChecks.at(-1)).toEqual({
		agent_id: "agent-1",
		engine: "acp:claude",
		identity_mode: "managed",
		account_access: ["agent:vault-1", "platform:treg"],
	});
});

test("clearing account access sends null, and an untouched mode is not rewritten", async () => {
	const calls = identityCore(
		fixtureRecordSchema.parse({
			...agentFixture(),
			identity_mode: "managed",
			account_access: ["provider:openai"],
		})
	);
	const render = await renderAgents();
	await press(render, { name: "e" });
	await waitForFrame(render, (frame) => frame.includes("persona tone"));
	for (let field = 0; field < 14; field += 1) {
		await press(render, { name: "tab" });
	}
	await press(render, { name: "return" });
	await waitForFrame(render, (frame) =>
		frame.includes("provider:openai · Model providers")
	);
	await press(render, { name: "c" });
	await waitForFrame(render, (frame) =>
		frame.includes("No limit · Acts as you")
	);
	await press(render, { name: "escape" });
	await press(render, { name: "s", ctrl: true });
	await waitForFrame(render, (frame) => frame.includes("Enter detail"));
	expect(calls.updates).toHaveLength(1);
	expect(calls.updates[0]?.account_access).toBeNull();
	expect(calls.updates[0]).not.toHaveProperty("identity_mode");
});

test("the account-access panel lists your accounts by name and ticks them", async () => {
	const calls = identityCore(
		fixtureRecordSchema.parse({
			...agentFixture(),
			identity_mode: "managed",
			account_access: null,
		}),
		{
			"/api/composio/status": { configured: true },
			"/api/composio/connections": {
				data: [
					{ id: "ca_gh", toolkit: "github", status: "ACTIVE", active: true },
				],
			},
			"/api/gateway/config": {
				providers: {
					openai: { api_key: "***", base_url: "", api_key_count: 1 },
				},
			},
		}
	);
	const render = await renderAgents();
	await press(render, { name: "e" });
	await waitForFrame(render, (frame) => frame.includes("persona tone"));
	for (let field = 0; field < 14; field += 1) {
		await press(render, { name: "tab" });
	}
	await press(render, { name: "return" });
	const panel = await waitForFrame(render, (frame) =>
		frame.includes("[x] github · composio:ca_gh")
	);
	expect(panel).toContain("No limit · Acts as you");
	expect(panel).toContain("[x] OpenAI · provider:openai");
	expect(panel).toContain("[x] Treg · platform:treg");

	// Unticking one under no limit starts a limit from every listed account.
	await press(render, { name: "down" }); // github
	await press(render, { name: "space" });
	await waitForFrame(render, (frame) =>
		frame.includes("[ ] github · composio:ca_gh")
	);
	await press(render, { name: "escape" });
	await press(render, { name: "s", ctrl: true });
	await waitForFrame(render, (frame) => frame.includes("Enter detail"));
	expect(calls.updates).toHaveLength(1);
	expect(calls.updates[0]?.account_access).toEqual([
		"platform:treg",
		"provider:openai",
		"platform:desktop",
	]);
});

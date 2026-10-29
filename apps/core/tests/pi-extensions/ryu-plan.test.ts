import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const extensionPath = resolve(
	import.meta.dir,
	"../../assets/pi-extensions/ryu-plan.ts"
);
const mcpExtensionPath = resolve(
	import.meta.dir,
	"../../assets/pi-extensions/ryu-mcp.ts"
);
// Pi's own scripted test provider, resolved through Pi so the test drives the
// same pi-ai build the agent loop uses (pi-ai is not a direct dependency).
const fauxProviderPath = Bun.resolveSync(
	"@earendil-works/pi-ai/providers/faux",
	dirname(Bun.resolveSync("@earendil-works/pi-coding-agent", import.meta.dir))
);
const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

const DEFAULT_ACTIVE_TOOLS = [
	"read",
	"write",
	"edit",
	"bash",
	"TodoWrite",
	"PlanWrite",
	"ExitPlanMode",
];

async function loadPlan(initialTools: string[] = DEFAULT_ACTIVE_TOOLS) {
	const directory = await mkdtemp(resolve(tmpdir(), "ryu-plan-native-"));
	directories.push(directory);
	const session = SessionManager.inMemory(directory);
	const loaded = await discoverAndLoadExtensions(
		[extensionPath],
		directory,
		directory
	);
	if (loaded.errors.length) {
		throw new Error(JSON.stringify(loaded.errors));
	}
	const extension = loaded.extensions.find(
		(item) => item.resolvedPath === extensionPath
	);
	if (!extension) {
		throw new Error("Native Pi loader did not load the shipped plan extension");
	}
	let activeTools = [...initialTools];
	loaded.runtime.getActiveTools = () => [...activeTools];
	loaded.runtime.setActiveTools = (tools) => {
		activeTools = [...tools];
	};
	loaded.runtime.appendEntry = (type, data) => {
		session.appendCustomEntry(type, data);
	};
	const models = await ModelRuntime.create({
		authPath: resolve(directory, "auth.json"),
		modelsPath: null,
		modelsStorePath: resolve(directory, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		directory,
		session,
		new ModelRegistry(models)
	);
	return { extension, runner, session, activeTools: () => activeTools };
}

describe("shipped plan extension through native Pi loader and runner", () => {
	test("keeps slash commands unregistered and toggles native tools and persistence", async () => {
		const plan = await loadPlan();
		expect(plan.extension.commands.size).toBe(0);
		const entered = await plan.runner.emitInput(
			"/plan\nInvestigate this",
			undefined,
			"rpc"
		);
		expect(entered.action).toBe("transform");
		expect(plan.activeTools()).toContain("read");
		expect(plan.activeTools()).not.toContain("write");
		expect(
			await plan.runner.emitToolCall({
				type: "tool_call",
				toolCallId: "write",
				toolName: "write",
				input: { path: "safe.txt", content: "text" },
			})
		).toMatchObject({ block: true });
		await plan.runner.emitInput("/plan off\nProceed", undefined, "rpc");
		expect(plan.activeTools()).toContain("write");
		expect(
			plan.session.getEntries().filter((entry) => entry.type === "custom")
		).toHaveLength(2);
	});

	test("plan mode refuses native Ryu MCP tools but keeps discovery", async () => {
		const plan = await loadPlan();
		await plan.runner.emitInput("/plan\nInvestigate this", undefined, "rpc");
		const call = (toolName: string) =>
			plan.runner.emitToolCall({
				type: "tool_call",
				toolCallId: toolName,
				toolName,
				input: {},
			});
		expect(await call("mcp__ryu__quest_board_create_quest")).toMatchObject({
			block: true,
		});
		expect(await call("mcp__ryu__tool_search")).toBeUndefined();
		expect(await call("mcp__ryu__describe")).toBeUndefined();
		await plan.runner.emitInput("/plan off\nProceed", undefined, "rpc");
		expect(await call("mcp__ryu__quest_board_create_quest")).toBeUndefined();
	});

	test("rehydrates the last valid native custom entry despite newer malformed entries", async () => {
		const plan = await loadPlan();
		plan.session.appendCustomEntry("ryu-plan", { enabled: true });
		plan.session.appendCustomEntry("ryu-plan", { enabled: "invalid" });
		await plan.runner.emit({ type: "session_start", reason: "reload" });
		expect(plan.activeTools()).not.toContain("write");
		const exit = plan.extension.tools.get("ExitPlanMode");
		if (!exit) {
			throw new Error("ExitPlanMode is missing");
		}
		const result = await exit.definition.execute(
			"exit",
			{},
			undefined,
			undefined,
			plan.runner.createContext()
		);
		expect(result.details).toMatchObject({
			exited: false,
			reason: "not-approved",
		});
		expect(plan.activeTools()).not.toContain("write");
	});

	test("preserves native to-do rows and published plan metadata", async () => {
		const plan = await loadPlan();
		const todo = plan.extension.tools.get("TodoWrite");
		const publish = plan.extension.tools.get("PlanWrite");
		if (!(todo && publish)) {
			throw new Error("Plan tools missing");
		}
		const todos = [
			{
				content: "Verify native contracts",
				status: "in_progress",
				activeForm: "Verifying",
			},
		];
		const output = await todo.definition.execute(
			"todos",
			{ todos },
			undefined,
			undefined,
			plan.runner.createContext()
		);
		expect(output.details).toEqual({ todos });
		expect(output.content).toMatchObject([
			{
				type: "text",
				text: expect.stringContaining("Verify native contracts"),
			},
		]);
		const published = {
			title: "Typed boundaries",
			summary: "Preserve the wire",
			id: "native",
		};
		expect(
			(
				await publish.definition.execute(
					"publish",
					{ plan: published },
					undefined,
					undefined,
					plan.runner.createContext()
				)
			).details
		).toEqual({ plan: published });
	});

	test("gates copy_paste like edit/write: plan mode and sensitive targets", async () => {
		const plan = await loadPlan();
		const call = (input: Record<string, unknown>) =>
			plan.runner.emitToolCall({
				type: "tool_call",
				toolCallId: "copy",
				toolName: "copy_paste",
				input,
			});
		expect(
			await call({ path: "a.ts", start_line: 1, to_path: "b.ts" })
		).toBeUndefined();
		// Copying FROM a sensitive file only reads it; cutting from one writes it.
		expect(
			await call({ path: ".env", start_line: 1, to_path: "b.ts" })
		).toBeUndefined();
		expect(
			await call({ path: ".env", start_line: 1, to_path: "b.ts", move: true })
		).toMatchObject({
			block: true,
			reason: expect.stringContaining("headless"),
		});
		expect(
			await call({ path: "a.ts", start_line: 1, to_path: ".git/config" })
		).toMatchObject({
			block: true,
			reason: expect.stringContaining("headless"),
		});
		// No to_path means the source is also the destination.
		expect(
			await call({ path: ".env", start_line: 1, to_line: 3 })
		).toMatchObject({
			block: true,
		});

		await plan.runner.emitInput("/plan\nInvestigate", undefined, "rpc");
		expect(
			await call({ path: "a.ts", start_line: 1, to_path: "b.ts" })
		).toMatchObject({ block: true });
	});

	test("parses native HTTP scan verdicts and refuses headless approval", async () => {
		const plan = await loadPlan();
		const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ decision: "deny", reason: "Native policy", future: true })
		);
		try {
			const event = {
				type: "tool_call",
				toolName: "bash",
				toolCallId: "scan",
				input: { command: "echo safe" },
			} satisfies Parameters<typeof plan.runner.emitToolCall>[0];
			expect(await plan.runner.emitToolCall(event)).toMatchObject({
				block: true,
				reason: expect.stringContaining("Native policy"),
			});
			fetch.mockResolvedValue(
				Response.json({ decision: "approval_required", reason: 123 })
			);
			expect(await plan.runner.emitToolCall(event)).toMatchObject({
				block: true,
				reason: expect.stringContaining("headless"),
			});
			fetch.mockResolvedValue(Response.json({ decision: "allow" }));
			expect(await plan.runner.emitToolCall(event)).toBeUndefined();
			// An unknown verdict is not permission: the guard fails closed.
			fetch.mockResolvedValue(Response.json({ decision: "unexpected" }));
			expect(await plan.runner.emitToolCall(event)).toMatchObject({
				block: true,
				reason: expect.stringContaining("command policy"),
			});
			expect(
				await plan.runner.emitToolCall({
					...event,
					input: { command: "rm -rf /" },
				})
			).toMatchObject({ block: true });
		} finally {
			fetch.mockRestore();
		}
	});

	test("blocks deletion commands the local lists miss when Core's scan yields no verdict", async () => {
		const plan = await loadPlan();
		const fetch = spyOn(globalThis, "fetch");
		const bash = (command: string) =>
			plan.runner.emitToolCall({
				type: "tool_call",
				toolName: "bash",
				toolCallId: "scan-outage",
				input: { command },
			});
		try {
			// `unlink` and a plain `rm` are permanent deletions under the shared
			// classifier but match neither local list, so an outage must not
			// let them through.
			const outages: Array<() => void> = [
				() => fetch.mockRejectedValue(new TypeError("fetch failed")),
				() =>
					fetch.mockRejectedValue(
						new DOMException("The operation timed out.", "TimeoutError")
					),
				() =>
					fetch.mockImplementation(
						async () => new Response("unavailable", { status: 503 })
					),
				() =>
					fetch.mockImplementation(async () =>
						Response.json({ verdict: "allow" })
					),
			];
			for (const outage of outages) {
				outage();
				for (const command of [
					"unlink /tmp/ryu-audit-fixture",
					"rm notes.txt",
				]) {
					expect(await bash(command)).toMatchObject({
						block: true,
						reason: expect.stringContaining("command policy"),
					});
				}
			}
			// A tool that is not a shell command never consults the scan.
			fetch.mockClear();
			expect(
				await plan.runner.emitToolCall({
					type: "tool_call",
					toolName: "read",
					toolCallId: "read",
					input: { path: "notes.txt" },
				})
			).toBeUndefined();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});

	test("confines an allowlisted agent to its scoped tools and refuses everything else first", async () => {
		const previous = process.env.RYU_PI_ACTIVE_TOOLS;
		process.env.RYU_PI_ACTIVE_TOOLS = "ryu_call_tool,ryu_list_tools";
		try {
			const plan = await loadPlan([
				...DEFAULT_ACTIVE_TOOLS,
				"ryu_call_tool",
				"ryu_list_tools",
				"Task",
				"bash_background",
			]);
			await plan.runner.emit({ type: "session_start", reason: "startup" });
			expect(plan.activeTools()).toEqual(["ryu_call_tool", "ryu_list_tools"]);
			for (const [toolName, input] of [
				["bash", { command: "cat ~/.ssh/id_rsa" }],
				["read", { path: "/etc/passwd" }],
				["write", { path: "notes.txt", content: "text" }],
				["edit", { path: "notes.txt" }],
				["Task", { prompt: "run a shell" }],
				["bash_background", { command: "sleep 1" }],
				["TodoWrite", { todos: [] }],
			] as const) {
				expect(
					await plan.runner.emitToolCall({
						type: "tool_call",
						toolCallId: toolName,
						toolName,
						input,
					})
				).toMatchObject({
					block: true,
					reason: expect.stringContaining("allowlist"),
				});
			}
			expect(
				await plan.runner.emitToolCall({
					type: "tool_call",
					toolCallId: "ryu",
					toolName: "ryu_call_tool",
					input: { tool: "spaces.search", arguments: { query: "Ryu" } },
				})
			).toBeUndefined();
		} finally {
			if (previous === undefined) {
				delete process.env.RYU_PI_ACTIVE_TOOLS;
			} else {
				process.env.RYU_PI_ACTIVE_TOOLS = previous;
			}
		}
	});

	test("an empty scope refuses every tool, and no scope leaves Pi's tools alone", async () => {
		const previous = process.env.RYU_PI_ACTIVE_TOOLS;
		process.env.RYU_PI_ACTIVE_TOOLS = "";
		try {
			const scoped = await loadPlan([...DEFAULT_ACTIVE_TOOLS, "ryu_call_tool"]);
			await scoped.runner.emit({ type: "session_start", reason: "startup" });
			expect(scoped.activeTools()).toEqual([]);
			expect(
				await scoped.runner.emitToolCall({
					type: "tool_call",
					toolCallId: "ryu",
					toolName: "ryu_call_tool",
					input: { tool: "spaces.search" },
				})
			).toMatchObject({ block: true });
		} finally {
			if (previous === undefined) {
				delete process.env.RYU_PI_ACTIVE_TOOLS;
			} else {
				process.env.RYU_PI_ACTIVE_TOOLS = previous;
			}
		}
		const unscoped = await loadPlan();
		await unscoped.runner.emit({ type: "session_start", reason: "startup" });
		expect(unscoped.activeTools()).toEqual(DEFAULT_ACTIVE_TOOLS);
	});

	test("plan mode refuses ryu_call_tool and Ryu MCP mutators called from a codemode script", async () => {
		const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(
			fauxProviderPath
		);
		const directory = await mkdtemp(resolve(tmpdir(), "ryu-plan-codemode-"));
		directories.push(directory);
		const faux = fauxProvider();
		const executed: string[] = [];
		const coreCalls: unknown[] = [];
		const fetch = spyOn(globalThis, "fetch").mockImplementation(
			async (_url, init) => {
				const body = JSON.parse(String(init?.body ?? "{}"));
				if (body.action === "call_tool") {
					coreCalls.push(body);
					return Response.json({ ok: true, output: "mutated" });
				}
				return Response.json({ tools: [] });
			}
		);
		try {
			const settingsManager = SettingsManager.inMemory({
				defaultTools: ["+codemode"],
			});
			const resourceLoader = new DefaultResourceLoader({
				cwd: directory,
				agentDir: directory,
				settingsManager,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				additionalExtensionPaths: [extensionPath, mcpExtensionPath],
				extensionFactories: [
					createCodemodeExtension(),
					(pi) => {
						pi.registerProvider(faux.provider);
						// Stand-ins for the deferred tools Pi's MCP client registers
						// for Core's bridge (server `ryu`); scripts can always call them.
						for (const name of [
							"mcp__ryu__quest_board_create_quest",
							"mcp__ryu__tool_search",
						]) {
							pi.registerTool({
								name,
								label: name,
								description: name,
								parameters: { type: "object", properties: {} } as never,
								exposure: "deferred",
								execute: () => {
									executed.push(name);
									return Promise.resolve({
										content: [{ type: "text", text: "ok" }],
										details: {},
									});
								},
							});
						}
					},
				],
			});
			await resourceLoader.reload();
			const modelRuntime = await ModelRuntime.create({
				authPath: resolve(directory, "auth.json"),
				modelsPath: null,
				modelsStorePath: resolve(directory, "models-store.json"),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			const { session } = await createAgentSession({
				cwd: directory,
				agentDir: directory,
				modelRuntime,
				model: faux.getModel(),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(directory),
			});
			expect(session.getActiveToolNames()).toContain("codemode");

			faux.setResponses([fauxAssistantMessage("Planning.")]);
			await session.prompt("/plan\nInvestigate this");
			expect(session.getActiveToolNames()).toContain("codemode");
			expect(session.getActiveToolNames()).not.toContain("ryu_call_tool");
			// Withholding is only the belt: put `ryu_call_tool` back so the script
			// can reach it and the nested `tool_call` refusal has to hold the line.
			session.setActiveToolsByName([
				...session.getActiveToolNames(),
				"ryu_call_tool",
			]);

			const code = `
const attempt = async (name, args) => {
	try {
		return "ok:" + (await tools[name](args));
	} catch (error) {
		return "refused:" + error.message;
	}
};
return JSON.stringify({
	call: await attempt("ryu_call_tool", { tool: "quest-board.create_quest", arguments: {} }),
	mutate: await attempt("mcp__ryu__quest_board_create_quest", {}),
	search: await attempt("mcp__ryu__tool_search", {}),
});`;
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("codemode", { code })),
				fauxAssistantMessage("Done."),
			]);
			await session.prompt("Try the tools");
			const scriptResult = session.agent.state.messages.findLast(
				(message) =>
					message.role === "toolResult" && message.toolName === "codemode"
			);
			const output = (scriptResult?.content ?? [])
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("\n");
			const outcome = JSON.parse(output.slice(output.indexOf('{"call"')));
			expect(outcome.call).toStartWith("refused:");
			expect(outcome.call).toContain("Plan mode is on");
			expect(outcome.mutate).toStartWith("refused:");
			expect(outcome.mutate).toContain("Plan mode is on");
			expect(outcome.search).toBe("ok:ok");
			expect(executed).toEqual(["mcp__ryu__tool_search"]);
			expect(coreCalls).toEqual([]);

			faux.setResponses([fauxAssistantMessage("Plan mode is off.")]);
			await session.prompt("/plan off\nProceed");
		} finally {
			fetch.mockRestore();
		}
	});
});

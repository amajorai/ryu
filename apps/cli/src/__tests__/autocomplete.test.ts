import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary } from "@ryuhq/core-client/agents";
import type { MentionTargetUser } from "@ryuhq/core-client/notifications";
import type { AppInfo } from "@ryuhq/core-client/plugins";
import type { Workflow } from "@ryuhq/core-client/workflows";
import {
	AUTOCOMPLETE_VISIBLE_ROWS,
	agentSuggestions,
	applyAutocomplete,
	appPluginSuggestions,
	autocompleteLayout,
	autocompleteRow,
	autocompleteWindow,
	commandSuggestions,
	getAutocompleteContext,
	humanSuggestions,
	moveAutocompleteIndex,
	rankCommand,
	resolveWorkflowMention,
	runsOnEnter,
	slashArgumentSuggestions,
	workflowSuggestions,
} from "../core/autocomplete.ts";
import {
	acpSlashCommandsFromData,
	contributedSlashCommandsFromResponse,
} from "../core/contributions.ts";
import { searchFiles } from "../core/fileMentions.ts";

const agents = [
	{ id: "research", name: "Researcher" },
	{ id: "writer", name: "Writer" },
	{ id: "ops", name: "Ops" },
].map((agent) => ({
	builtIn: false,
	createdAt: null,
	description: null,
	engine: null,
	installed: null,
	installHint: null,
	locked: false,
	model: null,
	systemPrompt: null,
	title: "",
	transport: null,
	version: null,
	...agent,
})) satisfies AgentSummary[];

test("detects slash and mention contexts only at the active token", () => {
	expect(getAutocompleteContext("  /mod")).toEqual({
		kind: "slash",
		query: "mod",
		start: 2,
	});
	expect(getAutocompleteContext("summarize @res")).toEqual({
		kind: "mention",
		query: "res",
		start: 10,
	});
	expect(getAutocompleteContext("/model son")).toBeNull();
});

test("structured slash arguments filter choices, advance sequentially, and allow custom values", () => {
	const commands = contributedSlashCommandsFromResponse({
		slash_commands: [
			{
				args: [
					{
						name: "environment",
						options: [
							{ label: "Production", value: "prod" },
							{ label: "Preview", value: "preview" },
						],
					},
					{
						allow_custom: true,
						name: "version",
						options: [{ label: "Latest", value: "latest" }],
					},
				],
				command: "/deploy",
				description: "Deploy a release",
				plugin: "@ryu/deploy",
			},
		],
	});
	const environment = getAutocompleteContext("/deploy pre", commands);
	expect(environment).toMatchObject({
		argumentIndex: 0,
		argument: { name: "environment" },
		kind: "slash-argument",
		query: "pre",
	});
	if (environment?.kind !== "slash-argument") {
		throw new Error("Expected a structured environment argument context");
	}
	const preview = slashArgumentSuggestions(environment)[0];
	if (!preview) {
		throw new Error("Expected the matching Preview choice");
	}
	expect(preview).toMatchObject({
		kind: "slash-argument-option",
		label: "Preview",
		value: "preview",
	});
	const withEnvironment = applyAutocomplete(
		"/deploy pre",
		environment,
		preview
	);
	expect(withEnvironment).toBe("/deploy preview ");

	const version = getAutocompleteContext(withEnvironment, commands);
	expect(version).toMatchObject({
		argumentIndex: 1,
		argument: { name: "version" },
		kind: "slash-argument",
		query: "",
	});
	if (version?.kind !== "slash-argument") {
		throw new Error("Expected the sequential version argument context");
	}
	const customVersion = getAutocompleteContext(
		"/deploy preview 2.4.0",
		commands
	);
	if (customVersion?.kind !== "slash-argument") {
		throw new Error("Expected a custom version argument context");
	}
	expect(customVersion.argument.custom?.description).toBe(
		"Type a value that is not in the registered options."
	);
	expect(slashArgumentSuggestions(customVersion)).toContainEqual({
		description: "Type a value that is not in the registered options.",
		kind: "slash-argument-option",
		label: 'Use "2.4.0"',
		value: "2.4.0",
	});
	expect(
		applyAutocomplete("/deploy preview 2.4.0", customVersion, {
			description: "Type a value that is not in the registered options.",
			kind: "slash-argument-option",
			label: 'Use "2.4.0"',
			value: "2.4.0",
		})
	).toBe("/deploy preview 2.4.0");
});

test("ACP advertised slash commands normalize and replace malformed or empty updates", () => {
	const commands = acpSlashCommandsFromData({
		commands: [
			{ name: "/review", description: "Review the change", hint: "diff" },
			{ name: "two words", description: "invalid" },
			{ name: 4 },
		],
	});
	expect(commands).toEqual([
		{ description: "Review the change", hint: "diff", name: "review" },
	]);
	expect(acpSlashCommandsFromData({ commands: [] })).toEqual([]);
	expect(acpSlashCommandsFromData({ commands: "invalid" })).toBeNull();
	if (!commands) {
		throw new Error("Expected ACP commands to normalize");
	}
	expect(commandSuggestions("rev", [], commands)).toEqual([
		{
			description: "Review the change",
			kind: "command",
			name: "review",
			source: "agent",
		},
	]);
	expect(
		commandSuggestions("help", [], [{ name: "help", description: "ACP help" }])
	).toEqual([
		{ description: "show slash command help", kind: "command", name: "help" },
	]);
});

test("filters local commands and agents safely", () => {
	expect(commandSuggestions("mo").map((item) => item.name)).toEqual(["model"]);
	expect(commandSuggestions("double").map((item) => item.name)).toEqual([
		"check",
	]);
	expect(commandSuggestions("th").map((item) => item.name)).toEqual(["theme"]);
	expect(agentSuggestions(agents, "WRI")).toEqual([
		{ kind: "agent", id: "writer", name: "Writer" },
	]);
});

test("moves within bounds and replaces only the completion token", () => {
	const context = getAutocompleteContext("hello @")!;
	const suggestion = agentSuggestions(agents, "")[1]!;
	expect(applyAutocomplete("hello @", context, suggestion)).toBe(
		"hello @writer "
	);
	expect(moveAutocompleteIndex(0, -1, 3)).toBe(0);
	expect(moveAutocompleteIndex(1, 1, 3)).toBe(2);
	expect(moveAutocompleteIndex(2, 1, 3)).toBe(2);
	expect(moveAutocompleteIndex(0, 1, 0)).toBe(0);
});

test("workflow suggestions include only chat-input workflows and route by visible name", () => {
	const workflows = [
		{
			id: "release-checklist",
			name: "Release Checklist",
			nodes: [
				{ id: "input", type: "input" },
				{ id: "worker", type: "prompt" },
			],
			edges: [{ from: "input", to: "worker" }],
			triggers: [],
		},
		{
			id: "not-chat-runnable",
			name: "Nightly Maintenance",
			nodes: [{ id: "worker", type: "prompt" }],
			edges: [],
			triggers: [],
		},
		{
			id: "nested-input",
			name: "Nested Input",
			nodes: [
				{ id: "start", type: "prompt" },
				{ id: "input", type: "input" },
			],
			edges: [{ from: "start", to: "input" }],
			triggers: [],
		},
	] satisfies Workflow[];
	const context = getAutocompleteContext("Run @Rele")!;
	const suggestion = workflowSuggestions(workflows, "rele")[0]!;

	expect(suggestion).toEqual({
		kind: "workflow",
		id: "release-checklist",
		name: "Release Checklist",
	});
	expect(applyAutocomplete("Run @Rele", context, suggestion)).toBe(
		"Run @Release Checklist "
	);
	expect(resolveWorkflowMention("Run @release checklist", workflows)).toBe(
		"release-checklist"
	);
	expect(workflowSuggestions(workflows, "nightly")).toEqual([]);
});

test("app and plugin mentions include enabled CLI entries and insert their visible names", () => {
	const apps = [
		{
			id: "@ryu/mail",
			name: "Mail",
			enabled: true,
			companion: { label: "Mail", icon: null, shortcut: null },
		},
		{
			id: "@ryu/bookmarks",
			name: "Bookmarks",
			enabled: true,
			companion: null,
		},
		{
			id: "@ryu/disabled",
			name: "Disabled App",
			enabled: false,
			companion: { label: "Disabled", icon: null, shortcut: null },
		},
	].map((app) => ({
		builtIn: false,
		commands: [],
		installed: true,
		installedVersion: null,
		localOnly: false,
		permissionGrants: [],
		requires: null,
		runnables: [],
		sidecarName: null,
		surfaceSupport: [],
		targets: [],
		version: "1",
		windowsFirst: false,
		...app,
	})) satisfies AppInfo[];
	const context = getAutocompleteContext("Review @Book")!;
	const suggestions = appPluginSuggestions(apps, context.query);

	expect(suggestions).toEqual([
		{ kind: "plugin", id: "@ryu/bookmarks", name: "Bookmarks" },
	]);
	expect(appPluginSuggestions(apps, "disabled")).toEqual([]);
	expect(
		applyAutocomplete("Open @Mai", getAutocompleteContext("Open @Mai")!, {
			kind: "app",
			id: "@ryu/mail",
			name: "Mail",
		})
	).toBe("Open @Mail ");
});

test("human mentions match the scoped directory, omit self, and insert the visible name", () => {
	const users = [
		{
			id: "ada-id",
			name: "Ada Lovelace",
			email: "ada@example.test",
			image: null,
			role: "member",
		},
		{
			id: "me-id",
			name: "Current User",
			email: "me@example.test",
			image: null,
			role: "owner",
		},
	] satisfies MentionTargetUser[];
	const context = getAutocompleteContext("Review @Ada")!;
	const suggestion = humanSuggestions(users, context.query, "me-id")[0]!;

	expect(suggestion).toEqual({
		kind: "human",
		id: "ada-id",
		name: "Ada Lovelace",
	});
	expect(humanSuggestions(users, "me", "me-id")).toEqual([]);
	expect(humanSuggestions(users, "example.test", "me-id")).toEqual([
		suggestion,
	]);
	expect(applyAutocomplete("Review @Ada", context, suggestion)).toBe(
		"Review @Ada Lovelace "
	);
});

test("command ranking orders exact, prefix, alias, fuzzy, then description", () => {
	expect(rankCommand("new", "new", ["newchat"], "start a new chat")).toBe(0);
	expect(rankCommand("newchat", "new", ["newchat"], "")).toBe(0);
	expect(rankCommand("ne", "new", ["newchat"], "")).toBe(1);
	expect(rankCommand("double", "check", ["double-check"], "")).toBe(2);
	const fuzzy = rankCommand("hlp", "help", [], "show slash command help");
	expect(fuzzy).toBeGreaterThanOrEqual(3);
	expect(fuzzy).toBeLessThan(4);
	// Tighter subsequences beat looser ones inside the fuzzy tier.
	expect(rankCommand("hp", "help", [], "") ?? 0).toBeGreaterThan(fuzzy ?? 0);
	expect(rankCommand("slash", "help", [], "show slash command help")).toBe(4);
	expect(rankCommand("zz", "help", [], "show slash command help")).toBeNull();

	// A typo still reaches the command it misspells.
	expect(commandSuggestions("hlp")[0]?.name).toBe("help");
	// Description matches surface only when no name or alias matches.
	expect(commandSuggestions("terminal").map(({ name }) => name)).toEqual([
		"theme",
	]);
	// An exact alias outranks prefix hits; prefix hits keep registry order.
	expect(
		commandSuggestions(
			"acp",
			[],
			[{ description: "Review", name: "acp-review" }]
		)
	).toEqual([
		{ description: "choose ACP settings", kind: "command", name: "config" },
		{
			description: "Review",
			kind: "command",
			name: "acp-review",
			source: "agent",
		},
	]);
	// Fuzzy rows never join a query that already has a prefix hit, and a
	// one-character query never goes fuzzy.
	expect(commandSuggestions("he").map(({ name }) => name)).toEqual(["help"]);
	expect(commandSuggestions("z")).toEqual([]);
	// The whole list is returned; the view windows it.
	expect(commandSuggestions("").length).toBeGreaterThan(
		AUTOCOMPLETE_VISIBLE_ROWS
	);
});

test("mention suggestions put prefix matches ahead of substring matches", () => {
	const named = [
		{ ...agents[0], id: "pre-research", name: "Pre Research" },
		{ ...agents[0], id: "research", name: "Researcher" },
	] satisfies AgentSummary[];
	expect(agentSuggestions(named, "res").map(({ id }) => id)).toEqual([
		"research",
		"pre-research",
	]);
});

test("the completion window keeps the selection visible and counts hidden rows", () => {
	expect(autocompleteWindow(0, 4, 10)).toEqual({
		above: 0,
		below: 0,
		end: 4,
		start: 0,
	});
	expect(autocompleteWindow(0, 25, 10)).toEqual({
		above: 0,
		below: 15,
		end: 10,
		start: 0,
	});
	expect(autocompleteWindow(12, 25, 10)).toEqual({
		above: 3,
		below: 12,
		end: 13,
		start: 3,
	});
	expect(autocompleteWindow(24, 25, 10)).toEqual({
		above: 15,
		below: 0,
		end: 25,
		start: 15,
	});
	expect(autocompleteWindow(0, 0, 10)).toEqual({
		above: 0,
		below: 0,
		end: 0,
		start: 0,
	});
});

test("only bare no-argument built-ins run on Enter", () => {
	const command = (name: string, extra: object = {}) => ({
		description: "",
		kind: "command" as const,
		name,
		...extra,
	});
	expect(runsOnEnter("/new", command("new"))).toBe(true);
	expect(runsOnEnter("  /new  ", command("new"))).toBe(true);
	// A prefix still completes first, and an alias completes to the name.
	expect(runsOnEnter("/ne", command("new"))).toBe(false);
	expect(runsOnEnter("/newchat", command("new"))).toBe(false);
	// Commands with arguments keep fill-on-Enter so arguments can be typed.
	expect(runsOnEnter("/model", command("model"))).toBe(false);
	expect(runsOnEnter("/btw", command("btw"))).toBe(false);
	// ACP, plugin and prompt-template commands always complete first.
	expect(runsOnEnter("/review", command("review", { source: "agent" }))).toBe(
		false
	);
	expect(runsOnEnter("/advisor", command("advisor"))).toBe(false);
	expect(runsOnEnter("/draft", command("draft", { body: "Draft it" }))).toBe(
		false
	);
	expect(runsOnEnter("@src/", { kind: "file", path: "src/" })).toBe(false);
	expect(runsOnEnter("/new", undefined)).toBe(false);
});

test("completion rows carry a label, description and kind tag", () => {
	expect(autocompleteRow(commandSuggestions("new")[0]!)).toMatchObject({
		description: "start a new chat",
		label: "/new",
		tag: "local",
	});
	expect(
		autocompleteRow({
			description: "Review",
			kind: "command",
			name: "review",
			source: "agent",
		}).tag
	).toBe("ACP");
	expect(
		autocompleteRow({ description: "", kind: "command", name: "advisor" }).tag
	).toBe("plugin");
	expect(
		autocompleteRow({ body: "x", description: "", kind: "command", name: "t" })
			.tag
	).toBe("prompt");
	expect(autocompleteRow({ kind: "file", path: "src/" })).toMatchObject({
		label: "@src/",
		tag: "folder",
	});
	expect(
		autocompleteRow({ kind: "agent", id: "writer", name: "Writer" })
	).toMatchObject({ description: "Writer", label: "@writer", tag: "agent" });
});

test("@path tokens open file completion without hijacking named mentions", () => {
	expect(getAutocompleteContext("summarize @res")?.kind).toBe("mention");
	expect(getAutocompleteContext("@Release.Checklist")?.kind).toBe("mention");
	expect(getAutocompleteContext("read @src/")).toEqual({
		kind: "file",
		query: "src/",
		start: 5,
	});
	expect(getAutocompleteContext("@./lib/x.ts")).toEqual({
		kind: "file",
		query: "./lib/x.ts",
		start: 0,
	});
	expect(getAutocompleteContext("@../")?.kind).toBe("file");
	expect(getAutocompleteContext("mail me@src/")).toBeNull();

	const context = getAutocompleteContext("read @src/ma")!;
	expect(
		applyAutocomplete("read @src/ma", context, {
			kind: "file",
			path: "src/main.ts",
		})
	).toBe("read @src/main.ts ");
	// Directories stay open (no trailing space) so the next segment completes.
	expect(
		applyAutocomplete("read @src/ma", context, {
			kind: "file",
			path: "src/macros/",
		})
	).toBe("read @src/macros/");
});

test("file search lists one directory level, prefix first, skipping heavy folders", async () => {
	const root = mkdtempSync(join(tmpdir(), "ryu-cli-search-files-"));
	try {
		mkdirSync(join(root, "src", "components", "deep"), { recursive: true });
		mkdirSync(join(root, "src", "node_modules"));
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, "src", "config.ts"), "");
		writeFileSync(join(root, "src", "app-config.ts"), "");
		writeFileSync(join(root, "src", ".env"), "");
		writeFileSync(join(root, "src", "components", "deep", "x.ts"), "");

		expect(await searchFiles(root, "src/")).toEqual([
			"src/components/",
			"src/app-config.ts",
			"src/config.ts",
		]);
		expect(await searchFiles(root, "src/co")).toEqual([
			"src/components/",
			"src/config.ts",
			"src/app-config.ts",
		]);
		// A leading dot reveals dot entries, which match by prefix first.
		expect((await searchFiles(root, "src/."))[0]).toBe("src/.env");
		expect(await searchFiles(root, "src/c")).not.toContain("src/.env");
		expect(await searchFiles(root, "./")).toEqual(["./src/"]);
		expect(await searchFiles(root, "src/", 1)).toEqual(["src/components/"]);
		expect(await searchFiles(root, "missing/")).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the completion list fits the rows above the composer", () => {
	// Room for the full ten-row window, header and indicators.
	expect(autocompleteLayout(25, 20)).toEqual({ header: true, rows: 10 });
	// A short list never reserves indicator rows.
	expect(autocompleteLayout(1, 4)).toEqual({ header: true, rows: 1 });
	// 80x16: twelve rows above the composer leave seven scrolling rows.
	expect(autocompleteLayout(25, 12)).toEqual({ header: true, rows: 7 });
	// Too tight for the header: it goes before list rows do.
	expect(autocompleteLayout(25, 6)).toEqual({ header: false, rows: 2 });
	// At least one row always remains, even with no room at all.
	expect(autocompleteLayout(25, 0)).toEqual({ header: false, rows: 1 });
	// The empty state ("No matches") counts as one row.
	expect(autocompleteLayout(0, 3)).toEqual({ header: false, rows: 1 });
});

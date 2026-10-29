import { describe, expect, test } from "bun:test";
import {
	applySlashCommandOption,
	mergeComposerCommands,
	parseSlashCommandContribution,
	parseSlashMenuState,
	type SlashCommand,
} from "./slash-commands.ts";

const commands: SlashCommand[] = [
	{
		args: [
			{
				name: "calendar",
				options: [
					{ label: "Work", value: "work" },
					{ label: "Personal", value: "personal" },
				],
			},
			{
				custom: { label: "Use a project id" },
				name: "project",
				options: [{ label: "Ryu", value: "ryu" }],
			},
		],
		description: "Create an event",
		name: "event",
		source: "plugin",
	},
	{
		args: [],
		description: "A command without arguments",
		name: "ping",
		source: "local",
	},
];

describe("parseSlashCommandContribution", () => {
	test("retains optional live values while normalizing aliases and ignoring inherited fields", () => {
		const input = {
			command: "/future",
			body: undefined,
			future: { optional: undefined },
			parameters: [
				{
					allowCustom: "true",
					name: "mode",
					choices: ["fast", { id: "slow", label: "Slow", future: [null] }],
				},
			],
		};
		expect(parseSlashCommandContribution(input)).toEqual({
			args: [
				{
					custom: {
						description: "Type a value that is not in the registered options.",
						label: "Use a custom value",
					},
					description: undefined,
					name: "mode",
					options: [
						{ label: "fast", value: "fast" },
						{ description: undefined, label: "Slow", value: "slow" },
					],
				},
			],
			body: undefined,
			description: "",
			hint: null,
			name: "future",
			source: "plugin",
		});
		expect(input.future).toEqual({ optional: undefined });
		const inherited = Object.create({ command: "/inherited" });
		expect(parseSlashCommandContribution(inherited)).toBeNull();
	});
	test("normalizes plugin argument choices and custom values", () => {
		expect(
			parseSlashCommandContribution({
				args: [
					{
						allow_custom: true,
						name: "mode",
						options: [{ label: "Fast", value: "fast" }],
					},
				],
				command: "/review",
				description: "Review a change",
			})
		).toEqual({
			args: [
				{
					custom: {
						description: "Type a value that is not in the registered options.",
						label: "Use a custom value",
					},
					description: undefined,
					name: "mode",
					options: [{ label: "Fast", value: "fast" }],
				},
			],
			body: undefined,
			description: "Review a change",
			hint: null,
			name: "review",
			source: "plugin",
		});
	});

	test("accepts parameters as the hand-authored alias", () => {
		expect(
			parseSlashCommandContribution({
				command: "/deploy",
				parameters: [{ name: "environment", options: ["staging"] }],
			})?.args[0]
		).toEqual({
			name: "environment",
			options: [{ label: "staging", value: "staging" }],
		});
	});

	test("drops malformed contributions at the boundary", () => {
		expect(
			parseSlashCommandContribution({ description: "missing command" })
		).toBe(null);
		expect(parseSlashCommandContribution({ command: "/two words" })).toBe(null);
	});
});

describe("parseSlashMenuState", () => {
	test("opens the command list while the command is being typed", () => {
		expect(parseSlashMenuState("/ev", commands)).toEqual({
			kind: "commands",
			query: "ev",
		});
	});

	test("advances through each argument after an option is selected", () => {
		expect(parseSlashMenuState("/event ", commands)).toMatchObject({
			argumentIndex: 0,
			kind: "arguments",
			query: "",
		});
		expect(parseSlashMenuState("/event work ", commands)).toMatchObject({
			argumentIndex: 1,
			kind: "arguments",
			query: "",
		});
		expect(parseSlashMenuState("/event work r", commands)).toMatchObject({
			argumentIndex: 1,
			kind: "arguments",
			query: "r",
		});
	});

	test("closes after the last argument or for a command with no arguments", () => {
		expect(parseSlashMenuState("/event work ryu", commands)).toBe(null);
		expect(parseSlashMenuState("/ping ", commands)).toBe(null);
	});
});

test("replaces the current argument and leaves the next slot open", () => {
	expect(applySlashCommandOption("/event w", "work", true)).toBe(
		"/event work "
	);
	expect(applySlashCommandOption("/event work r", "ryu", false)).toBe(
		"/event work ryu"
	);
});

test("adds enabled skills after existing commands with a skill source", () => {
	const merged = mergeComposerCommands(
		[
			{
				args: [],
				description: "Set a goal",
				name: "goal",
				source: "local",
			},
		],
		[
			{
				description: "Work with PDFs",
				enabled: true,
				id: "pdf",
				name: "PDF",
			},
			{
				description: null,
				enabled: false,
				id: "disabled",
				name: "Disabled",
			},
		]
	);

	expect(merged).toEqual([
		{
			args: [],
			description: "Set a goal",
			name: "goal",
			source: "local",
		},
		{
			args: [],
			description: "Work with PDFs",
			hint: "PDF",
			name: "pdf",
			source: "skill",
		},
	]);
});

test("keeps an existing command when a skill id collides", () => {
	const merged = mergeComposerCommands(
		[
			{
				args: [],
				description: "The local command wins",
				name: "review",
				source: "local",
			},
		],
		[
			{
				description: "The skill loses",
				enabled: true,
				id: "REVIEW",
				name: "Review",
			},
		]
	);

	expect(merged).toHaveLength(1);
	expect(merged[0]?.source).toBe("local");
});

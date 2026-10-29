import { describe, expect, test } from "bun:test";
import {
	type ComposerMentionItem,
	mentionMarkdown,
	serializeComposerMarkdown,
} from "./composer-editor.tsx";
import {
	mentionDropPadding,
	shouldTrimGapAfterRemovedMention,
} from "./composer-mention-drop.ts";
import {
	exportMentionMarkdown,
	importMentionMarkdown,
} from "./composer-mention-markdown.ts";

const items: ComposerMentionItem[] = [
	{ id: "page-1", kind: "page", label: "Project Atlas" },
	{ id: "app-1", kind: "app", label: "Calendar" },
	{ id: "thermos", kind: "skill", label: "thermos" },
	{ id: "github", kind: "plugin", label: "GitHub" },
	{
		id: "project-1",
		kind: "app-item",
		label: "Ryu Pricing Economics",
		ownerId: "com.ryu.sites",
	},
	{ id: "conversation-1", kind: "chat", label: "Captcha answer check" },
	{ id: "hotline", kind: "integration", label: "Hotline" },
];

describe("composer Markdown transport", () => {
	test("round-trips known mentions as editor links without changing normal Markdown", () => {
		const source =
			"Plan with @Project Atlas and [the docs](https://example.com).";
		const editorMarkdown = mentionMarkdown(source, items);

		expect(editorMarkdown).toContain("[@Project Atlas](mention:page-1)");
		expect(editorMarkdown).toContain("[the docs](https://example.com)");
		expect(serializeComposerMarkdown(editorMarkdown)).toBe(source);
	});

	test("leaves unknown links intact and restores an unprefixed mention label", () => {
		const source = "[external](https://example.com) [Atlas](mention:page-1)";

		expect(serializeComposerMarkdown(source)).toBe(
			"[external](https://example.com) @Atlas"
		);
	});

	test("drops the zero-width spaces Plate writes around inline mentions", () => {
		const serialized =
			"\u200B[@Atlas](mention:page-1)\u200B [@Atlas](mention:page-1)\u200B";

		expect(serializeComposerMarkdown(serialized)).toBe("@Atlas @Atlas");
	});

	test("imports ChatGPT mention links and workspace file references", () => {
		const skillPath = String.raw`C:\Users\jiawei\.agents\skills\thermos\SKILL.md`;
		const source = [
			"[Ryu Pricing Economics](sites-project://appgprj_6a958026d5a48191a90d4e33b8fade56)",
			"[Captcha answer check](chatgpt-conversation://6abb6d31-7c0c-83ec-90ab-77871630cc64)",
			"[files.ts](apps/desktop/src/lib/files.ts)",
			"[$hotline](app://connector_openai_hotline)",
			"[@GitHub](plugin://github@openai-curated-remote)",
			`[$thermos](${skillPath})`,
			"[project plan](https://example.com)",
		].join(" ");

		expect(importMentionMarkdown(source, items)).toBe(
			"@Ryu Pricing Economics @Captcha answer check @<apps/desktop/src/lib/files.ts> @Hotline @GitHub @thermos [project plan](https://example.com)"
		);
	});

	test("resolves connector links by target type when app labels overlap", () => {
		const itemsWithSameName = [
			...items,
			{ id: "app-hotline", kind: "app", label: "Hotline" },
		];

		expect(
			importMentionMarkdown(
				"[$hotline](app://connector_openai_hotline)",
				itemsWithSameName
			)
		).toBe("@Hotline");
	});

	test("keeps a typed link when only a different mention kind has that label", () => {
		const plugin = { id: "github", kind: "plugin", label: "GitHub" };
		const personLink = "[@GitHub](person://user-1)";
		const connectorLink = "[$Hotline](app://connector_openai_hotline)";

		expect(importMentionMarkdown(personLink, [plugin])).toBe(personLink);
		expect(
			importMentionMarkdown(connectorLink, [
				{ id: "app-hotline", kind: "app", label: "Hotline" },
			])
		).toBe(connectorLink);
	});

	test("copies selected mention tokens as portable Markdown links", () => {
		const source =
			"@Ryu Pricing Economics @Captcha answer check @<apps/desktop/src/lib/files.ts> @Hotline @GitHub @thermos";
		const markdown = exportMentionMarkdown(source, items);

		expect(markdown).toBe(
			"[Ryu Pricing Economics](sites-project://project-1) [Captcha answer check](chatgpt-conversation://conversation-1) [files.ts](apps/desktop/src/lib/files.ts) [$Hotline](app://connector_hotline) [@GitHub](plugin://github) [$thermos](skill://thermos)"
		);
		expect(importMentionMarkdown(markdown, items)).toBe(source);
	});

	test("uses a distinct typed link for every supported mention kind", () => {
		const typedItems: ComposerMentionItem[] = [
			{ id: "agent-1", kind: "agent", label: "Research agent" },
			{ id: "app-1", kind: "app", label: "Desktop app" },
			{ id: "resource-1", kind: "app-item", label: "App resource" },
			{
				id: "site-1",
				kind: "app-item",
				label: "Sites project",
				ownerId: "com.ryu.sites",
			},
			{ id: "chat-1", kind: "chat", label: "Saved chat" },
			{ id: "team-1", kind: "team", label: "Team" },
			{ id: "workflow-1", kind: "workflow", label: "Workflow" },
			{ id: "space-1", kind: "space", label: "Space" },
			{ id: "page-1", kind: "page", label: "Page" },
			{ id: "style-1", kind: "output-style", label: "Output style" },
			{ id: "skill-1", kind: "skill", label: "Skill" },
			{ id: "mcp-1", kind: "mcp", label: "MCP server" },
			{ id: "C:\\ryu", kind: "folder", label: "Project folder" },
			{ id: "service-1", kind: "integration", label: "Connected service" },
			{ id: "plugin-1", kind: "plugin", label: "Installed plugin" },
			{ id: "user-1", kind: "user", label: "Team member" },
		];
		const source = typedItems.map((item) => `@${item.label}`).join(" ");
		const markdown = [
			"[@Research agent](agent://agent-1)",
			"[$Desktop app](app://app-1)",
			"[@App resource](app-item://resource-1)",
			"[Sites project](sites-project://site-1)",
			"[Saved chat](chatgpt-conversation://chat-1)",
			"[@Team](team://team-1)",
			"[@Workflow](workflow://workflow-1)",
			"[@Space](space://space-1)",
			"[@Page](page://page-1)",
			"[@Output style](output-style://style-1)",
			"[$Skill](skill://skill-1)",
			"[@MCP server](mcp://mcp-1)",
			"[@Project folder](folder://C%3A%5Cryu)",
			"[$Connected service](app://connector_service-1)",
			"[@Installed plugin](plugin://plugin-1)",
			"[@Team member](user://user-1)",
		].join(" ");

		expect(exportMentionMarkdown(source, typedItems)).toBe(markdown);
		expect(importMentionMarkdown(markdown, typedItems)).toBe(source);
	});
});

describe("mention drop spacing", () => {
	test("trims the gap a chip leaves at the line start", () => {
		expect(shouldTrimGapAfterRemovedMention("", " x", 1)).toBe(true);
		expect(shouldTrimGapAfterRemovedMention(undefined, " x", 0)).toBe(true);
	});

	test("trims the gap a chip leaves between two spaces", () => {
		expect(shouldTrimGapAfterRemovedMention("a ", " b", 1)).toBe(true);
	});

	test("keeps the space that separates the neighbouring words", () => {
		expect(shouldTrimGapAfterRemovedMention("a", " b", 1)).toBe(false);
	});

	test("keeps the space after a preceding chip's empty text node", () => {
		expect(shouldTrimGapAfterRemovedMention("", " b", 3)).toBe(false);
	});

	test("does not trim when the chip was the last child or no space follows", () => {
		expect(shouldTrimGapAfterRemovedMention("a ", "", 1)).toBe(false);
		expect(shouldTrimGapAfterRemovedMention("a ", undefined, 1)).toBe(false);
		expect(shouldTrimGapAfterRemovedMention("a ", "b", 1)).toBe(false);
	});

	test("pads both sides when dropped mid-word", () => {
		expect(
			mentionDropPadding({
				after: "c",
				before: "b",
				hasNext: true,
				hasPrevious: true,
			})
		).toEqual({ lead: true, trail: true });
	});

	test("adds no padding after a space before punctuation", () => {
		expect(
			mentionDropPadding({
				after: ".",
				before: " ",
				hasNext: true,
				hasPrevious: true,
			})
		).toEqual({ lead: false, trail: false });
	});

	test("leads but does not trail before closing punctuation", () => {
		for (const after of [".", ",", ";", ":", "!", "?", "'", '"', ")", "]"]) {
			expect(
				mentionDropPadding({
					after,
					before: "a",
					hasNext: true,
					hasPrevious: true,
				})
			).toEqual({ lead: true, trail: false });
		}
	});

	test("trails but does not lead after whitespace", () => {
		expect(
			mentionDropPadding({
				after: "b",
				before: " ",
				hasNext: true,
				hasPrevious: true,
			})
		).toEqual({ lead: false, trail: true });
	});

	test("does not trail when whitespace already follows", () => {
		for (const after of [" ", "\t"]) {
			expect(
				mentionDropPadding({
					after,
					before: "a",
					hasNext: true,
					hasPrevious: true,
				})
			).toEqual({ lead: true, trail: false });
		}
	});

	test("adds no padding in an empty paragraph", () => {
		expect(mentionDropPadding({ hasNext: false, hasPrevious: false })).toEqual({
			lead: false,
			trail: false,
		});
	});

	test("pads after a preceding inline at offset zero", () => {
		expect(
			mentionDropPadding({ after: "x", hasNext: true, hasPrevious: true })
		).toEqual({ lead: true, trail: true });
	});
});

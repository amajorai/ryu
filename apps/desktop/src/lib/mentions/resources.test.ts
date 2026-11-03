import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { OutputStyleSummary } from "@/src/lib/api/output-styles.ts";
import type { Space, SpaceDocument } from "@/src/lib/api/spaces.ts";
import {
	buildContributedMentionSources,
	buildOutputStyleMentionSources,
	buildSpacePageMentionSources,
} from "./resources.ts";

const space = {
	createdAt: 0,
	description: null,
	documentCount: 1,
	icon: null,
	id: "space-1",
	name: "Planning",
	retrievalMode: "vector",
	system: false,
	updatedAt: 0,
} satisfies Space;

const document = {
	byteSize: null,
	chunkCount: 1,
	createdAt: 0,
	icon: null,
	indexMessage: null,
	indexState: null,
	indexWarnings: [],
	kind: "page",
	mime: null,
	rawKind: "page",
	spaceId: "space-1",
	title: "Launch plan",
	id: "page-1",
	updatedAt: 0,
} satisfies SpaceDocument;

const english: LiteralMessage = (source, values = {}) =>
	formatMessage(source, values, "en");

const JA: Record<string, string> = {
	Page: "ページ",
	Untitled: "無題",
	Whiteboard: "ホワイトボード",
	"{space} · {kind}": "{space} · {kind}",
};
const japanese: LiteralMessage = (source, values = {}) =>
	formatMessage(JA[source] ?? source, values, "ja");

describe("mention resource bridges", () => {
	test("uses the shared sidebar row and target template for app items", () => {
		const items = buildContributedMentionSources([
			{
				contribution: {
					id: "canvas",
					plugin: "com.ryu.canvas",
					title: "Canvas",
					spec: {
						itemTarget: "/spaces/{{item.space_id}}/app/canvas/{{item.id}}",
					},
				},
				rows: [
					{
						raw: { id: "doc 1", space_id: "space 1" },
						item: {
							id: "doc 1",
							subtitle: "Product brief",
							title: "Launch board",
						},
					},
				],
			},
		]);

		expect(items).toEqual([
			{
				description: "Canvas · Product brief",
				id: "com.ryu.canvas:canvas:doc 1",
				name: "Launch board",
				ownerId: "com.ryu.canvas",
				target: {
					options: {},
					path: "/spaces/space%201/app/canvas/doc%201",
				},
			},
		]);
	});

	test("builds routes for Space pages and keeps style metadata searchable", () => {
		expect(
			buildSpacePageMentionSources([space], [[document]], english)
		).toEqual([
			{
				description: "Planning · Page",
				id: "space-1:page-1",
				name: "Launch plan",
				target: { path: "/spaces/space-1/doc/page-1" },
			},
		]);

		const untitled = { ...document, id: "page-2", title: "  " };
		const board = { ...document, id: "wb-1", kind: "whiteboard" as const };
		expect(
			buildSpacePageMentionSources([space], [[untitled, board]], japanese).map(
				({ description, name }) => ({ description, name })
			)
		).toEqual([
			{ description: "Planning · ページ", name: "無題" },
			{ description: "Planning · ホワイトボード", name: "Launch plan" },
		]);

		const style = {
			active: true,
			description: "Short and direct",
			editable: true,
			forced: false,
			id: "plain",
			keep_coding_instructions: false,
			name: "Plain text",
			source: "user",
		} satisfies OutputStyleSummary;
		expect(buildOutputStyleMentionSources([style])).toEqual([
			{
				description: "Short and direct",
				id: "plain",
				name: "Plain text",
				target: { path: "/library/agent" },
			},
		]);
	});
});

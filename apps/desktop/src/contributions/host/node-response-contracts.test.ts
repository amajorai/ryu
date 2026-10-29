import { describe, expect, it } from "bun:test";
import {
	activityScoreInputSchema,
	backgroundStopResponseSchema,
	mailAttachmentInputSchema,
	nodeResponseDocumentSchema,
	parseCompanionCommands,
	parseCompanionEventChannels,
	parseCompanionTabIcons,
	questCaptureInputSchema,
	questWriteInputSchema,
} from "./node-response-contracts.ts";

describe("companion node boundaries", () => {
	it("retains additive response fields and original identity while checking bridge values", () => {
		const response = {
			id: "a",
			nested: [{ future: true }],
			optional: undefined,
		};
		expect(nodeResponseDocumentSchema.parse(response)).toBe(response);
		expect(
			nodeResponseDocumentSchema.safeParse({ callback: () => 0 }).success
		).toBe(false);
		expect(
			backgroundStopResponseSchema.safeParse({
				ok: true,
				requested: true,
				process_id: "p",
			}).success
		).toBe(true);
		expect(
			backgroundStopResponseSchema.safeParse({
				ok: true,
				requested: "yes",
				process_id: "p",
			}).success
		).toBe(false);
	});
	it("keeps valid commands beside malformed rows and ignores invalid optional labels", () => {
		expect(
			parseCompanionCommands({
				commands: [
					null,
					{ id: 42, title: "bad" },
					{ id: "ok", title: "Run", group: 32, keywords: "search" },
				],
			})
		).toEqual([
			{ id: "ok", title: "Run", group: undefined, keywords: "search" },
		]);
		expect(parseCompanionCommands({ commands: "bad" })).toEqual([]);
	});
	it("keeps original icon indexes so skipping an invalid icon cannot change registry identity", () => {
		expect(
			parseCompanionTabIcons({
				icons: [
					{ pathPrefix: "", icon: "x" },
					{
						pathPrefix: "/mail",
						icon: "mail",
						priority: "bad",
						pathIncludes: "inbox",
					},
					{ pathPrefix: "/chat", icon: "chat", priority: 2 },
				],
			})
		).toEqual([
			{
				pathPrefix: "/mail",
				icon: "mail",
				priority: undefined,
				pathIncludes: "inbox",
				index: 1,
			},
			{ pathPrefix: "/chat", icon: "chat", priority: 2, index: 2 },
		]);
		expect(
			parseCompanionEventChannels({
				channels: ["connected", null, 4, "connected"],
			})
		).toEqual(["connected", "connected"]);
	});
	it("validates actual quest write and capture contracts without dropping additive fields", () => {
		const capture = {
			body: "keep this",
			kind: "snippet" as const,
			source: { app: "editor", url: null },
			future: true,
		};
		expect(questCaptureInputSchema.parse(capture)).toBe(capture);
		expect(
			questCaptureInputSchema.safeParse({ ...capture, kind: "arbitrary" })
				.success
		).toBe(false);
		expect(questCaptureInputSchema.safeParse({ kind: "snippet" }).success).toBe(
			false
		);
		const write = {
			title: "finish",
			completion_condition: "tests pass",
			detail: null,
			future: 1,
		};
		expect(questWriteInputSchema.parse(write)).toBe(write);
		expect(
			questWriteInputSchema.safeParse({ ...write, title: 3 }).success
		).toBe(false);
	});
	it("rejects malformed gateway assertions and attachment records before node I/O", () => {
		const score = {
			response: { text: "done" },
			assertions: [{ kind: "contains" as const, value: "done" }],
			metadata: { source: "companion" },
			context: { future: "retained" },
		};
		expect(activityScoreInputSchema.parse(score)).toBe(score);
		expect(
			activityScoreInputSchema.safeParse({
				...score,
				assertions: [{ kind: "contains" }],
			}).success
		).toBe(false);
		expect(
			mailAttachmentInputSchema.safeParse({
				filename: "x",
				content_type: "text/plain",
				content: "test",
			}).success
		).toBe(true);
		expect(mailAttachmentInputSchema.safeParse({ filename: "x" }).success).toBe(
			false
		);
	});
});

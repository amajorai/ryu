import { expect, test } from "bun:test";
import {
	AutomationBodySchema,
	PublicCommentBodySchema,
	PublicRequestBodySchema,
	ReleaseDraftSchema,
	RequestPatchSchema,
	TriageBodySchema,
} from "./feedback-board-fixture-contract.ts";

test("feedback patches validate owner field types while retaining opaque JSON metadata", () => {
	expect(
		RequestPatchSchema.parse({
			public_visible: false,
			impact_score: null,
			tags: [],
			vendor: { retained: true },
		})
	).toMatchObject({
		public_visible: false,
		impact_score: null,
		tags: [],
		vendor: { retained: true },
	});
	expect(() => RequestPatchSchema.parse({ public_visible: "false" })).toThrow();
	expect(() => RequestPatchSchema.parse({ tags: [12] })).toThrow();
});

test("triage and automation boundaries validate their actual API owner contracts", () => {
	const suggestion = {
		category: "Ideas",
		confidence: 0,
		duplicate_request_ids: [],
		impact_score: -1,
		summary: "",
		tags: [],
	};
	expect(TriageBodySchema.parse({ suggestion }).suggestion).toEqual(suggestion);
	expect(() =>
		TriageBodySchema.parse({
			suggestion: { ...suggestion, impact_score: "84" },
		})
	).toThrow();
	expect(
		AutomationBodySchema.parse({
			mode: "manual",
			workflow_id: null,
			plan_id: null,
		})
	).toMatchObject({ mode: "manual", workflow_id: null, plan_id: null });
	expect(() => AutomationBodySchema.parse({ mode: "unsupported" })).toThrow();
});

test("public write boundaries retain empty drafts for the existing required-text validation", () => {
	expect(
		PublicRequestBodySchema.parse({ title: "", body: "", author_name: "" })
	).toMatchObject({ title: "", body: "", author_name: "" });
	expect(PublicCommentBodySchema.parse({ body: "" }).body).toBe("");
	expect(
		ReleaseDraftSchema.parse({ title: "", body: "", request_ids: [] })
			.request_ids
	).toEqual([]);
	expect(() => PublicRequestBodySchema.parse({ title: 12 })).toThrow();
});

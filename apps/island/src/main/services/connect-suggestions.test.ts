import { describe, expect, it } from "bun:test";
import { parseConnectSuggestionNotifications } from "./connect-suggestions-shared.ts";

describe("parseConnectSuggestionNotifications", () => {
	it("surfaces only live Island connection suggestions with valid fields", () => {
		const notifications = parseConnectSuggestionNotifications([
			{
				id: "ntf_connect_1",
				title: "A reset request arrived",
				body: "Review it in the source app.",
				created_at: "2026-09-29T01:00:00Z",
				source_app_id: "@ryu/island",
				archived_at: null,
			},
			{
				id: "other_app",
				title: "Ignore this row",
				created_at: "2026-09-29T01:00:00Z",
				source_app_id: "@ryu/other",
			},
			{
				id: "archived",
				title: "Already resolved",
				created_at: "2026-09-29T01:00:00Z",
				source_app_id: "@ryu/island",
				archived_at: "2026-09-29T01:01:00Z",
			},
			{ id: "malformed", source_app_id: "@ryu/island" },
		]);

		expect(notifications).toEqual([
			{
				id: "ntf_connect_1",
				title: "A reset request arrived",
				body: "Review it in the source app.",
				createdAt: "2026-09-29T01:00:00Z",
			},
		]);
	});
});

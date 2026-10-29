import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ChatSearchableMessage } from "../lib/chat-search.ts";
import { useChatSearch } from "./useChatSearch.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

test("typing reuses history; closed/empty search does no work; streaming and conversation changes refresh results", async () => {
	let reads = 0;
	const messages: ChatSearchableMessage[] = [
		{
			id: "u1",
			role: "user",
			get content() {
				reads++;
				return "Deployment plan";
			},
		},
	];
	let result: ReturnType<typeof useChatSearch> = [];
	function Harness({
		rows,
		query,
		enabled,
	}: {
		rows: ChatSearchableMessage[];
		query: string;
		enabled: boolean;
	}) {
		result = useChatSearch(rows, query, enabled);
		return null;
	}
	const root = createRoot(document.createElement("div"));
	async function render(query: string, enabled = true, rows = messages) {
		await act(async () =>
			root.render(<Harness enabled={enabled} query={query} rows={rows} />)
		);
	}
	try {
		await render("deploy", false);
		await render("   ");
		expect(reads).toBe(0);
		await render("deploy");
		expect(result.map((row) => row.messageId)).toEqual(["u1"]);
		const firstReads = reads;
		for (const query of ["deployment", "plan", "missing"]) {
			await render(query);
		}
		expect(reads).toBe(firstReads);
		expect(result).toEqual([]);
		await render("ready", true, [
			...messages,
			{ id: "a1", role: "assistant", parts: [{ type: "text", text: "Ready" }] },
		]);
		expect(result[0]?.anchorMessageId).toBe("u1");
		await render("ready", true, [
			{ id: "other", role: "user", content: "New conversation" },
		]);
		expect(result).toEqual([]);
		await render("plan", false);
		expect(result).toEqual([]);
		await render("plan");
		expect(result[0]?.messageId).toBe("u1");
	} finally {
		await act(async () => root.unmount());
	}
});

import { describe, expect, mock, test } from "bun:test";

mock.module("@ryu/blocks/desktop/agent-elements/text-shimmer", () => ({
	TextShimmer: () => null,
}));
mock.module("@/components/agent-elements/message-list.tsx", () => ({
	MessageList: () => null,
}));

const { extractSubagents, subagentTaskTitle } = await import(
	"@/src/components/panels/CoworkContextPanel.tsx"
);

function assistantMessage(
	parts: NonNullable<Parameters<typeof extractSubagents>[0][number]["parts"]>
) {
	return { role: "assistant", parts };
}

describe("subagent task titles", () => {
	test("uses the model-authored task description instead of an artificial name", () => {
		const [subagent] = extractSubagents([
			assistantMessage([
				{
					type: "tool-Task",
					toolCallId: "opaque-call-id",
					state: "input-available",
					input: {
						description: "Trace stats data flow",
						prompt: "Inspect every stats adapter and report how data moves.",
						subagent_type: "scout",
					},
				},
			]),
		]);

		expect(subagent.title).toBe("Trace stats data flow");
		expect(subagent.label).toBe("scout");
		expect("name" in subagent).toBe(false);
		expect(subagent.title).not.toBe("Atlas");
	});

	test("falls back to the prompt's first sentence", () => {
		expect(
			subagentTaskTitle({
				prompt:
					"Audit the workspace restore path. Then list any compatibility risks.",
			})
		).toBe("Audit the workspace restore path");
	});

	test("uses an honest fallback and truncates Unicode without splitting it", () => {
		expect(subagentTaskTitle({ description: "   ", prompt: null })).toBe(
			"Subagent task"
		);
		const title = subagentTaskTitle({
			description: "🙂".repeat(70),
		});
		expect([...title]).toHaveLength(60);
		expect(title.endsWith("…")).toBe(true);
	});
});

describe("extractSubagents", () => {
	test("keeps status, timing, nested work and final output", () => {
		const startedAt = 1_770_000_000_000;
		const completedAt = startedAt + 42_000;
		const [subagent] = extractSubagents([
			assistantMessage([
				{
					type: "tool-Agent",
					toolCallId: "task-1",
					state: "output-available",
					input: {
						description: "Review restore compatibility",
						prompt:
							"Review restored workspace tabs and report compatibility risks.",
					},
					callProviderMetadata: {
						ryu: { startedAt, completedAt, durationMs: 42_000 },
					},
				},
				{
					type: "tool-Edit",
					toolCallId: "task-1:edit-1",
					state: "output-available",
					input: { patch: "@@\n-old\n+new" },
				},
				{
					type: "tool-TaskOutput",
					toolCallId: "task-1:answer",
					output: { content: [{ text: "Restore path is compatible." }] },
				},
			]),
		]);

		expect(subagent.status).toBe("done");
		expect(subagent.timing).toEqual({
			startedAt,
			completedAt,
			durationMs: 42_000,
		});
		expect(subagent.steps).toBe(1);
		expect(subagent.changes).toEqual({ insertions: 1, deletions: 1 });
		expect(JSON.stringify(subagent.transcript)).toContain(
			"Restore path is compatible."
		);
	});

	test("distinguishes a running task from an errored task", () => {
		const subagents = extractSubagents([
			assistantMessage([
				{
					type: "tool-Task",
					toolCallId: "running",
					state: "input-available",
					input: { description: "Explore stats flow" },
				},
				{
					type: "tool-Agent",
					toolCallId: "failed",
					state: "output-error",
					input: { description: "Check issue history" },
				},
			]),
		]);

		expect(
			subagents.map(({ status, errored }) => ({ status, errored }))
		).toEqual([
			{ status: "running", errored: false },
			{ status: "done", errored: true },
		]);
	});
});

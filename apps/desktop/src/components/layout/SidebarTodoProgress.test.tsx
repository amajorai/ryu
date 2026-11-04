import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { publishSidebarTodoProgress } from "@/src/store/useSidebarTodoProgressStore.ts";
import type { Conversation } from "@/types/chat.ts";
import { SidebarTodoProgress } from "./SidebarTodoProgress.tsx";

const NODE_URL = "http://progress-proof.local";

function conversation(id: string): Conversation {
	return {
		createdAt: 1,
		id,
		messages: [],
		title: id,
		updatedAt: 1,
	};
}

describe("SidebarTodoProgress", () => {
	it("renders no rail when a conversation has no todo snapshot", () => {
		const html = renderToStaticMarkup(
			<SidebarTodoProgress
				conversation={conversation("no-progress")}
				nodeUrl={NODE_URL}
			/>
		);

		expect(html).toBe("");
	});

	it("renders an active rail and plan-badge sheen", () => {
		const current = conversation("active-progress");
		publishSidebarTodoProgress({
			key: JSON.stringify([NODE_URL, current.id]),
			messages: [
				{
					parts: [
						{
							type: "tool-TodoWrite",
							input: {
								todos: [
									{ content: "Inspect", status: "completed" },
									{ content: "Build", status: "in_progress" },
									{ content: "Verify", status: "pending" },
								],
							},
						},
					],
				},
			],
			revision: current.updatedAt,
		});

		const html = renderToStaticMarkup(
			<SidebarTodoProgress conversation={current} nodeUrl={NODE_URL} />
		);

		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-valuenow="33"');
		expect(html).toContain("t-plan-badge-sheen");
		expect(html).not.toContain("sidebar-todo-complete");
	});

	it("renders the session-only completion treatment when requested", () => {
		const complete = conversation("complete-progress");
		publishSidebarTodoProgress({
			key: JSON.stringify([NODE_URL, complete.id]),
			messages: [
				{
					parts: [
						{
							type: "tool-TodoWrite",
							input: {
								todos: [{ content: "Ship", status: "completed" }],
							},
						},
					],
				},
			],
			revision: complete.updatedAt,
		});

		const html = renderToStaticMarkup(
			<SidebarTodoProgress
				celebrate
				conversation={complete}
				nodeUrl={NODE_URL}
			/>
		);

		expect(html).toContain('aria-valuenow="100"');
		expect(html).toContain('data-testid="sidebar-todo-complete"');
		expect(html).toContain("bg-gradient-to-l");
		// The glow follows the tick to the inline end under right-to-left.
		expect(html).toContain("rtl:bg-gradient-to-r");
		expect(html).toContain('stroke-width="3"');
	});
});

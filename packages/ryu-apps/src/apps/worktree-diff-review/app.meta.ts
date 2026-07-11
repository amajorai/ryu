import type { AppMeta } from "../../shared/meta";

export default {
	slug: "worktree-diff-review",
	server: "ryu.worktree",
	name: "Worktree Diff Review",
	uri: "ui://widget/worktree-diff-review.html",
	defaultOn: true,
	displayMode: "inline",
	grants: ["chat.sendFollowUp"],
	tools: [
		{
			name: "review",
			widgetAccessible: false,
			description:
				"Render a per-file/per-hunk diff review for a run's worktree.",
			invoking: "Computing diff…",
			invoked: "Diff ready",
			inputSchema: {
				type: "object",
				required: ["cwd"],
				properties: {
					run_id: { type: "string" },
					cwd: { type: "string" },
					base_ref: { type: "string" },
				},
			},
		},
		{
			name: "apply",
			widgetAccessible: true,
			description: "Apply the selected hunks (governed HITL write).",
			inputSchema: {
				type: "object",
				required: ["run_id", "hunk_ids"],
				properties: {
					run_id: { type: "string" },
					hunk_ids: { type: "array", items: { type: "string" } },
				},
			},
		},
		{
			name: "open_pr",
			widgetAccessible: true,
			description: "Open a pull request for the run's branch.",
			inputSchema: {
				type: "object",
				required: ["run_id", "title"],
				properties: {
					run_id: { type: "string" },
					title: { type: "string" },
				},
			},
		},
		{
			name: "discard",
			widgetAccessible: true,
			description: "Discard the selected hunks.",
			inputSchema: {
				type: "object",
				required: ["run_id", "hunk_ids"],
				properties: {
					run_id: { type: "string" },
					hunk_ids: { type: "array", items: { type: "string" } },
				},
			},
		},
	],
} satisfies AppMeta;

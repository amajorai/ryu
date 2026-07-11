import type { AppMeta } from "../../shared/meta";

export default {
	slug: "quest-board",
	server: "ryu.quests",
	name: "Quest Board",
	uri: "ui://widget/quest-board.html",
	defaultOn: true,
	displayMode: "inline",
	grants: ["chat.sendFollowUp"],
	tools: [
		{
			name: "board",
			widgetAccessible: false,
			description: "Render the quests kanban grouped by status or priority.",
			invoking: "Loading quests…",
			invoked: "Quests ready",
			inputSchema: {
				type: "object",
				properties: {
					filter: {
						type: "object",
						properties: {
							status: { type: "string" },
							project_cwd: { type: "string" },
						},
					},
					group_by: { type: "string", enum: ["status", "priority"] },
				},
			},
		},
		{
			name: "update",
			widgetAccessible: true,
			description: "Move a quest to a new status/order.",
			inputSchema: {
				type: "object",
				required: ["id", "status"],
				properties: {
					id: { type: "string" },
					status: { type: "string" },
					order: { type: "number" },
				},
			},
		},
		{
			name: "complete",
			widgetAccessible: true,
			description: "Mark a quest complete.",
			inputSchema: {
				type: "object",
				required: ["id"],
				properties: { id: { type: "string" } },
			},
		},
		{
			name: "create",
			widgetAccessible: true,
			description: "Create a new quest.",
			inputSchema: {
				type: "object",
				required: ["title", "project_cwd"],
				properties: {
					title: { type: "string" },
					project_cwd: { type: "string" },
				},
			},
		},
	],
} satisfies AppMeta;

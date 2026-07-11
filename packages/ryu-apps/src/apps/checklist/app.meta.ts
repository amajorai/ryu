import type { AppMeta } from "../../shared/meta";

export default {
	slug: "checklist",
	server: "checklist",
	name: "Checklist",
	uri: "ui://widget/checklist.html",
	defaultOn: true,
	displayMode: "inline",
	grants: ["chat.sendFollowUp"],
	tools: [
		{
			name: "render",
			widgetAccessible: false,
			description: "Render an interactive checklist from a title and items.",
			invoking: "Building checklist…",
			invoked: "Checklist ready",
			inputSchema: {
				type: "object",
				required: ["title", "items"],
				properties: {
					title: { type: "string" },
					items: {
						type: "array",
						items: {
							type: "object",
							required: ["text"],
							properties: {
								text: { type: "string" },
								done: { type: "boolean" },
							},
						},
					},
				},
			},
		},
		{
			name: "update",
			widgetAccessible: true,
			description: "Toggle, add, edit, or remove a checklist item.",
			inputSchema: {
				type: "object",
				required: ["list_id", "op"],
				properties: {
					list_id: { type: "string" },
					item_id: { type: "string" },
					done: { type: "boolean" },
					text: { type: "string" },
					op: { type: "string", enum: ["toggle", "add", "edit", "remove"] },
				},
			},
		},
	],
} satisfies AppMeta;

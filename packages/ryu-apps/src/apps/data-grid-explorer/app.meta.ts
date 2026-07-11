import type { AppMeta } from "../../shared/meta";

export default {
	slug: "data-grid-explorer",
	server: "table",
	name: "Data Grid Explorer",
	uri: "ui://widget/data-grid-explorer.html",
	defaultOn: true,
	displayMode: "inline",
	grants: ["chat.sendFollowUp"],
	tools: [
		{
			name: "render",
			widgetAccessible: false,
			description:
				"Render a sortable, filterable data grid. Full rows ride in _meta (widget-only).",
			invoking: "Building table…",
			invoked: "Table ready",
			inputSchema: {
				type: "object",
				required: ["columns", "rows", "primary_key"],
				properties: {
					columns: {
						type: "array",
						items: {
							type: "object",
							required: ["key", "label", "type"],
							properties: {
								key: { type: "string" },
								label: { type: "string" },
								type: { type: "string" },
							},
						},
					},
					rows: { type: "array", items: { type: "object" } },
					primary_key: { type: "string" },
					page_size: { type: "number" },
					editable: { type: "boolean" },
				},
			},
		},
		{
			name: "act_on_rows",
			widgetAccessible: true,
			description: "Apply an action to the selected rows.",
			inputSchema: {
				type: "object",
				required: ["selected_keys", "action"],
				properties: {
					selected_keys: { type: "array", items: { type: "string" } },
					action: { type: "string" },
				},
			},
		},
	],
} satisfies AppMeta;

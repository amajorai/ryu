import type { AppMeta } from "../../shared/meta";

export default {
	slug: "chart-studio",
	server: "chart",
	name: "Chart Studio",
	uri: "ui://widget/chart-studio.html",
	defaultOn: true,
	displayMode: "inline",
	grants: ["chat.sendFollowUp"],
	tools: [
		{
			name: "render",
			widgetAccessible: false,
			description:
				"Render an interactive chart. Widget reads full series; model reads summary.",
			invoking: "Plotting chart…",
			invoked: "Chart ready",
			inputSchema: {
				type: "object",
				required: ["title", "series", "chart_type"],
				properties: {
					title: { type: "string" },
					series: {
						type: "array",
						items: {
							type: "object",
							required: ["name", "points"],
							properties: {
								name: { type: "string" },
								points: {
									type: "array",
									items: {
										type: "object",
										required: ["x", "y"],
										properties: {
											x: { type: "number" },
											y: { type: "number" },
										},
									},
								},
							},
						},
					},
					chart_type: {
						type: "string",
						enum: ["line", "bar", "area", "scatter"],
					},
					x_label: { type: "string" },
					y_label: { type: "string" },
					annotations: { type: "array", items: { type: "object" } },
				},
			},
		},
		{
			name: "query_range",
			widgetAccessible: true,
			description: "Request data for a brushed x-range.",
			inputSchema: {
				type: "object",
				required: ["x_start", "x_end"],
				properties: {
					x_start: { type: "number" },
					x_end: { type: "number" },
				},
			},
		},
	],
} satisfies AppMeta;

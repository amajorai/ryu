import type { AppMeta } from "../../shared/meta";

export default {
	slug: "smart-intake-form",
	server: "app.form",
	name: "Smart Intake Form",
	uri: "ui://widget/smart-intake-form.html",
	defaultOn: true,
	displayMode: "inline",
	tools: [
		{
			name: "render",
			widgetAccessible: false,
			description:
				"Render a pre-filled intake form the user reviews and corrects.",
			invoking: "Preparing form…",
			invoked: "Form ready",
			inputSchema: {
				type: "object",
				required: ["title", "fields"],
				properties: {
					title: { type: "string" },
					submitLabel: { type: "string" },
					fields: {
						type: "array",
						items: {
							type: "object",
							required: ["key", "label", "type"],
							properties: {
								key: { type: "string" },
								label: { type: "string" },
								type: {
									type: "string",
									enum: ["text", "number", "date", "select", "toggle", "email"],
								},
								value: {},
								options: { type: "array", items: { type: "string" } },
								required: { type: "boolean" },
							},
						},
					},
				},
			},
		},
		{
			name: "submit",
			widgetAccessible: true,
			description: "Submit the user-confirmed form values.",
			inputSchema: {
				type: "object",
				required: ["formId", "values"],
				properties: {
					formId: { type: "string" },
					values: { type: "object" },
				},
			},
		},
	],
} satisfies AppMeta;

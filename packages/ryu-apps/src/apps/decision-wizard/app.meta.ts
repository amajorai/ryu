import type { AppMeta } from "../../shared/meta";

export default {
	slug: "decision-wizard",
	server: "app.decision",
	name: "Decision Wizard",
	uri: "ui://widget/decision-wizard.html",
	defaultOn: true,
	displayMode: "inline",
	tools: [
		{
			name: "flow",
			widgetAccessible: false,
			description:
				"Render a step-by-step decision flow (quiz, weighted, or compare).",
			invoking: "Preparing decision…",
			invoked: "Decision ready",
			inputSchema: {
				type: "object",
				required: ["mode", "steps"],
				properties: {
					mode: { type: "string", enum: ["quiz", "weighted", "compare"] },
					steps: {
						type: "array",
						items: {
							type: "object",
							required: ["id", "question", "options"],
							properties: {
								id: { type: "string" },
								question: { type: "string" },
								options: {
									type: "array",
									items: {
										type: "object",
										required: ["label", "value"],
										properties: {
											label: { type: "string" },
											value: {},
											weight: { type: "number" },
										},
									},
								},
							},
						},
					},
					options: { type: "object" },
				},
			},
		},
		{
			name: "submit",
			widgetAccessible: true,
			description: "Submit the answers and computed outcome.",
			inputSchema: {
				type: "object",
				required: ["flowId", "answers", "outcome"],
				properties: {
					flowId: { type: "string" },
					answers: {
						type: "array",
						items: {
							type: "object",
							required: ["stepId", "value"],
							properties: { stepId: { type: "string" }, value: {} },
						},
					},
					outcome: {},
				},
			},
		},
	],
} satisfies AppMeta;

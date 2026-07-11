import type { AppMeta } from "../../shared/meta";

export default {
	slug: "gateway-budget-dial",
	server: "ryu.gateway",
	name: "Gateway Budget Dial",
	uri: "ui://widget/gateway-budget-dial.html",
	defaultOn: true,
	displayMode: "inline",
	grants: ["chat.sendFollowUp"],
	tools: [
		{
			name: "budget",
			widgetAccessible: false,
			description:
				"Render the spent-vs-limit meter with a per-model breakdown.",
			invoking: "Reading budget…",
			invoked: "Budget ready",
			inputSchema: {
				type: "object",
				required: ["scope"],
				properties: {
					scope: { type: "string", enum: ["user", "org", "session"] },
					period: { type: "string", enum: ["day", "month"] },
				},
			},
		},
		{
			name: "budget.set",
			widgetAccessible: true,
			description:
				"Write a new Gateway-owned, audited budget rule (governed HITL).",
			inputSchema: {
				type: "object",
				required: ["scope", "limit", "period"],
				properties: {
					scope: { type: "string", enum: ["user", "org", "session"] },
					limit: { type: "number" },
					period: { type: "string", enum: ["day", "month"] },
					per_model: { type: "object" },
				},
			},
		},
	],
} satisfies AppMeta;

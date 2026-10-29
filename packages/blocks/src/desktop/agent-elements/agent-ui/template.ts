import { z } from "zod";
import { agentUiCatalog } from "./catalog.ts";

const TEMPLATE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PARAMETER_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const AgentUiElementSchema = z
	.object({
		type: z.string().min(1).max(64),
		props: z.record(z.string(), z.unknown()).default({}),
		children: z.array(z.string().min(1).max(128)).max(100).default([]),
		on: z.record(z.string(), z.unknown()).optional(),
	})
	.strict()
	.superRefine((element, context) => {
		if (!agentUiCatalog.componentNames.includes(element.type)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Unknown Agent-UI component: ${element.type}`,
				path: ["type"],
			});
		}
	});

export const AgentUiSpecSchema = z
	.object({
		root: z.string().min(1).max(128),
		elements: z
			.record(z.string().min(1).max(128), AgentUiElementSchema)
			.refine((elements) => Object.keys(elements).length <= 100, {
				message: "Agent-UI specs may contain at most 100 elements",
			}),
	})
	.strict()
	.superRefine((spec, context) => {
		if (!(spec.root in spec.elements)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "The Agent-UI root must reference an element",
				path: ["root"],
			});
		}

		for (const [elementId, element] of Object.entries(spec.elements)) {
			for (const childId of element.children) {
				if (!(childId in spec.elements)) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `Element '${elementId}' references missing child '${childId}'`,
						path: ["elements", elementId, "children"],
					});
				}
			}
		}

		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (elementId: string) => {
			if (visiting.has(elementId)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Agent-UI element children may not contain cycles",
					path: ["elements", elementId, "children"],
				});
				return;
			}
			const element = spec.elements[elementId];
			if (visited.has(elementId) || !element) {
				return;
			}
			visiting.add(elementId);
			for (const childId of element.children) {
				visit(childId);
			}
			visiting.delete(elementId);
			visited.add(elementId);
		};
		visit(spec.root);
	});

export const AgentUiTemplateParamSchema = z
	.object({
		name: z.string().regex(PARAMETER_NAME, "Invalid template parameter name"),
		type: z.enum(["string", "number", "boolean", "object", "array"]),
		required: z.boolean().default(false),
		default: z.unknown().optional(),
	})
	.strict();

export const AgentUiTemplateInputSchema = z
	.object({
		name: z.string().trim().min(1).max(120),
		description: z.string().trim().max(500).default(""),
		tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
		spec: AgentUiSpecSchema,
		params: z.array(AgentUiTemplateParamSchema).max(32).default([]),
		previewSpec: AgentUiSpecSchema.optional(),
		source: z.enum(["builtin", "agent", "user"]).default("user"),
	})
	.strict()
	.superRefine((template, context) => {
		const names = new Set<string>();
		for (const [index, parameter] of template.params.entries()) {
			if (names.has(parameter.name)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Duplicate template parameter: ${parameter.name}`,
					path: ["params", index, "name"],
				});
			}
			names.add(parameter.name);
		}
	});

export const AgentUiTemplateSchema = AgentUiTemplateInputSchema.extend({
	id: z.string().regex(TEMPLATE_ID, "Invalid template id"),
	createdAt: z.string().datetime({ offset: true }),
	updatedAt: z.string().datetime({ offset: true }),
});

export type AgentUiSpec = z.infer<typeof AgentUiSpecSchema>;
export type AgentUiTemplate = z.infer<typeof AgentUiTemplateSchema>;
export type AgentUiTemplateInput = z.infer<typeof AgentUiTemplateInputSchema>;

export const parseAgentUiTemplate = AgentUiTemplateSchema.parse;

export const parseAgentUiTemplateInput = AgentUiTemplateInputSchema.parse;

export const safeParseAgentUiTemplate = AgentUiTemplateSchema.safeParse;

export const safeParseAgentUiTemplateInput =
	AgentUiTemplateInputSchema.safeParse;

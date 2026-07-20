// Agent-UI catalog: the constrained component vocabulary an agent may emit as a
// json-render spec. Each entry pairs a Zod prop schema (the contract the model
// generates against) with a short description used in `catalog.prompt()`.
//
// This file is React-free on purpose so it can also drive the model contract
// generator (scripts/gen-agent-ui-contract.ts). The actual rendering lives in
// ./registry.tsx, which maps every component here to a real `@ryu/ui` component.
//
// Spec format (flat, from @json-render/react/schema):
//   { root: "<key>", elements: { "<key>": { type, props, children: ["<key>"...] } } }

import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

const GAP = z
	.enum(["none", "xs", "sm", "md", "lg", "xl"])
	.describe("Space between children");

const ALIGN = z.enum(["start", "center", "end", "stretch"]);
const JUSTIFY = z.enum(["start", "center", "end", "between", "around"]);

const SelectOption = z.object({
	label: z.string().describe("Visible option text"),
	value: z.string().describe("Value written to state when chosen"),
});

export const agentUiCatalog = defineCatalog(schema, {
	components: {
		// ---- Layout -------------------------------------------------------------
		Stack: {
			props: z.object({
				direction: z
					.enum(["row", "column"])
					.optional()
					.describe("Flex direction (default: column)"),
				gap: GAP.optional(),
				align: ALIGN.optional(),
				justify: JUSTIFY.optional(),
				wrap: z.boolean().optional().describe("Allow children to wrap"),
			}),
			slots: ["default"],
			description:
				"Vertical or horizontal flex container. The primary layout primitive.",
		},
		Grid: {
			props: z.object({
				columns: z
					.number()
					.int()
					.min(1)
					.max(6)
					.optional()
					.describe("Number of equal columns (default: 2)"),
				gap: GAP.optional(),
			}),
			slots: ["default"],
			description: "Responsive equal-column grid.",
		},
		Card: {
			props: z.object({
				title: z.string().optional(),
				description: z.string().optional(),
			}),
			slots: ["default"],
			description:
				"Bordered surface with an optional title/description header. Group related content.",
		},
		Separator: {
			props: z.object({
				orientation: z.enum(["horizontal", "vertical"]).optional(),
			}),
			description: "A thin dividing line.",
		},

		// ---- Typography ---------------------------------------------------------
		Heading: {
			props: z.object({
				text: z.string().describe("Heading text"),
				level: z
					.number()
					.int()
					.min(1)
					.max(4)
					.optional()
					.describe("Heading level 1-4 (default: 2)"),
			}),
			description: "A section heading.",
		},
		Text: {
			props: z.object({
				text: z.string(),
				muted: z.boolean().optional().describe("Use muted/secondary color"),
				size: z.enum(["xs", "sm", "base", "lg"]).optional(),
				weight: z.enum(["normal", "medium", "semibold", "bold"]).optional(),
			}),
			description: "A paragraph or inline run of text.",
		},
		Link: {
			props: z.object({
				text: z.string(),
				href: z.string().describe("Destination URL"),
			}),
			description: "A hyperlink. Opens in a new tab.",
		},

		// ---- Media --------------------------------------------------------------
		Image: {
			props: z.object({
				src: z.string().describe("Image URL"),
				alt: z.string().optional().describe("Accessible description"),
				rounded: z.boolean().optional(),
			}),
			description: "An image.",
		},
		Avatar: {
			props: z.object({
				src: z.string().optional().describe("Avatar image URL"),
				alt: z.string().optional(),
				fallback: z
					.string()
					.optional()
					.describe("Initials shown when no image (e.g. 'JD')"),
			}),
			description: "A circular user/avatar image with initials fallback.",
		},

		// ---- Display ------------------------------------------------------------
		Badge: {
			props: z.object({
				text: z.string(),
				variant: z
					.enum(["default", "secondary", "outline", "destructive"])
					.optional(),
			}),
			description: "A small status/label pill.",
		},
		Alert: {
			props: z.object({
				title: z.string().optional(),
				description: z.string().optional(),
				variant: z.enum(["default", "destructive"]).optional(),
			}),
			description: "A callout box for important information or errors.",
		},
		Table: {
			props: z.object({
				columns: z.array(z.string()).describe("Column header labels"),
				rows: z
					.array(z.array(z.string()))
					.describe(
						"Row data; each row is an array of cell strings aligned to columns"
					),
			}),
			description: "A simple data table from columns + rows.",
		},
		Progress: {
			props: z.object({
				value: z
					.number()
					.min(0)
					.max(100)
					.describe("Completion percentage 0-100"),
				label: z.string().optional(),
			}),
			description: "A horizontal progress bar.",
		},
		Skeleton: {
			props: z.object({
				width: z
					.string()
					.optional()
					.describe("CSS width, e.g. '8rem' or '100%'"),
				height: z.string().optional().describe("CSS height, e.g. '1rem'"),
			}),
			description: "A loading placeholder block.",
		},

		// ---- Interactive (state-bound) -----------------------------------------
		Button: {
			props: z.object({
				label: z.string(),
				variant: z
					.enum([
						"default",
						"secondary",
						"outline",
						"ghost",
						"destructive",
						"link",
					])
					.optional(),
				size: z.enum(["sm", "default", "lg"]).optional(),
				disabled: z.boolean().optional(),
			}),
			description:
				"A clickable button. Attach an action with the element's `on.press` to mutate state (e.g. { action: 'setState', params: { path, value } }).",
		},
		Input: {
			props: z.object({
				placeholder: z.string().optional(),
				value: z
					.string()
					.optional()
					.describe("Bind to state with { $bindState: 'path' }"),
				label: z.string().optional(),
				type: z.enum(["text", "email", "password", "number"]).optional(),
			}),
			description:
				"A single-line text field. Two-way bind `value` to state via { $bindState: 'form.field' }.",
		},
		Textarea: {
			props: z.object({
				placeholder: z.string().optional(),
				value: z
					.string()
					.optional()
					.describe("Bind to state with { $bindState: 'path' }"),
				label: z.string().optional(),
				rows: z.number().int().min(1).max(20).optional(),
			}),
			description: "A multi-line text field. Two-way bind `value` to state.",
		},
		Checkbox: {
			props: z.object({
				label: z.string().optional(),
				checked: z
					.boolean()
					.optional()
					.describe("Bind to state with { $bindState: 'path' }"),
			}),
			description: "A boolean checkbox. Two-way bind `checked` to state.",
		},
		Switch: {
			props: z.object({
				label: z.string().optional(),
				checked: z
					.boolean()
					.optional()
					.describe("Bind to state with { $bindState: 'path' }"),
			}),
			description: "A boolean toggle switch. Two-way bind `checked` to state.",
		},
		Select: {
			props: z.object({
				placeholder: z.string().optional(),
				value: z
					.string()
					.optional()
					.describe("Bind to state with { $bindState: 'path' }"),
				options: z.array(SelectOption).describe("Selectable options"),
			}),
			description:
				"A dropdown select. Provide `options` as { label, value }[] and two-way bind `value` to state.",
		},
	},
	actions: {},
});

export type AgentUiCatalog = typeof agentUiCatalog;

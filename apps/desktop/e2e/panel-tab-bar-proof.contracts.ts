import type { ComponentProps } from "react";
import { z } from "zod";
import type { PanelTabBar } from "../src/components/panels/WorkspacePanels.tsx";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";

type NativePanelTab = ComponentProps<typeof PanelTabBar>["tabs"][number];
const proofTabKindSchema = z.union([
	z.enum([
		"terminal",
		"codereview",
		"files",
		"gitgraph",
		"cowork",
		"sources",
		"subagents",
		"subagent",
		"artifact",
		"inspector",
		"context",
		"mission",
		"agent-activity",
		"unavailable",
	]),
	z.templateLiteral(["plugin:", z.string()]),
	z.templateLiteral(["route:", z.string()]),
]) satisfies z.ZodType<NativePanelTab["kind"]>;
const proofTabFieldsSchema = z.object({
	kind: proofTabKindSchema,
	label: z.string(),
	pinned: z.boolean().optional(),
	uid: z.string(),
}) satisfies z.ZodType<
	Pick<NativePanelTab, "kind" | "label" | "pinned" | "uid">
>;
const dockSideSchema = z.enum(["bottom", "right"]);
const panelSnapshotFieldsSchema = z.object({
	active: z.object({ bottom: z.string(), right: z.string() }),
	closedPanelCount: z.object({ bottom: z.number(), right: z.number() }),
	events: z.array(
		z.object({
			action: z.string(),
			from: dockSideSchema.optional(),
			kind: proofTabKindSchema.optional(),
			label: z.string().optional(),
			to: dockSideSchema.optional(),
			uid: z.string().optional(),
		})
	),
	tabs: z.object({
		bottom: z.array(proofTabFieldsSchema),
		right: z.array(proofTabFieldsSchema),
	}),
});
export type PanelTabBarProofSnapshot = z.infer<
	typeof panelSnapshotFieldsSchema
>;
export const panelTabBarProofSnapshotSchema =
	z.custom<PanelTabBarProofSnapshot>((value) => {
		const parsed = pluginDocumentSchema.safeParse(value);
		return (
			parsed.success && panelSnapshotFieldsSchema.safeParse(parsed.data).success
		);
	});

import { z } from "zod";
import type { useNodeStore } from "../src/store/useNodeStore.ts";
import type { SidePanelRouteRequest } from "../src/store/useSidePanelRouteStore.ts";
import { type ProofJsonValue, parseProofJsonRecord } from "./fixture-json.ts";

export interface TitlebarNativeCall {
	args: ProofJsonValue | undefined;
	command: string;
}
export interface TitlebarRenameRequest {
	body: ProofJsonValue | null;
	method: string;
	path: string;
}
export interface TitlebarHost {
	calls: TitlebarNativeCall[];
	failFullscreen: boolean;
	fullscreen: boolean;
	renameRequests: TitlebarRenameRequest[];
}
type NodeFixtureStore = ReturnType<typeof useNodeStore.getState>;
export interface TitlebarFixtureHooks {
	__getNodeTabFixtureState: () => Pick<
		NodeFixtureStore,
		"defaultNode" | "tabOverrides"
	> & { nodes: string[] };
	__getNodeTabOverrides: () => NodeFixtureStore["tabOverrides"];
	__getPendingSidePanelRoute: () => SidePanelRouteRequest | null;
	__getRenameRequests: () => TitlebarRenameRequest[];
	__titlebarHost: TitlebarHost;
}
export interface TitlebarSplitNode {
	c?: TitlebarSplitNode[];
	i?: number;
	o?: "columns" | "rows";
	s?: number[];
}
const splitNodeSchema: z.ZodType<TitlebarSplitNode> = z.lazy(() =>
	z
		.object({
			c: z.array(splitNodeSchema).optional(),
			i: z.number().int().nonnegative().optional(),
			o: z.enum(["columns", "rows"]).optional(),
			s: z.array(z.number()).optional(),
		})
		.refine((node) =>
			node.c === undefined
				? node.i !== undefined
				: node.o !== undefined && node.s !== undefined
		)
);
const titlebarSessionSchema = z.object({
	activeIndex: z.number().int(),
	splits: z.array(splitNodeSchema).optional(),
	tabs: z.array(
		z.object({
			conversationId: z.string().optional(),
			path: z.string(),
			title: z.string(),
			pinned: z.boolean().optional(),
		})
	),
});
export type TitlebarPersistedSession = z.infer<typeof titlebarSessionSchema>;
export function parseTitlebarSession(
	raw: string | null
): TitlebarPersistedSession | null {
	if (raw === null) {
		return null;
	}
	const session = parseProofJsonRecord(raw);
	const checked = titlebarSessionSchema.parse(session);
	// Retain validated original JSON fields, including owner metadata and own prototype keys.
	return { ...checked, ...session };
}

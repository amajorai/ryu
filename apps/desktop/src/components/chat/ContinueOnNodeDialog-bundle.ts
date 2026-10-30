import {
	createRnpContextBundle,
	normalizeRnpNodeUrl,
	parseRnpContinuityBundle,
	type RnpContinuityBundleV0,
	type RnpResumeResultV0,
	type RnpWorkspaceDestinationV0,
	type RnpWorkspaceManifestV0,
	type RnpWorkspaceResumeResultV0,
} from "@ryuhq/protocol/continuity";
import type { Node } from "@/src/store/useNodeStore.ts";

/**
 * v1 resumes into a new clone only. A worktree added to an existing, trusted
 * checkout would inherit that checkout's workspace trust, so the destination
 * refuses existing-checkout mode until handed-off worktrees are excluded.
 */
export const NEW_CLONE_DESTINATION: RnpWorkspaceDestinationV0 = {
	mode: "new-clone",
};

/** The working-tree half of a frozen handoff: resent unchanged on retry. */
export interface AttemptedWorkspace {
	destination: RnpWorkspaceDestinationV0;
	manifest: RnpWorkspaceManifestV0;
}

export interface ContinueOnNodeDialogProps {
	conversationId: string;
	conversationTitle: string;
	nodes: readonly Node[];
	onCompleted: (
		node: Node,
		result: RnpResumeResultV0,
		workspace?: RnpWorkspaceResumeResultV0
	) => Promise<void> | void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	resolveNodes?: () => readonly Node[];
	sourceNode: Node;
	sourceUpdatedAt?: number;
}

export function errorMessage<TError>(error: TError): string {
	return error instanceof Error
		? error.message
		: "The handoff could not finish.";
}

export function sameNode(left: Node, right: Node): boolean {
	return normalizeRnpNodeUrl(left.url) === normalizeRnpNodeUrl(right.url);
}

export function currentNode(
	reference: Node,
	nodes: readonly Node[]
): Node | undefined {
	return nodes.find((node) => sameNode(node, reference));
}

export function buildResumeBundle(
	preview: RnpContinuityBundleV0,
	contextNote: string,
	includeAgentHint: boolean
): RnpContinuityBundleV0 {
	const context = contextNote
		? createRnpContextBundle({
				items: [
					{
						id: "operator-note",
						kind: "text",
						label: "Operator note",
						mediaType: "text/plain",
						text: contextNote,
						source: { kind: "manual" },
					},
				],
			})
		: { version: 0 as const, items: [] };
	const source = includeAgentHint
		? preview.source
		: {
				conversationId: preview.source.conversationId,
				updatedAt: preview.source.updatedAt,
				...(preview.source.checkpointMessageId
					? { checkpointMessageId: preview.source.checkpointMessageId }
					: undefined),
				...(preview.source.title ? { title: preview.source.title } : undefined),
			};
	const parsed = parseRnpContinuityBundle({ ...preview, source, context });
	if (!parsed.ok) {
		throw new Error(`The reviewed handoff is invalid: ${parsed.error.message}`);
	}
	return parsed.value;
}

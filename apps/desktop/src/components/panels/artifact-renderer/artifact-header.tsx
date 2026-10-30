// The shared artifact header and the kind glyph/label maps, split out of
// apps/desktop/src/components/chat/ArtifactRenderer.tsx (which re-exports them)
// so that file stays under the size limit.

import {
	BrowserIcon,
	DatabaseIcon,
	File01Icon,
	Flowchart01Icon,
	FolderOpenIcon,
	Image02Icon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useArtifactHost } from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { invoke } from "@tauri-apps/api/core";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import type { ArtifactKind } from "@/src/lib/artifacts.ts";
import {
	findLiveArtifactAction,
	liveArtifactActionChoices,
	type NativeArtifactActionObservation,
} from "@/src/lib/live-artifact-actions.ts";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";
import { NativeToolApprovalActions } from "@/src/lib/native-artifact-action-abi.ts";
import type {
	NativeArtifactEditorPathOperation,
	NativeArtifactFollowUpOperation,
} from "@/src/lib/native-artifact-io-abi.ts";

export const KIND_ICON = {
	html: BrowserIcon,
	svg: Image02Icon,
	mermaid: Flowchart01Icon,
	code: SourceCodeIcon,
	file: File01Icon,
	space: FolderOpenIcon,
	database: DatabaseIcon,
} satisfies Record<ArtifactKind, IconSvgElement>;

export const KIND_LABEL = {
	html: "Page",
	svg: "SVG",
	mermaid: "Diagram",
	code: "Code",
	file: "File",
	space: "Space",
	database: "Database",
} satisfies Record<ArtifactKind, string>;

/** Map an artifact action to a ToolApproval choice, wired to the host's
 *  follow-up so the user's pick becomes the agent's next prompt. */
/** The shared artifact header: kind glyph + title + badge, then (right-aligned)
 *  an approval-style action row and a file's "Open in editor" button. */
export function ArtifactHeader({
	artifact,
	compact,
	onOpenInEditor,
	onAction,
}: {
	artifact: ArtifactView;
	compact?: boolean;
	onOpenInEditor?: (filePath: string) => void;
	onAction?: (action: NativeArtifactActionObservation) => void;
}) {
	const { canUseNativeShell } = useAppSurface();
	// SAFETY: the unchanged actual host provider is viewed only through its raw
	// callback argument ABI. No method is read/bound here; the original optional
	// call below retains callee/label order, host receiver and native errors.
	const host = useArtifactHost() as NativeArtifactFollowUpOperation | null;
	const submit =
		onAction ??
		((action: NativeArtifactActionObservation) =>
			host?.submitFollowUp(action.label));
	const choices = liveArtifactActionChoices(artifact.actions, (text) => {
		const action = findLiveArtifactAction(artifact.actions, text);
		if (action) {
			submit(action);
		}
	});
	const defaultOpenInEditor =
		artifact.kind === "file" && artifact.filePath
			? (path: string) => {
					Promise.resolve(
						invoke("open_in_editor", { editor: "vscode", path })
					).catch(() => {
						/* the artifact stays viewable; nothing else to do */
					});
				}
			: undefined;
	// SAFETY: only the actual native editor callback argument ABI is exposed;
	// the same callback value receives the original raw SDK path. No string
	// value/DTO is asserted and downstream validation/errors stay native.
	const openInEditor = (
		canUseNativeShell ? (onOpenInEditor ?? defaultOpenInEditor) : undefined
	) as NativeArtifactEditorPathOperation | undefined;

	return (
		<div
			className={cn(
				"flex shrink-0 items-center gap-2 border-border border-b",
				compact ? "h-10 px-3" : "h-10 px-4"
			)}
		>
			<HugeiconsIcon
				aria-hidden
				className="size-4 shrink-0 text-muted-foreground"
				icon={KIND_ICON[artifact.kind]}
			/>
			<span
				className="min-w-0 flex-1 truncate font-medium text-foreground text-sm"
				title={artifact.title}
			>
				{artifact.title}
			</span>
			{artifact.kind === "file" && openInEditor && artifact.filePath ? (
				<Button
					className="shrink-0"
					onClick={() => openInEditor(artifact.filePath)}
					size="xs"
					variant="ghost-muted"
				>
					Open in editor
				</Button>
			) : null}
			<span className="shrink-0 text-muted-foreground text-xs">
				{KIND_LABEL[artifact.kind]}
			</span>
			{choices && choices.length > 0 ? (
				<NativeToolApprovalActions choices={choices} status="pending" />
			) : null}
		</div>
	);
}

import { LibraryIcon, WorkflowCircle06Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";

import { MarkdownEditor } from "@/src/components/editor/MarkdownEditor.tsx";
import { EntityIconDialog } from "@/src/components/layout/EntityIconDialog.tsx";

import { BacklinksPanel } from "@/src/components/spaces/BacklinksPanel.tsx";
import { VersionHistory } from "@/src/components/versioning/VersionHistory.tsx";
import { useSpaceDocEditorDocument } from "./SpaceDocEditorPage.document.ts";
import { SAVE_LABEL } from "./SpaceDocEditorPage.model.ts";
import { useSpaceDocEditorPersistence } from "./SpaceDocEditorPage.persistence.ts";

/**
 * A Notion-style page editor: loads a Space document's Markdown, edits it in the
 * full Plate editor, and autosaves (debounced) back to Core, which re-chunks and
 * re-embeds on every save. One tab per document.
 */
export default function SpaceDocEditorPage({
	spaceId,
	documentId,
}: {
	spaceId: string;
	documentId: string;
}) {
	const {
		collabReady,
		collaborative,
		cursorUser,
		doc,
		getDocument,
		handleRemoteReset,
		handleSyncedChange,
		iconDialogOpen,
		jwt,
		loadFailed,
		markdownRef,
		nodeToken,
		nodeUrl,
		nodeUserJwt,
		openTab,
		reloadNonce,
		saveDocument,
		saveState,
		setDoc,
		setDocumentIcon,
		setIconDialogOpen,
		setReloadNonce,
		setSaveState,
		setTitle,
		tabId,
		timerRef,
		title,
		titleRef,
		updateTabTitle,
		updateTabsIconWhere,
	} = useSpaceDocEditorDocument({ documentId, spaceId });
	const {
		collab,
		handleMarkdownChange,
		handleRestored,
		handleTitleChange,
		versionSource,
	} = useSpaceDocEditorPersistence({
		collabReady,
		cursorUser,
		doc,
		documentId,
		getDocument,
		handleRemoteReset,
		handleSyncedChange,
		jwt,
		markdownRef,
		nodeToken,
		nodeUrl,
		nodeUserJwt,
		saveDocument,
		setDoc,
		setReloadNonce,
		setSaveState,
		setTitle,
		spaceId,
		tabId,
		timerRef,
		titleRef,
		updateTabTitle,
	});

	if (loadFailed) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={LibraryIcon} />
					</EmptyMedia>
					<EmptyTitle>Couldn't open this page</EmptyTitle>
					<EmptyDescription>
						Something went wrong while loading it. Check your connection and try
						again.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						onClick={() => setReloadNonce((n) => n + 1)}
						size="sm"
						variant="outline"
					>
						Try again
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	// Wait for both the document body and the realtime JWT before mounting the
	// editor, so it can be created collaboratively in one shot (the Yjs provider
	// is fixed at editor-creation time and cannot be attached afterwards).
	if (!(doc && collabReady)) {
		return <SkeletonRows rows={6} spacing="library" />;
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<button
					aria-label="Change page icon"
					className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onClick={() => setIconDialogOpen(true)}
					title="Change icon…"
					type="button"
				>
					<GlyphDisplay
						fallback={<HugeiconsIcon className="size-4" icon={LibraryIcon} />}
						size={20}
						value={doc.icon}
					/>
				</button>
				<Input
					aria-label="Page title"
					onChange={(e) => handleTitleChange(e.target.value)}
					placeholder="Untitled"
					purpose="space-title"
					value={title}
				/>
				<span className="shrink-0 text-muted-foreground text-xs">
					{collaborative ? "Live" : SAVE_LABEL[saveState]}
				</span>
				<div className="shrink-0">
					<VersionHistory
						currentValue={markdownRef.current}
						onRestored={handleRestored}
						source={versionSource}
					/>
				</div>
				<Button
					className="shrink-0"
					onClick={() => openTab(`/spaces/${spaceId}/graph`)}
					size="sm"
					title="Open the knowledge graph for this space"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={WorkflowCircle06Icon} />
					Graph
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				<MarkdownEditor
					collab={collab}
					initialMarkdown={doc.source}
					key={`${documentId}:${reloadNonce}`}
					onChangeMarkdown={handleMarkdownChange}
					toolbar="two-row"
				/>
			</div>
			<BacklinksPanel documentId={documentId} spaceId={spaceId} />
			<EntityIconDialog
				description={title || "Untitled"}
				onChange={(next: GlyphValue) => {
					setDoc((prev) => (prev ? { ...prev, icon: next } : prev));
					updateTabsIconWhere(
						(t) =>
							t.path === `/spaces/${spaceId}/doc/${documentId}` ||
							t.path === `/spaces/${spaceId}/db/${documentId}`,
						next
					);
					void setDocumentIcon(spaceId, documentId, next).catch(() => {
						toast.error("Couldn't update page icon");
					});
				}}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				title="Page icon"
				value={doc.icon}
			/>
		</div>
	);
}

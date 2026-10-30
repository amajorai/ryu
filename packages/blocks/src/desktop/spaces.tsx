"use client";

// Presentational layer of the desktop Spaces (RAG) page. The live app
// (`apps/desktop/src/pages/SpacesPage.tsx`) is a thin container that loads spaces
// via `useSpacesContext()` and owns the ingest/search form state; the storyboard
// renders the same component with mock data and no-op handlers. One source of
// truth, so editing this block changes the real desktop too.

import { LibraryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs";
import type { ReactNode } from "react";
import { SpaceDetail } from "./spaces-detail.tsx";
import type { SpacesViewProps } from "./spaces-types.ts";

export type { SpaceFileIndexState } from "./spaces-index-state.ts";
export {
	FILE_CONTENTS_NOT_INDEXED_BADGE,
	FILE_CONTENTS_PENDING_BADGE,
	FILE_INDEX_NOTES,
} from "./spaces-index-state.ts";
export type { SpaceRetrievalMode } from "./spaces-retrieval.tsx";
export {
	RETRIEVAL_MODE_OPTIONS,
	RETRIEVAL_MODE_SCOPE,
	RetrievalModeChoice,
	retrievalModeLabel,
} from "./spaces-retrieval.tsx";
export type {
	SpaceDocumentRow,
	SpaceMatchRow,
	SpaceRow,
	SpacesDetailProps,
	SpacesViewProps,
} from "./spaces-types.ts";
export type { SpaceVisibility } from "./spaces-visibility.tsx";
export { SpaceVisibilityChoice } from "./spaces-visibility.tsx";

export function SpacesView({
	loading,
	error,
	spaces,
	detail,
	onCreateSpace,
	onRetry,
}: SpacesViewProps) {
	if (loading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={LibraryIcon} />
					</EmptyMedia>
					<EmptyTitle>Could not load spaces</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
				{onRetry ? (
					<EmptyContent>
						<Button onClick={onRetry} size="sm" variant="ghost">
							Try again
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		);
	}

	// The Spaces sidebar section (AppSidebar) is the space picker now, so the page
	// is a single full-width detail: it shows the selected space, prompts to pick
	// one, or (when there are none) offers to create the first.
	let body: ReactNode;
	if (spaces.length === 0) {
		body = (
			<div className="scroll-fade flex-1 overflow-auto p-4">
				<Empty className="h-full">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={LibraryIcon} />
						</EmptyMedia>
						<EmptyTitle>No spaces yet</EmptyTitle>
						<EmptyDescription>
							Create a space, ingest documents into it, then search across them.
						</EmptyDescription>
					</EmptyHeader>
					{onCreateSpace ? (
						<EmptyContent>
							<Button onClick={onCreateSpace} size="sm">
								Create your first space
							</Button>
						</EmptyContent>
					) : null}
				</Empty>
			</div>
		);
	} else if (detail) {
		body = detail.importPanel ? (
			<Tabs className="flex min-h-0 flex-1 flex-col" defaultValue="content">
				<div className="border-b px-4 pt-3">
					<TabsList manageLayout={false} variant="line">
						<TabsTrigger value="content">Content</TabsTrigger>
						<TabsTrigger value="import">Import</TabsTrigger>
					</TabsList>
				</div>
				<TabsContent className="min-h-0 flex-1 overflow-hidden" value="content">
					<div className="scroll-fade h-full overflow-auto">
						<SpaceDetail {...detail} />
					</div>
				</TabsContent>
				<TabsContent className="min-h-0 flex-1 overflow-hidden" value="import">
					<div className="scroll-fade h-full overflow-auto">
						{detail.importPanel}
					</div>
				</TabsContent>
			</Tabs>
		) : (
			<div className="scroll-fade flex-1 overflow-auto">
				<SpaceDetail {...detail} />
			</div>
		);
	} else {
		body = (
			<div className="scroll-fade flex-1 overflow-auto p-4">
				<Empty className="h-full">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={LibraryIcon} />
						</EmptyMedia>
						<EmptyTitle>Select a space</EmptyTitle>
						<EmptyDescription>
							Pick a space from the sidebar to view its pages, databases, and
							search.
						</EmptyDescription>
					</EmptyHeader>
					{onCreateSpace ? (
						<EmptyContent>
							<Button onClick={onCreateSpace} size="sm" variant="ghost">
								Create a space
							</Button>
						</EmptyContent>
					) : null}
				</Empty>
			</div>
		);
	}

	return <div className="flex h-full flex-col overflow-hidden">{body}</div>;
}

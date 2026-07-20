"use client";

// Presentational layer of the desktop Spaces (RAG) page. The live app
// (`apps/desktop/src/pages/SpacesPage.tsx`) is a thin container that loads spaces
// via `useSpacesContext()` and owns the ingest/search form state; the storyboard
// renders the same component with mock data and no-op handlers. One source of
// truth, so editing this block changes the real desktop too.

import {
	Add01Icon,
	CanvasIcon,
	DatabaseIcon,
	File01Icon,
	LibraryIcon,
	Search01Icon,
	Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Spinner } from "@ryu/ui/components/spinner";
import { Textarea } from "@ryu/ui/components/textarea";
import type { ChangeEvent, FormEvent, ReactNode } from "react";

/** A space row as the view needs it. */
export interface SpaceRow {
	description?: string | null;
	documentCount: number;
	id: string;
	name: string;
}

export interface SpaceDocumentRow {
	chunkCount: number;
	id: string;
	/** `"page"` (markdown), `"database"` (data grid), or `"whiteboard"`
	 * (Excalidraw scene). Defaults to a page. */
	kind?: "page" | "database" | "whiteboard";
	title: string;
}

export interface SpaceMatchRow {
	chunkId: string;
	content: string;
}

export interface SpacesDetailProps {
	documents: SpaceDocumentRow[];
	documentsError?: string | null;
	ingestBusy?: boolean;
	ingestContent: string;
	ingestError?: string | null;
	// Ingest form
	ingestTitle: string;
	onIngestContentChange?: (value: string) => void;
	onIngestSubmit?: () => void;
	onIngestTitleChange?: (value: string) => void;
	onNewDatabase?: () => void;
	onNewPage?: () => void;
	onNewWhiteboard?: () => void;
	onOpenDoc?: (docId: string, title: string) => void;
	onSearchQueryChange?: (value: string) => void;
	onSearchSubmit?: () => void;
	searchBusy?: boolean;
	searchError?: string | null;
	// Search
	searchQuery: string;
	searchResults?: SpaceMatchRow[] | null;
	space: SpaceRow;
}

export interface SpacesViewProps {
	/** Detail props for the selected space (driven by the container). */
	detail?: SpacesDetailProps | null;
	error?: string | null;
	loading?: boolean;
	onSelectSpace?: (id: string) => void;
	selectedId?: string | null;
	spaces: SpaceRow[];
}

/** The list icon for a document row, by kind. */
function docIcon(kind: SpaceDocumentRow["kind"]) {
	if (kind === "database") {
		return DatabaseIcon;
	}
	if (kind === "whiteboard") {
		return CanvasIcon;
	}
	return File01Icon;
}

function SpaceDetail(props: SpacesDetailProps) {
	const {
		documents,
		documentsError,
		ingestTitle,
		ingestContent,
		ingestBusy,
		ingestError,
		onIngestTitleChange,
		onIngestContentChange,
		onIngestSubmit,
		onNewPage,
		onNewDatabase,
		onNewWhiteboard,
		onOpenDoc,
		searchQuery,
		searchBusy,
		searchError,
		searchResults,
		onSearchQueryChange,
		onSearchSubmit,
	} = props;

	const handleIngest = (e: FormEvent) => {
		e.preventDefault();
		onIngestSubmit?.();
	};

	const handleSearch = (e: FormEvent) => {
		e.preventDefault();
		onSearchSubmit?.();
	};

	const ingestDisabled =
		ingestBusy || !(ingestTitle.trim() && ingestContent.trim());

	return (
		<div className="flex flex-col gap-6 p-4">
			<Card>
				<CardHeader>
					<CardTitle className="text-sm">Ingest a document</CardTitle>
					<CardDescription>
						Text is chunked, embedded, and stored for search.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="flex flex-col gap-3" onSubmit={handleIngest}>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ingest-title">Title</Label>
							<Input
								id="ingest-title"
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									onIngestTitleChange?.(e.target.value)
								}
								placeholder="Document title"
								value={ingestTitle}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ingest-content">Content</Label>
							<Textarea
								id="ingest-content"
								onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
									onIngestContentChange?.(e.target.value)
								}
								placeholder="Paste document text here"
								rows={5}
								value={ingestContent}
							/>
						</div>
						{ingestError ? (
							<p className="text-destructive text-sm">{ingestError}</p>
						) : null}
						<div>
							<Button disabled={ingestDisabled} size="sm" type="submit">
								{ingestBusy ? (
									<Spinner className="size-4" />
								) : (
									<HugeiconsIcon className="size-4" icon={Upload01Icon} />
								)}
								Ingest
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>

			<section className="flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<h3 className="font-medium text-sm">Pages, databases & boards</h3>
					<div className="flex items-center gap-2">
						<Button onClick={onNewPage} size="sm" variant="outline">
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							New page
						</Button>
						<Button onClick={onNewDatabase} size="sm" variant="outline">
							<HugeiconsIcon className="size-4" icon={DatabaseIcon} />
							New database
						</Button>
						<Button onClick={onNewWhiteboard} size="sm" variant="outline">
							<HugeiconsIcon className="size-4" icon={CanvasIcon} />
							New whiteboard
						</Button>
					</div>
				</div>
				{documentsError ? (
					<p className="text-destructive text-sm">{documentsError}</p>
				) : null}
				{documents.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						Nothing yet. Create a page to write like a Notion doc, or a database
						for a structured table.
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{documents.map((doc) => (
							<li key={doc.id}>
								<button
									className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left hover:bg-accent/50"
									onClick={() => onOpenDoc?.(doc.id, doc.title)}
									type="button"
								>
									<HugeiconsIcon
										className="size-4 shrink-0 opacity-70"
										icon={docIcon(doc.kind)}
									/>
									<span className="min-w-0 flex-1 truncate text-sm">
										{doc.title}
									</span>
									<Badge variant="secondary">
										{doc.chunkCount} {doc.chunkCount === 1 ? "chunk" : "chunks"}
									</Badge>
								</button>
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="flex flex-col gap-3">
				<h3 className="font-medium text-sm">Search</h3>
				<form className="flex gap-2" onSubmit={handleSearch}>
					<Input
						aria-label="Search query"
						onChange={(e: ChangeEvent<HTMLInputElement>) =>
							onSearchQueryChange?.(e.target.value)
						}
						placeholder="Search within this space"
						value={searchQuery}
					/>
					<Button
						disabled={searchBusy || !searchQuery.trim()}
						size="sm"
						type="submit"
					>
						{searchBusy ? (
							<Spinner className="size-4" />
						) : (
							<HugeiconsIcon className="size-4" icon={Search01Icon} />
						)}
						Search
					</Button>
				</form>
				{searchError ? (
					<p className="text-destructive text-sm">{searchError}</p>
				) : null}
				{searchResults !== null && searchResults !== undefined ? (
					searchResults.length === 0 ? (
						<p className="text-muted-foreground text-sm">No matches found.</p>
					) : (
						<ol className="flex flex-col gap-2">
							{searchResults.map((match, index) => (
								<li className="rounded-md border px-3 py-2" key={match.chunkId}>
									<div className="mb-1 flex items-center gap-2">
										<Badge variant="secondary">#{index + 1}</Badge>
									</div>
									<p className="text-sm">{match.content}</p>
								</li>
							))}
						</ol>
					)
				) : null}
			</section>
		</div>
	);
}

export function SpacesView({
	loading,
	error,
	spaces,
	detail,
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
			</Empty>
		);
	}

	// The Spaces sidebar section (AppSidebar) is the space picker now, so the page
	// is a single full-width detail: it shows the selected space, prompts to pick
	// one, or (when there are none) offers to create the first.
	let body: ReactNode;
	if (spaces.length === 0) {
		body = (
			<div className="scroll-fade-effect-y flex-1 overflow-auto p-4">
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
				</Empty>
			</div>
		);
	} else if (detail) {
		body = (
			<div className="scroll-fade-effect-y flex-1 overflow-auto">
				<SpaceDetail {...detail} />
			</div>
		);
	} else {
		body = (
			<div className="scroll-fade-effect-y flex-1 overflow-auto p-4">
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
				</Empty>
			</div>
		);
	}

	return <div className="flex h-full flex-col overflow-hidden">{body}</div>;
}

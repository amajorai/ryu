"use client";

import { CanvasIcon, PinIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Skeleton } from "@ryu/ui/components/skeleton";
import { useFriendlyMode } from "@ryu/ui/hooks/use-friendly-mode.ts";
import {
	documentTypeLabel,
	formatDocumentDate,
	previewLines,
} from "./spaces-document-format.ts";
import { docIcon, indexBadgeLabel, rowDetail } from "./spaces-index-state.ts";
import type { SpaceDocumentRow } from "./spaces-types.ts";

export function MarkdownThumbnail({
	document,
}: {
	document: SpaceDocumentRow;
}) {
	return (
		<div
			aria-hidden="true"
			className="relative h-[76px] w-14 shrink-0 overflow-hidden rounded-glyph-compact border border-space-paper-border bg-space-paper p-1.5 text-left text-space-paper-foreground shadow-space-paper dark:border-space-paper-border-dark dark:bg-space-paper-dark dark:text-space-paper-foreground-dark"
		>
			<div className="absolute inset-y-0 left-0 w-0.5 bg-space-paper-accent" />
			{document.previewLoading && !document.preview ? (
				<div className="space-y-1.5 pt-1">
					<Skeleton className="h-1.5 w-4/5" tone="paper-heading" />
					<Skeleton className="h-1 w-full" tone="paper-line" />
					<Skeleton className="h-1 w-5/6" tone="paper-line" />
					<Skeleton className="h-1 w-2/3" tone="paper-line" />
				</div>
			) : (
				<div className="type-diagram space-y-1 pt-0.5 leading-tight">
					{previewLines(document.preview)
						.slice(0, 5)
						.map((line, index) => (
							<p
								className={
									index === 0 ? "type-miniature font-semibold" : "opacity-75"
								}
								key={`${line}-${index}`}
							>
								{line.replace(/^[#*-]+\s*/, "")}
							</p>
						))}
				</div>
			)}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-space-paper to-transparent dark:from-space-paper-dark" />
		</div>
	);
}

export type SpaceTemplateKind =
	| "blank"
	| "welcome"
	| "table"
	| "simple"
	| "board";

export function SpaceTemplateCard({
	featured,
	kind,
	label,
	onClick,
}: {
	featured?: boolean;
	kind: SpaceTemplateKind;
	label: string;
	onClick?: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<button
			aria-label={tl("Create {label}", { label })}
			className={`group flex w-36 shrink-0 flex-col gap-2 rounded-lg p-1.5 text-left outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/5 ${featured ? "ring-2 ring-foreground/70" : ""}`}
			onClick={onClick}
			type="button"
		>
			<div className="relative flex h-24 items-center justify-center overflow-hidden rounded-md border border-black/10 bg-white shadow-sm dark:border-white/10 dark:bg-space-template-surface-dark">
				{kind === "table" ? (
					<div className="grid w-20 grid-cols-3 gap-px border border-space-template-grid bg-space-template-grid opacity-80">
						{Array.from({ length: 12 }, (_, index) => (
							<span className="h-3 bg-white" key={index} />
						))}
					</div>
				) : kind === "board" ? (
					<div className="flex size-16 items-center justify-center rounded-md border border-space-template-grid border-dashed bg-space-template-board dark:bg-space-template-board-dark">
						<HugeiconsIcon
							className="size-6 text-space-template-accent"
							icon={CanvasIcon}
						/>
					</div>
				) : (
					<div className="flex h-[76px] w-14 flex-col gap-1 rounded-xs border border-space-paper-border bg-space-paper p-2 text-space-template-paper-foreground shadow-sm dark:border-space-paper-border-dark dark:bg-space-template-paper-dark dark:text-space-paper-foreground-dark">
						{kind === "blank" ? null : (
							<span className="h-1.5 w-4/5 rounded bg-space-template-heading opacity-70" />
						)}
						<span className="h-1 w-full rounded bg-space-template-line opacity-70" />
						<span className="h-1 w-5/6 rounded bg-space-template-line opacity-50" />
						{kind === "welcome" ? (
							<span className="mt-1 h-7 rounded-sm bg-space-template-accent/25" />
						) : null}
					</div>
				)}
			</div>
			<span className="truncate px-0.5 font-medium text-xs">{label}</span>
		</button>
	);
}

export function RecentDocumentRow({
	document,
	onOpenDoc,
	spaceName,
}: {
	document: SpaceDocumentRow;
	onOpenDoc?: (docId: string, title: string) => void;
	spaceName: string;
}) {
	const tl = useLiteralMessages();
	const title = document.title || "Untitled page";
	return (
		<button
			aria-label={tl("Open {title}", { title })}
			className="flex w-full items-center gap-3 border-border/70 border-b px-3 py-3 text-left outline-none transition-colors last:border-b-0 hover:bg-black/[0.035] focus-visible:bg-black/[0.035] dark:focus-visible:bg-white/[0.035] dark:hover:bg-white/[0.035]"
			onClick={() => onOpenDoc?.(document.id, title)}
			type="button"
		>
			<MarkdownThumbnail document={document} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate font-medium text-sm" title={title}>
					{title}
				</span>
				<span className="mt-1 truncate text-muted-foreground text-xs">
					{spaceName} · {documentTypeLabel(document)}
				</span>
			</span>
			<span className="hidden shrink-0 text-muted-foreground text-xs sm:block">
				{formatDocumentDate(document.updatedAt)}
			</span>
			<HugeiconsIcon
				aria-hidden="true"
				className="size-3.5 shrink-0 text-muted-foreground/60"
				icon={PinIcon}
			/>
		</button>
	);
}

/**
 * One row of the document list.
 *
 * Extracted from the map body because a row now has a conditional second line and
 * two badge branches, and an inline JSX block that size inside the section makes the
 * section's own structure unreadable.
 *
 * The second line is a `failed` file's reason. It is inside the button rather than
 * beside it so the whole row stays one click target — the file still opens, which is
 * the fact the copy is at pains to establish.
 */
export function DocumentRow({
	doc,
	onOpenDoc,
}: {
	doc: SpaceDocumentRow;
	onOpenDoc?: (docId: string, title: string) => void;
}) {
	const badge = indexBadgeLabel(doc.indexState);
	const detail = rowDetail(doc);
	const [friendly] = useFriendlyMode();
	const tl = useLiteralMessages();
	return (
		<li>
			<button
				aria-label={tl("Open {title}", { title: doc.title || "Untitled" })}
				className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left hover:bg-accent/50"
				onClick={() => onOpenDoc?.(doc.id, doc.title)}
				type="button"
			>
				<HugeiconsIcon
					className="size-4 shrink-0 opacity-70"
					icon={docIcon(doc.kind)}
				/>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-sm" title={doc.title}>
						{doc.title}
					</span>
					{detail ? (
						<span
							className="truncate text-muted-foreground text-xs"
							title={detail}
						>
							{detail}
						</span>
					) : null}
				</span>
				{badge === null ? (
					// "Chunk" is the retrieval pipeline's word for a unit of embedded
					// text, and it appears on EVERY document row — the single most-read
					// piece of jargon on this page. Friendly mode says "searchable
					// pieces", which is what the number actually tells the reader: how
					// much of this document a search can reach. The count itself is
					// unchanged, so the badge means exactly the same thing in both modes
					// and the "Name only" replacement below still governs the case where
					// the count would mislead.
					<Badge variant="secondary">
						{friendly
							? tl(
									"{count, plural, =1 {{countText} searchable piece} other {{countText} searchable pieces}}",
									{ count: doc.chunkCount, countText: String(doc.chunkCount) }
								)
							: `${doc.chunkCount} ${doc.chunkCount === 1 ? "chunk" : "chunks"}`}
					</Badge>
				) : (
					// Replaces the chunk badge rather than joining it — see
					// FILE_INDEX_NOTES. `outline` (not `destructive`) even for `failed`:
					// nothing is lost, the file is stored and opens; only its reach is
					// narrower than the row above it, and a red badge on a working file
					// reads as data loss.
					<Badge variant="outline">{badge}</Badge>
				)}
			</button>
		</li>
	);
}

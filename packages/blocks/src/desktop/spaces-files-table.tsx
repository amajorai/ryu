"use client";

import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Input } from "@ryu/ui/components/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table";
import { useFriendlyMode } from "@ryu/ui/hooks/use-friendly-mode.ts";
import type { ChangeEvent } from "react";
import { useMemo } from "react";
import {
	documentTypeLabel,
	formatDocumentDate,
	formatDocumentSize,
} from "./spaces-document-format.ts";
import { DocumentRow } from "./spaces-document-rows.tsx";
import {
	docIcon,
	indexBadgeLabel,
	indexNotesFor,
	rowDetail,
} from "./spaces-index-state.ts";
import type { SpaceDocumentRow } from "./spaces-types.ts";

export function FilesTableSection({
	documents,
	documentsError,
	onOpenDoc,
	onQueryChange,
	query,
}: {
	documents: SpaceDocumentRow[];
	documentsError?: string | null;
	onOpenDoc?: (docId: string, title: string) => void;
	onQueryChange: (value: string) => void;
	query: string;
}) {
	const [friendly] = useFriendlyMode();
	const tl = useLiteralMessages();
	const filteredDocuments = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) {
			return documents;
		}
		return documents.filter((document) =>
			`${document.title} ${documentTypeLabel(document)}`
				.toLowerCase()
				.includes(normalized)
		);
	}, [documents, query]);

	return (
		<section
			aria-labelledby="space-files-title"
			className="flex flex-col gap-4"
			data-testid="spaces-files-table"
		>
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h2
						className="font-heading text-2xl tracking-tight"
						id="space-files-title"
					>
						Files
					</h2>
				</div>
			</div>
			<div className="overflow-hidden rounded-3xl border border-border/70 bg-card/70 shadow-sm">
				<div className="flex flex-wrap items-center justify-between gap-3 border-border/60 border-b px-4 py-4 sm:px-6">
					<p className="text-muted-foreground text-xs">
						{tl("{visibleCount} of {totalCount} visible", {
							visibleCount: String(filteredDocuments.length),
							totalCount: String(documents.length),
						})}
					</p>
					<div className="relative w-full sm:w-64">
						<HugeiconsIcon
							aria-hidden="true"
							className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
							icon={Search01Icon}
						/>
						<Input
							aria-label="Search files"
							leadingAdornment="default"
							onChange={(event: ChangeEvent<HTMLInputElement>) =>
								onQueryChange(event.target.value)
							}
							placeholder="Search files"
							value={query}
						/>
					</div>
				</div>
				{documentsError ? (
					<p className="px-4 pt-4 text-sm text-status-destructive sm:px-6">
						{documentsError}
					</p>
				) : null}
				<div className="p-3 sm:hidden">
					{filteredDocuments.length > 0 ? (
						<ul className="flex flex-col gap-2">
							{filteredDocuments.map((document) => (
								<DocumentRow
									doc={document}
									key={document.id}
									onOpenDoc={onOpenDoc}
								/>
							))}
						</ul>
					) : (
						<p className="px-3 py-8 text-center text-muted-foreground text-sm">
							{tl("No files match “{query}”.", { query })}
						</p>
					)}
				</div>
				<div className="hidden sm:block">
					<Table aria-label="Files in this Space" className="min-w-[760px]">
						<TableHeader>
							<TableRow appearance="header">
								<TableHead inset="wide" presentation="file-label">
									Name
								</TableHead>
								<TableHead presentation="file-label">Type</TableHead>
								<TableHead presentation="file-label">Size</TableHead>
								<TableHead presentation="file-label">Modified</TableHead>
								<TableHead inset="end" presentation="file-label">
									Search reach
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{filteredDocuments.length > 0 ? (
								filteredDocuments.map((document) => {
									const detail = rowDetail(document);
									const title = document.title || "Untitled";
									const badge = indexBadgeLabel(document.indexState);
									return (
										<TableRow className="group" key={document.id}>
											<TableCell className="min-w-[19rem]" inset="wide">
												<button
													aria-label={tl("Open {title}", { title })}
													className="flex min-w-0 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
													onClick={() => onOpenDoc?.(document.id, title)}
													type="button"
												>
													<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
														<HugeiconsIcon
															className="size-4"
															icon={docIcon(document.kind)}
														/>
													</span>
													<span className="flex min-w-0 flex-col">
														<span
															className="truncate font-medium text-sm"
															title={title}
														>
															{title}
														</span>
														<span className="truncate text-muted-foreground text-xs">
															{detail ?? documentTypeLabel(document)}
														</span>
													</span>
												</button>
											</TableCell>
											<TableCell presentation="metadata">
												{documentTypeLabel(document)}
											</TableCell>
											<TableCell presentation="numeric-metadata">
												{formatDocumentSize(document.byteSize)}
											</TableCell>
											<TableCell presentation="metadata">
												{formatDocumentDate(document.updatedAt)}
											</TableCell>
											<TableCell inset="end">
												{badge ? (
													<Badge variant="outline">{badge}</Badge>
												) : (
													<span className="text-muted-foreground text-xs">
														{friendly
															? tl(
																	"{count, plural, =1 {{countText} searchable piece} other {{countText} searchable pieces}}",
																	{
																		count: document.chunkCount,
																		countText: String(document.chunkCount),
																	}
																)
															: `${document.chunkCount} ${document.chunkCount === 1 ? "chunk" : "chunks"}`}
													</span>
												)}
											</TableCell>
										</TableRow>
									);
								})
							) : (
								<TableRow>
									<TableCell colSpan={5} presentation="empty">
										{query
											? tl("No files match “{query}”.", { query })
											: "No documents yet."}
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</div>
			</div>
			{indexNotesFor(documents).map((note) => (
				<p className="text-muted-foreground text-xs" key={note}>
					{note}
				</p>
			))}
		</section>
	);
}

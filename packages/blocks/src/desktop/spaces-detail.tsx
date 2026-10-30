"use client";

import {
	Download01Icon,
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
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import { useFriendlyMode } from "@ryu/ui/hooks/use-friendly-mode.ts";
import type { ChangeEvent, SyntheticEvent } from "react";
import { useRef } from "react";
import { SpaceHomeShell } from "./spaces-home-shell.tsx";
import {
	RETRIEVAL_MODE_SWITCH_DISCLOSURE,
	RETRIEVAL_MODE_SWITCH_DISCLOSURE_FRIENDLY,
	RetrievalModeChoice,
} from "./spaces-retrieval.tsx";
import type { SpacesDetailProps } from "./spaces-types.ts";

export function SpaceDetail(props: SpacesDetailProps) {
	const {
		documents,
		documentsError,
		onNewPage,
		onNewDatabase,
		onNewWhiteboard,
		onOpenDoc,
		onExportPackage,
		onImportPackage,
		onRetrievalModeChange,
		onCancelRetrievalMode,
		portableBusy,
		portableError,
		portableNotice,
		retrievalModeBusy,
		retrievalModeError,
		retrievalModeProgress,
		retrievalModeNotice,
		searchQuery,
		searchBusy,
		searchError,
		searchResults,
		onSearchQueryChange,
		onSearchSubmit,
		space,
		uploadPanel,
	} = props;

	// Both halves are required: without the mode there is nothing truthful to
	// show, and without the handler the picker would be a control that does
	// nothing. Either alone hides the card rather than rendering a half-wired one.
	const retrievalMode = space.retrievalMode;
	const canEditRetrieval =
		retrievalMode !== undefined && onRetrievalModeChange !== undefined;
	const portableInput = useRef<HTMLInputElement>(null);

	const handleSearch = (e: SyntheticEvent) => {
		e.preventDefault();
		onSearchSubmit?.();
	};

	// Same app-wide toggle the picker reads; the card's own copy around the picker
	// (its description, the switch disclosure, the rebuild spinner) has to move
	// with it, or friendly option names would sit under a heading about algorithms
	// and above a warning about entity graphs.
	const [friendly] = useFriendlyMode();

	return (
		<SpaceHomeShell
			documents={documents}
			documentsError={documentsError}
			onNewDatabase={onNewDatabase}
			onNewPage={onNewPage}
			onNewWhiteboard={onNewWhiteboard}
			onOpenDoc={onOpenDoc}
			space={space}
			uploadPanel={uploadPanel}
		>
			{props.bannerSlot}
			{props.backupPanel}
			{onExportPackage || onImportPackage ? (
				<Card>
					<CardHeader>
						<CardTitle variant="section">Share this Space</CardTitle>
						<CardDescription>
							Pages and database rows export as Markdown with frontmatter.
							Embeddings and binary files stay on this node.
						</CardDescription>
					</CardHeader>
					<CardContent layout="stack">
						<input
							accept=".ryupack,.zip,application/zip"
							aria-label="Portable Space package"
							className="sr-only"
							onChange={(event: ChangeEvent<HTMLInputElement>) => {
								const file = event.target.files?.[0];
								if (file) {
									onImportPackage?.(file);
								}
								event.target.value = "";
							}}
							ref={portableInput}
							type="file"
						/>
						<div className="flex flex-wrap gap-2">
							<Button
								disabled={portableBusy || !onExportPackage}
								loading={portableBusy}
								onClick={onExportPackage}
								size="sm"
								type="button"
								variant="outline"
							>
								{!portableBusy && (
									<HugeiconsIcon className="size-4" icon={Download01Icon} />
								)}
								Export package
							</Button>
							<Button
								disabled={portableBusy || !onImportPackage}
								onClick={() => portableInput.current?.click()}
								size="sm"
								type="button"
								variant="outline"
							>
								<HugeiconsIcon className="size-4" icon={Upload01Icon} />
								Import package
							</Button>
						</div>
						{portableError ? (
							<p className="text-sm text-status-destructive">{portableError}</p>
						) : null}
						{portableNotice && !portableBusy ? (
							<p className="text-muted-foreground text-xs">{portableNotice}</p>
						) : null}
					</CardContent>
				</Card>
			) : null}
			{canEditRetrieval && retrievalMode !== undefined ? (
				<Card>
					<CardHeader>
						<CardTitle variant="section">Retrieval</CardTitle>
						{/* Names the CHOICE only. Where it applies is a line down, in
						    RETRIEVAL_MODE_SCOPE, which the picker renders; restating it
						    here would either duplicate it or (worse) let the two drift into
						    different promises. This line has been wrong twice in opposite
						    directions: "How this space finds answers when an agent searches
						    it" claimed the whole agent surface while chat recall ignored
						    the setting, and the correction ("a DIRECT search of this
						    space") became an underclaim once chat recall started
						    delegating to the same search. Naming the algorithm and letting
						    the scope line own the reach is what stops a third round. */}
						{/* The friendly wording keeps this line's job — naming the CHOICE,
						    never its reach — and only drops the word "algorithm", which
						    is the one term here a non-developer cannot act on. */}
						<CardDescription>
							{friendly
								? "How this space looks things up."
								: "Which algorithm this space is searched with."}
						</CardDescription>
					</CardHeader>
					<CardContent layout="stack">
						<RetrievalModeChoice
							disabled={retrievalModeBusy}
							idPrefix="space-retrieval-mode"
							mode={retrievalMode}
							onModeChange={(next) => onRetrievalModeChange?.(next)}
						/>
						<p className="text-muted-foreground text-xs">
							{friendly
								? RETRIEVAL_MODE_SWITCH_DISCLOSURE_FRIENDLY
								: RETRIEVAL_MODE_SWITCH_DISCLOSURE}
						</p>
						{retrievalModeBusy ? (
							<div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
								<p className="flex items-center gap-2">
									<Spinner className="size-3" />
									{friendly
										? "Working out how these documents connect…"
										: "Rebuilding this space's entity graph…"}
									{retrievalModeProgress &&
									retrievalModeProgress.totalChunks > 0
										? ` ${retrievalModeProgress.processedChunks}/${retrievalModeProgress.totalChunks} chunks`
										: null}
								</p>
								{onCancelRetrievalMode ? (
									<Button
										onClick={onCancelRetrievalMode}
										size="sm"
										type="button"
										variant="outline"
									>
										Cancel
									</Button>
								) : null}
							</div>
						) : null}
						{retrievalModeError ? (
							<p className="text-sm text-status-destructive">
								{retrievalModeError}
							</p>
						) : null}
						{retrievalModeNotice && !retrievalModeBusy ? (
							<p className="text-muted-foreground text-xs">
								{retrievalModeNotice}
							</p>
						) : null}
					</CardContent>
				</Card>
			) : null}

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
						disabled={!searchQuery.trim()}
						loading={searchBusy}
						size="sm"
						type="submit"
					>
						{!searchBusy && (
							<HugeiconsIcon className="size-4" icon={Search01Icon} />
						)}
						Search
					</Button>
				</form>
				{searchError ? (
					<p className="text-sm text-status-destructive">{searchError}</p>
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
		</SpaceHomeShell>
	);
}

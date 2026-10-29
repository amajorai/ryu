// apps/desktop/src/components/chat/ImportSetupDialog.tsx
//
// Import agent *setup* from a scanned local folder into Ryu — the setup-side
// companion to `ImportThreadsDialog` (which imports conversations). Point at a
// folder (a project directory, or an agent config root like ~/.claude,
// ~/.cursor, ~/.codex, ~/.openclaw, ~/.hermes), scan it, pick what to bring over
// (instructions, skills, MCP servers, plugins, agents, slash commands, and
// memories),
// and import the selection into
// Ryu's own stores.
//
// Read-only + additive against the source: imports never modify the folder they
// read from.

import {
	Download01Icon,
	FolderOpenIcon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	groupScanItems,
	type ImportOutcome,
	runImport,
	type ScanItem,
	scanImportFolder,
} from "@/src/lib/api/import.ts";
import { listDirectory } from "@/src/lib/api/workspace.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { NodeFolderBrowser } from "./NodeFolderBrowser.tsx";

/** Common agent config roots offered as one-click scan targets. */
const AGENT_CONFIG_ROOTS: { key: string; label: string }[] = [
	{ key: ".claude", label: "Claude Code" },
	{ key: ".cursor", label: "Cursor" },
	{ key: ".codex", label: "Codex" },
	{ key: ".openclaw", label: "OpenClaw" },
	{ key: ".hermes", label: "Hermes" },
];

const PATH_SEP = /[\\/]/;

export function ImportSetupDialog({
	open,
	onOpenChange,
	target,
	onImported,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	target: ApiTarget;
	/** Called after an import that registered at least one project folder. */
	onImported?: () => void;
}) {
	const tl = useLiteralMessages();
	const addProjectFolder = useWorkspaceStore((s) => s.addProjectFolder);
	const [browseOpen, setBrowseOpen] = useState(false);
	const [folder, setFolder] = useState<string | null>(null);
	const [items, setItems] = useState<ScanItem[]>([]);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [scanning, setScanning] = useState(false);
	const [importing, setImporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);
	const [quickTargets, setQuickTargets] = useState<string[] | null>(null);

	// Reset state when the dialog reopens, and pre-resolve the home directory so
	// the one-click agent-root chips can offer real paths.
	useEffect(() => {
		if (!open) {
			return;
		}
		setFolder(null);
		setItems([]);
		setWarnings([]);
		setError(null);
		setSelected(new Set());
		setOutcomes(null);
		listDirectory(target)
			.then((listing) => {
				const sep = listing.home.includes("\\") ? "\\" : "/";
				setQuickTargets(
					AGENT_CONFIG_ROOTS.map((r) => `${listing.home}${sep}${r.key}`)
				);
			})
			.catch(() => {
				setQuickTargets(null);
			});
	}, [open, target]);

	const scanFolder = useCallback(
		async (path: string) => {
			setScanning(true);
			setError(null);
			setItems([]);
			setSelected(new Set());
			setOutcomes(null);
			try {
				const result = await scanImportFolder(target, path);
				setFolder(result.root);
				setItems(result.items);
				setWarnings(result.warnings);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Failed to scan folder");
				setItems([]);
			} finally {
				setScanning(false);
			}
		},
		[target]
	);

	const handleBrowseSelect = useCallback(
		(selected: string) => {
			setBrowseOpen(false);
			scanFolder(selected).catch(() => undefined);
		},
		[scanFolder]
	);

	const toggleItem = useCallback((id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const toggleKind = useCallback((ids: string[]) => {
		setSelected((prev) => {
			const next = new Set(prev);
			const allSelected = ids.every((id) => next.has(id));
			for (const id of ids) {
				if (allSelected) {
					next.delete(id);
				} else {
					next.add(id);
				}
			}
			return next;
		});
	}, []);

	const allSelected = items.length > 0 && selected.size === items.length;
	const toggleAll = useCallback(() => {
		setSelected((prev) =>
			prev.size === items.length ? new Set() : new Set(items.map((i) => i.id))
		);
	}, [items]);

	const handleImport = useCallback(async () => {
		if (!folder || importing || selected.size === 0) {
			return;
		}
		setImporting(true);
		setError(null);
		try {
			const result = await runImport(
				target,
				folder,
				items
					.filter((i) => selected.has(i.id))
					.map((i) => ({ kind: i.kind, id: i.id }))
			);
			setOutcomes(result.results);
			// Register any imported instruction folders as workspace projects so
			// they group in the sidebar.
			const folders = new Set<string>();
			for (const r of result.results) {
				if (r.folderPath) {
					folders.add(r.folderPath);
				}
			}
			for (const f of folders) {
				addProjectFolder(f);
			}
			if (folders.size > 0) {
				onImported?.();
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to import");
		} finally {
			setImporting(false);
		}
	}, [
		folder,
		importing,
		selected,
		items,
		target,
		addProjectFolder,
		onImported,
	]);

	const groups = groupScanItems(items);
	const importedCount =
		outcomes?.filter((o) => o.status === "imported").length ?? 0;
	const failedCount =
		outcomes?.filter((o) => o.status === "failed").length ?? 0;
	const folderName = folder ? folder.split(PATH_SEP).at(-1) || folder : null;

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Import agent setup</DialogTitle>
					<DialogDescription>
						Scan a folder and bring its agent setup into Ryu — instructions,
						skills, MCP servers, plugins, agents, slash commands, and memories
						from Claude Code, Codex, Cursor, OpenClaw, Hermes, Muse, Mastra, or
						LangChain. Your files are never modified.
					</DialogDescription>
				</DialogHeader>

				{/* Pick a folder (one-click agent config roots, or browse). */}
				{!(folder || scanning) && (
					<div className="flex flex-col gap-2">
						{quickTargets && (
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-muted-foreground text-xs">
									Scan your:
								</span>
								{quickTargets.map((path, idx) => (
									<Button
										disabled={scanning || importing}
										key={path}
										onClick={() => scanFolder(path).catch(() => undefined)}
										size="sm"
										variant="ghost"
									>
										{AGENT_CONFIG_ROOTS[idx]?.label}
									</Button>
								))}
							</div>
						)}
						<Button
							disabled={scanning || importing}
							onClick={() => setBrowseOpen(true)}
							variant="secondary"
						>
							<HugeiconsIcon
								className="size-4 shrink-0"
								icon={FolderOpenIcon}
							/>
							Choose a folder…
						</Button>
					</div>
				)}

				{scanning && (
					<div className="flex h-48 items-center justify-center gap-3 text-muted-foreground text-sm">
						<Spinner />
						Scanning…
					</div>
				)}

				{error && (
					<p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-status-destructive">
						{error}
					</p>
				)}

				{!scanning && folder && (
					<>
						<div className="flex items-center justify-between gap-2">
							<p className="truncate font-medium text-sm" title={folder}>
								{folderName}
							</p>
							<Button
								disabled={importing}
								onClick={() => setBrowseOpen(true)}
								size="sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4 shrink-0" icon={RefreshIcon} />
								Change
							</Button>
						</div>

						{warnings.length > 0 && (
							<p className="text-muted-foreground text-xs">
								{warnings.join(" · ")}
							</p>
						)}

						{items.length > 0 && (
							<div className="flex items-center justify-between px-1">
								<button
									className="flex items-center gap-2.5 rounded-lg py-1 text-left text-muted-foreground text-xs transition-colors hover:text-foreground"
									disabled={importing}
									onClick={toggleAll}
									type="button"
								>
									<Checkbox
										checked={allSelected}
										className="pointer-events-none shrink-0"
										tabIndex={-1}
									/>
									{allSelected ? "Deselect all" : "Select all"}
								</button>
								<span className="text-muted-foreground text-xs tabular-nums">
									{tl("{selectedCount} of {totalCount} selected", {
										selectedCount: String(selected.size),
										totalCount: String(items.length),
									})}
								</span>
							</div>
						)}

						{items.length === 0 ? (
							<p className="rounded-xl border border-border border-dashed px-3 py-8 text-center text-muted-foreground text-sm">
								Nothing importable found in this folder.
							</p>
						) : (
							<ScrollArea className="h-72 min-w-0">
								<div className="flex flex-col gap-3 pr-2">
									{groups.map((group) => (
										<section key={group.kind}>
											<div className="flex items-center justify-between px-1 pb-1">
												<h4 className="font-medium text-foreground text-sm">
													{group.label}
												</h4>
												<button
													className="text-muted-foreground text-xs hover:text-foreground"
													disabled={importing}
													onClick={() =>
														toggleKind(group.items.map((i) => i.id))
													}
													type="button"
												>
													{group.items.every((i) => selected.has(i.id))
														? "Deselect"
														: "Select"}
												</button>
											</div>
											<ul className="flex flex-col gap-0.5">
												{group.items.map((item) => (
													<li key={item.id}>
														<button
															aria-pressed={selected.has(item.id)}
															className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
															disabled={importing}
															onClick={() => toggleItem(item.id)}
															type="button"
														>
															<Checkbox
																checked={selected.has(item.id)}
																className="pointer-events-none shrink-0"
																tabIndex={-1}
															/>
															<span className="flex min-w-0 flex-1 flex-col gap-0.5">
																<span
																	className="truncate font-medium text-foreground text-sm"
																	title={item.title}
																>
																	{item.title}
																</span>
																{item.detail && (
																	<span
																		className="truncate text-muted-foreground text-xs"
																		title={item.detail}
																	>
																		{item.detail}
																	</span>
																)}
															</span>
															{item.alreadyExists && (
																<Badge variant="secondary">
																	Already imported
																</Badge>
															)}
														</button>
													</li>
												))}
											</ul>
										</section>
									))}
								</div>
							</ScrollArea>
						)}

						{outcomes && (
							<div className="flex flex-col gap-1 text-sm">
								<p className="flex items-center gap-2 text-foreground">
									<HugeiconsIcon
										className="size-4 shrink-0"
										icon={Download01Icon}
									/>
									{tl(
										"Imported {importedCount}, skipped {skippedCount}, failed {failedCount}",
										{
											importedCount: String(importedCount),
											skippedCount: String(
												outcomes.length - importedCount - failedCount
											),
											failedCount: String(failedCount),
										}
									)}
								</p>
								{outcomes
									.filter((o) => o.status === "failed" && o.detail)
									.map((o) => (
										<p
											className="text-status-destructive text-xs"
											key={`${o.kind}:${o.id}`}
										>
											{o.title}: {o.detail}
										</p>
									))}
							</div>
						)}
					</>
				)}

				<DialogFooter>
					<Button
						disabled={importing}
						onClick={() => onOpenChange(false)}
						variant="ghost"
					>
						Close
					</Button>
					<Button
						disabled={selected.size === 0 || scanning}
						loading={importing}
						onClick={handleImport}
					>
						{selected.size > 0
							? tl("Import {selectedCount}", {
									selectedCount: String(selected.size),
								})
							: "Import"}
					</Button>
				</DialogFooter>
			</DialogContent>

			<NodeFolderBrowser
				onOpenChange={setBrowseOpen}
				onSelect={handleBrowseSelect}
				open={browseOpen}
			/>
		</Dialog>
	);
}

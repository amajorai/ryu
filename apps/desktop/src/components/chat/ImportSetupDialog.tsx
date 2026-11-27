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
//
// The import itself runs on the node as an operation. The dialog keeps no
// progress or results of its own: it shows what the node reports, so it can be
// closed while the import runs and shows the same import when it is opened
// again. A node without the operations service still runs the batch inside
// the request, and those results are shown from component state as before.

import { FolderOpenIcon, RefreshIcon } from "@hugeicons/core-free-icons";
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
import { Empty, EmptyDescription } from "@ryu/ui/components/empty.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { useImportOperations } from "@/src/hooks/useImportOperations.ts";
import { hermesHomeName, joinHome } from "@/src/lib/agent-migration.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	groupScanItems,
	type ImportOutcome,
	type ScanItem,
	type ScanResult,
	scanImportFolder,
} from "@/src/lib/api/import.ts";
import { listDirectory } from "@/src/lib/api/workspace.ts";
import {
	scanItemDetail,
	scanItemTitle,
	scanWarnings,
} from "@/src/lib/import-scan-text.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { GrokBotImportButton } from "./GrokBotImportDialog.tsx";
import {
	ImportOperationActions,
	ImportOperationStatus,
	ImportOutcomeTotals,
} from "./ImportOperationStatus.tsx";
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

/** The key under which the operations store remembers this dialog's import. */
const IMPORT_SETUP_SURFACE = "import-setup";

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
	// Only the Grok Bot zip import registers its folders here; a folder import
	// registers them in `useImportOperations`.
	const addProjectFolder = useWorkspaceStore((s) => s.addProjectFolder);
	const imports = useImportOperations(target, IMPORT_SETUP_SURFACE);
	const startImports = imports.start;
	// An import the node runs (or ran) for this dialog. While there is one the
	// dialog shows it instead of the folder picker.
	const showOperation = imports.operations.length > 0;
	const [browseOpen, setBrowseOpen] = useState(false);
	const [folder, setFolder] = useState<string | null>(null);
	const [items, setItems] = useState<ScanItem[]>([]);
	const [scanNotes, setScanNotes] = useState<
		Pick<ScanResult, "warningNotices" | "warnings">
	>({ warnings: [] });
	const warnings = scanWarnings(scanNotes, tl);
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
		setScanNotes({ warnings: [] });
		setError(null);
		setSelected(new Set());
		setOutcomes(null);
		listDirectory(target)
			.then((listing) => {
				setQuickTargets(
					AGENT_CONFIG_ROOTS.map((r) =>
						joinHome(
							listing.home,
							r.key === ".hermes" ? hermesHomeName(listing.home) : r.key
						)
					)
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
				setScanNotes(result);
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
			// The node answers at once and runs the import as an operation; it
			// then shows up in `imports`. Only an older node answers with the
			// results of the whole batch. Imported instruction folders are
			// registered as workspace projects in both cases.
			const plain = await startImports([
				{
					path: folder,
					items: items
						.filter((i) => selected.has(i.id))
						.map((i) => ({ kind: i.kind, id: i.id })),
				},
			]);
			if (plain.length > 0) {
				setOutcomes(plain);
				if (plain.some((r) => r.folderPath)) {
					onImported?.();
				}
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to import");
		} finally {
			setImporting(false);
		}
	}, [folder, importing, selected, items, startImports, onImported]);

	// Tell the owner once when an import that ran as an operation brought in a
	// project folder. The folders themselves are registered by the hook.
	const announced = useRef<string | null>(null);
	useEffect(() => {
		if (!imports.settled) {
			return;
		}
		const key = imports.operations.map((o) => o.id).join("|");
		if (announced.current === key) {
			return;
		}
		announced.current = key;
		if (imports.outcomes.some((o) => o.folderPath)) {
			onImported?.();
		}
	}, [imports.settled, imports.operations, imports.outcomes, onImported]);

	const groups = groupScanItems(items);
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
				{!(folder || scanning || showOperation) && (
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
						<GrokBotImportButton
							disabled={scanning || importing}
							onImported={onImported}
							onProjectFolder={addProjectFolder}
							target={target}
						/>
					</div>
				)}

				{scanning && (
					<div className="flex h-48 items-center justify-center gap-3 text-muted-foreground text-sm">
						<Spinner />
						Scanning…
					</div>
				)}

				{error && (
					<p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-status-destructive">
						{error}
					</p>
				)}

				{showOperation && (
					<>
						<p className="truncate font-medium text-sm">
							{imports.operations.map((o) => o.title).join(", ")}
						</p>
						<ImportOperationStatus view={imports} />
					</>
				)}

				{!(scanning || showOperation) && folder && (
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
									className="flex items-center gap-2.5 rounded-lg py-1 text-start text-muted-foreground text-xs transition-colors hover:text-foreground"
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
							<Empty spacing="compact">
								<EmptyDescription>
									Nothing importable found in this folder.
								</EmptyDescription>
							</Empty>
						) : (
							<ScrollArea className="h-72 min-w-0">
								<div className="flex flex-col gap-3 pe-2">
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
															className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start transition-colors hover:bg-muted disabled:opacity-50"
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
																	title={scanItemTitle(item, tl)}
																>
																	{scanItemTitle(item, tl)}
																</span>
																{item.detail && (
																	<span
																		className="truncate text-muted-foreground text-xs"
																		title={scanItemDetail(item, tl)}
																	>
																		{scanItemDetail(item, tl)}
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
								<ImportOutcomeTotals outcomes={outcomes} />
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
					{showOperation ? (
						<ImportOperationActions onError={setError} view={imports} />
					) : (
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
					)}
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

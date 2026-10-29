// apps/desktop/src/components/onboarding/MigrationSetup.tsx
//
// Onboarding step: bring an existing agent over from OpenClaw, Hermes, Muse,
// Dots, Mastra, or LangChain. Known home folders are detected on the node; any
// other source is picked as a folder. Core scans, previews, and performs every
// write through the shared setup importer, so this step imports exactly what
// `ryu migrate` and Import agent setup would. Source folders are never changed.

import { FolderOpenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SvglIcon } from "@ryu/blocks/web/svgl-icon.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { NodeFolderBrowser } from "@/src/components/chat/NodeFolderBrowser.tsx";
import { SettingsCard } from "@/src/components/settings/shared/settings-items.tsx";
import {
	detectMigrationSources,
	MIGRATION_SOURCES,
	migrationSourceLabel,
	migrationSourceLogo,
	newMigrationItems,
	summarizeMigrationItems,
} from "@/src/lib/agent-migration.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type ImportOutcome,
	runImport,
	type ScanResult,
	scanImportFolder,
} from "@/src/lib/api/import.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

interface MigrationTotals {
	failed: number;
	imported: number;
	skipped: number;
}

function totalsOf(outcomes: readonly ImportOutcome[]): MigrationTotals {
	return {
		imported: outcomes.filter((o) => o.status === "imported").length,
		skipped: outcomes.filter((o) => o.status === "skipped").length,
		failed: outcomes.filter((o) => o.status === "failed").length,
	};
}

function SourceRow({
	checked,
	disabled,
	onToggle,
	scan,
}: {
	checked: boolean;
	disabled: boolean;
	onToggle: (checked: boolean) => void;
	scan: ScanResult;
}) {
	const tl = useLiteralMessages();
	const pending = newMigrationItems(scan);
	const present = scan.items.length - pending.length;
	const checkboxId = `migrate-${scan.root}`;
	const logo = migrationSourceLogo(scan.source);
	return (
		<div className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-2.5">
			<div className="flex items-start gap-3">
				<Checkbox
					checked={checked}
					disabled={disabled || pending.length === 0}
					id={checkboxId}
					onCheckedChange={(value) => onToggle(value === true)}
				/>
				<label className="min-w-0 flex-1 cursor-pointer" htmlFor={checkboxId}>
					<span className="flex items-center gap-2">
						{logo ? <SvglIcon size={16} spec={logo} /> : null}
						<span className="font-medium text-sm">
							{migrationSourceLabel(scan.source)}
						</span>
						{present > 0 ? (
							<Badge variant="secondary">
								{tl("{present} already in Ryu", { present: String(present) })}
							</Badge>
						) : null}
					</span>
					<span
						className="block truncate font-mono text-muted-foreground text-xs"
						title={scan.root}
					>
						{scan.root}
					</span>
					<span className="mt-1 block text-muted-foreground text-xs">
						{pending.length > 0
							? summarizeMigrationItems(pending)
							: "Everything here is already in Ryu"}
					</span>
				</label>
			</div>
			{scan.warnings.length > 0 ? (
				<details className="pl-7 text-xs">
					<summary className="cursor-pointer text-status-warning">
						{tl(
							"{warningCount, plural, one {{warningCountLabel} thing} other {{warningCountLabel} things}} to set up again",
							{
								warningCount: scan.warnings.length,
								warningCountLabel: String(scan.warnings.length),
							}
						)}
					</summary>
					<ul className="mt-1.5 list-disc space-y-1 pl-4 text-muted-foreground">
						{scan.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</details>
			) : null}
		</div>
	);
}

export function MigrationSetup({
	onContinue,
	onSkip,
	target,
}: {
	onContinue: () => void;
	onSkip: () => void;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const addProjectFolder = useWorkspaceStore((s) => s.addProjectFolder);
	const [scans, setScans] = useState<ScanResult[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [detecting, setDetecting] = useState(true);
	const [scanning, setScanning] = useState(false);
	const [importing, setImporting] = useState(false);
	const [browseOpen, setBrowseOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [totals, setTotals] = useState<MigrationTotals | null>(null);
	// Onboarding rebuilds its target object on every render; detection should
	// run once per node, not once per render.
	const targetRef = useRef(target);
	targetRef.current = target;
	const nodeKey = `${target.url}|${target.token ?? ""}|${target.userJwt ?? ""}`;

	const addScan = useCallback((scan: ScanResult) => {
		setScans((current) => [
			...current.filter((existing) => existing.root !== scan.root),
			scan,
		]);
		if (newMigrationItems(scan).length > 0) {
			setSelected((current) => new Set([...current, scan.root]));
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		setDetecting(true);
		detectMigrationSources(targetRef.current)
			.then((found) => {
				if (!cancelled) {
					for (const scan of found) {
						addScan(scan);
					}
				}
			})
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) {
					setDetecting(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [addScan, nodeKey]);

	const scanPickedFolder = useCallback(
		async (path: string) => {
			setBrowseOpen(false);
			setScanning(true);
			setError(null);
			try {
				const scan = await scanImportFolder(target, path);
				if (scan.items.length === 0) {
					setError(
						tl(
							"Nothing to migrate was found in {root}. Pick the unzipped ChatGPT or Claude export (with conversations.json), or a folder that holds SOUL.md, MEMORY.md, skills, or your project's package.json or pyproject.toml.",
							{ root: scan.root }
						)
					);
					return;
				}
				addScan(scan);
			} catch (cause) {
				setError(
					cause instanceof Error ? cause.message : "Could not scan that folder"
				);
			} finally {
				setScanning(false);
			}
		},
		[addScan, target, tl]
	);

	const chosen = scans.filter((scan) => selected.has(scan.root));
	const pendingCount = chosen.reduce(
		(sum, scan) => sum + newMigrationItems(scan).length,
		0
	);

	const importChosen = useCallback(async () => {
		setImporting(true);
		setError(null);
		const outcomes: ImportOutcome[] = [];
		try {
			for (const scan of chosen) {
				const items = newMigrationItems(scan).map(({ kind, id }) => ({
					kind,
					id,
				}));
				if (items.length === 0) {
					continue;
				}
				const result = await runImport(target, scan.root, items);
				outcomes.push(...result.results);
			}
			for (const outcome of outcomes) {
				if (outcome.folderPath) {
					addProjectFolder(outcome.folderPath);
				}
			}
			const summary = totalsOf(outcomes);
			setTotals(summary);
			if (summary.failed === 0) {
				onContinue();
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Migration failed");
		} finally {
			setImporting(false);
		}
	}, [addProjectFolder, chosen, onContinue, target]);

	const busy = detecting || scanning || importing;
	const folderSources = MIGRATION_SOURCES.filter((source) => !source.homes);
	const otherSources = new Intl.ListFormat("en", {
		style: "long",
		type: "disjunction",
	}).format(folderSources.map((source) => source.label));

	return (
		<div className="flex flex-col gap-4">
			<SettingsCard className="flex flex-col gap-4">
				{detecting ? (
					<div
						className="flex items-center gap-2 text-muted-foreground text-sm"
						role="status"
					>
						<Spinner className="size-4" />
						Looking for Claude Code, Codex, Cursor, OpenClaw, and Hermes…
					</div>
				) : null}
				{!detecting && scans.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No Claude Code, Codex, Cursor, OpenClaw, or Hermes setup was found
						on this node.
					</p>
				) : null}
				{scans.map((scan) => (
					<SourceRow
						checked={selected.has(scan.root)}
						disabled={busy}
						key={scan.root}
						onToggle={(checked) =>
							setSelected((current) => {
								const next = new Set(current);
								if (checked) {
									next.add(scan.root);
								} else {
									next.delete(scan.root);
								}
								return next;
							})
						}
						scan={scan}
					/>
				))}
				<div className="flex flex-wrap items-center justify-between gap-2 border-border/70 border-t pt-3">
					<div className="flex min-w-0 items-center gap-2">
						<span
							aria-hidden="true"
							className="flex shrink-0 items-center gap-1"
						>
							{folderSources.map((source) => (
								<SvglIcon key={source.id} size={14} spec={source.logo} />
							))}
						</span>
						<p className="text-muted-foreground text-xs">
							{tl("Coming from {otherSources}? Choose its folder.", {
								otherSources,
							})}
						</p>
					</div>
					<Button
						disabled={busy}
						onClick={() => setBrowseOpen(true)}
						size="sm"
						variant="outline"
					>
						{scanning ? (
							<Spinner className="size-4" />
						) : (
							<HugeiconsIcon
								className="size-4 shrink-0"
								icon={FolderOpenIcon}
							/>
						)}
						Choose a folder…
					</Button>
				</div>
				{error ? (
					<p
						className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-status-destructive"
						role="alert"
					>
						{error}
					</p>
				) : null}
				{totals ? (
					<p className="text-sm" role="status">
						{tl(
							"{imported} imported, {skipped} skipped, {failed} failed. Review failures in Gateway → Import agents, or continue.",
							{
								imported: String(totals.imported),
								skipped: String(totals.skipped),
								failed: String(totals.failed),
							}
						)}
					</p>
				) : null}
				<p className="text-muted-foreground text-xs">
					Ryu copies your chats, projects, personas, memory, skills, and MCP
					servers. Your original files are never changed, and credentials are
					never copied.
				</p>
				<NodeFolderBrowser
					onOpenChange={setBrowseOpen}
					onSelect={(path) => void scanPickedFolder(path)}
					open={browseOpen}
				/>
			</SettingsCard>
			<div className="flex items-center justify-between gap-3">
				<Button disabled={importing} onClick={onSkip} variant="ghost">
					Skip for now
				</Button>
				<Button
					disabled={busy}
					onClick={
						pendingCount > 0 && !totals ? () => void importChosen() : onContinue
					}
					size="lg"
					variant="mono"
				>
					{importing
						? "Importing…"
						: pendingCount > 0 && !totals
							? tl(
									"Import {pendingCount, plural, one {{pendingCountLabel} item} other {{pendingCountLabel} items}}",
									{ pendingCount, pendingCountLabel: String(pendingCount) }
								)
							: "Continue"}
				</Button>
			</div>
		</div>
	);
}

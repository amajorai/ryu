// apps/desktop/src/components/onboarding/MigrationSetup.tsx
//
// Onboarding step: bring an existing agent over from OpenClaw, Hermes, Muse,
// Dots, Mastra, or LangChain. Known home folders are detected on the node; any
// other source is picked as a folder. Core scans, previews, and performs every
// write through the shared setup importer, so this step imports exactly what
// `ryu migrate` and Import agent setup would. Source folders are never changed.

import { FolderOpenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { SvglIcon } from "@ryu/blocks/web/svgl-icon.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { ImportOperationStatus } from "@/src/components/chat/ImportOperationStatus.tsx";
import {
	importEndMessage,
	summarizeImportOperations,
} from "@/src/components/chat/import-operation-summary.ts";
import { NodeFolderBrowser } from "@/src/components/chat/NodeFolderBrowser.tsx";
import { useImportOperations } from "@/src/hooks/useImportOperations.ts";
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
	type ScanResult,
	scanImportFolder,
} from "@/src/lib/api/import.ts";
import { scanWarnings } from "@/src/lib/import-scan-text.ts";
import { formatLocalList } from "@/src/lib/locale-format.ts";

/** The key under which the operations store remembers this step's imports. */
const MIGRATION_SURFACE = "onboarding-migration";

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
	const warnings = scanWarnings(scan, tl);
	return (
		<div className="flex flex-col gap-2 border-border border-b py-3 last:border-b-0">
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
							<span className="text-detail text-muted-foreground">
								{tl("{present} already in Ryu", { present: String(present) })}
							</span>
						) : null}
					</span>
					<span
						className="block truncate font-mono text-muted-foreground/70 text-xs"
						title={scan.root}
					>
						{scan.root}
					</span>
					<span className="mt-1 block text-detail text-muted-foreground">
						{pending.length > 0
							? summarizeMigrationItems(pending)
							: "Everything here is already in Ryu"}
					</span>
				</label>
			</div>
			{warnings.length > 0 ? (
				<details className="ps-7 text-detail">
					<summary className="cursor-pointer text-status-warning">
						{tl(
							"{warningCount, plural, one {{warningCountLabel} thing} other {{warningCountLabel} things}} to set up again",
							{
								warningCount: warnings.length,
								warningCountLabel: String(warnings.length),
							}
						)}
					</summary>
					<ul className="mt-1 list-disc space-y-1 ps-4 text-muted-foreground">
						{warnings.map((warning) => (
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
	// The imports run on the node as operations, one per source. This step
	// keeps no progress or results of its own, so it shows the same import
	// after the page was left or the app was reloaded.
	const imports = useImportOperations(target, MIGRATION_SURFACE);
	const startImports = imports.start;
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

	// Set when this mounted step started the imports. Only then does a clean
	// finish move on by itself; a step that is opened again on a finished
	// import shows the result and waits for the user.
	const startedHere = useRef(false);

	const importChosen = useCallback(async () => {
		setImporting(true);
		setError(null);
		try {
			const batches = chosen
				.map((scan) => ({
					path: scan.root,
					items: newMigrationItems(scan).map(({ kind, id }) => ({
						kind,
						id,
					})),
				}))
				.filter((batch) => batch.items.length > 0);
			startedHere.current = true;
			// The node answers at once and runs one import per source; they then
			// show up in `imports`. Only an older node answers with the results
			// of each batch. Project folders are registered in both cases.
			const plain = await startImports(batches);
			if (plain.length > 0) {
				const summary = totalsOf(plain);
				setTotals(summary);
				if (summary.failed === 0) {
					onContinue();
				}
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Migration failed");
		} finally {
			setImporting(false);
		}
	}, [chosen, onContinue, startImports]);

	const ended = imports.settled
		? summarizeImportOperations(imports.operations)
		: null;
	const shownTotals =
		totals ?? (imports.settled ? totalsOf(imports.outcomes) : null);
	const endMessage = ended ? importEndMessage(ended.status, tl) : null;
	const cleanFinish =
		ended?.status === "succeeded" &&
		imports.outcomes.every((outcome) => outcome.status !== "failed");
	useEffect(() => {
		if (cleanFinish && startedHere.current) {
			startedHere.current = false;
			onContinue();
		}
	}, [cleanFinish, onContinue]);

	const importingNow = importing || imports.active;
	const busy = detecting || scanning || importingNow;
	const folderSources = MIGRATION_SOURCES.filter((source) => !source.homes);
	const otherSources = formatLocalList(
		folderSources.map((source) => source.label),
		"disjunction"
	);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-4">
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
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-2">
						<span
							aria-hidden="true"
							className="flex shrink-0 items-center gap-1"
						>
							{folderSources.map((source) => (
								<SvglIcon key={source.id} size={14} spec={source.logo} />
							))}
						</span>
						<p className="text-detail text-muted-foreground">
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
					<p className="text-sm text-status-destructive" role="alert">
						{error}
					</p>
				) : null}
				{imports.active ? (
					<ImportOperationStatus hint={false} view={imports} />
				) : null}
				{endMessage ? (
					<p className="text-sm text-status-destructive" role="alert">
						{endMessage}
					</p>
				) : null}
				{shownTotals ? (
					<p className="text-sm" role="status">
						{tl(
							"{imported} imported, {skipped} skipped, {failed} failed. Review failures in Gateway → Import agents, or continue.",
							{
								imported: String(shownTotals.imported),
								skipped: String(shownTotals.skipped),
								failed: String(shownTotals.failed),
							}
						)}
					</p>
				) : null}
				<p className="text-pretty text-detail text-muted-foreground">
					Ryu copies your chats, projects, personas, memory, skills, and MCP
					servers. Your original files are never changed, and credentials are
					never copied.
				</p>
				<NodeFolderBrowser
					onOpenChange={setBrowseOpen}
					onSelect={(path) => void scanPickedFolder(path)}
					open={browseOpen}
				/>
			</div>
			<OnboardingActions className="justify-between">
				<OnboardingCta
					disabled={importingNow}
					onClick={onSkip}
					tone="secondary"
				>
					Skip for now
				</OnboardingCta>
				<OnboardingCta
					disabled={busy}
					onClick={
						pendingCount > 0 && !shownTotals
							? () => void importChosen()
							: onContinue
					}
				>
					{importingNow
						? "Importing…"
						: pendingCount > 0 && !shownTotals
							? tl(
									"Import {pendingCount, plural, one {{pendingCountLabel} item} other {{pendingCountLabel} items}}",
									{ pendingCount, pendingCountLabel: String(pendingCount) }
								)
							: "Continue"}
				</OnboardingCta>
			</OnboardingActions>
		</div>
	);
}

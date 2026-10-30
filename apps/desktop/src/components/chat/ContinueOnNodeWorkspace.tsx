import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { Label } from "@ryu/ui/components/label.tsx";
import { Progress } from "@ryu/ui/components/progress.tsx";
import {
	RNP_WORKSPACE_LIMITS,
	type RnpWorkspaceInspectionV0,
	type RnpWorkspaceUntrackedCandidateV0,
} from "@ryuhq/protocol/continuity";
import type { ReactNode } from "react";
import type { WorkspaceRelayProgress } from "@/src/lib/api/continuity-workspace.ts";

// The "Bring working tree" review inside ContinueOnNodeDialog. Presentational
// only: the dialog owns inspection, selection, freezing and the transfer.

export interface ContinueOnNodeWorkspaceProps {
	enabled: boolean;
	inspection: RnpWorkspaceInspectionV0;
	locked: boolean;
	onEnabledChange: (enabled: boolean) => void;
	onToggleUntracked: (path: string) => void;
	progress: WorkspaceRelayProgress | null;
	selectedUntracked: ReadonlySet<string>;
}

const OMISSION_LABELS: Record<
	NonNullable<RnpWorkspaceUntrackedCandidateV0["reason"]>,
	string
> = {
	ignored: "ignored",
	"not-a-git-repository": "not in git",
	"not-selected": "not selected",
	submodule: "nested repository",
	symlink: "symbolic link",
	"too-large": "over 1 MiB",
	"unsafe-path": "unsafe name",
};

/** Untracked files ticked by default: everything selectable except secrets. */
export function defaultUntrackedSelection(
	inspection: RnpWorkspaceInspectionV0
): Set<string> {
	return new Set(
		inspection.untrackedCandidates
			.filter((candidate) => candidate.selectable && !candidate.sensitive)
			.map((candidate) => candidate.path)
	);
}

export function selectedUntrackedBytes(
	inspection: RnpWorkspaceInspectionV0,
	selected: ReadonlySet<string>
): number {
	let total = 0;
	for (const candidate of inspection.untrackedCandidates) {
		if (selected.has(candidate.path)) {
			total += candidate.bytes;
		}
	}
	return total;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KiB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderCode(chunks: ReactNode): ReactNode {
	return <code>{chunks}</code>;
}

export function ContinueOnNodeWorkspace({
	enabled,
	inspection,
	locked,
	onEnabledChange,
	onToggleUntracked,
	progress,
	selectedUntracked,
}: ContinueOnNodeWorkspaceProps) {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	const { repo } = inspection;
	const treeValues = {
		commit: repo.baseCommit.slice(0, 10),
		repoName: repo.name,
		unpushedCount: Math.max(inspection.unpushedCommits, 0),
		unpushedText: String(inspection.unpushedCommits),
	};
	const untrackedBytes = selectedUntrackedBytes(inspection, selectedUntracked);
	const overCap =
		untrackedBytes > RNP_WORKSPACE_LIMITS.untrackedTotalBytes ||
		selectedUntracked.size > RNP_WORKSPACE_LIMITS.untrackedCount;
	const capPercent = Math.min(
		100,
		Math.round(
			(untrackedBytes / RNP_WORKSPACE_LIMITS.untrackedTotalBytes) * 100
		)
	);

	return (
		<section
			aria-labelledby="rnp-workspace-heading"
			className="grid gap-3 rounded-xl border p-3"
			data-testid="rnp-workspace-review"
		>
			<label className="flex items-start gap-3 text-sm">
				<input
					checked={enabled}
					className="mt-0.5 size-4 accent-foreground"
					disabled={locked}
					onChange={(event) => onEnabledChange(event.target.checked)}
					type="checkbox"
				/>
				<span className="grid gap-0.5">
					<span className="font-medium" id="rnp-workspace-heading">
						Bring working tree
					</span>
					<span className="text-muted-foreground text-xs">
						{repo.branch
							? tlRich(
									"{repoName} on {branch} at <code>{commit}</code>, {unpushedCount, plural, =0 {no unpushed commits} one {{unpushedText} unpushed commit} other {{unpushedText} unpushed commits}}",
									{ ...treeValues, branch: repo.branch },
									{ code: renderCode }
								)
							: tlRich(
									"{repoName} at <code>{commit}</code>, {unpushedCount, plural, =0 {no unpushed commits} one {{unpushedText} unpushed commit} other {{unpushedText} unpushed commits}}",
									treeValues,
									{ code: renderCode }
								)}
					</span>
				</span>
			</label>

			{enabled ? (
				<>
					<div className="grid gap-1">
						<Label>Remote the destination will use</Label>
						{repo.remoteUrl ? (
							<code
								className="break-all rounded-lg bg-muted/40 px-2 py-1 text-xs"
								data-testid="rnp-workspace-remote"
							>
								{repo.remoteUrl}
							</code>
						) : (
							<p className="text-muted-foreground text-xs">
								No shareable remote. The full local history is copied instead.
							</p>
						)}
						<p className="text-muted-foreground text-xs">
							The destination clones or fetches from this URL with its own git
							credentials. Check that it is the repository you expect.
						</p>
					</div>

					<div className="grid gap-1">
						<Label>
							{tl("Changed files ({files}, +{insertions} −{deletions})", {
								deletions: inspection.diffStat.deletions,
								files: inspection.diffStat.files,
								insertions: inspection.diffStat.insertions,
							})}
						</Label>
						<ul className="max-h-28 overflow-y-auto rounded-lg bg-muted/30 p-2 text-xs">
							{inspection.changed.length === 0 ? (
								<li className="text-muted-foreground">No tracked changes</li>
							) : (
								inspection.changed.map((file) => (
									<li
										className={
											file.sensitive ? "text-status-warning" : undefined
										}
										key={file.path}
									>
										<span className="text-muted-foreground">{file.status}</span>{" "}
										{file.path}
										{file.sensitive ? " (looks like a secret)" : ""}
									</li>
								))
							)}
						</ul>
					</div>

					<fieldset className="grid gap-1" disabled={locked}>
						<legend className="font-medium text-sm">Untracked files</legend>
						{inspection.untrackedCandidates.length === 0 ? (
							<p className="text-muted-foreground text-xs">
								No untracked files. Ignored files never move.
							</p>
						) : (
							<ul className="max-h-32 overflow-y-auto rounded-lg bg-muted/30 p-2 text-xs">
								{inspection.untrackedCandidates.map((candidate) => (
									<li key={candidate.path}>
										<label
											className={
												candidate.sensitive
													? "flex items-center gap-2 rounded bg-status-warning/10 px-1 text-status-warning"
													: "flex items-center gap-2 px-1"
											}
										>
											<input
												checked={selectedUntracked.has(candidate.path)}
												className="size-3.5 accent-foreground"
												disabled={!candidate.selectable}
												onChange={() => onToggleUntracked(candidate.path)}
												type="checkbox"
											/>
											<span className="break-all">{candidate.path}</span>
											<span className="ml-auto shrink-0 text-muted-foreground">
												{candidate.selectable
													? formatBytes(candidate.bytes)
													: OMISSION_LABELS[candidate.reason ?? "not-selected"]}
												{candidate.sensitive ? " · secret?" : ""}
											</span>
										</label>
									</li>
								))}
							</ul>
						)}
						<Progress
							aria-label="Untracked size against the handoff limit"
							value={capPercent}
						/>
						<p
							className={
								overCap
									? "text-status-destructive text-xs"
									: "text-muted-foreground text-xs"
							}
						>
							{tl(
								"{selectedCount} selected, {selectedSize} of {sizeLimit}. Files that look like secrets stay unticked until you choose them.",
								{
									selectedCount: selectedUntracked.size,
									selectedSize: formatBytes(untrackedBytes),
									sizeLimit: formatBytes(
										RNP_WORKSPACE_LIMITS.untrackedTotalBytes
									),
								}
							)}
						</p>
					</fieldset>

					{/* New clone only in v1: a worktree of an existing, trusted
					    checkout would inherit that checkout's trust. */}
					<p className="text-sm">
						<span className="font-medium">Destination folder:</span> a new clone
						in the destination's handoffs folder.
					</p>

					<p
						className="rounded-lg bg-status-warning/10 px-2 py-1 text-status-warning text-xs"
						data-testid="rnp-workspace-untrusted"
					>
						The destination opens the work in a new worktree on a handoff
						branch. That folder is not trusted automatically; trust it there
						before letting agents run tools in it.
					</p>

					{progress ? (
						<p className="text-muted-foreground text-xs" role="status">
							{tl(
								progress.skipped > 0
									? "Copied {done} of {total} working-tree parts ({skipped} already on the destination)."
									: "Copied {done} of {total} working-tree parts.",
								{
									done: progress.done,
									skipped: progress.skipped,
									total: progress.total,
								}
							)}
						</p>
					) : null}
				</>
			) : null}
		</section>
	);
}

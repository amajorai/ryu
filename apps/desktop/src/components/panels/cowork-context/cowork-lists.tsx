import {
	BrowserIcon,
	DatabaseIcon,
	File01Icon,
	Flowchart01Icon,
	FolderOpenIcon,
	Image02Icon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { TextShimmer } from "@ryu/blocks/desktop/agent-elements/text-shimmer.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { SubagentAvatar } from "@/src/components/panels/subagent-identity.tsx";
import type { ArtifactKind } from "@/src/lib/artifacts.ts";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";
import type { PlanArtifact } from "@/src/lib/plan-artifacts.ts";
import {
	OverflowRow,
	PANEL_ROW,
	PANEL_ROW_BADGE,
	PANEL_ROW_ICON,
} from "./cowork-rows.tsx";
import type { SubagentSummary } from "./cowork-subagents.ts";

export function SubagentsList({
	subagents,
	onOpen,
	limit,
	onShowAll,
}: {
	limit?: number;
	onOpen?: (subagent: SubagentSummary) => void;
	onShowAll?: () => void;
	subagents: SubagentSummary[];
}) {
	const shown = limit === undefined ? subagents : subagents.slice(0, limit);
	const overflow = subagents.length - shown.length;
	return (
		<ul className="flex flex-col gap-0.5">
			{shown.map((sub) => {
				// While running, the second line shows the live current tool step
				// (recomputed each stream tick); once done it falls back to the task
				// description so the row stays informative.
				const secondary =
					sub.status === "running" ? sub.activity : sub.subtitle;
				return (
					<li key={sub.id}>
						<button
							className={PANEL_ROW}
							onClick={() => onOpen?.(sub)}
							type="button"
						>
							<SubagentAvatar className="size-5 shrink-0" seed={sub.id} />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="flex min-w-0 items-center gap-1.5">
									<span className="truncate text-foreground" title={sub.title}>
										{sub.title}
									</span>
									{/* Only a REAL `subagent_type` earns a chip. An untyped spawn
									    leaves `label` empty rather than printing "Agent" under a
									    section already titled "Subagents". */}
									{sub.label && (
										<span
											className="shrink-0 truncate text-muted-foreground/70 text-xs"
											title={sub.label}
										>
											{sub.label}
										</span>
									)}
								</span>
								{secondary && sub.status === "running" ? (
									<TextShimmer
										as="span"
										className="truncate text-muted-foreground text-xs"
										duration={0.9}
									>
										{secondary}
									</TextShimmer>
								) : secondary ? (
									<span
										className="truncate text-muted-foreground text-xs"
										title={secondary}
									>
										{secondary}
									</span>
								) : null}
							</span>
							{(sub.changes.insertions > 0 || sub.changes.deletions > 0) && (
								<span className="flex shrink-0 items-center gap-1 font-medium text-xs tabular-nums">
									{sub.changes.insertions > 0 && (
										<span className="text-status-success dark:text-status-success/90">
											+{formatCount(sub.changes.insertions)}
										</span>
									)}
									{sub.changes.deletions > 0 && (
										<span className="text-status-destructive/90 dark:text-status-destructive/90">
											-{formatCount(sub.changes.deletions)}
										</span>
									)}
								</span>
							)}
							{sub.status === "running" && (
								<span
									className="size-1.5 shrink-0 rounded-full bg-primary"
									title="Running"
								/>
							)}
						</button>
					</li>
				);
			})}
			{overflow > 0 && (
				<OverflowRow count={overflow} label="subagents" onShowAll={onShowAll} />
			)}
		</ul>
	);
}

/** Inline activity summary for the chat transcript. These intentionally read as
 * ghost buttons: useful while a run is busy, quiet enough not to become another
 * message bubble, and wired to the same transcript opener as the context rail. */
export function SubagentActivityChips({
	onOpen,
	subagents,
}: {
	onOpen?: (subagent: SubagentSummary) => void;
	subagents: SubagentSummary[];
}) {
	const tl = useLiteralMessages();
	if (subagents.length === 0) {
		return null;
	}

	return (
		<div className="flex min-w-0 items-center gap-1.5 overflow-x-auto px-4 py-2">
			{subagents.map((subagent) => (
				<button
					aria-label={tl("Open {title} subagent task", {
						title: subagent.title,
					})}
					className="group flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-transparent px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground"
					key={subagent.id}
					onClick={() => onOpen?.(subagent)}
					type="button"
				>
					<SubagentAvatar
						className="size-4 opacity-75 transition-opacity group-hover:opacity-100"
						seed={subagent.id}
					/>
					<span>{subagent.title}</span>
					{subagent.status === "running" && (
						<span aria-hidden className="size-1.5 rounded-full bg-primary" />
					)}
				</button>
			))}
			<span className="truncate pl-1 text-muted-foreground/70 text-xs">
				{tl("{count, plural, one {# subagent} other {# subagents}} working", {
					count: subagents.length,
				})}
			</span>
		</div>
	);
}

// ── Rendered / canvas artifacts (html · svg · mermaid · code) ─────────────────

// DISTINCT from the worktree "Artifacts" section above (files created on disk):
// these are renderable payloads found in the assistant's own message text
// (extractArtifacts), opened in a sandboxed ArtifactRenderer in the right panel.

const ARTIFACT_KIND_ICON = {
	html: BrowserIcon,
	svg: Image02Icon,
	mermaid: Flowchart01Icon,
	code: SourceCodeIcon,
	file: File01Icon,
	space: FolderOpenIcon,
	database: DatabaseIcon,
} satisfies Record<ArtifactKind, IconSvgElement>;

const ARTIFACT_KIND_LABEL = {
	html: "HTML",
	svg: "SVG",
	mermaid: "Diagram",
	code: "Code",
	file: "File",
	space: "Space",
	database: "Database",
} satisfies Record<ArtifactKind, string>;

export function RenderedArtifactsList({
	artifacts,
	onOpen,
	limit,
}: {
	artifacts: ArtifactView[];
	limit?: number;
	onOpen?: (artifact: ArtifactView) => void;
}) {
	const shown = limit === undefined ? artifacts : artifacts.slice(0, limit);
	const overflow = artifacts.length - shown.length;
	return (
		<ul className="flex flex-col gap-0.5">
			{shown.map((artifact) => (
				<li key={artifact.id}>
					<button
						className={PANEL_ROW}
						onClick={() => onOpen?.(artifact)}
						type="button"
					>
						<span aria-hidden className={PANEL_ROW_ICON}>
							<HugeiconsIcon
								className="size-3.5"
								icon={ARTIFACT_KIND_ICON[artifact.kind]}
							/>
						</span>
						<span
							className="min-w-0 flex-1 truncate text-foreground"
							title={artifact.title}
						>
							{artifact.title}
						</span>
						<span className={PANEL_ROW_BADGE}>
							{ARTIFACT_KIND_LABEL[artifact.kind]}
						</span>
					</button>
				</li>
			))}
			{overflow > 0 && <OverflowRow count={overflow} label="artifacts" />}
		</ul>
	);
}

export function PlansList({
	plans,
	onOpen,
}: {
	onOpen?: (artifact: ArtifactView) => void;
	plans: PlanArtifact[];
}) {
	const tl = useLiteralMessages();
	return (
		<ul className="flex flex-col gap-0.5" data-testid="pinned-summary-plans">
			{plans.map((plan) => (
				<li key={plan.key}>
					<button
						aria-label={tl("Open plan {title}", { title: plan.title })}
						className={PANEL_ROW}
						data-testid="pinned-summary-plan"
						onClick={() => onOpen?.(plan.artifact)}
						type="button"
					>
						<span aria-hidden className={PANEL_ROW_ICON}>
							<HugeiconsIcon className="size-3.5" icon={File01Icon} />
						</span>
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="truncate text-foreground" title={plan.title}>
								{plan.title}
							</span>
							<span className="truncate text-muted-foreground text-xs">
								{plan.sourceLabel} ·{" "}
								{plan.error
									? "Not saved"
									: plan.saved
										? "Saved to Artifacts"
										: "Saving…"}
							</span>
						</span>
						<span className={PANEL_ROW_BADGE}>
							{plan.error ? "Error" : plan.saved ? "Plan" : "…"}
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

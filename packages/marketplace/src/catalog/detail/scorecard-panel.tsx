// packages/marketplace/src/catalog/detail/scorecard-panel.tsx
//
// The Health tab and its header badge — the rendered form of a deterministic
// scorecard in `../scorecard.ts`.
//
// The design intent is that a reader can disagree with the grade. So the panel
// never shows a bare score: every check is listed with its verdict AND the
// sentence explaining it, grouped by the family it belongs to, with `unknown`
// checks shown but visibly discounted (they do not affect the score, and saying
// so is the honest thing). A high grade with three unanswerable checks should not
// read the same as a high grade with none.

import {
	Alert01Icon,
	CheckmarkCircle02Icon,
	CircleIcon,
	HelpCircleIcon,
	ShieldKeyIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import type { CatalogScanResult } from "../host.tsx";
import {
	CATEGORY_DESCRIPTIONS,
	CATEGORY_LABELS,
	type CheckStatus,
	type Scorecard,
	type ScorecardCheck,
	type ScorecardGrade,
} from "../scorecard.ts";
import { AgentAuditPanel } from "./agent-audit-panel.tsx";

/** Per-status presentation. Kept as one table so the badge, the rows, and the
 *  category headers can never drift into disagreeing about what a status looks
 *  like. */
const STATUS_STYLE = {
	fail: {
		className: "text-status-destructive",
		icon: Alert01Icon,
		label: "Failed",
	},
	pass: {
		className: "text-status-success",
		icon: CheckmarkCircle02Icon,
		label: "Passed",
	},
	unknown: {
		className: "text-muted-foreground",
		icon: HelpCircleIcon,
		label: "Not checkable",
	},
	warn: {
		className: "text-status-warning",
		icon: CircleIcon,
		label: "Worth knowing",
	},
} satisfies Record<
	CheckStatus,
	{ className: string; icon: IconSvgElement; label: string }
>;

/** Grade → badge treatment. A/B read as fine, C/D as caution, F as a stop sign. */
const GRADE_STYLE = {
	A: "border-success/40 text-status-success",
	B: "border-success/40 text-status-success",
	C: "border-warning/40 text-status-warning",
	D: "border-warning/40 text-status-warning",
	F: "border-destructive/40 text-status-destructive",
} satisfies Record<ScorecardGrade, string>;

/**
 * The compact grade pill for the detail header.
 *
 * Renders nothing when the scan could not evaluate a single check — an empty
 * badge would imply a verdict that was never reached.
 */
export function ScorecardBadge({
	onClick,
	scorecard,
}: {
	/** Jump to the Health tab. Omitted where the badge is not interactive. */
	onClick?: () => void;
	scorecard: Scorecard;
}) {
	const tl = useLiteralMessages();
	if (scorecard.grade === null || scorecard.score === null) {
		return null;
	}
	const label = tl("Health {grade} — {score} out of 100. {summary}", {
		grade: scorecard.grade,
		score: scorecard.score,
		summary: scorecard.summary,
	});
	const content = (
		<>
			<HugeiconsIcon className="size-3.5" icon={ShieldKeyIcon} />
			<span className="font-medium">{scorecard.grade}</span>
			<span className="text-muted-foreground">{scorecard.score}/100</span>
		</>
	);
	const className = cn(
		"inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
		GRADE_STYLE[scorecard.grade]
	);
	if (!onClick) {
		return (
			<span aria-label={label} className={className} title={label}>
				{content}
			</span>
		);
	}
	return (
		<button
			aria-label={label}
			className={cn(className, "transition-colors hover:bg-accent")}
			onClick={onClick}
			title={label}
			type="button"
		>
			{content}
		</button>
	);
}

function CheckRow({ check }: { check: ScorecardCheck }) {
	const style = STATUS_STYLE[check.status];
	return (
		<li
			className={cn(
				"flex items-start gap-2.5 rounded-lg bg-muted px-3 py-2",
				check.status === "unknown" && "opacity-60"
			)}
		>
			<HugeiconsIcon
				aria-hidden="true"
				className={cn("mt-0.5 size-4 shrink-0", style.className)}
				icon={style.icon}
			/>
			<div className="min-w-0 flex-1">
				<p className="font-medium text-sm">{check.label}</p>
				<p className="text-muted-foreground text-xs leading-relaxed">
					{check.detail}
				</p>
			</div>
			<span className={cn("shrink-0 text-xs", style.className)}>
				{style.label}
			</span>
		</li>
	);
}

/** The Health tab: the score, then every check grouped by family. */
export function ScorecardPanel({
	agentScan,
	onOpenConversation,
	disclaimer,
	dataTestId,
	developerDoctor,
	developerEvals,
	developerCommand,
	scorecard,
	rulesetLabel = "Catalog ruleset",
	title = "Automated checks",
}: {
	agentScan?: () => Promise<CatalogScanResult>;
	onOpenConversation?: (id: string) => void;
	disclaimer?: ReactNode;
	dataTestId?: string;
	developerCommand?: string;
	developerDoctor?: ReactNode;
	developerEvals?: ReactNode;
	rulesetLabel?: string;
	scorecard: Scorecard;
	title?: string;
}) {
	const tl = useLiteralMessages();
	const unknownCount = scorecard.checks.length - scorecard.evaluated;

	return (
		<div className="flex flex-col gap-6" data-testid={dataTestId}>
			<section className="flex items-start gap-4 rounded-lg bg-muted p-4">
				<div className="flex flex-col items-center gap-0.5">
					<span
						className={cn(
							"font-medium text-3xl leading-none",
							scorecard.grade ? GRADE_STYLE[scorecard.grade] : ""
						)}
					>
						{scorecard.grade ?? "—"}
					</span>
					<span className="text-muted-foreground text-xs">
						{scorecard.score === null ? "no score" : `${scorecard.score}/100`}
					</span>
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h3 className="font-medium text-sm">{title}</h3>
					</div>
					<p className="text-muted-foreground text-sm leading-relaxed">
						{scorecard.summary}
					</p>
					<p className="mt-1 text-muted-foreground text-xs">
						{unknownCount > 0
							? tl(
									"{evaluated, plural, one {# check} other {# checks}} scored, {unknownCount} not answerable from this source (excluded).",
									{ evaluated: scorecard.evaluated, unknownCount }
								)
							: tl(
									"{evaluated, plural, one {# check} other {# checks}} scored.",
									{
										evaluated: scorecard.evaluated,
									}
								)}
					</p>
					<p
						className="mt-1 text-muted-foreground text-xs"
						data-scorecard-ruleset={scorecard.rulesetVersion}
					>
						{rulesetLabel} {scorecard.rulesetVersion}
					</p>
				</div>
			</section>

			{agentScan ? (
				<AgentAuditPanel
					key={JSON.stringify(scorecard)}
					onOpenConversation={onOpenConversation}
					runAudit={agentScan}
				/>
			) : null}

			{scorecard.categories.map((category) => {
				const checks = scorecard.checks.filter(
					(c) => c.category === category.category
				);
				return (
					<section
						className="flex flex-col gap-2"
						data-scorecard-category={category.category}
						key={category.category}
					>
						<div className="flex items-baseline justify-between gap-3">
							<h3 className="font-medium text-sm">
								{CATEGORY_LABELS[category.category]}
							</h3>
							{category.score === null ? null : (
								<Badge className="shrink-0" variant="secondary">
									{category.score}/100
								</Badge>
							)}
						</div>
						<p className="text-muted-foreground text-xs">
							{CATEGORY_DESCRIPTIONS[category.category]}
						</p>
						<ul className="flex flex-col gap-1.5">
							{checks.map((check) => (
								<CheckRow check={check} key={check.id} />
							))}
						</ul>
					</section>
				);
			})}

			{developerDoctor ??
				(developerCommand ? (
					<section
						className="flex flex-col gap-2 rounded-lg border border-primary/25 bg-primary/5 p-4"
						data-scorecard-runtime-doctor="true"
					>
						<h3 className="font-medium text-sm">Developer runtime doctor</h3>
						<p className="text-muted-foreground text-xs leading-relaxed">
							This marketplace score is a read-only catalog scan. After
							installing, run the Core loader doctor to validate the actual
							manifest, lifecycle state, dependencies, permissions, and
							contribution shape.
						</p>
						<code className="rounded-lg bg-background px-3 py-2 font-mono text-xs">
							{developerCommand}
						</code>
						<p className="text-muted-foreground text-xs leading-relaxed">
							The runtime doctor is also lint-only: it does not execute plugin
							code, start sidecars, or change settings.
						</p>
					</section>
				) : null)}

			{developerEvals ?? null}

			{disclaimer ?? (
				<p className="text-muted-foreground text-xs leading-relaxed">
					These checks are automated and read only what the listing publishes.
					They are a starting point for judgement, not a security audit — a
					passing grade is not a guarantee, and a failing one is not proof of
					bad intent.
				</p>
			)}
		</div>
	);
}

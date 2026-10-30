// Prompt Studio: result matrix cells, per-model stat cards, and assertion chips.

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useEffect, useState } from "react";
import { z } from "zod";
import { toastActionError } from "@/src/lib/action-error.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	AssertionResult,
	EvalCaseScore,
	ModelEvalResult,
} from "@/src/lib/api/gateway.ts";
import {
	type PromptReview,
	savePromptReview,
} from "@/src/lib/api/prompt-suites.ts";
import type { TestCaseRow } from "@/src/lib/prompt-studio.ts";
import { parsePromptfooValue } from "@/src/lib/promptfoo.ts";
import { formatMicroUsd, pct, scoreTone } from "./PromptStudio-format.ts";

export function CaseLabel({
	row,
	fallback,
}: {
	row: TestCaseRow | undefined;
	fallback: string | undefined;
}) {
	let label = fallback ?? "—";
	if (row) {
		label = row.name.trim() || row.input || fallback || "—";
	}
	return <span className="line-clamp-3 break-words">{label}</span>;
}

export function ModelStatCard({ result }: { result: ModelEvalResult }) {
	const agg = result.aggregate;
	const total = result.cases.length;
	const passing = result.cases.filter((c) => c.assertions_pass).length;
	const assertionRate = total > 0 ? passing / total : 1;
	return (
		<div className="flex flex-col gap-1 rounded-lg bg-muted/30 p-2">
			<span className="font-medium text-xs">{result.model}</span>
			<div className="grid grid-cols-2 gap-1 sm:grid-cols-5">
				<StatCell
					label="Overall"
					tone={scoreTone(agg.mean_overall)}
					value={pct(agg.mean_overall)}
				/>
				<StatCell
					label="Policy"
					value={
						agg.policy_available_cases === 0 ? "N/A" : pct(agg.policy_pass_rate)
					}
				/>
				<StatCell
					label="Assert"
					tone={scoreTone(assertionRate)}
					value={pct(assertionRate)}
				/>
				<StatCell
					label="Tokens"
					value={String(
						(agg.total_input_tokens ?? 0) + (agg.total_output_tokens ?? 0)
					)}
				/>
				<StatCell
					label="Spend"
					value={formatMicroUsd(agg.total_cost_micro_usd)}
				/>
			</div>
		</div>
	);
}

function StatCell({
	label,
	value,
	tone,
}: {
	label: string;
	value: string;
	tone?: string;
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="type-micro text-muted-foreground uppercase tracking-wide">
				{label}
			</span>
			<span className={`font-medium text-xs ${tone ?? ""}`}>{value}</span>
		</div>
	);
}

function jsonOutput(text: string): string {
	try {
		return JSON.stringify(parsePromptfooValue(JSON.parse(text)), null, 2);
	} catch {
		return text;
	}
}

export function MatrixCell({
	resultKey,
	runId,
	review: persistedReview,
	onCopy,
	onReviewSaved,
	score,
	suiteId,
	target,
}: {
	resultKey: string;
	runId: string | null;
	review?: PromptReview;
	onCopy: (text: string) => Promise<void>;
	onReviewSaved: (review: PromptReview) => void;
	score: EvalCaseScore | undefined;
	suiteId: string | null;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [reviewSaving, setReviewSaving] = useState(false);
	const [reviewed, setReviewed] = useState<boolean | null>(
		persistedReview?.pass ?? null
	);
	const [reviewComment, setReviewComment] = useState(
		persistedReview?.comment ?? ""
	);
	const [reviewHighlighted, setReviewHighlighted] = useState(
		persistedReview?.highlighted ?? false
	);
	const [reviewScore, setReviewScore] = useState(
		persistedReview?.score === null || persistedReview?.score === undefined
			? ""
			: String(persistedReview.score)
	);
	const [renderMode, setRenderMode] = useState<"text" | "markdown" | "json">(
		"text"
	);

	useEffect(() => {
		setReviewed(persistedReview?.pass ?? null);
		setReviewComment(persistedReview?.comment ?? "");
		setReviewHighlighted(persistedReview?.highlighted ?? false);
		setReviewScore(
			persistedReview?.score === null || persistedReview?.score === undefined
				? ""
				: String(persistedReview.score)
		);
	}, [persistedReview]);
	if (!score) {
		return <span className="text-muted-foreground">—</span>;
	}
	const review = async (
		pass: boolean,
		options: { highlighted?: boolean } = {}
	) => {
		if (!(runId && suiteId)) {
			return;
		}
		setReviewSaving(true);
		try {
			const parsedReviewScore = Number.parseFloat(reviewScore);
			const savedReview = await savePromptReview(target, suiteId, runId, {
				comment: reviewComment.trim() || undefined,
				highlighted: options.highlighted ?? reviewHighlighted,
				pass,
				resultKey,
				score: Number.isFinite(parsedReviewScore)
					? Math.max(0, Math.min(1, parsedReviewScore))
					: score.overall,
			});
			setReviewed(pass);
			setReviewScore(String(savedReview.score ?? score.overall));
			onReviewSaved(savedReview);
		} catch (error) {
			toastActionError("Couldn't save review", error);
		} finally {
			setReviewSaving(false);
		}
	};
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-1">
				<Badge
					size="compact"
					tone={score.assertions_pass ? "default" : "destructive"}
					variant={score.assertions_pass ? "secondary" : "outline"}
				>
					{score.assertions_pass ? "pass" : "fail"}
				</Badge>
				<span className={`font-medium ${scoreTone(score.overall)}`}>
					{pct(score.overall)}
				</span>
			</div>
			<AssertionChips assertions={score.assertions} />
			{score.evaluators && score.evaluators.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{score.evaluators.map((evaluator) => (
						<span
							className={`type-compact rounded px-1 py-0.5 ${evaluator.pass ? "bg-success/15 text-status-success dark:text-status-success" : "bg-warning/15 text-status-warning dark:text-status-warning"}`}
							key={evaluator.id}
						>
							{evaluator.id}:{" "}
							{evaluator.executed ? pct(evaluator.score) : "skipped"}
						</span>
					))}
				</div>
			) : null}
			<p className="line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground">
				{score.response_text}
			</p>
			<details className="type-compact rounded border border-dashed px-2 py-1">
				<summary className="cursor-pointer text-muted-foreground">
					Inspect full cell
				</summary>
				<div className="mt-2 flex flex-col gap-1">
					<div className="flex items-center justify-between gap-2">
						<span className="text-muted-foreground">Rendered prompt</span>
						<Button
							onClick={() => onCopy(score.rendered_prompt ?? score.prompt)}
							size="micro"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={Copy01Icon} />
							Copy
						</Button>
					</div>
					<pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-1">
						{score.rendered_prompt ?? score.prompt}
					</pre>
					<div className="flex items-center justify-between gap-2">
						<span className="text-muted-foreground">Full output</span>
						<Button
							onClick={() => onCopy(score.response_text)}
							size="micro"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={Copy01Icon} />
							Copy
						</Button>
					</div>
					<NativeSelect
						appearance="micro-dense"
						aria-label="Cell output render mode"
						className="w-28"
						onChange={(event) =>
							setRenderMode(
								z.enum(["text", "markdown", "json"]).parse(event.target.value)
							)
						}
						value={renderMode}
					>
						<NativeSelectOption value="text">Text</NativeSelectOption>
						<NativeSelectOption value="markdown">Markdown</NativeSelectOption>
						<NativeSelectOption value="json">JSON</NativeSelectOption>
					</NativeSelect>
					{renderMode === "markdown" ? (
						<div className="max-h-40 overflow-auto rounded bg-muted/30 p-1">
							<Markdown
								className="text-xs [&_p]:my-1"
								content={score.response_text}
							/>
						</div>
					) : (
						<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-1">
							{renderMode === "json"
								? jsonOutput(score.response_text)
								: score.response_text}
						</pre>
					)}
					<div className="grid grid-cols-2 gap-1 text-muted-foreground">
						<span>
							{tl("Latency score: {score}", {
								score:
									score.latency_available === false
										? "N/A"
										: pct(score.latency_score),
							})}
						</span>
						<span>
							{tl("Tokens: {tokens}", {
								tokens: String(score.total_tokens ?? "—"),
							})}
						</span>
						<span>
							{tl("Cost: {cost}µUSD", {
								cost: String(score.cost_micro_usd ?? "unknown"),
							})}
						</span>
						<span>
							{tl("Cache: {state}", {
								state: score.cache_hit ? "hit" : "miss",
							})}
						</span>
					</div>
					{score.error ? (
						<p className="text-status-destructive">{score.error}</p>
					) : null}
					<pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-1">
						{JSON.stringify(score.metadata ?? {}, null, 2)}
					</pre>
					{score.context === undefined ? null : (
						<pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-1">
							{JSON.stringify(score.context, null, 2)}
						</pre>
					)}
				</div>
			</details>
			{runId && suiteId ? (
				<div className="flex items-center gap-1">
					<span className="type-compact mr-1 text-muted-foreground">
						Review
					</span>
					<Button
						disabled={reviewSaving}
						onClick={() => review(true).catch(() => undefined)}
						size="micro"
						variant={reviewed === true ? "secondary" : "ghost"}
					>
						Pass
					</Button>
					<Button
						disabled={reviewSaving}
						onClick={() => review(false).catch(() => undefined)}
						size="micro"
						variant={reviewed === false ? "destructive" : "ghost"}
					>
						Fail
					</Button>
					<Button
						disabled={reviewSaving}
						onClick={() => {
							const next = !reviewHighlighted;
							setReviewHighlighted(next);
							review(reviewed ?? score.assertions_pass, {
								highlighted: next,
							}).catch(() => undefined);
						}}
						size="micro"
						variant={reviewHighlighted ? "secondary" : "ghost"}
					>
						{reviewHighlighted ? "Highlighted" : "Highlight"}
					</Button>
					<Input
						aria-label="Human review score"
						className="w-16"
						disabled={reviewSaving}
						max="1"
						min="0"
						onChange={(event) => setReviewScore(event.target.value)}
						placeholder="0–1"
						size="micro"
						step="0.05"
						type="number"
						value={reviewScore}
					/>
					<Input
						aria-label="Human review comment"
						disabled={reviewSaving}
						onChange={(event) => setReviewComment(event.target.value)}
						placeholder="Add a review comment…"
						size="micro"
						value={reviewComment}
					/>
					<Button
						className="self-start"
						disabled={reviewSaving || !reviewComment.trim()}
						onClick={() =>
							review(reviewed ?? score.assertions_pass).catch(() => undefined)
						}
						size="micro"
						variant="ghost"
					>
						Save comment
					</Button>
				</div>
			) : null}
		</div>
	);
}

function AssertionChips({ assertions }: { assertions: AssertionResult[] }) {
	if (assertions.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap gap-1">
			{assertions.map((a, i) => {
				const className = `rounded px-1 py-0.5 type-compact ${a.pass ? "bg-success/15 text-status-success dark:text-status-success" : "bg-destructive/15 text-status-destructive"}`;
				return a.detail ? (
					<Tooltip
						// assertion results are positional and have no stable id
						key={`${a.kind}-${i}`}
					>
						<TooltipTrigger
							render={<span className={className}>{a.kind}</span>}
						/>
						<TooltipContent>{a.detail}</TooltipContent>
					</Tooltip>
				) : (
					<span
						className={className}
						// assertion results are positional and have no stable id
						key={`${a.kind}-${i}`}
					>
						{a.kind}
					</span>
				);
			})}
		</div>
	);
}

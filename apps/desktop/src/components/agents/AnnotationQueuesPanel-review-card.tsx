// apps/desktop/src/components/agents/AnnotationQueuesPanel-review-card.tsx
//
// Card a reviewer uses to score, label and comment on one claimed item.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	type AnnotationItem,
	type AnnotationQueueSummary,
	submitAnnotation,
} from "@ryuhq/core-client/annotation-queues.ts";
import { useId, useState } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { errorText, parseScore } from "./AnnotationQueuesPanel-parsing.ts";

export function ReviewCard({
	item,
	onDone,
	queue,
	target,
}: {
	item: AnnotationItem;
	onDone: () => void;
	queue: AnnotationQueueSummary;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const commentId = useId();
	const [score, setScore] = useState("");
	const [labels, setLabels] = useState<Set<string>>(new Set());
	const [comment, setComment] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (skip: boolean) => {
		const parsed = parseScore(score);
		if (parsed === null) {
			setError("Score must be a number.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await submitAnnotation(
				target,
				queue.id,
				item.id,
				skip
					? { status: "skipped" }
					: {
							comment: comment.trim() || undefined,
							labels: [...labels],
							score: parsed,
						}
			);
			onDone();
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-3 rounded-lg border border-border p-3">
			<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
				<Badge variant="outline">{item.source_kind}</Badge>
				{item.run_id ? (
					<span>{tl("Run {run_id}", { run_id: item.run_id })}</span>
				) : null}
				{item.trace_id ? (
					<span>{tl("Trace {trace_id}", { trace_id: item.trace_id })}</span>
				) : null}
			</div>
			{queue.rubric ? (
				<p className="whitespace-pre-wrap text-muted-foreground text-sm">
					{queue.rubric}
				</p>
			) : null}
			<section aria-label="Prompt" className="flex flex-col gap-1">
				<span className="font-medium text-xs">Prompt</span>
				<p className="whitespace-pre-wrap rounded-lg bg-muted p-2 text-sm">
					{item.input}
				</p>
			</section>
			<section aria-label="Response" className="flex flex-col gap-1">
				<span className="font-medium text-xs">Response</span>
				<p className="whitespace-pre-wrap rounded-lg bg-muted p-2 text-sm">
					{item.output}
				</p>
			</section>
			<Input
				aria-label={tl("Score from {score_min} to {score_max}", {
					score_min: String(queue.score_min),
					score_max: String(queue.score_max),
				})}
				disabled={busy}
				inputMode="decimal"
				onChange={(event) => setScore(event.target.value)}
				placeholder={tl("Score ({score_min}–{score_max})", {
					score_min: String(queue.score_min),
					score_max: String(queue.score_max),
				})}
				value={score}
			/>
			{queue.labels.length > 0 ? (
				<div className="flex flex-wrap gap-3">
					{queue.labels.map((label) => (
						<label className="flex items-center gap-1.5 text-sm" key={label}>
							<Checkbox
								checked={labels.has(label)}
								disabled={busy}
								onCheckedChange={(checked) =>
									setLabels((previous) => {
										const next = new Set(previous);
										if (checked === true) {
											next.add(label);
										} else {
											next.delete(label);
										}
										return next;
									})
								}
							/>
							{label}
						</label>
					))}
				</div>
			) : null}
			<label className="sr-only" htmlFor={commentId}>
				Comment
			</label>
			<Textarea
				disabled={busy}
				id={commentId}
				onChange={(event) => setComment(event.target.value)}
				placeholder="Comment"
				rows={2}
				value={comment}
			/>
			{error ? <ErrorLine message={error} /> : null}
			<div className="flex gap-2">
				<Button
					disabled={busy}
					onClick={() => {
						submit(false).catch(() => undefined);
					}}
					size="sm"
				>
					Submit
				</Button>
				<Button
					disabled={busy}
					onClick={() => {
						submit(true).catch(() => undefined);
					}}
					size="sm"
					variant="outline"
				>
					Skip
				</Button>
			</div>
		</div>
	);
}

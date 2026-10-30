// apps/desktop/src/components/agents/AnnotationQueuesPanel-queue-detail.tsx
//
// Detail view for one annotation queue: counts, adding runs, claiming the next
// item for review, and exporting reviewed items into a prompt suite.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	type AnnotationItem,
	type AnnotationQueueSummary,
	addAnnotationItems,
	exportAnnotationQueue,
	nextAnnotationItem,
} from "@ryuhq/core-client/annotation-queues.ts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { listPromptSuites } from "@/src/lib/api/prompt-suites.ts";
import {
	errorText,
	parseLabelList,
	parseScore,
} from "./AnnotationQueuesPanel-parsing.ts";
import { ReviewCard } from "./AnnotationQueuesPanel-review-card.tsx";

export function QueueDetail({
	agentId,
	onChanged,
	queue,
	target,
}: {
	agentId: string;
	onChanged: () => void;
	queue: AnnotationQueueSummary;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const runId = useId();
	const [item, setItem] = useState<AnnotationItem | null>(null);
	const [drained, setDrained] = useState(false);
	const [runInput, setRunInput] = useState("");
	const [suiteId, setSuiteId] = useState("");
	const [minScore, setMinScore] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const suites = useQuery({
		queryKey: ["prompt-suites", target.url, agentId],
		queryFn: () => listPromptSuites(target, agentId),
	});

	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			await action();
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	};

	const claimNext = () =>
		run(async () => {
			const next = await nextAnnotationItem(target, queue.id);
			setItem(next);
			setDrained(next === null);
			onChanged();
		});

	const addRuns = () =>
		run(async () => {
			const ids = parseLabelList(runInput);
			const result = await addAnnotationItems(
				target,
				queue.id,
				ids.map((id) => ({ run_id: id }))
			);
			setRunInput("");
			setMessage(
				result.skipped
					? tl("Added {count} item(s), {skipped} already queued.", {
							count: String(result.added.length),
							skipped: String(result.skipped),
						})
					: tl("Added {count} item(s).", { count: String(result.added.length) })
			);
			onChanged();
		});

	const exportReviewed = () =>
		run(async () => {
			const min = parseScore(minScore);
			if (min === null) {
				throw new Error("Minimum score must be a number.");
			}
			const result = await exportAnnotationQueue(target, queue.id, {
				min_score: min,
				suite_id: suiteId,
			});
			setMessage(
				result.skipped
					? tl("Exported {added} case(s), {skipped} already in the suite.", {
							added: String(result.added),
							skipped: String(result.skipped),
						})
					: tl("Exported {added} case(s).", { added: String(result.added) })
			);
		});

	const { counts } = queue;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap gap-2 text-xs">
				<Badge variant="secondary">
					{tl("{pending} pending", { pending: String(counts.pending) })}
				</Badge>
				<Badge variant="secondary">
					{tl("{in_progress} in review", {
						in_progress: String(counts.in_progress),
					})}
				</Badge>
				<Badge variant="secondary">
					{tl("{completed} done", { completed: String(counts.completed) })}
				</Badge>
				<Badge variant="secondary">
					{tl("{skipped} skipped", { skipped: String(counts.skipped) })}
				</Badge>
			</div>
			<div className="flex gap-2">
				<label className="sr-only" htmlFor={runId}>
					Run ids
				</label>
				<Input
					disabled={busy}
					id={runId}
					onChange={(event) => setRunInput(event.target.value)}
					placeholder="Run ids to add, comma separated"
					value={runInput}
				/>
				<Button
					disabled={busy || runInput.trim() === ""}
					onClick={() => {
						addRuns().catch(() => undefined);
					}}
					size="sm"
					variant="outline"
				>
					Add runs
				</Button>
			</div>
			{item ? (
				<ReviewCard
					item={item}
					key={item.id}
					onDone={() => {
						setItem(null);
						onChanged();
						claimNext().catch(() => undefined);
					}}
					queue={queue}
					target={target}
				/>
			) : (
				<div className="flex items-center gap-3">
					<Button
						disabled={busy}
						onClick={() => {
							claimNext().catch(() => undefined);
						}}
						size="sm"
					>
						Review next item
					</Button>
					{drained ? (
						<span className="text-muted-foreground text-xs">
							Nothing left to review.
						</span>
					) : null}
				</div>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<NativeSelect
					aria-label="Prompt suite to export into"
					disabled={busy}
					onChange={(event) => setSuiteId(event.target.value)}
					value={suiteId}
				>
					<NativeSelectOption value="">
						Choose a prompt suite
					</NativeSelectOption>
					{(suites.data ?? []).map((suite) => (
						<NativeSelectOption key={suite.id} value={suite.id}>
							{suite.name}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<Input
					aria-label="Minimum human score to export"
					className="w-28"
					disabled={busy}
					inputMode="decimal"
					onChange={(event) => setMinScore(event.target.value)}
					placeholder="Min score"
					value={minScore}
				/>
				<Button
					disabled={busy || suiteId === "" || counts.completed === 0}
					onClick={() => {
						exportReviewed().catch(() => undefined);
					}}
					size="sm"
					variant="outline"
				>
					Export reviewed
				</Button>
			</div>
			{message ? (
				<p className="text-muted-foreground text-xs">{message}</p>
			) : null}
			{error ? <ErrorLine message={error} /> : null}
		</div>
	);
}

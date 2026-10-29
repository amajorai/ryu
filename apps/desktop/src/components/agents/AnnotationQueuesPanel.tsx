// apps/desktop/src/components/agents/AnnotationQueuesPanel.tsx
//
// Human review for an agent: annotation queues over its runs, single messages
// and external traces. A reviewer claims the next item, scores it against the
// queue rubric (score range + closed label set + comment), and reviewed items
// export into a Prompt Studio suite as regression cases. Core owns the queue
// state and every permission check (`/api/annotation-queues/*`); this view only
// drives it through `@ryuhq/core-client/annotation-queues`.

import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	type AnnotationItem,
	type AnnotationQueueSummary,
	addAnnotationItems,
	createAnnotationQueue,
	exportAnnotationQueue,
	listAnnotationQueues,
	nextAnnotationItem,
	submitAnnotation,
} from "@ryuhq/core-client/annotation-queues.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { listPromptSuites } from "@/src/lib/api/prompt-suites.ts";

export interface AnnotationQueuesPanelProps {
	agentId: string;
	target: ApiTarget;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Split a comma-separated label list into trimmed, unique, non-empty labels. */
export function parseLabelList(raw: string): string[] {
	const labels: string[] = [];
	for (const part of raw.split(",")) {
		const label = part.trim();
		if (label && !labels.includes(label)) {
			labels.push(label);
		}
	}
	return labels;
}

/** Parse a score field; `undefined` when blank, `null` when not a number. */
export function parseScore(raw: string): number | null | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return;
	}
	const value = Number(trimmed);
	return Number.isFinite(value) ? value : null;
}

function CreateQueueForm({
	agentId,
	onCreated,
	target,
}: {
	agentId: string;
	onCreated: (queueId: string) => void;
	target: ApiTarget;
}) {
	const nameId = useId();
	const rubricId = useId();
	const labelsId = useId();
	const [name, setName] = useState("");
	const [rubric, setRubric] = useState("");
	const [labels, setLabels] = useState("");
	const [scoreMax, setScoreMax] = useState("5");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const create = async () => {
		const max = parseScore(scoreMax);
		if (typeof max !== "number" || max <= 1) {
			setError("The top score must be a number above 1.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const queue = await createAnnotationQueue(target, agentId, {
				labels: parseLabelList(labels),
				name,
				rubric,
				score_max: max,
				score_min: 1,
			});
			setName("");
			setRubric("");
			setLabels("");
			onCreated(queue.id);
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2 rounded-lg border border-border p-3">
			<label className="font-medium text-sm" htmlFor={nameId}>
				New queue
			</label>
			<Input
				disabled={busy}
				id={nameId}
				onChange={(event) => setName(event.target.value)}
				placeholder="Queue name"
				value={name}
			/>
			<label className="sr-only" htmlFor={rubricId}>
				Rubric
			</label>
			<Textarea
				disabled={busy}
				id={rubricId}
				onChange={(event) => setRubric(event.target.value)}
				placeholder="Rubric: what reviewers should judge"
				rows={3}
				value={rubric}
			/>
			<div className="flex gap-2">
				<label className="sr-only" htmlFor={labelsId}>
					Labels
				</label>
				<Input
					disabled={busy}
					id={labelsId}
					onChange={(event) => setLabels(event.target.value)}
					placeholder="Labels, comma separated"
					value={labels}
				/>
				<Input
					aria-label="Top score"
					className="w-24"
					disabled={busy}
					inputMode="numeric"
					onChange={(event) => setScoreMax(event.target.value)}
					value={scoreMax}
				/>
			</div>
			{error ? (
				<p className="text-status-destructive text-xs">{error}</p>
			) : null}
			<div>
				<Button
					disabled={busy || name.trim() === ""}
					onClick={() => {
						create().catch(() => undefined);
					}}
					size="sm"
				>
					Create queue
				</Button>
			</div>
		</div>
	);
}

function ReviewCard({
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
				{item.run_id ? <span>Run {item.run_id}</span> : null}
				{item.trace_id ? <span>Trace {item.trace_id}</span> : null}
			</div>
			{queue.rubric ? (
				<p className="whitespace-pre-wrap text-muted-foreground text-sm">
					{queue.rubric}
				</p>
			) : null}
			<section aria-label="Prompt" className="flex flex-col gap-1">
				<span className="font-medium text-xs">Prompt</span>
				<p className="whitespace-pre-wrap rounded-md bg-muted p-2 text-sm">
					{item.input}
				</p>
			</section>
			<section aria-label="Response" className="flex flex-col gap-1">
				<span className="font-medium text-xs">Response</span>
				<p className="whitespace-pre-wrap rounded-md bg-muted p-2 text-sm">
					{item.output}
				</p>
			</section>
			<Input
				aria-label={`Score from ${queue.score_min} to ${queue.score_max}`}
				disabled={busy}
				inputMode="decimal"
				onChange={(event) => setScore(event.target.value)}
				placeholder={`Score (${queue.score_min}–${queue.score_max})`}
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
			{error ? (
				<p className="text-status-destructive text-xs">{error}</p>
			) : null}
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

function QueueDetail({
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
				`Added ${result.added.length} item(s)${result.skipped ? `, ${result.skipped} already queued` : ""}.`
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
				`Exported ${result.added} case(s)${result.skipped ? `, ${result.skipped} already in the suite` : ""}.`
			);
		});

	const { counts } = queue;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap gap-2 text-xs">
				<Badge variant="secondary">{counts.pending} pending</Badge>
				<Badge variant="secondary">{counts.in_progress} in review</Badge>
				<Badge variant="secondary">{counts.completed} done</Badge>
				<Badge variant="secondary">{counts.skipped} skipped</Badge>
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
			{error ? (
				<p className="text-status-destructive text-xs">{error}</p>
			) : null}
		</div>
	);
}

export function AnnotationQueuesPanel({
	agentId,
	target,
}: AnnotationQueuesPanelProps) {
	const queryClient = useQueryClient();
	const queryKey = useMemo(
		() => ["annotation-queues", target.url, agentId],
		[target.url, agentId]
	);
	const queues = useQuery({
		queryKey,
		queryFn: () => listAnnotationQueues(target, agentId),
	});
	const [selectedId, setSelectedId] = useState<string>("");
	const list = queues.data ?? [];
	const selected =
		list.find((queue) => queue.id === selectedId) ?? list[0] ?? null;
	const refresh = () => {
		queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
	};

	return (
		<section
			aria-label="Annotation queues"
			className="flex flex-col gap-3 border-border border-t pt-4"
		>
			<div className="flex flex-col gap-1">
				<h3 className="font-medium text-sm">Annotation queues</h3>
				<p className="text-muted-foreground text-xs">
					Review this agent's runs by hand, then export the reviewed exchanges
					into a prompt suite.
				</p>
			</div>
			{queues.error ? (
				<p className="text-status-destructive text-xs">
					{errorText(queues.error)}
				</p>
			) : null}
			{list.length > 0 ? (
				<NativeSelect
					aria-label="Annotation queue"
					onChange={(event) => setSelectedId(event.target.value)}
					value={selected?.id ?? ""}
				>
					{list.map((queue) => (
						<NativeSelectOption key={queue.id} value={queue.id}>
							{queue.name} ({queue.counts.pending} pending)
						</NativeSelectOption>
					))}
				</NativeSelect>
			) : null}
			{selected ? (
				<QueueDetail
					agentId={agentId}
					key={selected.id}
					onChanged={refresh}
					queue={selected}
					target={target}
				/>
			) : null}
			<CreateQueueForm
				agentId={agentId}
				onCreated={(queueId) => {
					setSelectedId(queueId);
					refresh();
				}}
				target={target}
			/>
		</section>
	);
}

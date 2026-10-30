// apps/desktop/src/components/agents/AnnotationQueuesPanel-create-form.tsx
//
// Form that creates a new annotation queue for an agent.

import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { createAnnotationQueue } from "@ryuhq/core-client/annotation-queues.ts";
import { useId, useState } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	errorText,
	parseLabelList,
	parseScore,
} from "./AnnotationQueuesPanel-parsing.ts";

export function CreateQueueForm({
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
			{error ? <ErrorLine message={error} /> : null}
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

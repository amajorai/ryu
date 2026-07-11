// The Decision Wizard widget (spec §3 app 5, D-decisions). A step-by-step decision
// surface that generalises the quiz: pick one option per step, watch a live
// tally / weighted score / compare matrix computed LOCALLY in widgetState, then
// finish to submit the answers + computed outcome back through the governed tool.
//
// Data contract:
//   toolInput  = { mode: "quiz"|"weighted"|"compare", steps: [...], options?: [...] }
//   toolOutput = { flowId, steps }
//   callTool("app.decision.submit", { flowId, answers, outcome }) -> { ..., score? }
//
// Only primitives are read/written through the bridge; nothing here reaches the
// network directly (CSP `connect-src 'none'` — all egress is a host-governed RPC).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRyuGlobal } from "../../shared/useRyuGlobal";

// ---- domain types ------------------------------------------------------------

type Mode = "quiz" | "weighted" | "compare";

interface StepOption {
	label: string;
	value: unknown;
	weight?: number;
}

interface FlowStep {
	id: string;
	question: string;
	options: StepOption[];
}

interface CompareOption {
	id: string;
	label: string;
}

/** A rendered choice for a step (unifies step.options and compare candidates). */
interface Choice {
	key: string;
	label: string;
	value: unknown;
	weight: number;
}

interface TallyEntry {
	key: string;
	label: string;
	value: number;
}

interface MatrixRow {
	id: string;
	label: string;
	wins: number;
	perStep: boolean[];
}

type Outcome =
	| { kind: "quiz"; numeric: true; score: number; answered: number }
	| { kind: "quiz"; numeric: false; winner: string; tally: TallyEntry[] }
	| { kind: "weighted"; score: number; winner: string; tally: TallyEntry[] }
	| {
			kind: "compare";
			winnerId: string;
			winnerLabel: string;
			rows: MatrixRow[];
	  };

interface FlowOutput {
	flowId: string;
	steps: FlowStep[];
}

interface FlowInput {
	mode?: Mode;
	steps?: FlowStep[];
	options?: CompareOption[];
}

interface PersistedState {
	answers: Record<string, unknown>;
	step: number;
	phase: Phase;
	submitted: boolean;
}

type Phase = "stepping" | "result";

// ---- pure helpers ------------------------------------------------------------

const MODE_LABEL: Record<Mode, string> = {
	quiz: "Quiz",
	weighted: "Weighted",
	compare: "Compare",
};

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	return JSON.stringify(a) === JSON.stringify(b);
}

function valueKey(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	return JSON.stringify(value) ?? "null";
}

function resolveMode(input: FlowInput | undefined, steps: FlowStep[]): Mode {
	if (input?.mode) {
		return input.mode;
	}
	if (input?.options && input.options.length > 0) {
		return "compare";
	}
	const hasWeight = steps.some((step) =>
		step.options.some((option) => isNumber(option.weight)),
	);
	return hasWeight ? "weighted" : "quiz";
}

/** The choices shown for a step: compare candidates in compare mode, else the
 *  step's own options. */
function choicesForStep(
	step: FlowStep,
	mode: Mode,
	compareOptions: CompareOption[],
): Choice[] {
	if (mode === "compare" && compareOptions.length > 0) {
		return compareOptions.map((option) => ({
			key: option.id,
			label: option.label,
			value: option.id,
			weight: 1,
		}));
	}
	return step.options.map((option) => ({
		key: `${valueKey(option.value)}::${option.label}`,
		label: option.label,
		value: option.value,
		weight: isNumber(option.weight) ? option.weight : 1,
	}));
}

function chosenChoice(choices: Choice[], answer: unknown): Choice | undefined {
	if (answer === undefined) {
		return undefined;
	}
	return choices.find((choice) => valuesEqual(choice.value, answer));
}

function answeredSteps(
	steps: FlowStep[],
	answers: Record<string, unknown>,
): FlowStep[] {
	return steps.filter((step) => step.id in answers);
}

function sortTally(entries: Map<string, TallyEntry>): TallyEntry[] {
	return [...entries.values()].sort((a, b) => b.value - a.value);
}

function computeQuiz(
	steps: FlowStep[],
	answers: Record<string, unknown>,
	choicesOf: (step: FlowStep) => Choice[],
): Outcome {
	const done = answeredSteps(steps, answers);
	const chosen = done
		.map((step) => chosenChoice(choicesOf(step), answers[step.id]))
		.filter((choice): choice is Choice => choice !== undefined);
	const allNumeric =
		chosen.length > 0 && chosen.every((choice) => isNumber(choice.value));
	if (allNumeric) {
		const score = chosen.reduce(
			(sum, choice) => sum + (choice.value as number),
			0,
		);
		return { kind: "quiz", numeric: true, score, answered: chosen.length };
	}
	const tally = new Map<string, TallyEntry>();
	for (const choice of chosen) {
		const key = valueKey(choice.value);
		const entry = tally.get(key) ?? { key, label: choice.label, value: 0 };
		entry.value += 1;
		tally.set(key, entry);
	}
	const ranked = sortTally(tally);
	return {
		kind: "quiz",
		numeric: false,
		winner: ranked[0]?.label ?? "",
		tally: ranked,
	};
}

function computeWeighted(
	steps: FlowStep[],
	answers: Record<string, unknown>,
	choicesOf: (step: FlowStep) => Choice[],
): Outcome {
	const done = answeredSteps(steps, answers);
	const chosen = done
		.map((step) => chosenChoice(choicesOf(step), answers[step.id]))
		.filter((choice): choice is Choice => choice !== undefined);
	let score = 0;
	const tally = new Map<string, TallyEntry>();
	for (const choice of chosen) {
		const contribution = isNumber(choice.value)
			? choice.value * choice.weight
			: choice.weight;
		score += contribution;
		const key = valueKey(choice.value);
		const entry = tally.get(key) ?? { key, label: choice.label, value: 0 };
		entry.value += contribution;
		tally.set(key, entry);
	}
	const ranked = sortTally(tally);
	return {
		kind: "weighted",
		score: Math.round(score * 100) / 100,
		winner: ranked[0]?.label ?? "",
		tally: ranked,
	};
}

function computeCompare(
	steps: FlowStep[],
	answers: Record<string, unknown>,
	compareOptions: CompareOption[],
): Outcome {
	const rows: MatrixRow[] = compareOptions.map((option) => ({
		id: option.id,
		label: option.label,
		wins: 0,
		perStep: steps.map((step) => valuesEqual(answers[step.id], option.id)),
	}));
	for (const row of rows) {
		row.wins = row.perStep.filter(Boolean).length;
	}
	const ranked = [...rows].sort((a, b) => b.wins - a.wins);
	const top = ranked[0];
	return {
		kind: "compare",
		winnerId: top?.id ?? "",
		winnerLabel: top?.label ?? "",
		rows,
	};
}

function computeOutcome(
	mode: Mode,
	steps: FlowStep[],
	answers: Record<string, unknown>,
	compareOptions: CompareOption[],
	choicesOf: (step: FlowStep) => Choice[],
): Outcome {
	// Compare needs top-level candidates to build a matrix; without them, fall back
	// to a per-step tally of the chosen options so the flow still resolves a winner.
	if (mode === "compare" && compareOptions.length > 0) {
		return computeCompare(steps, answers, compareOptions);
	}
	if (mode === "weighted") {
		return computeWeighted(steps, answers, choicesOf);
	}
	return computeQuiz(steps, answers, choicesOf);
}

function outcomeScore(outcome: Outcome): number | undefined {
	if (outcome.kind === "quiz" && outcome.numeric) {
		return outcome.score;
	}
	if (outcome.kind === "weighted") {
		return outcome.score;
	}
	return undefined;
}

function outcomeHeadline(outcome: Outcome): string {
	if (outcome.kind === "quiz") {
		return outcome.numeric ? `Score ${outcome.score}` : outcome.winner;
	}
	if (outcome.kind === "weighted") {
		return outcome.winner;
	}
	return outcome.winnerLabel;
}

function buildFollowUpPrompt(mode: Mode, outcome: Outcome): string {
	const score = outcomeScore(outcome);
	const headline = outcomeHeadline(outcome);
	const scoreSuffix = score === undefined ? "" : ` (score ${score})`;
	return `I finished the ${MODE_LABEL[mode].toLowerCase()} decision flow. My outcome: ${headline}${scoreSuffix}. Please factor this into what we do next.`;
}

// ---- inline SVG icons --------------------------------------------------------

function IconCheck() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="14"
			viewBox="0 0 24 24"
			width="14"
		>
			<path
				d="M5 13l4 4L19 7"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="3"
			/>
		</svg>
	);
}

function IconChevron({ dir }: { dir: "left" | "right" }) {
	const d = dir === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6";
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="16"
			viewBox="0 0 24 24"
			width="16"
		>
			<path
				d={d}
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
			/>
		</svg>
	);
}

function IconSpark() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="12"
			viewBox="0 0 24 24"
			width="12"
		>
			<path
				d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"
				fill="currentColor"
			/>
		</svg>
	);
}

function IconTrophy() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="26"
			viewBox="0 0 24 24"
			width="26"
		>
			<path
				d="M7 4h10v4a5 5 0 01-10 0V4zM5 5H3v2a3 3 0 003 3M19 5h2v2a3 3 0 01-3 3M9 17h6M10 17v-2M14 17v-2M8 21h8"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
			/>
		</svg>
	);
}

function IconAlert() {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height="16"
			viewBox="0 0 24 24"
			width="16"
		>
			<path
				d="M12 8v5M12 16.5v.5M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
			/>
		</svg>
	);
}

function IconSpinner() {
	return (
		<svg
			aria-hidden="true"
			className="dw-spinner"
			fill="none"
			height="26"
			viewBox="0 0 24 24"
			width="26"
		>
			<circle
				cx="12"
				cy="12"
				opacity="0.25"
				r="9"
				stroke="currentColor"
				strokeWidth="3"
			/>
			<path
				d="M21 12a9 9 0 00-9-9"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="3"
			/>
		</svg>
	);
}

// ---- presentational pieces ---------------------------------------------------

function TallyBars({ entries }: { entries: TallyEntry[] }) {
	const max = entries.reduce((peak, entry) => Math.max(peak, entry.value), 0);
	return (
		<div className="dw-bars">
			{entries.map((entry) => {
				const pct = max > 0 ? Math.round((entry.value / max) * 100) : 0;
				return (
					<div className="dw-bar-row" key={entry.key}>
						<span className="dw-bar-label" title={entry.label}>
							{entry.label}
						</span>
						<span className="dw-bar-track">
							<span className="dw-bar-fill" style={{ width: `${pct}%` }} />
						</span>
						<span className="dw-bar-value">{entry.value}</span>
					</div>
				);
			})}
		</div>
	);
}

function CompareMatrix({
	rows,
	steps,
}: {
	rows: MatrixRow[];
	steps: FlowStep[];
}) {
	return (
		<div className="dw-matrix-wrap">
			<table className="dw-matrix">
				<thead>
					<tr>
						<th scope="col">Option</th>
						{steps.map((step, index) => (
							<th key={step.id} scope="col" title={step.question}>
								C{index + 1}
							</th>
						))}
						<th scope="col">Wins</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.id}>
							<td>{row.label}</td>
							{row.perStep.map((hit, index) => (
								<td
									className={hit ? "dw-matrix-hit" : "dw-matrix-miss"}
									key={steps[index]?.id ?? String(index)}
								>
									{hit ? "✓" : "·"}
								</td>
							))}
							<td>{row.wins}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function LiveTally({
	mode,
	outcome,
	steps,
}: {
	mode: Mode;
	outcome: Outcome;
	steps: FlowStep[];
}) {
	const score = outcomeScore(outcome);
	return (
		<div className="dw-tally">
			<span className="dw-tally-title">
				<IconSpark />
				{mode === "compare" ? "Running matrix" : "Running tally"}
			</span>
			{score !== undefined && <span className="dw-tally-score">{score}</span>}
			{outcome.kind === "quiz" && !outcome.numeric && (
				<TallyBars entries={outcome.tally} />
			)}
			{outcome.kind === "weighted" && <TallyBars entries={outcome.tally} />}
			{outcome.kind === "compare" && (
				<CompareMatrix rows={outcome.rows} steps={steps} />
			)}
		</div>
	);
}

interface StateBlockProps {
	icon: React.ReactNode;
	title: string;
	detail?: string;
}

function StateBlock({ icon, title, detail }: StateBlockProps) {
	return (
		<div className="dw-state">
			{icon}
			<strong>{title}</strong>
			{detail && <span>{detail}</span>}
		</div>
	);
}

// ---- root component ----------------------------------------------------------

function readPersisted(state: unknown): PersistedState | null {
	if (!state || typeof state !== "object") {
		return null;
	}
	const candidate = state as Partial<PersistedState>;
	if (!candidate.answers || typeof candidate.answers !== "object") {
		return null;
	}
	return {
		answers: candidate.answers as Record<string, unknown>,
		step: typeof candidate.step === "number" ? candidate.step : 0,
		phase: candidate.phase === "result" ? "result" : "stepping",
		submitted: candidate.submitted === true,
	};
}

export function DecisionWizard() {
	const output = useRyuGlobal("toolOutput") as FlowOutput | undefined;
	const input = useRyuGlobal("toolInput") as FlowInput | undefined;
	const persistedGlobal = useRyuGlobal("widgetState");

	// Hydrate once from whatever the host injected synchronously (D2/D4).
	const initial = useRef<PersistedState | null>(
		readPersisted(window.ryu?.widgetState ?? persistedGlobal),
	);
	const [answers, setAnswers] = useState<Record<string, unknown>>(
		() => initial.current?.answers ?? {},
	);
	const [stepIndex, setStepIndex] = useState(() => initial.current?.step ?? 0);
	const [phase, setPhase] = useState<Phase>(
		() => initial.current?.phase ?? "stepping",
	);
	const [submitted, setSubmitted] = useState(
		() => initial.current?.submitted ?? false,
	);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const steps = useMemo<FlowStep[]>(() => {
		const source = output?.steps ?? input?.steps ?? [];
		return Array.isArray(source) ? source : [];
	}, [output, input]);

	const mode = useMemo(() => resolveMode(input, steps), [input, steps]);
	const compareOptions = useMemo<CompareOption[]>(
		() => (Array.isArray(input?.options) ? input.options : []),
		[input],
	);

	const choicesOf = useCallback(
		(step: FlowStep) => choicesForStep(step, mode, compareOptions),
		[mode, compareOptions],
	);

	const outcome = useMemo(
		() => computeOutcome(mode, steps, answers, compareOptions, choicesOf),
		[mode, steps, answers, compareOptions, choicesOf],
	);

	// Persist UI state whenever it changes, skipping the initial hydration render.
	const hydrated = useRef(false);
	useEffect(() => {
		if (!hydrated.current) {
			hydrated.current = true;
			return;
		}
		const snapshot: PersistedState = {
			answers,
			step: stepIndex,
			phase,
			submitted,
		};
		void window.ryu?.setWidgetState(snapshot);
	}, [answers, stepIndex, phase, submitted]);

	// Nudge the host to re-measure on any view transition (belt-and-suspenders on
	// top of WidgetRoot's ResizeObserver). phase/stepIndex are the transition keys.
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps are the view-transition triggers, not values read in the body.
	useEffect(() => {
		const el = document.querySelector(".dw");
		if (el instanceof HTMLElement) {
			window.ryu?.notifyIntrinsicHeight(Math.ceil(el.scrollHeight));
		}
	}, [phase, stepIndex]);

	const answeredCount = steps.filter((step) => step.id in answers).length;
	const allAnswered = steps.length > 0 && answeredCount === steps.length;

	const pick = useCallback((stepId: string, value: unknown) => {
		setError(null);
		setAnswers((prev) => ({ ...prev, [stepId]: value }));
	}, []);

	const goNext = useCallback(() => {
		if (stepIndex >= steps.length - 1) {
			setPhase("result");
			return;
		}
		setStepIndex((index) => index + 1);
	}, [stepIndex, steps.length]);

	const goBack = useCallback(() => {
		if (phase === "result") {
			setPhase("stepping");
			return;
		}
		setStepIndex((index) => Math.max(0, index - 1));
	}, [phase]);

	const restart = useCallback(() => {
		setAnswers({});
		setStepIndex(0);
		setPhase("stepping");
		setSubmitted(false);
		setError(null);
	}, []);

	const submit = useCallback(async () => {
		if (!output?.flowId) {
			setError("This flow is missing its id, so it cannot be submitted.");
			return;
		}
		setSubmitting(true);
		setError(null);
		const payloadAnswers = steps
			.filter((step) => step.id in answers)
			.map((step) => ({ stepId: step.id, value: answers[step.id] }));
		try {
			await window.ryu.callTool("app.decision__submit", {
				flowId: output.flowId,
				answers: payloadAnswers,
				outcome,
			});
			setSubmitted(true);
			await window.ryu.sendFollowUpMessage({
				prompt: buildFollowUpPrompt(mode, outcome),
			});
		} catch (caught) {
			const message =
				caught instanceof Error ? caught.message : "Submission failed.";
			setError(message);
		} finally {
			setSubmitting(false);
		}
	}, [output, steps, answers, outcome, mode]);

	// ---- render states ----

	if (output === undefined && input === undefined) {
		return (
			<div className="dw">
				<StateBlock
					icon={<IconSpinner />}
					title="Preparing your decision flow…"
				/>
			</div>
		);
	}

	if (steps.length === 0) {
		return (
			<div className="dw">
				<StateBlock
					detail="No steps were provided for this decision."
					icon={<IconAlert />}
					title="Nothing to decide yet"
				/>
			</div>
		);
	}

	const progressPct = Math.round((answeredCount / steps.length) * 100);

	if (phase === "result") {
		return (
			<div className="dw">
				<div className="dw-result">
					<span className="dw-result-crest">
						<IconTrophy />
					</span>
					<span className="dw-result-eyebrow">
						{submitted ? "Sent to the model" : `${MODE_LABEL[mode]} outcome`}
					</span>
					<h2 className="dw-result-title">{outcomeHeadline(outcome)}</h2>
					{outcomeScore(outcome) !== undefined && (
						<span className="dw-result-score">
							Score {outcomeScore(outcome)}
						</span>
					)}
				</div>

				<LiveTally mode={mode} outcome={outcome} steps={steps} />

				{error && (
					<div className="dw-error" role="alert">
						<IconAlert />
						<span>{error}</span>
					</div>
				)}

				<div className="dw-actions">
					<button
						className="dw-btn"
						disabled={submitting}
						onClick={goBack}
						type="button"
					>
						<IconChevron dir="left" />
						Review
					</button>
					{submitted ? (
						<button className="dw-btn" onClick={restart} type="button">
							Start over
						</button>
					) : (
						<button
							className="dw-btn dw-btn-primary"
							disabled={submitting}
							onClick={submit}
							type="button"
						>
							{submitting ? <IconSpinner /> : <IconCheck />}
							{submitting ? "Sending…" : "Confirm & tell the model"}
						</button>
					)}
				</div>
			</div>
		);
	}

	const step = steps[stepIndex];
	if (!step) {
		return (
			<div className="dw">
				<StateBlock icon={<IconAlert />} title="That step could not be found" />
			</div>
		);
	}
	const choices = choicesOf(step);
	const currentAnswer = answers[step.id];
	const answeredHere = step.id in answers;
	const onLastStep = stepIndex === steps.length - 1;

	return (
		<div className="dw">
			<header className="dw-header">
				<div className="dw-mode-row">
					<span className="dw-mode-badge">
						<IconSpark />
						{MODE_LABEL[mode]}
					</span>
					<span className="dw-step-count">
						Step {stepIndex + 1} of {steps.length}
					</span>
				</div>
				<div
					aria-label={`${progressPct}% answered`}
					aria-valuemax={100}
					aria-valuemin={0}
					aria-valuenow={progressPct}
					className="dw-progress"
					role="progressbar"
				>
					<span
						className="dw-progress-fill"
						style={{ width: `${progressPct}%` }}
					/>
				</div>
			</header>

			<h2 className="dw-question">{step.question}</h2>

			<div className="dw-options">
				{choices.map((choice) => {
					const active = valuesEqual(choice.value, currentAnswer);
					return (
						<button
							aria-pressed={active}
							className="dw-option"
							key={choice.key}
							onClick={() => pick(step.id, choice.value)}
							type="button"
						>
							<span className="dw-option-marker">
								{active && <IconCheck />}
							</span>
							<span className="dw-option-label">{choice.label}</span>
							{mode === "weighted" && choice.weight !== 1 && (
								<span className="dw-option-weight">&times;{choice.weight}</span>
							)}
						</button>
					);
				})}
			</div>

			{answeredCount > 0 && (
				<LiveTally mode={mode} outcome={outcome} steps={steps} />
			)}

			<div className="dw-actions">
				<button
					className="dw-btn"
					disabled={stepIndex === 0}
					onClick={goBack}
					type="button"
				>
					<IconChevron dir="left" />
					Back
				</button>
				<button
					className="dw-btn dw-btn-primary"
					disabled={!answeredHere || (onLastStep && !allAnswered)}
					onClick={goNext}
					type="button"
				>
					{onLastStep ? "See result" : "Next"}
					{!onLastStep && <IconChevron dir="right" />}
				</button>
			</div>
		</div>
	);
}

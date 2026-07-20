// Create-from-scratch evaluator editor, launched from both the gateway policy
// surface and the agent evals surface. Two modes:
//   • "judge" — LLM-as-a-Judge: name + rubric + category + target + threshold +
//     judge model. Persists as an `llm_judge` evaluator.
//   • "code"  — Code evaluator: name + language (JS/Python) + source. Persists as
//     a `code` evaluator; the (input, output, expected, vars) -> {score, pass}
//     contract is documented inline.
//
// Both persist as `builtin: false` entries via `saveCustomEvaluator`, which
// writes the full custom set to gateway config and restarts the gateway so the
// new evaluator is catalogued + runnable. On success `onSaved` fires so the
// caller can refetch the catalog.

import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { Textarea } from "@ryu/ui/components/textarea";
import { useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	Evaluator,
	EvaluatorCategory,
	EvaluatorCodeLang,
	EvaluatorTarget,
} from "@/src/lib/api/gateway.ts";
import { saveCustomEvaluator } from "@/src/lib/api/gateway.ts";

/** Which editor to show. */
export type EvaluatorEditorMode = "judge" | "code";

export interface EvaluatorEditorDialogProps {
	/** Current custom set (from `fetchEvaluators` filtered by `builtin === false`). */
	existingCustom: Evaluator[];
	/** All catalog ids (built-in + custom) to prevent silent overrides. */
	existingIds: string[];
	mode: EvaluatorEditorMode;
	onOpenChange: (open: boolean) => void;
	/** Fired after a successful save (caller should refetch the catalog). */
	onSaved: () => void;
	open: boolean;
	target: ApiTarget;
}

const CATEGORY_ITEMS: { value: EvaluatorCategory; label: string }[] = [
	{ value: "custom", label: "Custom" },
	{ value: "security", label: "Security" },
	{ value: "safety", label: "Safety" },
	{ value: "quality", label: "Quality" },
	{ value: "conversation", label: "Conversation" },
	{ value: "trajectory", label: "Trajectory" },
	{ value: "image", label: "Image" },
	{ value: "voice", label: "Voice" },
];

const TARGET_ITEMS: { value: EvaluatorTarget; label: string }[] = [
	{ value: "output", label: "Output — the model's reply" },
	{ value: "input", label: "Input — the user prompt" },
	{ value: "conversation", label: "Conversation — full history" },
	{ value: "trajectory", label: "Trajectory — agent steps" },
	{ value: "image", label: "Image" },
	{ value: "audio", label: "Audio" },
];

const LANG_ITEMS: { value: EvaluatorCodeLang; label: string }[] = [
	{ value: "js", label: "JavaScript (Deno)" },
	{ value: "python", label: "Python (sandbox)" },
];

const CODE_TEMPLATE_JS = `// Score one case. Return { score: 0..1, pass: boolean }.
// Available: input (prompt), output (response), expected (string|null), vars (object).
function evaluate(input, output, expected, vars) {
  const ok = expected ? output.includes(expected) : output.length > 0;
  return { score: ok ? 1 : 0, pass: ok };
}`;

const CODE_TEMPLATE_PY = `# Score one case. Return {"score": 0..1, "pass": bool}.
# Available: input (prompt), output (response), expected (str|None), vars (dict).
def evaluate(input, output, expected, vars):
    ok = (expected in output) if expected else len(output) > 0
    return {"score": 1 if ok else 0, "pass": ok}`;

/** Slugify a display name to a stable snake_case id. */
function slugify(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

export function EvaluatorEditorDialog({
	open,
	onOpenChange,
	mode,
	target,
	existingCustom,
	existingIds,
	onSaved,
}: EvaluatorEditorDialogProps) {
	const [name, setName] = useState("");
	const [category, setCategory] = useState<EvaluatorCategory>("custom");
	const [evalTarget, setEvalTarget] = useState<EvaluatorTarget>("output");
	const [threshold, setThreshold] = useState("0.7");
	const [judgeModel, setJudgeModel] = useState("");
	const [rubric, setRubric] = useState("");
	const [lang, setLang] = useState<EvaluatorCodeLang>("js");
	const [source, setSource] = useState(CODE_TEMPLATE_JS);
	const [inlineEnabled, setInlineEnabled] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Which impls the editor can offer as an inline guardrail. Both editor modes
	// produce an inline-capable impl (judge → `llm_judge`, code → `code`), so the
	// toggle is always available here; regex/heuristic-only entries (which this
	// editor never creates) would gate it off. Enforcement honesty diverges from
	// capability, though: only `llm_judge` actually RUNS on the inline path today
	// (`flag_inline_binding` in the gateway pipeline), so a code evaluator can be
	// OFFERED inline (`capabilities.inline`) yet must report `enforced: false`.
	const inlineCapable = mode === "judge" || mode === "code";

	const id = useMemo(() => slugify(name), [name]);
	const idCollision = id.length > 0 && existingIds.includes(id);
	const thresholdNum = Number.parseFloat(threshold);
	const thresholdValid =
		!Number.isNaN(thresholdNum) && thresholdNum >= 0 && thresholdNum <= 1;

	const canSave =
		id.length > 0 &&
		!idCollision &&
		thresholdValid &&
		!saving &&
		(mode === "judge" ? rubric.trim().length > 0 : source.trim().length > 0);

	const reset = () => {
		setName("");
		setCategory("custom");
		setEvalTarget("output");
		setThreshold("0.7");
		setJudgeModel("");
		setRubric("");
		setLang("js");
		setSource(CODE_TEMPLATE_JS);
		setInlineEnabled(false);
		setError(null);
	};

	const handleSave = async () => {
		setSaving(true);
		setError(null);
		try {
			// Offer inline only for inline-capable impls; enforce honesty: a custom
			// inline evaluator is `enforced` only when its impl actually runs on the
			// inline path (`llm_judge`). Code is inline-capable but a no-op inline
			// today (P4), so it is offered inline yet reports `enforced: false`.
			const offerInline = inlineEnabled && inlineCapable;
			const enforced = offerInline && mode === "judge";
			const evaluator: Evaluator = {
				id,
				name: name.trim(),
				description:
					mode === "judge"
						? "Custom LLM-as-a-Judge evaluator."
						: `Custom ${lang === "js" ? "JavaScript" : "Python"} code evaluator.`,
				category,
				target: evalTarget,
				capabilities: { inline: offerInline, offline: true },
				impl:
					mode === "judge"
						? { kind: "llm_judge", rubric: rubric.trim() }
						: { kind: "code", lang, source },
				inline: offerInline ? { action: "warn_and_continue" } : null,
				offline: {
					threshold: thresholdNum,
					judgeModel:
						mode === "judge" && judgeModel.trim().length > 0
							? judgeModel.trim()
							: null,
				},
				builtin: false,
				enforced,
				higherIsBetter: true,
			};
			await saveCustomEvaluator(target, evaluator, existingCustom);
			reset();
			onSaved();
			onOpenChange(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to save evaluator");
		} finally {
			setSaving(false);
		}
	};

	const onLangChange = (next: EvaluatorCodeLang) => {
		setLang(next);
		// Swap the starter template only when the source is still an untouched
		// template, so we never clobber real edits.
		setSource((prev) =>
			prev === CODE_TEMPLATE_JS || prev === CODE_TEMPLATE_PY
				? next === "js"
					? CODE_TEMPLATE_JS
					: CODE_TEMPLATE_PY
				: prev
		);
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{mode === "judge"
							? "New LLM-as-a-Judge evaluator"
							: "New code evaluator"}
					</DialogTitle>
					<DialogDescription>
						{mode === "judge"
							? "A model judges each case against your rubric and returns a score."
							: "Your function scores each case. Runs sandboxed (Deno for JS, sandbox for Python)."}
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-1">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ev-name">Name</Label>
						<Input
							id="ev-name"
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. Answer faithfulness"
							value={name}
						/>
						{id.length > 0 ? (
							<p className="text-muted-foreground text-xs">
								id: <code>{id}</code>
								{idCollision ? (
									<span className="text-destructive">
										{" "}
										— already exists, choose another name
									</span>
								) : null}
							</p>
						) : null}
					</div>

					<div className="flex gap-3">
						<div className="flex flex-1 flex-col gap-1.5">
							<Label htmlFor="ev-category">Category</Label>
							<Select
								items={CATEGORY_ITEMS}
								onValueChange={(v: string | null) =>
									setCategory((v ?? "custom") as EvaluatorCategory)
								}
								value={category}
							>
								<SelectTrigger id="ev-category">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CATEGORY_ITEMS.map((it) => (
										<SelectItem key={it.value} value={it.value}>
											{it.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-1 flex-col gap-1.5">
							<Label htmlFor="ev-target">Target</Label>
							<Select
								items={TARGET_ITEMS}
								onValueChange={(v: string | null) =>
									setEvalTarget((v ?? "output") as EvaluatorTarget)
								}
								value={evalTarget}
							>
								<SelectTrigger id="ev-target">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{TARGET_ITEMS.map((it) => (
										<SelectItem key={it.value} value={it.value}>
											{it.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ev-threshold">Pass threshold (0–1)</Label>
						<Input
							id="ev-threshold"
							inputMode="decimal"
							onChange={(e) => setThreshold(e.target.value)}
							value={threshold}
						/>
						{thresholdValid ? null : (
							<p className="text-destructive text-xs">
								Enter a number between 0 and 1.
							</p>
						)}
					</div>

					{inlineCapable ? (
						<div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/20 p-3">
							<div className="flex min-w-0 flex-col gap-0.5">
								<Label htmlFor="ev-inline">Available as inline guardrail</Label>
								<p className="text-muted-foreground text-xs">
									{mode === "judge"
										? "Also run this on the request/response path as a Warn guardrail (change the action per scope in the gateway policy)."
										: "Offer this on the gateway policy surface. Code guardrails do not execute inline yet, so it is catalogued but not enforced."}
								</p>
							</div>
							<Switch
								checked={inlineEnabled}
								id="ev-inline"
								onCheckedChange={setInlineEnabled}
							/>
						</div>
					) : null}

					{mode === "judge" ? (
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="ev-judge-model">Judge model (optional)</Label>
								<Input
									id="ev-judge-model"
									onChange={(e) => setJudgeModel(e.target.value)}
									placeholder="Leave empty for the default router"
									value={judgeModel}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="ev-rubric">Rubric</Label>
								<Textarea
									className="min-h-32 font-mono text-xs"
									id="ev-rubric"
									onChange={(e) => setRubric(e.target.value)}
									placeholder="Describe what a good response looks like. The judge scores each case against this."
									value={rubric}
								/>
							</div>
						</>
					) : (
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="ev-lang">Language</Label>
								<Select
									items={LANG_ITEMS}
									onValueChange={(v: string | null) =>
										onLangChange((v ?? "js") as EvaluatorCodeLang)
									}
									value={lang}
								>
									<SelectTrigger id="ev-lang">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{LANG_ITEMS.map((it) => (
											<SelectItem key={it.value} value={it.value}>
												{it.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="ev-source">Source</Label>
								<Textarea
									className="min-h-48 font-mono text-xs"
									id="ev-source"
									onChange={(e) => setSource(e.target.value)}
									spellCheck={false}
									value={source}
								/>
								<p className="text-muted-foreground text-xs">
									Contract:{" "}
									<code>
										(input, output, expected, vars) → {"{ score, pass }"}
									</code>{" "}
									— score in [0,1], pass boolean.
								</p>
							</div>
						</>
					)}

					{error ? <p className="text-destructive text-sm">{error}</p> : null}
				</div>

				<DialogFooter>
					<Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
						Cancel
					</Button>
					<Button disabled={!canSave} onClick={handleSave} size="sm">
						{saving ? <Spinner className="size-3" /> : null}
						Save evaluator
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

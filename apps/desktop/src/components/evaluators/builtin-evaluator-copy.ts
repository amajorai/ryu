// The built-in Gateway evaluators' names and descriptions as UI copy.
//
// The Gateway seeds its built-in catalog in English
// (`apps/gateway/src/evaluators/catalog.rs` `builtin_catalog`) and its API
// text stays English by policy. The desktop shows those built-ins in the UI
// language by looking the evaluator id up here; a custom evaluator (or a
// built-in this table does not know yet) keeps the Gateway's text. The
// literal `{ title, description }` rows are what the i18n extractor reads;
// `builtin-evaluator-copy.test.ts` fails when a Gateway built-in id is missing.

import { translate as tl } from "@ryu/i18n/core";

interface BuiltinEvaluatorCopy {
	readonly description: string;
	/** The evaluator's name (`title` so the extractor reads it as copy). */
	readonly title: string;
}

interface EvaluatorDisplayCopy {
	readonly description: string;
	readonly name: string;
}

export const BUILTIN_EVALUATOR_COPY: Readonly<
	Record<string, BuiltinEvaluatorCopy>
> = {
	llm_as_a_judge: {
		title: "LLM-as-a-Judge Evaluator",
		description:
			"Blank rubric template: score output with an LLM judge you define.",
	},
	code_evaluator: {
		title: "Code Evaluator",
		description: "Blank JS/Python template: score output with code you write.",
	},
	pii_leakage: {
		title: "PII Leakage",
		description: "Detects personally identifiable information in model output.",
	},
	code_injection: {
		title: "Code Injection",
		description: "Flags code-injection payloads in the request.",
	},
	prompt_injection: {
		title: "Prompt Injection",
		description:
			"Flags prompt-injection / instruction-override attempts in the request.",
	},
	toxicity: {
		title: "Toxicity",
		description: "Judges whether output is toxic, hateful, or harassing.",
	},
	bias_fairness: {
		title: "Bias & Fairness",
		description:
			"Judges whether output reflects unfair bias against a protected group.",
	},
	hallucination: {
		title: "Hallucination",
		description:
			"Judges whether the output is unsupported by the provided context.",
	},
	assertions: {
		title: "Assertions",
		description:
			"Checks the output satisfies every assertion in the reference.",
	},
	code_checker: {
		title: "Code Checker",
		description: "Checks the output code is correct and solves the problem.",
	},
	exact_match: {
		title: "Exact Match",
		description: "Checks the output exactly matches the reference.",
	},
	correctness: {
		title: "Correctness",
		description: "Judges whether the output semantically matches a reference.",
	},
	conciseness: {
		title: "Conciseness",
		description: "Judges whether the output is concise and free of filler.",
	},
	answer_relevance: {
		title: "Answer Relevance",
		description:
			"Judges whether the output actually answers the question asked.",
	},
	perceived_error: {
		title: "Perceived Error",
		description:
			"Judges whether the conversation shows a user-perceived error.",
	},
	support_intent: {
		title: "Support Intent",
		description:
			"Judges whether the conversation addressed the user's support intent.",
	},
	tone: {
		title: "Tone",
		description:
			"Judges whether the assistant's tone was appropriate throughout.",
	},
	knowledge_retention: {
		title: "Knowledge Retention",
		description:
			"Judges whether the assistant retained earlier conversation context.",
	},
	user_satisfaction: {
		title: "User Satisfaction",
		description:
			"Judges the user's apparent satisfaction across the conversation.",
	},
	task_completion: {
		title: "Task Completion",
		description:
			"Judges whether the user's task was completed by the conversation's end.",
	},
	plan_adherence: {
		title: "Plan Adherence",
		description: "Judges whether the agent adhered to its stated plan.",
	},
	trajectory_accuracy: {
		title: "Trajectory Accuracy",
		description: "Judges whether the agent's overall trajectory was correct.",
	},
	tool_selection: {
		title: "Tool Selection",
		description:
			"Judges whether the agent selected the right tools for each step.",
	},
	explicit_content: {
		title: "Explicit Content",
		description: "Judges whether an image contains explicit content.",
	},
	sensitive_imagery: {
		title: "Sensitive Imagery",
		description:
			"Judges whether an image contains sensitive or graphic imagery.",
	},
	audio_quality: {
		title: "Audio Quality",
		description: "Scores the technical quality of the audio.",
	},
	user_interrupts: {
		title: "User Interrupts",
		description: "Judges how often the user had to interrupt the assistant.",
	},
	transcription_accuracy: {
		title: "Transcription Accuracy",
		description: "Scores transcription accuracy against a reference.",
	},
	vocal_affect: {
		title: "Vocal Affect",
		description: "Judges the vocal affect / emotional tone of the audio.",
	},
	language: {
		title: "Language",
		description: "Detects the primary language of the audio.",
	},
};

/**
 * The shown name and description of an evaluator: a built-in's in the UI
 * language, anything else exactly as the Gateway sent it.
 */
export function evaluatorDisplayCopy(evaluator: {
	readonly builtin: boolean;
	readonly description: string;
	readonly id: string;
	readonly name: string;
}): EvaluatorDisplayCopy {
	const copy =
		evaluator.builtin && Object.hasOwn(BUILTIN_EVALUATOR_COPY, evaluator.id)
			? BUILTIN_EVALUATOR_COPY[evaluator.id]
			: undefined;
	if (!copy) {
		return { name: evaluator.name, description: evaluator.description };
	}
	return { name: tl(copy.title), description: tl(copy.description) };
}

import type { ProductProfile } from "./profile-types.ts";

/**
 * Red Teaming's profile, split out of ./profiles-infrastructure-b.ts to keep
 * that file under the size limit. Red Teaming is a test harness: the CI gate
 * command, a failing run in the terminal, and the ten probes with the five
 * evaluators that score them. Every entry names its source;
 * ./profile-grounding.ts checks each file and quote.
 */

const DOCS = "apps/fumadocs/content/docs";
const EVALS = `${DOCS}/gateway/evals.mdx`;
const EVALUATORS = `${DOCS}/gateway/evaluators.mdx`;
const CLI_REFERENCE = `${DOCS}/surfaces/cli/reference.mdx`;
const DESKTOP_EVALS = `${DOCS}/surfaces/desktop/user-guide/agent-observability-and-evals.mdx`;

export const RED_TEAM_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Probes",
			value: "Ten, built in and owned by the server",
			source: { path: EVALS, quote: "Core runs all ten server-owned probes" },
		},
		{
			label: "Run it from",
			value: "Security sweep in Ryu Desktop, or ryu-cli redteam",
			source: {
				path: EVALS,
				quote:
					"render this as **Security sweep**. The CLI exposes the same contract",
			},
		},
		{
			label: "Scored by",
			value: "The Gateway's evaluator catalog",
			source: {
				path: EVALS,
				quote:
					"Each probe is scored through the existing Gateway evaluator catalog",
			},
		},
		{
			label: "Real tools run",
			value: "None. The tool-misuse probe is text only",
			source: {
				path: EVALS,
				quote:
					"The tool-misuse probe is text-only; the campaign never executes a real tool.",
			},
		},
		{
			label: "Probe list",
			value: "A closed list. Unknown probe ids are rejected",
			source: { path: EVALS, quote: "Unknown strategy ids are rejected." },
		},
		{
			label: "CI gate",
			value: "--max-attention fails the run past your limit",
			source: {
				path: EVALS,
				quote:
					"`--max-attention` turns the run into a CI gate that fails when more probes need attention than the number you pass.",
			},
		},
	],
	architecture: {
		title: "What happens in a sweep",
		caption:
			"Probes are real model calls, so they count against the normal Gateway budget.",
		nodes: [
			{
				label: "Start a sweep",
				detail:
					"From an agent's observability view in Desktop, the Activity app, or the CLI.",
			},
			{
				label: "Core",
				detail:
					"Builds the probes from a fixed, server-owned list and rejects unknown ids.",
			},
			{
				label: "Gateway",
				detail:
					"Sends each probe through its normal authentication, policy, budget, and audit path.",
			},
			{
				label: "Evaluators",
				detail:
					"Five Security and Safety evaluators score each answer. No tool from a probe runs.",
			},
			{
				label: "Result",
				detail:
					"Each probe comes back protected or needing attention, with a short detail.",
			},
		],
		source: {
			path: EVALS,
			quote:
				"Because the probes are provider-backed, they use the normal Gateway authentication, policy, budget, and audit path.",
		},
	},
	code: [
		{
			id: "red-team-ci-gate",
			label: "Gate CI",
			language: "bash",
			code: [
				"# Fail the job when any probe needs attention.",
				"# --junit reports one test case per probe.",
				"ryu-cli redteam <agent-id> --max-attention 0 --junit > redteam.xml",
			].join("\n"),
			source: {
				path: CLI_REFERENCE,
				quote: "ryu-cli redteam <agent-id> --max-attention 0",
			},
		},
		{
			id: "red-team-http",
			label: "Core API",
			language: "http",
			code: [
				"POST /api/gateway/redteam/run",
				"Content-Type: application/json",
				"",
				"{",
				'  "agent_id": "support-agent",',
				'  "strategies": ["prompt_injection", "tool_misuse", "pii_exfiltration"]',
				"}",
			].join("\n"),
			source: { path: EVALS, quote: "POST /api/gateway/redteam/run" },
		},
	],
	guardrail: {
		title: "One weak probe fails the build",
		description:
			"An example run against an agent called support-agent. With --max-attention 0, a single probe that needs attention makes the command exit 1, so the sweep can stop a release.",
		lines: [
			{
				kind: "command",
				text: "ryu-cli redteam support-agent --max-attention 0",
			},
			{
				kind: "allowed",
				text: "prompt_injection · scored by prompt_injection · protected",
			},
			{
				kind: "allowed",
				text: "pii_exfiltration · scored by pii_leakage · protected",
			},
			{
				kind: "denied",
				text: "shell_injection · scored by code_injection · needs attention",
			},
			{
				kind: "output",
				text: "summary · 10 total · 9 protected · 1 needs attention",
			},
			{
				kind: "denied",
				text: "redteam gate failed: 1 probe(s) need attention (maximum 0)",
			},
		],
		source: {
			path: CLI_REFERENCE,
			quote:
				"`ryu-cli redteam <agent-id> --max-attention 0` exits 1 when more probes need attention than allowed",
		},
	},
	comparison: {
		title: "Ten probes, five evaluators",
		rowHeader: "What it tries",
		columns: ["Probe ids", "Scored by", "Evaluator group"],
		rows: [
			{
				label: "Injection and prompt leaks",
				values: [
					"prompt_injection, system_prompt_leak, indirect_injection",
					"prompt_injection",
					"Security",
				],
			},
			{
				label: "Tool abuse",
				values: [
					"tool_misuse, sql_injection, shell_injection",
					"code_injection",
					"Security",
				],
			},
			{
				label: "Personal data",
				values: ["pii_exfiltration", "pii_leakage", "Security"],
			},
			{
				label: "Harmful output",
				values: ["jailbreak, toxic_output", "toxicity", "Safety"],
			},
			{
				label: "Bias",
				values: ["bias_fairness", "bias_fairness", "Safety"],
			},
		],
		source: {
			path: EVALS,
			quote:
				"| `tool_misuse`, `sql_injection`, `shell_injection` | `code_injection` |",
		},
	},
	security: {
		points: [
			{
				text: "The five evaluators that score the probes are the same Security and Safety detectors the Gateway can enforce on live traffic.",
				source: {
					path: EVALUATORS,
					quote:
						"The five Security and Safety text detectors (`pii_leakage`, `code_injection`, `prompt_injection`, `toxicity`, `bias_fairness`) report `enforced: true`.",
				},
			},
			{
				text: "A sweep never executes a tool from a probe.",
				source: {
					path: DESKTOP_EVALS,
					quote: "it never executes a tool from a probe.",
				},
			},
			{
				text: "Records stay on your node by default, and provider calls go through Ryu's own Gateway.",
				source: {
					path: EVALS,
					quote:
						"Ryu keeps these records on the node by default and routes provider calls through its own Gateway.",
				},
			},
			{
				text: "The same probes run from Desktop and the CLI, so a local check and a CI gate test the same things.",
				source: { path: EVALS, quote: "The CLI exposes the same contract" },
			},
		],
	},
	compareSlugs: ["braintrust"],
	related: [
		{
			label: "What is prompt injection and how to defend against it",
			href: "/blog/what-is-prompt-injection",
			kind: "blog",
		},
		{
			label: "How to add prompt injection protection to your AI agents",
			href: "/blog/how-to-add-prompt-injection-protection",
			kind: "blog",
		},
		{
			label: "LLM observability tools: a tracing and evaluation checklist",
			href: "/blog/best-ai-observability-tools-llm",
			kind: "blog",
		},
	],
	docs: [
		{
			label: "Bounded red-team campaigns",
			path: "/docs/gateway/evals#bounded-red-team-campaigns",
			description: "The ten probes, the request, and what each run returns.",
		},
		{
			label: "Evaluator catalog",
			path: "/docs/gateway/evaluators",
			description: "Every evaluator, and which ones guard live traffic.",
		},
		{
			label: "Eval and red-team gates in the CLI",
			path: "/docs/surfaces/cli/reference#eval-gates",
			description: "Exit codes, JUnit output, and CI usage.",
		},
		{
			label: "Agent observability and evals",
			path: "/docs/surfaces/desktop/user-guide/agent-observability-and-evals",
			description: "Run a Security sweep from an agent in Desktop.",
		},
	],
};

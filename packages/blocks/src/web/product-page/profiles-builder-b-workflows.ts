import type { ProductProfile } from "./profile-types.ts";

/**
 * The Workflows profile (unit builder-b), kept beside ./profiles-builder-b.ts
 * so that file stays small. The page leads with the workflow as data: a fan-out
 * node, a schedule that waits for approval, a read-only dry run, and forking a
 * finished run from one of its checkpoints. Every sample is copied from the
 * Core workflow docs.
 */

const DOCS = "apps/fumadocs/content/docs";
const WORKFLOWS = `${DOCS}/core/workflows.mdx`;
const EXECUTION = `${DOCS}/core/workflow-execution.mdx`;
const LOOPS = `${DOCS}/core/workflow-loops-and-fan-out.mdx`;
const RUNS_API = `${DOCS}/core/workflow-runs-and-api.mdx`;
const SCHEDULE = `${DOCS}/learn/cookbook/schedule-a-workflow.mdx`;

const FAN_OUT = `{
  "id": "review",
  "type": "parallel",
  "max_concurrency": 4,
  "branches": [
    { "id": "security", "workflow_id": "wf_security_review" },
    { "id": "style", "workflow_id": "wf_style_review" },
    { "id": "tests", "workflow_id": "wf_test_review", "input": "{{state.diff}}" }
  ]
}`;

const SCHEDULED = `{
  "triggers": [
    { "type": "schedule", "cron": "0 9 * * *", "require_approval": true }
  ]
}`;

const DRY_RUN = `POST /workflows/:id/run

{
  "input": { "text": "hello" },
  "dryRun": true
}`;

const FORK = `curl -X POST http://127.0.0.1:7980/workflows/runs/run_123/fork \\
  -H 'Content-Type: application/json' \\
  -d '{ "checkpoint_id": "cp-000002", "state_patch": { "topic": "go" } }'`;

export const WORKFLOWS_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Shape",
			value: "A graph of typed steps that Core runs",
			source: {
				path: WORKFLOWS,
				quote:
					"A **workflow** is a directed acyclic graph (DAG) of typed nodes that Core executes in process.",
			},
		},
		{
			label: "Step kinds",
			value: "27, from prompts and agents to loops and human gates",
			source: {
				path: WORKFLOWS,
				quote: "tagged enum (`type`, snake_case) with 27 variants",
			},
		},
		{
			label: "Durability",
			value: "Every step and loop pass is saved to disk",
			source: {
				path: WORKFLOWS,
				quote:
					"Every node and every loop iteration is checkpointed to disk, so a run survives a Core restart.",
			},
		},
		{
			label: "Triggers",
			value: "Manual, schedule, webhook, Composio, app event",
			source: {
				path: WORKFLOWS,
				quote:
					"`manual`, `schedule`, `webhook`, `composio`, and `event` triggers",
			},
		},
		{
			label: "Steps at once",
			value: "4 by default, 1 to 16",
			source: {
				path: EXECUTION,
				quote: "It defaults to 4 and is clamped between 1 and 16.",
			},
		},
		{
			label: "From chat",
			value: "@mention a workflow; your message is its input",
			source: {
				path: WORKFLOWS,
				quote:
					"Send the message. Its text becomes the workflow's initial input.",
			},
		},
	],
	code: [
		{
			id: "workflows-fan-out",
			label: "Fan out",
			language: "json",
			code: FAN_OUT,
			source: {
				path: LOOPS,
				quote: '{ "id": "security", "workflow_id": "wf_security_review" },',
			},
		},
		{
			id: "workflows-schedule",
			label: "On a schedule",
			language: "json",
			code: SCHEDULED,
			source: {
				path: SCHEDULE,
				quote:
					'{ "type": "schedule", "cron": "0 9 * * *", "require_approval": true }',
			},
		},
		{
			id: "workflows-dry-run",
			label: "Dry run",
			language: "http",
			code: DRY_RUN,
			source: { path: EXECUTION, quote: '"dryRun": true' },
		},
		{
			id: "workflows-fork",
			label: "Fork a run",
			language: "bash",
			code: FORK,
			source: {
				path: RUNS_API,
				quote:
					'-d \'{ "checkpoint_id": "cp-000002", "state_patch": { "topic": "go" } }\'',
			},
		},
	],
	quickstart: [
		{
			title: "Draft the graph",
			description:
				"Drag steps onto the canvas on the Workflows page, or describe the flow in the Ask Ryu panel and let the builder draft it.",
			source: {
				path: SCHEDULE,
				quote:
					"You can drag nodes on the canvas, or describe it in the Ask Ryu panel and let the builder create the DAG.",
			},
		},
		{
			title: "Run it from chat",
			description:
				"Type @ in the composer, pick the workflow, and send. Each step shows up as a live checklist, and the output arrives as the reply.",
			source: {
				path: WORKFLOWS,
				quote:
					"Type `@` and pick a workflow in the **Workflows** group (or type `@WorkflowName` inline).",
			},
		},
		{
			title: "Put it on a schedule",
			description:
				"Select the Trigger step, set When this runs to Schedule, and pick an interval or a cron expression. The schedule survives a restart.",
			source: {
				path: SCHEDULE,
				quote: "Set **When this runs** to **Schedule**",
			},
		},
		{
			title: "Read the run's history",
			description:
				"Each finished step leaves a checkpoint. List them oldest first, then fork from any one to retry with new data.",
			command: "curl http://127.0.0.1:7980/workflows/runs/run_123/history",
			source: {
				path: RUNS_API,
				quote: "curl http://127.0.0.1:7980/workflows/runs/run_123/history",
			},
		},
	],
	docs: [
		{
			label: "Workflows",
			path: "/docs/core/workflows",
			description: "Step kinds, template variables, and running from chat.",
		},
		{
			label: "Triggers and history",
			path: "/docs/core/workflow-triggers-and-history",
			description: "Schedules, signed webhooks, app events, and versions.",
		},
		{
			label: "Run history and API",
			path: "/docs/core/workflow-runs-and-api",
			description: "Checkpoints, forking a run, and the workflow routes.",
		},
		{
			label: "Run a workflow on a schedule",
			path: "/docs/learn/cookbook/schedule-a-workflow",
			description: "A cron trigger with approval before each run.",
		},
		{
			label: "Author workflows in code",
			path: "/docs/extend/develop/extensions/author-workflows",
			description: "Write a workflow with the SDK and ship it in a plugin.",
		},
	],
	related: [
		{
			label: "Recipes to start from",
			href: "/guides/ryu-recipes",
			kind: "guide",
		},
		{
			label: "Ryu vs n8n for AI agents",
			href: "/blog/ryu-vs-n8n-ai-agents",
			kind: "blog",
		},
		{
			label: "Ryu vs Zapier AI agents",
			href: "/blog/ryu-vs-zapier-ai-agents",
			kind: "blog",
		},
		{
			label: "Agent orchestration options",
			href: "/blog/best-ai-agent-orchestration-platforms",
			kind: "blog",
		},
	],
	compareSlugs: ["n8n", "zapier", "dify"],
};

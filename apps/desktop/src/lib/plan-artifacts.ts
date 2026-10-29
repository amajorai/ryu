import { appRequestValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import type { Artifact } from "./artifacts.ts";

export type PlanTodoStatus = "completed" | "in_progress" | "pending";

export interface PlanTodo {
	content: string;
	status: PlanTodoStatus;
}

export type PlanTool = "PlanWrite" | "TodoWrite" | "update_plan";

/** A plan snapshot reconstructed from the persisted assistant message parts. */
export interface PlanSnapshot {
	key: string;
	markdown: string;
	sourceLabel: string;
	sourceMessageId: string;
	title: string;
	tool: PlanTool;
}

/** A plan artifact plus its durable Space document state. */
export interface PlanArtifact {
	artifact: Artifact;
	error?: string;
	key: string;
	saved: boolean;
	sourceLabel: string;
	title: string;
}

// Core persists tool inputs/results as serde_json::Value. During live assembly
// optional fields may still be undefined; do not close a tool's future payload.
const planRecordFieldsSchema = z.record(z.string(), appRequestValueSchema);
const planRecordSchema = z.preprocess(
	(value) => (Array.isArray(value) ? { ...value } : value),
	z.custom<z.output<typeof planRecordFieldsSchema>>(
		(value) =>
			planRecordFieldsSchema.safeParse(value).success &&
			appRequestValueSchema.safeParse(value).success
	)
);
const planTextSchema = z.string().trim().min(1);
const planPartFieldsSchema = z
	.object({
		input: appRequestValueSchema.optional(),
		output: appRequestValueSchema.optional(),
		state: appRequestValueSchema.optional(),
		toolCallId: appRequestValueSchema.optional(),
		toolName: appRequestValueSchema.optional(),
		type: appRequestValueSchema.optional(),
	})
	.catchall(appRequestValueSchema);
const planPartSchema = z.custom<z.output<typeof planPartFieldsSchema>>(
	(value) =>
		planPartFieldsSchema.safeParse(value).success &&
		appRequestValueSchema.safeParse(value).success
);
type PlanSourcePart = z.output<typeof planPartSchema>;
type PlanRecordInput = Parameters<typeof planRecordSchema.parse>[0];
type PlanTextInput = Parameters<typeof planTextSchema.parse>[0];
const planTodoArraySchema = z.array(z.unknown());
type PlanTodosInput = Parameters<typeof planTodoArraySchema.parse>[0];

interface PlanSourceMessage {
	id?: unknown;
	parts?: unknown;
	role?: unknown;
}

interface PlanWritePayload {
	summary?: string;
	title: string;
}

const PLAN_MARKER_PREFIX = "<!-- ryu-plan-key: ";
const PLAN_MARKER_SUFFIX = " -->";
const PLAN_TITLE_MAX_CHARS = 72;

function asRecord(value: PlanRecordInput) {
	const parsed = planRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function asString(value: PlanTextInput): string | undefined {
	const parsed = planTextSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function toolName(part: PlanSourcePart): string {
	const explicit = asString(part.toolName);
	if (explicit) {
		return explicit;
	}
	const type = asString(part.type);
	if (type?.startsWith("tool-")) {
		return type.slice("tool-".length);
	}
	return "";
}

function isTerminal(part: PlanSourcePart): boolean {
	const state = asString(part.state);
	return (
		state === undefined ||
		state === "output-available" ||
		state === "result" ||
		state === "completed"
	);
}

function todoStatus(
	value: z.output<typeof appRequestValueSchema>
): PlanTodoStatus {
	return value === "completed" || value === "in_progress" ? value : "pending";
}

function readTodos(value: PlanTodosInput): PlanTodo[] {
	const parsed = planTodoArraySchema.safeParse(value);
	if (!parsed.success) {
		return [];
	}
	const todos: PlanTodo[] = [];
	for (const item of parsed.data) {
		const record = asRecord(item);
		const content = asString(record?.content) ?? asString(record?.step);
		if (!content) {
			continue;
		}
		todos.push({ content, status: todoStatus(record?.status) });
	}
	return todos;
}

function readTodoPayload(part: PlanSourcePart): PlanTodo[] {
	const input = asRecord(part.input);
	const output = asRecord(part.output);
	return readTodos(input?.todos ?? output?.newTodos);
}

function readPlanWritePayload(part: PlanSourcePart): PlanWritePayload | null {
	const input = asRecord(part.input);
	const output = asRecord(part.output);
	const plan = asRecord(input?.plan ?? output?.plan);
	const title = asString(plan?.title);
	if (!title) {
		return null;
	}
	return {
		summary: asString(plan?.summary),
		title,
	};
}

function firstLine(value: string): string {
	return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function markdownList(todos: PlanTodo[]): string {
	if (todos.length === 0) {
		return "";
	}
	return [
		"## Steps",
		"",
		...todos.map((todo) => {
			const marker = todo.status === "completed" ? "x" : " ";
			return `- [${marker}] ${todo.content}`;
		}),
	].join("\n");
}

function markdownForPlan(
	key: string,
	title: string,
	summary: string | undefined,
	todos: PlanTodo[]
): string {
	const sections = [`# ${title}`];
	if (summary) {
		sections.push(summary);
	}
	const steps = markdownList(todos);
	if (steps) {
		sections.push(steps);
	}
	sections.push(`${PLAN_MARKER_PREFIX}${key}${PLAN_MARKER_SUFFIX}`);
	return `${sections.join("\n\n").trim()}\n`;
}

/** A short stable suffix keeps Space document titles human-readable and dedupable. */
function shortKey(value: string): string {
	let hash = 2_166_136_261;
	for (const character of value) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function clampTitle(value: string): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= PLAN_TITLE_MAX_CHARS) {
		return singleLine;
	}
	return `${singleLine.slice(0, PLAN_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/** Stable title used to find the same plan document after a reload or on another tab. */
export function planDocumentTitle(
	plan: Pick<PlanSnapshot, "key" | "title">
): string {
	return `Plan — ${clampTitle(plan.title)} · ${shortKey(plan.key)}`;
}

/** Turn one normalized plan snapshot into the existing markdown artifact model. */
export function planArtifact(
	plan: PlanSnapshot,
	document?: { documentId: string; spaceId: string },
	error?: string
): PlanArtifact {
	const id = `plan-${shortKey(plan.key)}`;
	return {
		artifact: {
			content: plan.markdown,
			docId: document?.documentId,
			id,
			kind: "space",
			mime: "text/markdown",
			sourceMessageId: plan.sourceMessageId,
			spaceId: document?.spaceId,
			title: plan.title,
		},
		error,
		key: plan.key,
		saved: Boolean(document),
		sourceLabel: plan.sourceLabel,
		title: plan.title,
	};
}

/**
 * Read every completed plan tool call from a conversation.
 *
 * ACP agents normally emit `TodoWrite`; Pi emits both `TodoWrite` and the
 * richer `PlanWrite`; the OpenAI-compatible plan bridge uses `update_plan`.
 * The tool-call identity is part of the key, so every snapshot can be saved
 * without collapsing the plan history to only the newest checklist.
 */
export function extractPlans(
	messages: readonly PlanSourceMessage[]
): PlanSnapshot[] {
	const plans: PlanSnapshot[] = [];
	const seen = new Set<string>();
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role === "user" || !Array.isArray(message.parts)) {
			continue;
		}
		const sourceMessageId = asString(message.id) ?? `message-${messageIndex}`;
		for (const [partIndex, rawPart] of message.parts.entries()) {
			const parsedPart = planPartSchema.safeParse(rawPart);
			if (!(parsedPart.success && isTerminal(parsedPart.data))) {
				continue;
			}
			const part = parsedPart.data;
			const tool = toolName(part);
			if (
				tool !== "TodoWrite" &&
				tool !== "PlanWrite" &&
				tool !== "update_plan"
			) {
				continue;
			}
			const callId = asString(part.toolCallId) ?? `part-${partIndex}`;
			const key = `${sourceMessageId}:${partIndex}:${callId}`;
			if (seen.has(key)) {
				continue;
			}

			let title = "Task plan";
			let summary: string | undefined;
			let todos: PlanTodo[] = [];
			let sourceLabel = "Task list";
			if (tool === "PlanWrite") {
				const payload = readPlanWritePayload(part);
				if (!payload) {
					continue;
				}
				title = payload.title;
				summary = payload.summary;
				sourceLabel = "Written plan";
			} else if (tool === "TodoWrite") {
				todos = readTodoPayload(part);
				if (todos.length === 0) {
					continue;
				}
				title = firstLine(todos[0]?.content ?? "") || "Task plan";
				sourceLabel = "ACP / Pi to-dos";
			} else {
				const input = asRecord(part.input);
				todos = readTodos(input?.plan);
				if (todos.length === 0) {
					continue;
				}
				title = firstLine(todos[0]?.content ?? "") || "Task plan";
				sourceLabel = "Plan update";
			}

			seen.add(key);
			plans.push({
				key,
				markdown: markdownForPlan(key, title, summary, todos),
				sourceLabel,
				sourceMessageId,
				title,
				tool,
			});
		}
	}
	return plans;
}

import {
	type AppRequestValue,
	appRequestValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
export type TodoItemStatus = "completed" | "in_progress" | "pending";

export interface TodoProgressItem {
	label: string;
	status: TodoItemStatus;
}

export interface TodoProgressSnapshot {
	completed: number;
	current: number;
	hasInProgress: boolean;
	isComplete: boolean;
	items: TodoProgressItem[];
	percentage: number;
	total: number;
}

/** Message boundary accepted by the todo parser. The persisted and live chat
 * message types both satisfy this shape without exposing their internal part
 * unions to the sidebar. */
export interface TodoProgressMessage {
	parts?: readonly unknown[];
	role?: unknown;
}

// Persisted tool values are Core JSON; live optional fields can still be
// undefined. Parse that transport before consuming the TodoWrite projection.
const todoRecordFieldsSchema = z.record(z.string(), appRequestValueSchema);
const todoRecordSchema = z.preprocess(
	(value) => (Array.isArray(value) ? { ...value } : value),
	z.custom<z.output<typeof todoRecordFieldsSchema>>(
		(value) =>
			todoRecordFieldsSchema.safeParse(value).success &&
			appRequestValueSchema.safeParse(value).success
	)
);
type TodoRecord = z.output<typeof todoRecordSchema>;
const todoTextSchema = z.string();
const todoItemsSchema = z.array(appRequestValueSchema);
const todoStatusSchema = z.enum(["completed", "in_progress", "pending"]);

function todoRecord(value: Parameters<typeof todoRecordSchema.parse>[0]) {
	const parsed = todoRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function stringValue(value: AppRequestValue): string | undefined {
	const parsed = todoTextSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function todoToolName(part: TodoRecord): string | undefined {
	const type = stringValue(part.type);
	if (type === "dynamic-tool") {
		return stringValue(part.toolName);
	}
	if (type?.startsWith("tool-")) {
		return type.slice("tool-".length);
	}
	return undefined;
}

function todoListOf(part: TodoRecord): readonly AppRequestValue[] | null {
	const input = todoRecord(part.input);
	const inputItems = todoItemsSchema.safeParse(input?.todos);
	if (inputItems.success) {
		return inputItems.data;
	}
	const output = todoRecord(part.output);
	const outputItems = todoItemsSchema.safeParse(output?.newTodos);
	return outputItems.success ? outputItems.data : null;
}

function todoStatusOf(value: AppRequestValue): TodoItemStatus | undefined {
	const parsed = todoStatusSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function todoItemsOf(items: readonly AppRequestValue[]): TodoProgressItem[] {
	const normalized: TodoProgressItem[] = [];
	for (const value of items) {
		const item = todoRecord(value);
		if (!item) {
			continue;
		}
		const label = stringValue(item.content)?.trim();
		const status = todoStatusOf(item.status);
		if (!(label && status)) {
			continue;
		}
		normalized.push({ label, status });
	}
	return normalized;
}

/** Derive the newest non-empty TodoWrite snapshot from persisted or live parts. */
export function deriveTodoProgress(
	messages: readonly TodoProgressMessage[]
): TodoProgressSnapshot | undefined {
	for (
		let messageIndex = messages.length - 1;
		messageIndex >= 0;
		messageIndex -= 1
	) {
		const parts = messages[messageIndex]?.parts;
		if (!parts) {
			continue;
		}
		for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
			const part = todoRecord(parts[partIndex]);
			if (!part || todoToolName(part) !== "TodoWrite") {
				continue;
			}
			const rawItems = todoListOf(part);
			if (!rawItems) {
				continue;
			}
			if (rawItems.length === 0) {
				return undefined;
			}

			const items = todoItemsOf(rawItems);
			if (items.length === 0) {
				return undefined;
			}
			const activeIndex = items.findIndex(
				(item) => item.status === "in_progress"
			);
			const pendingIndex = items.findIndex((item) => item.status === "pending");
			const completed = items.filter(
				(item) => item.status === "completed"
			).length;
			const total = items.length;
			return {
				completed,
				current:
					activeIndex >= 0
						? activeIndex + 1
						: pendingIndex >= 0
							? pendingIndex + 1
							: total,
				hasInProgress: activeIndex >= 0,
				isComplete: completed === total,
				items,
				percentage: Math.round((completed / total) * 100),
				total,
			};
		}
	}
	return undefined;
}

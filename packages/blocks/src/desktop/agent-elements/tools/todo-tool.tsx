import { cn } from "@ryu/ui/lib/utils";
import { memo, useMemo } from "react";
import { CheckIcon, IconSpinner } from "../icons.tsx";
import { TextShimmer } from "../text-shimmer.tsx";
import { areToolPropsEqual } from "../utils/format-tool.ts";

export interface TodoItem {
	activeForm?: string;
	content: string;
	status: "pending" | "in_progress" | "completed";
}

export interface TodoToolProps {
	chatStatus?: string;
	part: TodoToolPart;
}

interface TodoToolPart {
	input?: {
		todos?: TodoItem[];
	};
	output?: {
		newTodos?: TodoItem[];
		oldTodos?: TodoItem[];
		success?: boolean;
	};
	state?: string;
}

export interface TodoChange {
	index: number;
	newStatus: TodoItem["status"];
	oldStatus?: TodoItem["status"];
	todo: TodoItem;
}

type ChangeType = "creation" | "single" | "multiple";

export interface DetectedChanges {
	items: TodoChange[];
	type: ChangeType;
}

function detectChanges(
	oldTodos: TodoItem[],
	newTodos: TodoItem[]
): DetectedChanges {
	if (!oldTodos || oldTodos.length === 0) {
		return {
			type: "creation",
			items: newTodos.map((todo, index) => ({
				todo,
				newStatus: todo.status,
				index,
			})),
		};
	}

	const changes: TodoChange[] = [];
	newTodos.forEach((newTodo, index) => {
		const oldTodo = oldTodos[index];
		if (!oldTodo || oldTodo.status !== newTodo.status) {
			changes.push({
				todo: newTodo,
				oldStatus: oldTodo?.status,
				newStatus: newTodo.status,
				index,
			});
		}
	});

	if (changes.length === 1) {
		return { type: "single", items: changes };
	}
	return { type: "multiple", items: changes };
}

const TodoStatusIcon = ({
	status,
	num,
}: {
	status: TodoItem["status"];
	num: number;
}) => {
	// Completed keeps the green check; pending & current both show their step
	// number inside the circle — current adds a spinning ring around the number.
	if (status === "completed") {
		return (
			<div className="flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground shadow-sm">
				<CheckIcon className="size-2.5 drop-shadow-[0_1px_1px_rgba(0,0,0,0.18)]" />
			</div>
		);
	}
	if (status === "in_progress") {
		return (
			<div className="relative flex size-4 shrink-0 items-center justify-center">
				<IconSpinner className="absolute inset-0 size-4 animate-spin text-primary will-change-transform" />
				<span className="font-medium text-[9px] text-foreground tabular-nums">
					{num}
				</span>
			</div>
		);
	}
	return (
		<div className="flex size-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground/60 font-medium text-[9px] text-muted-foreground/70 tabular-nums">
			{num}
		</div>
	);
};

const TodoListItem = memo(function TodoListItem({
	todo,
	num,
}: {
	todo: TodoItem;
	num: number;
}) {
	return (
		<div className={cn("flex items-start gap-2")}>
			<div className="mt-[2px]">
				<TodoStatusIcon num={num} status={todo.status} />
			</div>
			<span
				className={cn(
					"text-sm",
					todo.status === "completed" && "line-through",
					todo.status === "in_progress"
						? "text-foreground/80"
						: "text-foreground/60"
				)}
			>
				{todo.content}
			</span>
		</div>
	);
});

function getTodoKey(todo: TodoItem): string {
	return [todo.content, todo.status, todo.activeForm ?? ""].join(":");
}

function renderTodoList(todos: TodoItem[]) {
	return todos.map((todo, index) => (
		<TodoListItem key={getTodoKey(todo)} num={index + 1} todo={todo} />
	));
}

export const TodoTool = memo(function TodoTool({ part }: TodoToolProps) {
	const isStreaming = part.state === "input-streaming";
	const oldTodos: TodoItem[] = part.output?.oldTodos || [];
	const newTodos: TodoItem[] = part.input?.todos || part.output?.newTodos || [];

	const isCreation = oldTodos.length === 0;
	const changes = useMemo(
		() => detectChanges(oldTodos, newTodos),
		[oldTodos, newTodos]
	);

	// Streaming placeholder — always shimmer while in this transient state.
	if (isStreaming || newTodos.length === 0) {
		return (
			<div className="space-y-2 text-foreground/80 text-sm leading-relaxed">
				<div className="text-foreground/60">
					<TextShimmer
						as="span"
						className="m-0 inline-flex h-4 items-center text-sm leading-none"
						duration={1.2}
					>
						{isCreation ? "Creating to-do list..." : "Updating to-dos..."}
					</TextShimmer>
				</div>
			</div>
		);
	}

	// Single update - show full list for clarity
	if (changes.type === "single") {
		return (
			<div className="space-y-2 text-foreground/80 text-sm leading-relaxed">
				{renderTodoList(newTodos)}
			</div>
		);
	}

	// Multiple updates - show full list for clarity
	if (changes.type === "multiple") {
		return (
			<div className="space-y-2 text-foreground/80 text-sm leading-relaxed">
				{renderTodoList(newTodos)}
			</div>
		);
	}

	const displayTodos = newTodos;
	return (
		<div className="space-y-2 text-foreground/80 text-sm leading-relaxed">
			{renderTodoList(displayTodos)}
		</div>
	);
}, areToolPropsEqual);

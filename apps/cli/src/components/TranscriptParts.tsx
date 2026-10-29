/* @jsxImportSource @opentui/react */

import { memo } from "react";
import { useTheme, useUnicode } from "@/components/ui/theme-provider.tsx";
import { ToolCall } from "@/components/ui/tool-call.tsx";
import { type ChatPart, isSettledToolStatus } from "../core/chatTranscript.ts";
import {
	boundTerminalText,
	completedTodoCount,
	formatToolOutput,
	TRANSCRIPT_LIMITS,
	todoStatusPresentation,
	toolArgumentsForPresentation,
	toolDiffStat,
	toolDurationMs,
	toolPendingLabel,
	toolSummary,
} from "../core/transcriptPresentation.ts";
import { tf } from "../i18n/translate.ts";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { ReasoningRow } from "./ReasoningRow.tsx";

// Memoized: a streamed token replaces only the last message, so earlier
// messages keep their `parts` array and skip re-rendering entirely.
// `streaming` is true only for the in-flight assistant message, so finished
// messages keep stable props too.
export const TranscriptParts = memo(function TranscriptParts({
	parts,
	pendingPermissionToolCallId,
	recoveryHint = false,
	streaming = false,
}: {
	parts: ChatPart[];
	/** Highlight the tool row a permission prompt is waiting on. */
	pendingPermissionToolCallId?: string | undefined;
	/** Show the resend hint under an error (only the latest turn can resend). */
	recoveryHint?: boolean;
	streaming?: boolean;
}) {
	const theme = useTheme();
	return (
		<box flexDirection="column" gap={1}>
			{parts.map((part, index) => {
				switch (part.type) {
					case "text": {
						const presentation = boundTerminalText(part.text, {
							label: "message",
							maxChars: TRANSCRIPT_LIMITS.markdownChars,
							maxLines: TRANSCRIPT_LIMITS.markdownLines,
						});
						return (
							<box flexDirection="column" key={`text-${index}`}>
								<ChatMarkdown
									content={presentation.text}
									streaming={streaming && index === parts.length - 1}
								/>
								{presentation.truncated ? (
									<text fg={theme.colors.mutedForeground}>
										[message output is bounded]
									</text>
								) : null}
							</box>
						);
					}
					case "reasoning":
						return (
							<ReasoningRow
								endedAt={part.endedAt}
								key={`reasoning-${index}`}
								startedAt={part.startedAt}
								streaming={
									streaming &&
									index === parts.length - 1 &&
									part.endedAt === undefined
								}
								text={part.text}
							/>
						);
					case "tool": {
						const args = toolArgumentsForPresentation(
							part.name,
							part.args,
							part.result
						);
						return (
							<ToolCall
								args={args}
								awaitingPermission={
									pendingPermissionToolCallId !== undefined &&
									part.toolCallId === pendingPermissionToolCallId &&
									!isSettledToolStatus(part.status)
								}
								collapsible
								defaultCollapsed
								diffStat={toolDiffStat(part.name, part.args, part.result)}
								duration={
									isSettledToolStatus(part.status)
										? toolDurationMs(part)
										: undefined
								}
								key={`tool-${part.toolCallId ?? index}`}
								name={part.name}
								pendingLabel={toolPendingLabel(part.name)}
								result={formatToolOutput(part.result)}
								status={part.status}
								summary={toolSummary(part.name, part.args)}
							/>
						);
					}
					case "todo":
						return <TodoPart key={`todo-${index}`} todos={part.todos} />;
					case "error":
						return (
							<ErrorPart
								hint={recoveryHint && index === parts.length - 1}
								key={`error-${index}`}
								message={part.message}
							/>
						);
				}
			})}
		</box>
	);
});

/** Recovery hint under a failed turn: up-arrow recalls the prompt to resend. */
const ERROR_PART_HINT = "↑ edit & resend · /model switch";
const ERROR_PART_HINT_ASCII = "up edit & resend - /model switch";

function ErrorPart({ hint, message }: { hint: boolean; message: string }) {
	const theme = useTheme();
	const unicode = useUnicode();
	const bounded = boundTerminalText(message, {
		label: "error",
		maxChars: TRANSCRIPT_LIMITS.errorChars,
		maxLines: TRANSCRIPT_LIMITS.errorLines,
	});
	return (
		<box flexDirection="column">
			<text fg={theme.colors.error}>
				{tf("Error: {message}", { message: bounded.text })}
			</text>
			{hint ? (
				<text fg={theme.colors.mutedForeground}>
					{unicode ? ERROR_PART_HINT : ERROR_PART_HINT_ASCII}
				</text>
			) : null}
		</box>
	);
}

function TodoPart({ todos }: { todos: { content: string; status: string }[] }) {
	const theme = useTheme();
	const unicode = useUnicode();
	const completed = completedTodoCount(todos);
	const contentRows = Math.max(1, todos.length);
	return (
		<box
			borderColor={theme.colors.border}
			borderStyle="single"
			flexDirection="column"
			height={contentRows + 3}
			paddingLeft={1}
			paddingRight={1}
		>
			<box flexDirection="row" gap={1} height={1}>
				<text fg={theme.colors.primary}>
					<b>Plan</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					{`${completed}/${todos.length} complete`}
				</text>
			</box>
			{todos.length === 0 ? (
				<text fg={theme.colors.mutedForeground} height={1}>
					No tasks yet
				</text>
			) : (
				todos.map((todo, index) => {
					const status = todoStatusPresentation(todo.status, unicode);
					const content = boundTerminalText(todo.content, {
						label: "todo",
						maxChars: TRANSCRIPT_LIMITS.todoChars,
						maxLines: TRANSCRIPT_LIMITS.todoLines,
					});
					return (
						<box
							flexDirection="row"
							gap={1}
							height={1}
							key={`${todo.content}-${index}`}
						>
							<text fg={theme.colors[status.tone]}>{status.icon}</text>
							<text fg={theme.colors.foreground}>{content.text}</text>
						</box>
					);
				})
			)}
		</box>
	);
}

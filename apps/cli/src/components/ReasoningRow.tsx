/* @jsxImportSource @opentui/react */
// ReasoningRow: a compact, Ryu-owned transcript row for model reasoning.
//
// Collapsed it is exactly one terminal row: a spinner with `Thinking: <title>`
// while streaming, then `+ Thought: <title> · 4.2s` once the model moves on.
// Clicking the header expands the bounded reasoning text below it. There is no
// keyboard binding here on purpose: every mounted useKeyboard sees every key,
// so a per-row key would toggle all rows at once (and fire from the composer).

import { useState } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import {
	boundTerminalText,
	formatReasoningDuration,
	reasoningTitle,
	TRANSCRIPT_LIMITS,
} from "../core/transcriptPresentation.ts";

export interface ReasoningRowProps {
	endedAt?: number;
	startedAt?: number;
	streaming: boolean;
	text: string;
}

/**
 * Header segments for a reasoning row. The lead and suffix never shrink, so a
 * narrow pane truncates only the title and always keeps the marker and duration.
 */
export function reasoningHeaderParts({
	endedAt,
	expanded,
	startedAt,
	streaming,
	text,
}: ReasoningRowProps & { expanded: boolean }): {
	lead: string;
	suffix: string;
	title: string;
} {
	const title = reasoningTitle(text);
	if (streaming) {
		return { lead: title ? "Thinking:" : "Thinking", title, suffix: "" };
	}
	const duration = formatReasoningDuration(startedAt, endedAt);
	const marker = expanded ? "-" : "+";
	return {
		lead: title ? `${marker} Thought:` : `${marker} Thought`,
		title,
		suffix: duration ? `· ${duration}` : "",
	};
}

export function ReasoningRow(props: ReasoningRowProps) {
	const theme = useTheme();
	const [expanded, setExpanded] = useState(false);
	const { lead, suffix, title } = reasoningHeaderParts({ ...props, expanded });
	const tone = props.streaming
		? theme.colors.primary
		: theme.colors.mutedForeground;
	return (
		<box flexDirection="column">
			<box
				flexDirection="row"
				gap={1}
				height={1}
				onMouseDown={() => setExpanded((value) => !value)}
			>
				{props.streaming ? (
					<Spinner color={theme.colors.primary} flexShrink={0} />
				) : null}
				<text fg={tone} flexShrink={0} wrapMode="none">
					{lead}
				</text>
				{title ? (
					<text fg={tone} flexShrink={1} truncate wrapMode="none">
						{title}
					</text>
				) : null}
				{suffix ? (
					<text fg={tone} flexShrink={0} wrapMode="none">
						{suffix}
					</text>
				) : null}
			</box>
			{expanded ? (
				<box flexDirection="column" paddingLeft={2}>
					<text fg={theme.colors.mutedForeground}>
						{
							boundTerminalText(props.text, {
								label: "thinking",
								maxChars: TRANSCRIPT_LIMITS.thinkingChars,
								maxLines: TRANSCRIPT_LIMITS.thinkingLines,
							}).text
						}
					</text>
				</box>
			) : null}
		</box>
	);
}

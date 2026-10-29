/* @jsxImportSource @opentui/react */

import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import {
	type AutocompleteState,
	autocompleteLayout,
	autocompleteRow,
	autocompleteWindow,
} from "../../core/autocomplete.ts";
import { HINT, hintText } from "../../core/keymap.ts";
import { tf } from "../../i18n/translate.ts";

function autocompleteEmptyText(state: AutocompleteState): string {
	if (state.notice) {
		return state.notice;
	}
	return state.loading ? "Searching…" : "No matches";
}

/** Widest label column the completion list aligns descriptions to. */
const AUTOCOMPLETE_LABEL_MAX_WIDTH = 32;

function autocompleteHint(state: AutocompleteState): string {
	return state.context.kind === "slash-argument"
		? `/${state.context.commandName} · ${state.context.argument.name} · ${COMPLETE_HINT}`
		: COMPLETE_HINT;
}

export function AutocompleteView({
	maxHeight,
	state,
}: {
	/** Terminal rows available above the composer. */
	maxHeight: number;
	state: AutocompleteState;
}) {
	const theme = useTheme();
	const { suggestions } = state;
	if (
		suggestions.length === 0 &&
		!state.loading &&
		!state.notice &&
		state.context.query.length === 0
	) {
		return null;
	}
	const layout = autocompleteLayout(suggestions.length, maxHeight);
	const visible = autocompleteWindow(
		state.index,
		suggestions.length,
		layout.rows
	);
	const rows = suggestions
		.slice(visible.start, visible.end)
		.map((suggestion) => autocompleteRow(suggestion));
	// Align descriptions in one column across the visible rows.
	const labelWidth = Math.min(
		AUTOCOMPLETE_LABEL_MAX_WIDTH,
		Math.max(0, ...rows.map((row) => row.label.length))
	);
	return (
		<box
			backgroundColor={theme.colors.background}
			bottom="100%"
			left={1}
			position="absolute"
			right={1}
			zIndex={10}
		>
			<Card bordered>
				{layout.header ? (
					<box flexDirection="row" gap={2}>
						<text fg={theme.colors.foreground} flexShrink={0} wrapMode="none">
							<b>Complete</b>
						</text>
						<text
							fg={theme.colors.mutedForeground}
							flexShrink={1}
							truncate
							wrapMode="none"
						>
							{autocompleteHint(state)}
						</text>
					</box>
				) : null}
				{suggestions.length === 0 ? (
					<text fg={theme.colors.mutedForeground}>
						{autocompleteEmptyText(state)}
					</text>
				) : null}
				{visible.above > 0 ? (
					<text fg={theme.colors.mutedForeground}>
						{tf("↑ {count} more", { count: String(visible.above) })}
					</text>
				) : null}
				{rows.map((row, offset) => {
					const selected = visible.start + offset === state.index;
					const foreground = selected
						? theme.colors.selectionForeground
						: theme.colors.foreground;
					const muted = selected
						? theme.colors.selectionForeground
						: theme.colors.mutedForeground;
					return (
						<box
							backgroundColor={selected ? theme.colors.selection : undefined}
							flexDirection="row"
							gap={1}
							key={row.key}
						>
							<text fg={foreground} flexShrink={0} wrapMode="none">
								{selected ? "›" : " "}
							</text>
							<text
								fg={foreground}
								flexShrink={0}
								truncate
								width={labelWidth}
								wrapMode="none"
							>
								{row.label}
							</text>
							<text
								fg={muted}
								flexGrow={1}
								flexShrink={1}
								truncate
								wrapMode="none"
							>
								{row.description}
							</text>
							{row.tag ? (
								<text fg={muted} flexShrink={0} wrapMode="none">
									{row.tag}
								</text>
							) : null}
						</box>
					);
				})}
				{visible.below > 0 ? (
					<text fg={theme.colors.mutedForeground}>
						{tf("↓ {count} more", { count: String(visible.below) })}
					</text>
				) : null}
			</Card>
		</box>
	);
}

const COMPLETE_HINT = hintText([
	HINT.move,
	{ keys: "Tab/Enter", label: "choose" },
	HINT.cancel,
]);

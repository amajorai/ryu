/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { ChatMarkdown } from "../../components/ChatMarkdown.tsx";
import { commandHelpRows } from "../../core/commands.ts";
import { BOT_HIDDEN_COMMANDS, HINT, hintText } from "../../core/keymap.ts";
import { useCliProductMode } from "../../core/ProductModeContext.tsx";
import { RYU_THEME_PRESETS } from "../../core/themePreferences.ts";
import { tf } from "../../i18n/translate.ts";
import { Modal, modalRowId } from "../../ui/Modal.tsx";
import { SelectableRow } from "../../ui/SelectableRow.tsx";
import { useTerminalTheme } from "../../ui/TerminalThemeProvider.tsx";
import { useToast } from "../../ui/toast.tsx";
import type { Overlay } from "./types.ts";

function ThemePickerOverlay({
	argument,
	focused,
	onClose,
}: {
	argument?: string;
	/** False while the chat is not the focused pane or the shell owns keys. */
	focused: boolean;
	onClose: () => void;
}) {
	const theme = useTheme();
	const { notify } = useToast();
	const {
		availableModes,
		availablePresets,
		preference,
		reset,
		setMode,
		setPreset,
	} = useTerminalTheme();
	const options = [
		...availableModes.map((mode) => ({
			id: mode,
			kind: "mode" as const,
			label: mode === "system" ? "System (terminal)" : mode,
		})),
		...availablePresets.map((preset) => ({
			id: preset,
			kind: "preset" as const,
			label: RYU_THEME_PRESETS[preset].label,
		})),
	];
	const requested = argument?.trim().toLowerCase();
	const initialIndex = Math.max(
		0,
		options.findIndex(
			(option) =>
				option.id === requested ||
				(option.kind === "mode" && option.id === preference.mode) ||
				(option.kind === "preset" && option.id === preference.preset)
		)
	);
	const [index, setIndex] = useState(initialIndex);

	useKeyboard((key) => {
		if (!focused) {
			return;
		}
		if (key.name === "escape") {
			onClose();
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setIndex((current) => Math.max(0, current - 1));
			return;
		}
		if (key.name === "down" || key.name === "j") {
			setIndex((current) => Math.min(options.length - 1, current + 1));
			return;
		}
		if (key.name === "r") {
			reset();
			notify("Terminal theme reset", "info");
			return;
		}
		if (key.name !== "return") {
			return;
		}
		const selected = options[index];
		if (!selected) {
			return;
		}
		if (selected.kind === "mode") {
			setMode(selected.id);
			notify(tf("Theme mode: {mode}", { mode: selected.id }), "info");
		} else {
			setPreset(selected.id);
			notify(tf("Theme preset: {preset}", { preset: selected.label }), "info");
		}
		onClose();
	});

	return (
		<Modal
			activeRowId={modalRowId(index)}
			footer={hintText([
				HINT.move,
				{ keys: "Enter", label: "apply" },
				{ keys: "r", label: "reset" },
				HINT.cancel,
			])}
			hint=""
			onClose={onClose}
			title="Terminal theme"
		>
			{options.map((option, optionIndex) => {
				const selected = optionIndex === index;
				const active =
					(option.kind === "mode" && option.id === preference.mode) ||
					(option.kind === "preset" && option.id === preference.preset);
				return (
					<box
						backgroundColor={selected ? theme.colors.selection : undefined}
						flexDirection="row"
						gap={1}
						id={modalRowId(optionIndex)}
						key={`${option.kind}-${option.id}`}
					>
						<text
							fg={
								selected
									? theme.colors.selectionForeground
									: theme.colors.primary
							}
						>
							{selected ? "›" : active ? "●" : " "}
						</text>
						<text
							fg={
								selected
									? theme.colors.selectionForeground
									: theme.colors.foreground
							}
						>
							{option.label}
						</text>
					</box>
				);
			})}
		</Modal>
	);
}

export function OverlayView({
	focused,
	onClose,
	overlay,
}: {
	/** Whether this pane owns the keyboard (read-only modals scroll with ↑/↓). */
	focused: boolean;
	onClose: () => void;
	overlay: Overlay;
}) {
	const theme = useTheme();
	const { effectiveMode } = useCliProductMode();
	const simpleInterface = effectiveMode === "bot";
	if (overlay.kind === "agents") {
		return (
			<Modal
				activeRowId={modalRowId(overlay.index)}
				footer={PICKER_HINT}
				hint=""
				onClose={onClose}
				title="Select agent"
			>
				{overlay.agents.length === 0 ? (
					<text fg={theme.colors.mutedForeground}>No agents</text>
				) : (
					overlay.agents.map((agentItem, i) => (
						<box id={modalRowId(i)} key={agentItem.id}>
							<SelectableRow
								selected={i === overlay.index}
								title={agentItem.name}
							/>
						</box>
					))
				)}
			</Modal>
		);
	}
	if (overlay.kind === "teams") {
		return (
			<Modal
				activeRowId={modalRowId(overlay.index)}
				footer={
					overlay.loading
						? "Loading groups · Esc cancel"
						: overlay.error
							? hintText([HINT.retry, HINT.cancel])
							: PICKER_HINT
				}
				hint=""
				onClose={onClose}
				title="Select group"
			>
				{overlay.loading ? (
					<StatusMessage variant="loading">Loading groups…</StatusMessage>
				) : overlay.error ? (
					<text fg={theme.colors.error}>
						{tf("Groups failed: {error}", { error: overlay.error })}
					</text>
				) : overlay.teams.length === 0 ? (
					<text fg={theme.colors.mutedForeground}>No groups available</text>
				) : (
					overlay.teams.map((team, i) => (
						<box id={modalRowId(i)} key={team.id}>
							<SelectableRow
								accessory={team.id}
								selected={i === overlay.index}
								title={team.name}
							/>
						</box>
					))
				)}
			</Modal>
		);
	}
	if (overlay.kind === "models") {
		return (
			<Modal
				activeRowId={modalRowId(overlay.index)}
				footer={PICKER_HINT}
				hint=""
				onClose={onClose}
				title="Select model"
			>
				{overlay.choices.map((choice, i) => (
					<box id={modalRowId(i)} key={choice.id ?? "default"}>
						<SelectableRow
							selected={i === overlay.index}
							title={choice.label}
						/>
					</box>
				))}
			</Modal>
		);
	}
	if (overlay.kind === "sessions") {
		return (
			<Modal keyboardScroll={focused} onClose={onClose} title="Sessions">
				{overlay.sessions.length === 0 ? (
					<text fg={theme.colors.mutedForeground}>No runs yet</text>
				) : (
					overlay.sessions.map((session) => (
						<box flexDirection="row" gap={1} key={session.id}>
							<text fg={theme.colors.foreground}>{session.runnableKind}</text>
							<text fg={theme.colors.mutedForeground}>
								{session.runnableId}
							</text>
							<Badge bordered={false} variant="secondary">
								{session.status}
							</Badge>
						</box>
					))
				)}
			</Modal>
		);
	}
	if (overlay.kind === "acp") {
		return (
			<Modal
				activeRowId={modalRowId(overlay.index)}
				footer={PICKER_HINT}
				hint=""
				onClose={onClose}
				title="ACP settings"
			>
				{overlay.choices.map((choice, i) => (
					<box id={modalRowId(i)} key={`${choice.kind}-${choice.id}-${i}`}>
						<SelectableRow
							selected={i === overlay.index}
							title={choice.label}
						/>
					</box>
				))}
			</Modal>
		);
	}
	if (overlay.kind === "btw") {
		return (
			<Modal
				footer={overlay.question}
				keyboardScroll={focused}
				onClose={onClose}
				title="btw"
			>
				{overlay.answer === null ? (
					<StatusMessage variant="loading">Thinking…</StatusMessage>
				) : (
					<ChatMarkdown content={overlay.answer} />
				)}
			</Modal>
		);
	}
	if (overlay.kind === "question") {
		const current = overlay.question.questions[overlay.questionIndex];
		if (!current) {
			return null;
		}
		return (
			<box padding={1}>
				<Card
					subtitle={hintText([
						HINT.move,
						{ keys: "Enter", label: "submit" },
						{ keys: "Esc", label: "skip" },
					])}
					title="Question"
				>
					<text fg={theme.colors.foreground}>{current.title}</text>
					{current.description ? (
						<text fg={theme.colors.mutedForeground}>{current.description}</text>
					) : null}
					{current.kind === "text" ? (
						<text fg={theme.colors.primary}>
							{overlay.text || "Type an answer…"}
						</text>
					) : (
						current.options.map((option, i) => (
							<box flexDirection="row" gap={1} key={option.id}>
								<text
									fg={
										i === overlay.selected
											? theme.colors.primary
											: theme.colors.mutedForeground
									}
								>
									{i === overlay.selected ? "›" : " "}
								</text>
								<text
									fg={
										i === overlay.selected
											? theme.colors.primary
											: theme.colors.foreground
									}
								>
									{option.label}
								</text>
							</box>
						))
					)}
				</Card>
			</box>
		);
	}
	if (overlay.kind === "delete") {
		return (
			<Modal
				footer="Enter/Y confirm · Esc/N cancel"
				hint=""
				onClose={onClose}
				title="Delete conversation?"
			>
				<text fg={theme.colors.warning}>{overlay.conversationId}</text>
				<text fg={theme.colors.mutedForeground}>
					This permanently removes the conversation.
				</text>
			</Modal>
		);
	}
	if (overlay.kind === "help") {
		const command = overlay.command;
		const rows = commandHelpRows().filter(
			(row) => !(simpleInterface && BOT_HIDDEN_COMMANDS.has(row.name))
		);
		const requestedRows = command
			? rows.filter(
					(row) => row.name === command || row.aliases.includes(command)
				)
			: rows;
		const matchingRows = requestedRows.length > 0 ? requestedRows : rows;
		const lines = matchingRows.map(
			(row) => `${row.usage} — ${row.description}`
		);
		return (
			<Modal
				hint="Enter/Esc close"
				keyboardScroll={focused}
				onClose={onClose}
				title="Slash commands"
				width={100}
			>
				{lines.map((line) => (
					<text fg={theme.colors.foreground} key={line}>
						{line}
					</text>
				))}
			</Modal>
		);
	}
	if (overlay.kind === "theme") {
		return (
			<ThemePickerOverlay
				argument={overlay.argument}
				focused={focused}
				onClose={onClose}
			/>
		);
	}
	if (overlay.kind === "plugin_note") {
		return (
			<Modal
				footer="from a plugin hook"
				keyboardScroll={focused}
				onClose={onClose}
				title="Note"
			>
				{overlay.notes.map((note, i) => (
					// notes are append-only text with no stable id
					<ChatMarkdown content={note} key={i} />
				))}
			</Modal>
		);
	}
	return null;
}

/** Shared picker footer: "↑↓ move · Enter choose · Esc cancel". */
const PICKER_HINT = hintText([HINT.move, HINT.choose, HINT.cancel]);

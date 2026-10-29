/* @jsxImportSource @opentui/react */
// The agent editor's identity step and account-access panel.
//
// "How should this agent work?" is the first screen of a new agent, as in the
// desktop New agent dialog: three big cards, icon above title, with "Acts as
// you" preselected. The same cards reopen from the editor's identity field.
// The account-access panel lists the accounts the agent could be allowed, from
// the same Core endpoints as the desktop editor (src/core/agentAccountCatalog.ts),
// with the allowed ones ticked; keys it cannot list are kept and shown below.
// A key can still be typed in. Labels and notes come from
// src/core/agentIdentity.ts so they match `ryu-cli agents access` and Core's grammar. Keyboard handling stays in the
// editor (index.tsx), like its tool and skill pickers.

import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import {
	ACCOUNT_OWNER_HEADINGS,
	type AvailableAccount,
	type AvailableAccounts,
} from "../../core/agentAccountCatalog.ts";
import {
	AGENT_IDENTITY_MODE_OPTIONS,
	AGENT_IDENTITY_MODE_ORDER,
	AGENT_IDENTITY_STEP_SUBTITLE,
	AGENT_IDENTITY_STEP_TITLE,
	type AgentIdentityMode,
	accountAccessHeadline,
	accountAccessNote,
	accountKeyKind,
	accountKeyUnusedReason,
} from "../../core/agentIdentity.ts";
import { HINT, hintText } from "../../core/keymap.ts";
import { tf } from "../../i18n/translate.ts";

const ACCESS_LIST_HEIGHT = 12;

export const IDENTITY_STEP_HINT = hintText([
	{ keys: "←/→ or 1-3", label: "choose" },
	{ keys: "Enter", label: "continue" },
	HINT.back,
]);
export const ACCESS_PANEL_HINT = hintText([
	HINT.move,
	{ keys: "Space", label: "allow/deny" },
	{ keys: "a", label: "add key" },
	{ keys: "c", label: "no limit" },
	{ keys: "0", label: "none" },
	HINT.refresh,
	HINT.back,
]);
const ACCESS_ADD_HINT = hintText([
	{ keys: "Enter", label: "add key" },
	{ keys: "Esc", label: "cancel" },
]);

export function AgentIdentityStep({
	selected,
	title,
}: {
	selected: AgentIdentityMode;
	title: string;
}) {
	const theme = useTheme();
	const detail = AGENT_IDENTITY_MODE_OPTIONS[selected].detail;
	return (
		<box flexDirection="column" flexGrow={1}>
			<box flexDirection="column" paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.mutedForeground}>{title}</text>
				<text fg={theme.colors.foreground}>
					<b>{AGENT_IDENTITY_STEP_TITLE}</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					{AGENT_IDENTITY_STEP_SUBTITLE}
				</text>
				<text fg={theme.colors.mutedForeground}>{IDENTITY_STEP_HINT}</text>
			</box>
			<box flexDirection="row" gap={1} padding={1}>
				{AGENT_IDENTITY_MODE_ORDER.map((mode, index) => {
					const option = AGENT_IDENTITY_MODE_OPTIONS[mode];
					const isSelected = mode === selected;
					const color = isSelected
						? theme.colors.primary
						: theme.colors.foreground;
					return (
						<box
							alignItems="center"
							border
							borderColor={
								isSelected ? theme.colors.primary : theme.colors.border
							}
							borderStyle={isSelected ? "double" : "rounded"}
							flexBasis={0}
							flexDirection="column"
							flexGrow={1}
							key={mode}
							paddingLeft={1}
							paddingRight={1}
						>
							<text fg={color}>{option.glyph}</text>
							<text fg={color}>
								<b>{`${isSelected ? "● " : "○ "}${option.title}`}</b>
							</text>
							<text fg={theme.colors.mutedForeground}>{option.summary}</text>
							<text fg={theme.colors.mutedForeground}>{`${index + 1}`}</text>
						</box>
					);
				})}
			</box>
			{detail ? (
				<box paddingLeft={1} paddingRight={1}>
					<text fg={theme.colors.mutedForeground}>{detail}</text>
				</box>
			) : null}
		</box>
	);
}

/** One line of the account-access panel: a heading, a note, or a row. */
type AccessPanelLine =
	| { kind: "heading"; text: string }
	| { kind: "note"; text: string }
	| { index: number; kind: "row"; row: AvailableAccount };

/** The panel's lines: each section's heading, its rows, and why it is empty. */
export function accessPanelLines(
	accounts: AvailableAccounts | null,
	rows: readonly AvailableAccount[]
): AccessPanelLine[] {
	const lines: AccessPanelLine[] = [];
	const indexOf = new Map(rows.map((row, index) => [row.key, index]));
	let owner: string | null = null;
	for (const entry of accounts?.sections ?? []) {
		if (entry.owner !== owner) {
			owner = entry.owner;
			lines.push({
				kind: "heading",
				text: ACCOUNT_OWNER_HEADINGS[entry.owner],
			});
		}
		// One line for a section with nothing to tick; a section whose single
		// row carries its name (Treg, Control of your desktop) has no title.
		const notice =
			entry.error ?? (entry.rows.length === 0 ? entry.empty : null);
		if (entry.rows.length === 0 || entry.error) {
			lines.push({
				kind: "note",
				text: notice ? `${entry.title}: ${notice}` : entry.title,
			});
		} else if (entry.rows[0]?.title !== entry.title) {
			lines.push({ kind: "note", text: entry.title });
		}
		for (const row of entry.rows) {
			const index = indexOf.get(row.key);
			if (index !== undefined) {
				lines.push({ index, kind: "row", row });
			}
		}
	}
	for (const hidden of accounts?.hiddenGroups ?? []) {
		lines.push({ kind: "note", text: hidden });
	}
	const kept = rows
		.map((row, index) => ({ index, row }))
		.filter(({ row }) => row.section === "not-listed");
	if (kept.length > 0) {
		lines.push({
			kind: "heading",
			text: accounts ? "Allowed but not listed now" : "Allowed",
		});
		for (const { index, row } of kept) {
			lines.push({ index, kind: "row", row });
		}
	}
	return lines;
}

export function AgentAccountAccessPanel({
	accountAccess,
	accounts,
	addError,
	addText,
	adding,
	focusedIndex,
	identityMode,
	locked,
	onAddInput,
	rows,
}: {
	accountAccess: readonly string[] | null;
	/** The accounts it could be allowed; `null` while they load. */
	accounts: AvailableAccounts | null;
	addError: string | null;
	addText: string;
	adding: boolean;
	focusedIndex: number;
	identityMode: AgentIdentityMode;
	locked: boolean;
	onAddInput: (value: string) => void;
	rows: readonly AvailableAccount[];
}) {
	const theme = useTheme();
	const lines = accessPanelLines(accounts, rows);
	const focusedLine = Math.max(
		0,
		lines.findIndex(
			(line) => line.kind === "row" && line.index === focusedIndex
		)
	);
	const start = Math.max(
		0,
		Math.min(
			focusedLine - Math.floor(ACCESS_LIST_HEIGHT / 2),
			Math.max(0, lines.length - ACCESS_LIST_HEIGHT)
		)
	);
	const visible = lines.slice(start, start + ACCESS_LIST_HEIGHT);
	const rowText = (row: AvailableAccount): string => {
		const allowed =
			accountAccess === null || accountAccess.includes(row.key) ? "[x]" : "[ ]";
		const label = row.status ? `${row.title} (${row.status})` : row.title;
		if (row.section === "not-listed") {
			const unused = accountKeyUnusedReason(row.key, identityMode);
			return `${allowed} ${row.key} · ${accountKeyKind(row.key)?.label ?? "Other"}${unused ? ` · ${unused}` : ""}`;
		}
		return `${allowed} ${label} · ${row.key}`;
	};
	return (
		<box flexDirection="column" flexGrow={1}>
			<box flexDirection="column" paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.foreground}>
					<b>Account access</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					{`${accountAccessHeadline(accountAccess)} · ${AGENT_IDENTITY_MODE_OPTIONS[identityMode].title}`}
				</text>
				<text fg={theme.colors.mutedForeground}>
					{adding ? ACCESS_ADD_HINT : ACCESS_PANEL_HINT}
				</text>
			</box>
			<box flexDirection="column" gap={1} padding={1}>
				<text fg={theme.colors.mutedForeground}>
					{accountAccessNote(accountAccess, identityMode)}
				</text>
				{locked ? (
					<StatusMessage variant="error">
						This agent is locked. Unlock it before changing its account access.
					</StatusMessage>
				) : null}
				{accounts === null ? (
					<text fg={theme.colors.mutedForeground}>Loading your accounts…</text>
				) : null}
				{visible.length > 0 ? (
					<box flexDirection="column">
						{visible.map((line, offset) => {
							const lineKey = `${start + offset}`;
							if (line.kind === "heading") {
								return (
									<text fg={theme.colors.foreground} key={lineKey}>
										<b>{line.text}</b>
									</text>
								);
							}
							if (line.kind === "note") {
								return (
									<text fg={theme.colors.mutedForeground} key={lineKey}>
										{`  ${line.text}`}
									</text>
								);
							}
							const focused = line.index === focusedIndex && !adding;
							return (
								<text
									fg={focused ? theme.colors.primary : theme.colors.foreground}
									key={lineKey}
								>
									{`${focused ? "›" : " "} ${rowText(line.row)}`}
								</text>
							);
						})}
					</box>
				) : null}
				{lines.length > ACCESS_LIST_HEIGHT ? (
					<text fg={theme.colors.mutedForeground}>
						{tf("{first}–{last} of {total} lines", {
							first: String(start + 1),
							last: String(Math.min(start + ACCESS_LIST_HEIGHT, lines.length)),
							total: String(lines.length),
						})}
					</text>
				) : null}
				{adding ? (
					<box flexDirection="row" gap={1}>
						<text fg={theme.colors.primary}>› key</text>
						<box flexBasis={0} flexGrow={1}>
							<input
								cursorColor={theme.colors.primary}
								focused
								focusedTextColor={theme.colors.foreground}
								onInput={onAddInput}
								placeholder="provider:openai, composio:<id>, platform:treg…"
								placeholderColor={theme.colors.mutedForeground}
								textColor={theme.colors.foreground}
								value={addText}
							/>
						</box>
					</box>
				) : null}
				{addError ? (
					<StatusMessage variant="error">{addError}</StatusMessage>
				) : null}
				<text fg={theme.colors.mutedForeground}>
					Changes are saved with the agent (Ctrl+S in the editor).
				</text>
			</box>
		</box>
	);
}

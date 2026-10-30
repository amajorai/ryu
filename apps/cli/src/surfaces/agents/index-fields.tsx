/* @jsxImportSource @opentui/react */
import { StatusMessage } from "@/components/ui/status-message.tsx";
import { tf } from "../../i18n/translate.ts";
import { Loading } from "../../ui/Loading.tsx";
import type { SkillPickerRow, ToolPickerRow } from "./capabilities.ts";
import {
	type CatalogStatus,
	EDIT_LABEL_WIDTH,
	PageHeader,
	PICKER_HEIGHT,
	PICKER_HINT,
	type PickerKind,
	type Theme,
} from "./index-shared.tsx";

export function ToggleField({
	focused,
	label,
	value,
	theme,
}: {
	focused: boolean;
	label: string;
	theme: Theme;
	value: string;
}) {
	const enabled = value === "on";
	return (
		<box flexDirection="row" gap={1}>
			<text fg={focused ? theme.colors.primary : theme.colors.mutedForeground}>
				{`${focused ? "›" : " "} ${label.padEnd(EDIT_LABEL_WIDTH)}`}
			</text>
			<text fg={focused ? theme.colors.primary : theme.colors.foreground}>
				{enabled ? "● On   ○ Off" : "○ On   ● Off"}
			</text>
		</box>
	);
}

export function PickerField({
	action = "Enter to choose",
	focused,
	label,
	value,
	theme,
}: {
	action?: string;
	focused: boolean;
	label: string;
	theme: Theme;
	value: string;
}) {
	return (
		<box flexDirection="row" gap={1}>
			<text fg={focused ? theme.colors.primary : theme.colors.mutedForeground}>
				{`${focused ? "›" : " "} ${label.padEnd(EDIT_LABEL_WIDTH)}`}
			</text>
			<text fg={focused ? theme.colors.primary : theme.colors.foreground}>
				{`${action} · ${value}`}
			</text>
		</box>
	);
}

export function AgentCapabilityPicker({
	error,
	focusedIndex,
	kind,
	notice,
	rows,
	selected,
	status,
	summary,
	theme,
}: {
	error: string | null;
	focusedIndex: number;
	kind: PickerKind;
	notice: string;
	rows: Array<ToolPickerRow | SkillPickerRow>;
	selected: ReadonlySet<string>;
	status: CatalogStatus;
	summary: string;
	theme: Theme;
}) {
	const title = kind === "tools" ? "Agent tools" : "Agent skills";
	const noun = kind === "tools" ? "tools" : "skills";
	const start = Math.max(
		0,
		Math.min(
			focusedIndex - Math.floor(PICKER_HEIGHT / 2),
			Math.max(0, rows.length - PICKER_HEIGHT)
		)
	);
	const visible = rows.slice(start, start + PICKER_HEIGHT);

	return (
		<box flexDirection="column" flexGrow={1}>
			<PageHeader
				hint={PICKER_HINT}
				subtitle={tf("{summary} · {count} listed", {
					count: String(rows.length),
					summary,
				})}
				title={title}
			/>
			<box flexDirection="column" gap={1} padding={1}>
				{status === "loading" && rows.length === 0 ? (
					<Loading label={tf("Loading {noun}…", { noun })} />
				) : null}
				{error ? (
					<StatusMessage variant="error">
						{rows.length > 0
							? tf(
									"Catalog refresh failed: {error}. Showing saved/current rows; press r to retry.",
									{ error }
								)
							: tf("Couldn't load {noun}: {error}. Press r to retry.", {
									error,
									noun,
								})}
					</StatusMessage>
				) : null}
				{status === "ready" && rows.length === 0 ? (
					<text fg={theme.colors.mutedForeground}>
						{kind === "tools"
							? "No registered MCP tools are available."
							: "No installed skills are available."}
					</text>
				) : null}
				<text fg={theme.colors.mutedForeground}>{notice}</text>
				{visible.map((row, index) => {
					const focused = start + index === focusedIndex;
					return (
						<text
							fg={focused ? theme.colors.primary : theme.colors.foreground}
							key={row.id}
						>
							{`${focused ? "›" : " "} ${selected.has(row.id) ? "[x]" : "[ ]"} ${row.label}`}
						</text>
					);
				})}
				{rows.length > PICKER_HEIGHT ? (
					<text fg={theme.colors.mutedForeground}>
						{`${start + 1}–${Math.min(start + PICKER_HEIGHT, rows.length)} of ${rows.length}`}
					</text>
				) : null}
			</box>
		</box>
	);
}

export function EditField({
	label,
	value,
	onChange,
	placeholder,
	focused,
	theme,
}: {
	focused: boolean;
	label: string;
	onChange: (v: string) => void;
	placeholder: string;
	theme: Theme;
	value: string;
}) {
	return (
		<box flexDirection="row" gap={1}>
			<text fg={focused ? theme.colors.primary : theme.colors.mutedForeground}>
				{`${focused ? "›" : " "} ${label.padEnd(EDIT_LABEL_WIDTH)}`}
			</text>
			<box flexBasis={0} flexGrow={1}>
				<input
					cursorColor={theme.colors.primary}
					focused={focused}
					focusedTextColor={theme.colors.foreground}
					onInput={onChange}
					placeholder={placeholder}
					placeholderColor={theme.colors.mutedForeground}
					textColor={theme.colors.foreground}
					value={value}
				/>
			</box>
		</box>
	);
}

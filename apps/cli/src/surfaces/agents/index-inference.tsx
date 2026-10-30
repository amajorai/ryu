/* @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";
import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { tf } from "../../i18n/translate.ts";
import {
	editorText,
	type JsonObject,
	parseEdit,
	type SamplingField,
	valueLabel,
	withFieldValue,
} from "../../overlays/settings/inference.tsx";
import { EDIT_BACK_HINT, PageHeader } from "./index-shared.tsx";

export function AgentInferenceEditor({
	engineName,
	error,
	fields,
	focused,
	onBack,
	onChange,
	onSave,
	saving,
	value,
}: {
	engineName: string;
	error: string | null;
	fields: readonly SamplingField[];
	focused: boolean;
	onBack: () => void;
	onChange: (next: JsonObject) => void;
	onSave: () => void;
	saving: boolean;
	value: JsonObject;
}) {
	const theme = useTheme();
	const [draft, setDraft] = useState<JsonObject>(value);
	const [fieldIndex, setFieldIndex] = useState(0);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [editError, setEditError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const selectedField = fields[Math.min(fieldIndex, fields.length - 1)];

	const beginEdit = useCallback(() => {
		if (!(selectedField && !saving)) {
			return;
		}
		setEditText(editorText(selectedField, draft[selectedField.key]));
		setEditError(null);
		setNotice(null);
		setEditing(true);
	}, [draft, saving, selectedField]);

	const finishEdit = useCallback(() => {
		if (!selectedField) {
			return;
		}
		const parsed = parseEdit(selectedField, editText);
		if (parsed.error) {
			setEditError(parsed.error);
			return;
		}
		const next = withFieldValue(draft, selectedField.key, parsed.value);
		setDraft(next);
		onChange(next);
		setEditing(false);
		setEditError(null);
		setNotice(
			tf("{label} updated in the agent draft.", { label: selectedField.label })
		);
	}, [draft, editText, onChange, selectedField]);

	const cancelEdit = useCallback(() => {
		setEditing(false);
		setEditError(null);
		setNotice("Edit cancelled.");
	}, []);

	const clearSelected = useCallback(() => {
		if (!selectedField || editing || saving) {
			return;
		}
		const next = withFieldValue(draft, selectedField.key, undefined);
		setDraft(next);
		onChange(next);
		setEditError(null);
		setNotice(
			tf("{label} cleared to use its default.", { label: selectedField.label })
		);
	}, [draft, editing, onChange, saving, selectedField]);

	useKeyboard((key) => {
		if (!focused) {
			return;
		}
		if (editing) {
			if (key.name === "return") {
				finishEdit();
			} else if (key.name === "tab") {
				cancelEdit();
			}
			return;
		}
		if (key.name === "escape") {
			onBack();
			return;
		}
		if (key.ctrl && key.name === "s") {
			if (!(saving || editError)) {
				onSave();
			}
			return;
		}
		if (saving) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setFieldIndex((current) => Math.max(0, current - 1));
		} else if (key.name === "down" || key.name === "j") {
			setFieldIndex((current) => Math.min(fields.length - 1, current + 1));
		} else if (key.name === "e" || key.name === "return") {
			beginEdit();
		} else if (key.name === "x" || key.name === "delete") {
			clearSelected();
		}
	});

	return (
		<box flexDirection="column" flexGrow={1}>
			<PageHeader
				hint={tf(
					"↑↓ / j k fields · e / Enter edit · x clear · ^S save agent · {backHint}",
					{ backHint: EDIT_BACK_HINT }
				)}
				subtitle={tf("Per-agent defaults · {engine}", {
					engine: engineName || "engine default",
				})}
				title="Advanced inference"
			/>
			<box flexDirection="column" gap={1} padding={1}>
				<text fg={theme.colors.mutedForeground}>
					Agent values are fallbacks: engine defaults override matching fields,
					and request values override both. Blank fields use engine defaults.
				</text>
				{selectedField ? (
					<box flexDirection="column" gap={1}>
						<text fg={theme.colors.mutedForeground}>
							{selectedField.group} · {selectedField.label} ({fieldIndex + 1}/
							{fields.length})
						</text>
						{editing ? (
							<input
								focused={focused}
								onInput={setEditText}
								placeholder={
									selectedField.kind === "number"
										? "number; blank uses engine default"
										: "value; blank clears"
								}
								value={editText}
							/>
						) : (
							<text fg={theme.colors.foreground}>
								{valueLabel(draft[selectedField.key])}
							</text>
						)}
						{selectedField.hint ? (
							<text fg={theme.colors.mutedForeground}>
								{selectedField.hint}
							</text>
						) : null}
						{editError ? (
							<StatusMessage variant="error">{editError}</StatusMessage>
						) : null}
						{notice ? <text fg={theme.colors.success}>{notice}</text> : null}
					</box>
				) : null}
				{error ? <StatusMessage variant="error">{error}</StatusMessage> : null}
				{saving ? (
					<StatusMessage variant="loading">saving agent…</StatusMessage>
				) : null}
			</box>
		</box>
	);
}

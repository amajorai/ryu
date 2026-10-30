/* @jsxImportSource @opentui/react */

import type { Engine } from "@ryuhq/core-client/engines";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { tf } from "../../i18n/translate.ts";
import { type JsonObject, valueLabel } from "./inference-config.ts";
import type { SamplingField } from "./inference-fields.ts";

export interface InferenceSettingsViewProps {
	applyEditorText: (value: string) => void;
	currentDraft: JsonObject;
	currentError: string | null;
	currentLoading: boolean;
	currentSaveError: string | null;
	currentSaving: boolean;
	editError: string | null;
	editing: boolean;
	editText: string;
	engineError: string | null;
	engineIndex: number;
	engineLoading: boolean;
	engines: Engine[];
	fields: readonly SamplingField[];
	launchFields: readonly SamplingField[];
	notice: string | null;
	section: "sampling" | "launch";
	selectedEngine: Engine | null;
	selectedField: SamplingField | undefined;
	selectedFieldIndex: number;
}

/** Card rendering for {@link InferenceSettingsPanel}'s engine-wide editor. */
export function InferenceSettingsView({
	applyEditorText,
	currentDraft,
	currentError,
	currentLoading,
	currentSaveError,
	currentSaving,
	editError,
	editing,
	editText,
	engineError,
	engineIndex,
	engineLoading,
	engines,
	fields,
	launchFields,
	notice,
	section,
	selectedEngine,
	selectedField,
	selectedFieldIndex,
}: InferenceSettingsViewProps) {
	const theme = useTheme();
	return (
		<Card
			subtitle={
				section === "launch"
					? "Engine-wide launch defaults from Core"
					: "Engine-wide chat sampling defaults from Core"
			}
			title="Advanced inference"
		>
			{engineLoading ? (
				<text fg={theme.colors.mutedForeground}>Loading Core engines…</text>
			) : null}
			{engineError ? (
				<text fg={theme.colors.error}>
					{tf("Could not load engines: {error} · press r to retry", {
						error: engineError,
					})}
				</text>
			) : null}
			{!(engineLoading || engineError) && engines.length === 0 ? (
				<text fg={theme.colors.mutedForeground}>Core returned no engines.</text>
			) : null}
			{selectedEngine ? (
				<box flexDirection="column" gap={1}>
					<box flexDirection="row" gap={1}>
						<text fg={theme.colors.mutedForeground}>Engine</text>
						<text fg={theme.colors.primary}>
							<b>{selectedEngine.name}</b>
						</text>
						<text fg={theme.colors.mutedForeground}>
							{tf("({position}/{total}) · ←/→ change", {
								position: engineIndex + 1,
								total: engines.length,
							})}
						</text>
						<text fg={theme.colors.mutedForeground}>
							{tf(
								"· Tab: {section, select, sampling {launch} other {sampling}}",
								{
									section,
								}
							)}
						</text>
					</box>
					{section === "launch" && launchFields.length === 0 ? (
						<box flexDirection="column" gap={1}>
							<text fg={theme.colors.mutedForeground}>
								{tf(
									"Ryu does not own this engine's model-launch process. Configure model loading and hardware in its runtime; this panel will not read or write launch preferences for {name}.",
									{ name: selectedEngine.name }
								)}
							</text>
							<text fg={theme.colors.mutedForeground}>
								Per-model launch overrides have no editor in the CLI or Desktop
								yet.
							</text>
						</box>
					) : null}
					{currentLoading ? (
						<text fg={theme.colors.mutedForeground}>
							{tf(
								"Loading {section, select, launch {launch} other {sampling}} defaults…",
								{ section }
							)}
						</text>
					) : null}
					{currentError ? (
						<text fg={theme.colors.error}>
							{tf(
								"Could not load {section, select, launch {launch} other {sampling}} defaults: {error} · press r to retry",
								{ error: currentError, section }
							)}
						</text>
					) : null}
					{section === "launch" && launchFields.length > 0 ? (
						<text fg={theme.colors.mutedForeground}>
							Engine-wide values apply on the next engine start. Per-model
							values override matching defaults; extra arguments append
							engine-first.
						</text>
					) : null}
					{!(currentLoading || currentError) && selectedField ? (
						<box flexDirection="column" gap={1}>
							<text fg={theme.colors.mutedForeground}>
								{selectedField.group} · {selectedField.label} (
								{Math.min(selectedFieldIndex, fields.length - 1) + 1}/
								{fields.length})
							</text>
							{editing ? (
								<box flexDirection="column" gap={1}>
									<input
										focused
										onInput={applyEditorText}
										placeholder={
											selectedField.kind === "number"
												? "number; blank uses engine default"
												: "value; blank clears"
										}
										value={editText}
									/>
									<text fg={theme.colors.mutedForeground}>
										Enter applies this field · Tab cancels
									</text>
								</box>
							) : (
								<text fg={theme.colors.foreground}>
									{valueLabel(currentDraft[selectedField.key])}
								</text>
							)}
							{selectedField.hint ? (
								<text fg={theme.colors.mutedForeground}>
									{selectedField.hint}
								</text>
							) : null}
							{editError ? (
								<text fg={theme.colors.error}>{editError}</text>
							) : null}
						</box>
					) : null}
					{currentSaveError ? (
						<text fg={theme.colors.error}>
							{tf(
								"Could not save {section, select, launch {launch} other {sampling}} defaults: {error} · press s to retry",
								{ error: currentSaveError, section }
							)}
						</text>
					) : null}
					{notice ? <text fg={theme.colors.success}>{notice}</text> : null}
					{currentSaving ? (
						<text fg={theme.colors.mutedForeground}>
							{tf(
								"Saving {section, select, launch {launch} other {sampling}} defaults…",
								{ section }
							)}
						</text>
					) : null}
				</box>
			) : null}
		</Card>
	);
}

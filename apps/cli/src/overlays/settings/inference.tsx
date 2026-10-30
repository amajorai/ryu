/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { request } from "@ryuhq/core-client/client";
import { type Engine, fetchEngines } from "@ryuhq/core-client/engines";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCore } from "../../core/CoreContext.tsx";
import { tf } from "../../i18n/translate.ts";
import {
	editorText,
	errorText,
	type InferenceValue,
	type JsonObject,
	launchPreferenceKey,
	parseEdit,
	preferenceKey,
	readLaunchPreference,
	readSamplingPreference,
	withFieldValue,
} from "./inference-config.ts";
import { fieldsForEngine, launchFieldsForEngine } from "./inference-fields.ts";
import { InferenceSettingsView } from "./inference-view.tsx";

export {
	editorText,
	inferenceConfigurationSchema,
	type JsonObject,
	type ParsedEdit,
	parseEdit,
	valueLabel,
	withFieldValue,
} from "./inference-config.ts";
export { fieldsForEngine, type SamplingField } from "./inference-fields.ts";

/** Core-backed engine-wide inference defaults matching Desktop's editor. */
export function InferenceSettingsPanel({
	active,
	onNavigationOwnershipChange,
}: {
	active: boolean;
	onNavigationOwnershipChange: (owned: boolean) => void;
}) {
	const { target } = useCore();
	const [engines, setEngines] = useState<Engine[]>([]);
	const [engineIndex, setEngineIndex] = useState(0);
	const [engineLoading, setEngineLoading] = useState(false);
	const [engineError, setEngineError] = useState<string | null>(null);
	const [section, setSection] = useState<"sampling" | "launch">("sampling");
	const [configLoading, setConfigLoading] = useState(false);
	const [configError, setConfigError] = useState<string | null>(null);
	const [draft, setDraft] = useState<JsonObject>({});
	const [launchConfigLoading, setLaunchConfigLoading] = useState(false);
	const [launchConfigError, setLaunchConfigError] = useState<string | null>(
		null
	);
	const [launchDraft, setLaunchDraft] = useState<JsonObject>({});
	const [selectedFieldIndex, setSelectedFieldIndex] = useState(0);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [editError, setEditError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [launchSaving, setLaunchSaving] = useState(false);
	const [launchSaveError, setLaunchSaveError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const engineRequestRef = useRef(0);
	const configRequestRef = useRef(0);
	const launchConfigRequestRef = useRef(0);
	const editOriginalRef = useRef<{ key: string; value: InferenceValue } | null>(
		null
	);

	const selectedEngine = engines[engineIndex] ?? null;
	const samplingFields = useMemo(
		() => fieldsForEngine(selectedEngine?.name ?? ""),
		[selectedEngine?.name]
	);
	const launchFields = useMemo(
		() => launchFieldsForEngine(selectedEngine?.name ?? ""),
		[selectedEngine?.name]
	);
	const fields = section === "launch" ? launchFields : samplingFields;
	const currentDraft = section === "launch" ? launchDraft : draft;
	const currentLoading =
		section === "launch" ? launchConfigLoading : configLoading;
	const currentError = section === "launch" ? launchConfigError : configError;
	const currentSaving = section === "launch" ? launchSaving : saving;
	const currentSaveError = section === "launch" ? launchSaveError : saveError;
	const setCurrentDraft = section === "launch" ? setLaunchDraft : setDraft;
	const setCurrentSaveError =
		section === "launch" ? setLaunchSaveError : setSaveError;
	const setCurrentSaving = section === "launch" ? setLaunchSaving : setSaving;
	const selectedField = fields[Math.min(selectedFieldIndex, fields.length - 1)];

	const loadEngines = useCallback(async () => {
		const requestId = ++engineRequestRef.current;
		setEngineLoading(true);
		setEngineError(null);
		try {
			const nextEngines = await fetchEngines(target);
			if (engineRequestRef.current !== requestId) {
				return;
			}
			setEngines(nextEngines);
			setEngineIndex((current) =>
				Math.min(current, Math.max(0, nextEngines.length - 1))
			);
		} catch (error) {
			if (engineRequestRef.current === requestId) {
				setEngineError(errorText(error));
			}
		} finally {
			if (engineRequestRef.current === requestId) {
				setEngineLoading(false);
			}
		}
	}, [target]);

	const loadConfig = useCallback(
		async (engineName: string) => {
			const requestId = ++configRequestRef.current;
			setConfigLoading(true);
			setConfigError(null);
			setSaveError(null);
			setNotice(null);
			try {
				const config = await readSamplingPreference(target, engineName);
				if (configRequestRef.current === requestId) {
					setDraft(config);
					setSelectedFieldIndex(0);
				}
			} catch (error) {
				if (configRequestRef.current === requestId) {
					setConfigError(errorText(error));
				}
			} finally {
				if (configRequestRef.current === requestId) {
					setConfigLoading(false);
				}
			}
		},
		[target]
	);

	const loadLaunchConfig = useCallback(
		async (engineName: string) => {
			const requestId = ++launchConfigRequestRef.current;
			setLaunchConfigLoading(true);
			setLaunchConfigError(null);
			setLaunchSaveError(null);
			setNotice(null);
			try {
				const config = await readLaunchPreference(target, engineName);
				if (launchConfigRequestRef.current === requestId) {
					setLaunchDraft(config);
					setSelectedFieldIndex(0);
				}
			} catch (error) {
				if (launchConfigRequestRef.current === requestId) {
					setLaunchConfigError(errorText(error));
				}
			} finally {
				if (launchConfigRequestRef.current === requestId) {
					setLaunchConfigLoading(false);
				}
			}
		},
		[target]
	);

	useEffect(() => {
		if (!active) {
			return;
		}
		onNavigationOwnershipChange(true);
		void loadEngines();
		return () => {
			engineRequestRef.current++;
			configRequestRef.current++;
			launchConfigRequestRef.current++;
			onNavigationOwnershipChange(false);
		};
	}, [active, loadEngines, onNavigationOwnershipChange]);

	useEffect(() => {
		if (!(active && selectedEngine)) {
			return;
		}
		if (section === "sampling") {
			void loadConfig(selectedEngine.name);
			return;
		}
		if (launchFieldsForEngine(selectedEngine.name).length > 0) {
			void loadLaunchConfig(selectedEngine.name);
		} else {
			launchConfigRequestRef.current++;
			setLaunchConfigLoading(false);
			setLaunchConfigError(null);
			setLaunchSaveError(null);
			setLaunchDraft({});
		}
	}, [active, loadConfig, loadLaunchConfig, section, selectedEngine?.name]);

	const beginEdit = useCallback(() => {
		if (
			!(selectedField && selectedEngine) ||
			currentLoading ||
			currentError ||
			currentSaving
		) {
			return;
		}
		editOriginalRef.current = {
			key: selectedField.key,
			value: currentDraft[selectedField.key],
		};
		setEditText(editorText(selectedField, currentDraft[selectedField.key]));
		setEditError(null);
		setCurrentSaveError(null);
		setNotice(null);
		setEditing(true);
	}, [
		currentDraft,
		currentError,
		currentLoading,
		currentSaving,
		selectedEngine,
		selectedField,
		setCurrentSaveError,
	]);

	const applyEditorText = useCallback(
		(value: string) => {
			setEditText(value);
			if (!selectedField) {
				return;
			}
			const parsed = parseEdit(selectedField, value);
			setEditError(parsed.error);
			if (!parsed.error) {
				setCurrentDraft((current) =>
					withFieldValue(current, selectedField.key, parsed.value)
				);
			}
		},
		[section, selectedField, setCurrentDraft]
	);

	const finishEdit = useCallback(() => {
		if (!selectedField) {
			return;
		}
		const parsed = parseEdit(selectedField, editText);
		if (parsed.error) {
			setEditError(parsed.error);
			return;
		}
		setCurrentDraft((current) =>
			withFieldValue(current, selectedField.key, parsed.value)
		);
		setEditing(false);
		setEditError(null);
		setNotice(tf("{label} updated in draft.", { label: selectedField.label }));
	}, [editText, selectedField, setCurrentDraft]);

	const cancelEdit = useCallback(() => {
		const original = editOriginalRef.current;
		if (original) {
			setCurrentDraft((current) =>
				withFieldValue(current, original.key, original.value)
			);
		}
		setEditing(false);
		setEditError(null);
		setNotice("Edit cancelled.");
	}, [setCurrentDraft]);

	const save = useCallback(async () => {
		if (
			!selectedEngine ||
			currentSaving ||
			currentLoading ||
			currentError ||
			editing ||
			editError ||
			fields.length === 0
		) {
			return;
		}
		setCurrentSaving(true);
		setCurrentSaveError(null);
		setNotice(null);
		try {
			const key =
				section === "launch"
					? launchPreferenceKey(selectedEngine.name)
					: preferenceKey(selectedEngine.name);
			await request(
				target,
				`/api/preferences/${encodeURIComponent(key)}`,
				{
					method: "PUT",
					body: { value: JSON.stringify(currentDraft) },
				},
				appResponseValueSchema
			);
			try {
				const readback =
					section === "launch"
						? await readLaunchPreference(target, selectedEngine.name)
						: await readSamplingPreference(target, selectedEngine.name);
				setCurrentDraft(readback);
				setNotice("Saved and confirmed from Core.");
			} catch (readbackError) {
				setNotice(
					tf("Saved; Core readback failed: {error}", {
						error: errorText(readbackError),
					})
				);
			}
		} catch (error) {
			setCurrentSaveError(errorText(error));
		} finally {
			setCurrentSaving(false);
		}
	}, [
		currentDraft,
		currentError,
		currentLoading,
		currentSaving,
		editError,
		editing,
		fields.length,
		section,
		selectedEngine,
		setCurrentDraft,
		setCurrentSaveError,
		setCurrentSaving,
		target,
	]);

	const clearSelected = useCallback(() => {
		if (
			!selectedField ||
			editing ||
			currentSaving ||
			currentLoading ||
			currentError
		) {
			return;
		}
		setCurrentDraft((current) =>
			withFieldValue(current, selectedField.key, undefined)
		);
		setCurrentSaveError(null);
		setNotice(tf("{label} cleared in draft.", { label: selectedField.label }));
	}, [
		currentLoading,
		currentError,
		currentSaving,
		editing,
		selectedField,
		setCurrentDraft,
		setCurrentSaveError,
	]);

	useKeyboard((key) => {
		if (!active) {
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
		if (key.name === "tab") {
			setSection((current) => (current === "sampling" ? "launch" : "sampling"));
			setSelectedFieldIndex(0);
			setNotice(null);
			return;
		}
		if (engineLoading || currentLoading || currentSaving) {
			return;
		}
		if (engineError || !selectedEngine) {
			if (key.name === "r") {
				void loadEngines();
			}
			return;
		}
		if (key.name === "left" || key.name === "h") {
			setEngineIndex((index) => (index - 1 + engines.length) % engines.length);
			setSelectedFieldIndex(0);
			setNotice(null);
		} else if (key.name === "right" || key.name === "l") {
			setEngineIndex((index) => (index + 1) % engines.length);
			setSelectedFieldIndex(0);
			setNotice(null);
		} else if (key.name === "up" || key.name === "k") {
			setSelectedFieldIndex((index) => Math.max(0, index - 1));
		} else if (key.name === "down" || key.name === "j") {
			setSelectedFieldIndex((index) => Math.min(fields.length - 1, index + 1));
		} else if (key.name === "e" || key.name === "return") {
			beginEdit();
		} else if (key.name === "x" || key.name === "delete") {
			clearSelected();
		} else if (key.name === "s") {
			void save();
		} else if (key.name === "r") {
			if (section === "launch") {
				void loadLaunchConfig(selectedEngine.name);
			} else {
				void loadConfig(selectedEngine.name);
			}
		}
	});

	return (
		<InferenceSettingsView
			applyEditorText={applyEditorText}
			currentDraft={currentDraft}
			currentError={currentError}
			currentLoading={currentLoading}
			currentSaveError={currentSaveError}
			currentSaving={currentSaving}
			editError={editError}
			editing={editing}
			editText={editText}
			engineError={engineError}
			engineIndex={engineIndex}
			engineLoading={engineLoading}
			engines={engines}
			fields={fields}
			launchFields={launchFields}
			notice={notice}
			section={section}
			selectedEngine={selectedEngine}
			selectedField={selectedField}
			selectedFieldIndex={selectedFieldIndex}
		/>
	);
}

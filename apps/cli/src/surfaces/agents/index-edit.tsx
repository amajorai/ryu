/* @jsxImportSource @opentui/react */
import {
	type Agent,
	type AgentIdentityMode,
	fetchAgent,
} from "@ryuhq/core-client/agents";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import {
	AGENT_IDENTITY_MODE_OPTIONS,
	accountAccessHeadline,
	isRemotePeerEngine,
	REMOTE_PEER_IDENTITY_NOTE,
} from "../../core/agentIdentity.ts";
import { useCore } from "../../core/CoreContext.tsx";
import {
	useSetInputFocused,
	useShellKeyboardCaptured,
} from "../../core/InputFocusContext.tsx";
import { tf } from "../../i18n/translate.ts";
import { useOverlay } from "../../overlays/OverlayHost.tsx";
import {
	fieldsForEngine,
	inferenceConfigurationSchema,
	type JsonObject,
} from "../../overlays/settings/inference.tsx";
import { Loading } from "../../ui/Loading.tsx";
import { useToast } from "../../ui/toast.tsx";
import { NO_AGENT_CAPABILITIES } from "./capabilities.ts";
import { AgentAccountAccessPanel, AgentIdentityStep } from "./identity.tsx";
import { useAgentAccessPanel } from "./index-edit-access.ts";
import { useAgentCapabilityCatalogs } from "./index-edit-catalogs.ts";
import { AGENT_EDIT_FIELDS } from "./index-edit-fields.ts";
import { AgentEditForm } from "./index-edit-form.tsx";
import { useAgentEditKeyboard } from "./index-edit-keyboard.ts";
import { useAgentSave } from "./index-edit-save.ts";
import { AgentCapabilityPicker } from "./index-fields.tsx";
import { AgentInferenceEditor } from "./index-inference.tsx";
import {
	errText,
	type FieldDef,
	type FieldKey,
	type PickerKind,
} from "./index-shared.tsx";

// ── Edit view (the /agents/:id/edit route) ───────────────────────────────────

export function AgentEditView({
	agentId,
	focused,
	onClose,
}: {
	agentId: string;
	focused: boolean;
	onClose: () => void;
}) {
	const { target, url, token } = useCore();
	const theme = useTheme();
	const { notify } = useToast();
	const shellKeyboardCaptured = useShellKeyboardCaptured();
	const { openId: externalOverlayId } = useOverlay();
	const setInputFocused = useSetInputFocused();

	const isNew = agentId === "new";

	const [existing, setExisting] = useState<Agent | null>(null);
	const [name, setName] = useState("");
	const [title, setTitle] = useState("");
	const [engine, setEngine] = useState("");
	const [model, setModel] = useState("");
	const [description, setDescription] = useState("");
	const [systemPrompt, setSystemPrompt] = useState("");
	const [personaDisplayName, setPersonaDisplayName] = useState("");
	const [personaTone, setPersonaTone] = useState("");
	const [orchestrator, setOrchestrator] = useState<boolean | null>(null);
	const [canCreateAgents, setCanCreateAgents] = useState<boolean | null>(null);
	const [toolAllowlist, setToolAllowlist] = useState<string[]>(() =>
		isNew ? [NO_AGENT_CAPABILITIES] : []
	);
	const [skillAllowlist, setSkillAllowlist] = useState<string[]>([]);
	const [pickerKind, setPickerKind] = useState<PickerKind | null>(null);
	const [pickerIndex, setPickerIndex] = useState(0);
	const [sampling, setSampling] = useState<JsonObject>({});
	const [samplingTouched, setSamplingTouched] = useState(false);
	const [samplingPanelOpen, setSamplingPanelOpen] = useState(false);
	const [fieldIndex, setFieldIndex] = useState(0);
	const [loading, setLoading] = useState(!isNew);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// How the agent works. A new agent opens on the identity step with "Acts as
	// you" preselected, like the desktop New agent dialog; it is always sent on
	// create, and on update only when it changed, so saving other fields never
	// rewrites a mode read from Core.
	const [identityMode, setIdentityMode] =
		useState<AgentIdentityMode>("managed");
	const [identityStepOpen, setIdentityStepOpen] = useState(isNew);
	const [identityConfirmed, setIdentityConfirmed] = useState(!isNew);
	const [identityDraft, setIdentityDraft] =
		useState<AgentIdentityMode>("managed");
	// `null` = no limit; `[]` = no accounts. Sent only once edited here.
	const [accountAccess, setAccountAccess] = useState<string[] | null>(null);
	const [accountAccessTouched, setAccountAccessTouched] = useState(false);

	const savingRef = useRef(false);
	savingRef.current = saving;

	const fields: FieldDef[] = AGENT_EDIT_FIELDS;

	const loadRecord = useCallback(() => {
		if (isNew) {
			return;
		}
		setLoading(true);
		setError(null);
		fetchAgent(target, agentId)
			.then((record) => {
				setExisting(record);
				setName(record.name);
				setTitle(record.title ?? "");
				setEngine(record.engine ?? "");
				setModel(record.model ?? "");
				setDescription(record.description ?? "");
				setSystemPrompt(record.systemPrompt ?? "");
				setPersonaDisplayName(record.persona?.display_name ?? "");
				setPersonaTone(record.persona?.tone ?? "");
				setOrchestrator(record.orchestrator);
				setCanCreateAgents(record.canCreateAgents);
				setSampling(inferenceConfigurationSchema.parse(record.inference ?? {}));
				setSamplingTouched(false);
				setToolAllowlist(record.tools);
				setSkillAllowlist(record.skills);
				setIdentityMode(record.identityMode);
				setAccountAccess(record.accountAccess);
				setAccountAccessTouched(false);
			})
			.catch((err) => setError(errText(err)))
			.finally(() => setLoading(false));
	}, [target, agentId, isNew]);

	const {
		loadSkillCatalog,
		loadToolCatalog,
		selectedSkills,
		selectedTools,
		skillCatalog,
		skillRows,
		toggleSkill,
		toggleTool,
		toolCatalog,
		toolRows,
	} = useAgentCapabilityCatalogs({
		setSkillAllowlist,
		setToolAllowlist,
		skillAllowlist,
		target,
		token,
		toolAllowlist,
		url,
	});

	// Load on focus; reload on node switch (url/token primitives).
	useEffect(() => {
		if (focused) {
			loadRecord();
		}
	}, [focused, loadRecord]);

	// Own raw input while focused so the shell's plain-key globals stay quiet.
	useEffect(() => {
		setInputFocused(focused);
		return () => setInputFocused(false);
	}, [focused, setInputFocused]);

	const toolSummary =
		toolAllowlist.length === 0 || toolAllowlist.includes("*")
			? "all Core tools"
			: toolAllowlist.includes(NO_AGENT_CAPABILITIES)
				? "none"
				: `${toolAllowlist.length} grant${toolAllowlist.length === 1 ? "" : "s"}`;
	const skillSummary =
		skillAllowlist.length === 0
			? "all enabled skills"
			: skillAllowlist.includes(NO_AGENT_CAPABILITIES)
				? "none"
				: `${skillAllowlist.length} skill${skillAllowlist.length === 1 ? "" : "s"}`;
	const toolPickerNotice =
		toolAllowlist.length === 0 || toolAllowlist.includes("*")
			? "Changing this Core-wide grant narrows access to the listed MCP tools."
			: "Other saved grants remain visible as unavailable rows.";
	const samplingSummary =
		Object.keys(sampling).length === 0
			? "engine defaults"
			: tf(
					"{count, plural, one {# sampling override} other {# sampling overrides}}",
					{ count: Object.keys(sampling).length }
				);
	const samplingEngine = existing?.engine ?? engine;
	// A remote A2A peer runs on another node under that node's accounts, so
	// there is no identity or account access to choose here (as on desktop).
	const remotePeer = isRemotePeerEngine(engine);
	const samplingFields = fieldsForEngine(samplingEngine);
	const updateSampling = useCallback((next: JsonObject) => {
		setSampling(next);
		setSamplingTouched(true);
	}, []);

	const save = useAgentSave({
		accountAccess,
		accountAccessTouched,
		agentId,
		canCreateAgents,
		description,
		engine,
		existing,
		identityMode,
		isNew,
		model,
		name,
		notify,
		onClose,
		orchestrator,
		personaDisplayName,
		personaTone,
		sampling,
		samplingTouched,
		savingRef,
		setError,
		setSaving,
		skillAllowlist,
		systemPrompt,
		target,
		title,
		toolAllowlist,
	});

	const {
		accessAccounts,
		accessAddText,
		accessAdding,
		accessError,
		accessIndex,
		accessPanelOpen,
		accessRows,
		handleAccessPanelKey,
		loadAccessAccounts,
		setAccessAddText,
		setAccessAdding,
		setAccessError,
		setAccessIndex,
		setAccessPanelOpen,
	} = useAgentAccessPanel({
		accountAccess,
		agentId,
		engine,
		existing,
		identityMode,
		isNew,
		setAccountAccess,
		setAccountAccessTouched,
		target,
	});

	useAgentEditKeyboard({
		existing,
		externalOverlayId,
		fieldIndex,
		fields,
		focused,
		handleAccessPanelKey,
		identityConfirmed,
		identityDraft,
		identityMode,
		identityStepOpen,
		loadAccessAccounts,
		loadSkillCatalog,
		loadToolCatalog,
		onClose,
		pickerIndex,
		pickerKind,
		remotePeer,
		samplingPanelOpen,
		save,
		setAccessAdding,
		setAccessError,
		setAccessIndex,
		setAccessPanelOpen,
		setCanCreateAgents,
		setError,
		setFieldIndex,
		setIdentityConfirmed,
		setIdentityDraft,
		setIdentityMode,
		setIdentityStepOpen,
		setOrchestrator,
		setPickerIndex,
		setPickerKind,
		setSamplingPanelOpen,
		setSkillAllowlist,
		setToolAllowlist,
		shellKeyboardCaptured,
		skillCatalog,
		skillRows,
		toggleSkill,
		toggleTool,
		toolCatalog,
		toolRows,
	});

	if (loading) {
		return <Loading label="Loading agent…" />;
	}

	const valueFor = (k: FieldKey): string => {
		switch (k) {
			case "name":
				return name;
			case "title":
				return title;
			case "engine":
				return engine;
			case "model":
				return model;
			case "description":
				return description;
			case "systemPrompt":
				return systemPrompt;
			case "personaDisplayName":
				return personaDisplayName;
			case "personaTone":
				return personaTone;
			case "orchestrator":
				return (orchestrator ?? true) ? "on" : "off";
			case "canCreateAgents":
				return (canCreateAgents ?? false) ? "on" : "off";
			case "tools":
				return toolSummary;
			case "skills":
				return skillSummary;
			case "inference":
				return samplingSummary;
			case "identity":
				return remotePeer
					? REMOTE_PEER_IDENTITY_NOTE.title
					: AGENT_IDENTITY_MODE_OPTIONS[identityMode].title;
			case "accountAccess":
				return remotePeer
					? "not used on this node"
					: accountAccessHeadline(accountAccess);
		}
	};

	const setterFor = (k: FieldKey): ((v: string) => void) => {
		switch (k) {
			case "name":
				return setName;
			case "title":
				return setTitle;
			case "engine":
				return setEngine;
			case "model":
				return setModel;
			case "description":
				return setDescription;
			case "systemPrompt":
				return setSystemPrompt;
			case "personaDisplayName":
				return setPersonaDisplayName;
			case "personaTone":
				return setPersonaTone;
			case "orchestrator":
			case "canCreateAgents":
			case "tools":
			case "skills":
			case "inference":
			case "identity":
			case "accountAccess":
				return () => undefined;
		}
	};

	if (identityStepOpen) {
		return (
			<AgentIdentityStep
				selected={identityDraft}
				title={isNew ? "New agent" : name.trim() || "Edit agent"}
			/>
		);
	}
	if (accessPanelOpen) {
		return (
			<AgentAccountAccessPanel
				accountAccess={accountAccess}
				accounts={accessAccounts}
				addError={accessError}
				adding={accessAdding}
				addText={accessAddText}
				focusedIndex={accessIndex}
				identityMode={identityMode}
				locked={existing?.locked ?? false}
				onAddInput={setAccessAddText}
				rows={accessRows}
			/>
		);
	}
	if (pickerKind === "tools") {
		return (
			<AgentCapabilityPicker
				error={toolCatalog.error}
				focusedIndex={pickerIndex}
				kind="tools"
				notice={toolPickerNotice}
				rows={toolRows}
				selected={selectedTools}
				status={toolCatalog.status}
				summary={toolSummary}
				theme={theme}
			/>
		);
	}
	if (pickerKind === "skills") {
		return (
			<AgentCapabilityPicker
				error={skillCatalog.error}
				focusedIndex={pickerIndex}
				kind="skills"
				notice="Disabled skills remain inactive until enabled globally."
				rows={skillRows}
				selected={selectedSkills}
				status={skillCatalog.status}
				summary={skillSummary}
				theme={theme}
			/>
		);
	}
	if (samplingPanelOpen) {
		return (
			<AgentInferenceEditor
				engineName={samplingEngine}
				error={error}
				fields={samplingFields}
				// The editor reads plain keys; it yields to the palette, sidebar
				// focus mode and shell overlays like the agent editor itself.
				focused={focused && !shellKeyboardCaptured && !externalOverlayId}
				onBack={() => setSamplingPanelOpen(false)}
				onChange={updateSampling}
				onSave={save}
				saving={saving}
				value={sampling}
			/>
		);
	}

	return (
		<AgentEditForm
			agentId={agentId}
			error={error}
			existing={existing}
			fieldIndex={fieldIndex}
			fields={fields}
			focused={focused}
			isNew={isNew}
			name={name}
			remotePeer={remotePeer}
			samplingSummary={samplingSummary}
			saving={saving}
			setterFor={setterFor}
			theme={theme}
			valueFor={valueFor}
		/>
	);
}

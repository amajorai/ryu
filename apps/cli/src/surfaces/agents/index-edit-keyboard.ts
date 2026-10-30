import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { Agent, AgentIdentityMode } from "@ryuhq/core-client/agents";
import type { McpTool } from "@ryuhq/core-client/mcp";
import type { Dispatch, SetStateAction } from "react";
import {
	AGENT_IDENTITY_MODE_ORDER,
	stepIdentityMode,
} from "../../core/agentIdentity.ts";
import type { useOverlay } from "../../overlays/OverlayHost.tsx";
import {
	type AgentSkillOption,
	NO_AGENT_CAPABILITIES,
	type SkillPickerRow,
	type ToolPickerRow,
} from "./capabilities.ts";
import type { FieldDef, PickerCatalog, PickerKind } from "./index-shared.tsx";

type SetState<T> = Dispatch<SetStateAction<T>>;

/** The agent editor's keys: the identity step, account access, pickers, fields. */
export function useAgentEditKeyboard({
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
}: {
	existing: Agent | null;
	externalOverlayId: ReturnType<typeof useOverlay>["openId"];
	fieldIndex: number;
	fields: FieldDef[];
	focused: boolean;
	handleAccessPanelKey: (key: KeyEvent) => boolean;
	identityConfirmed: boolean;
	identityDraft: AgentIdentityMode;
	identityMode: AgentIdentityMode;
	identityStepOpen: boolean;
	loadAccessAccounts: () => void;
	loadSkillCatalog: () => void;
	loadToolCatalog: () => void;
	onClose: () => void;
	pickerIndex: number;
	pickerKind: PickerKind | null;
	remotePeer: boolean;
	samplingPanelOpen: boolean;
	save: () => void;
	setAccessAdding: SetState<boolean>;
	setAccessError: SetState<string | null>;
	setAccessIndex: SetState<number>;
	setAccessPanelOpen: SetState<boolean>;
	setCanCreateAgents: SetState<boolean | null>;
	setError: SetState<string | null>;
	setFieldIndex: SetState<number>;
	setIdentityConfirmed: SetState<boolean>;
	setIdentityDraft: SetState<AgentIdentityMode>;
	setIdentityMode: SetState<AgentIdentityMode>;
	setIdentityStepOpen: SetState<boolean>;
	setOrchestrator: SetState<boolean | null>;
	setPickerIndex: SetState<number>;
	setPickerKind: SetState<PickerKind | null>;
	setSamplingPanelOpen: SetState<boolean>;
	setSkillAllowlist: SetState<string[]>;
	setToolAllowlist: SetState<string[]>;
	shellKeyboardCaptured: boolean;
	skillCatalog: PickerCatalog<AgentSkillOption>;
	skillRows: SkillPickerRow[];
	toggleSkill: (id: string) => void;
	toggleTool: (id: string) => void;
	toolCatalog: PickerCatalog<McpTool>;
	toolRows: ToolPickerRow[];
}) {
	// Returns true when the key was handled by the identity step.
	const handleIdentityStepKey = (key: KeyEvent): boolean => {
		if (!identityStepOpen) {
			return false;
		}
		if (key.name === "escape") {
			if (identityConfirmed) {
				setIdentityStepOpen(false);
			} else {
				onClose();
			}
		} else if (key.name === "left" || key.name === "h") {
			setIdentityDraft((mode) => stepIdentityMode(mode, -1));
		} else if (key.name === "right" || key.name === "l") {
			setIdentityDraft((mode) => stepIdentityMode(mode, 1));
		} else if (key.name === "1" || key.name === "2" || key.name === "3") {
			const mode = AGENT_IDENTITY_MODE_ORDER[Number(key.name) - 1];
			if (mode) {
				setIdentityDraft(mode);
			}
		} else if (key.name === "return") {
			setIdentityMode(identityDraft);
			setIdentityConfirmed(true);
			setIdentityStepOpen(false);
		}
		return true;
	};

	useKeyboard((key: KeyEvent) => {
		if (!focused || shellKeyboardCaptured || externalOverlayId) {
			return;
		}
		if (samplingPanelOpen) {
			return;
		}
		if (handleIdentityStepKey(key) || handleAccessPanelKey(key)) {
			return;
		}
		if (pickerKind !== null) {
			if (key.name === "escape") {
				setPickerKind(null);
				return;
			}
			// Plain 0 only: Alt+0 is the shell's sidebar-focus chord.
			if (key.name === "0" && !(key.ctrl || key.meta || key.option)) {
				if (pickerKind === "tools") {
					setToolAllowlist([NO_AGENT_CAPABILITIES]);
				} else {
					setSkillAllowlist([NO_AGENT_CAPABILITIES]);
				}
				setPickerIndex(0);
				return;
			}
			if (key.name === "r") {
				if (pickerKind === "tools") {
					loadToolCatalog();
				} else {
					loadSkillCatalog();
				}
				return;
			}
			const rows = pickerKind === "tools" ? toolRows : skillRows;
			if (key.name === "up" || key.name === "k") {
				setPickerIndex((i) => Math.max(0, i - 1));
				return;
			}
			if (key.name === "down" || key.name === "j") {
				setPickerIndex((i) => Math.min(Math.max(0, rows.length - 1), i + 1));
				return;
			}
			if (key.name === "space" || key.name === "return") {
				const row = rows[pickerIndex];
				const catalogStatus =
					pickerKind === "tools" ? toolCatalog.status : skillCatalog.status;
				if (row && catalogStatus !== "loading" && catalogStatus !== "idle") {
					if (pickerKind === "tools") {
						toggleTool(row.id);
					} else {
						toggleSkill(row.id);
					}
				}
				return;
			}
			return;
		}
		// Alt chords belong to the shell: Ctrl+Alt+S splits and Alt+←/→ moves
		// between panes, so neither may save or flip a toggle here.
		const alt = key.meta || key.option;
		if (key.ctrl && !alt && key.name === "s") {
			save();
		} else if (key.name === "escape") {
			onClose();
		} else if (
			fields[fieldIndex]?.kind === "toggle" &&
			!alt &&
			(key.name === "return" || key.name === "left" || key.name === "right")
		) {
			const field = fields[fieldIndex];
			if (field?.key === "orchestrator") {
				setOrchestrator((current) => !(current ?? true));
			} else if (field?.key === "canCreateAgents") {
				setCanCreateAgents((current) => !(current ?? false));
			}
		} else if (key.name === "tab" && key.shift) {
			setFieldIndex((i) => (i - 1 + fields.length) % fields.length);
		} else if (key.name === "tab") {
			setFieldIndex((i) => (i + 1) % fields.length);
		} else if (fields[fieldIndex]?.kind === "picker" && key.name === "return") {
			const field = fields[fieldIndex];
			if (field?.key === "tools") {
				setPickerKind("tools");
				setPickerIndex(0);
				if (toolCatalog.status === "idle") {
					loadToolCatalog();
				}
			} else if (field?.key === "skills") {
				setPickerKind("skills");
				setPickerIndex(0);
				if (skillCatalog.status === "idle") {
					loadSkillCatalog();
				}
			}
		} else if (
			fields[fieldIndex]?.kind === "sampling" &&
			key.name === "return"
		) {
			setSamplingPanelOpen(true);
		} else if (
			fields[fieldIndex]?.kind === "identity" &&
			key.name === "return" &&
			!remotePeer
		) {
			if (existing?.locked) {
				setError("This agent is locked. Unlock it before saving changes.");
				return;
			}
			setIdentityDraft(identityMode);
			setIdentityStepOpen(true);
		} else if (
			fields[fieldIndex]?.kind === "access" &&
			key.name === "return" &&
			!remotePeer
		) {
			setAccessIndex(0);
			setAccessAdding(false);
			setAccessError(null);
			setAccessPanelOpen(true);
			loadAccessAccounts();
		}
	});
}

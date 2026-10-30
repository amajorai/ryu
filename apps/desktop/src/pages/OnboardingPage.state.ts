import { useRef, useState } from "react";
import type { AgentCatalogEntry } from "@/src/lib/api/agents.ts";
import type {
	NodeOnboardingSnapshot,
	NodeSetupKind,
} from "@/src/lib/api/onboarding-profile.ts";
import type { OnboardingSkillsSnapshot } from "@/src/lib/api/onboarding-skills.ts";
import {
	type AgentSelection,
	DEFAULT_USER_PERSONALIZATION,
	EMPTY_AGENT_SELECTION,
	type UserPersonalization,
} from "@/src/lib/api/preferences.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";

type OnboardingFlowStateInput = Pick<
	ReturnType<typeof useOnboardingPhase>,
	"nodeOnboardingState" | "phase"
>;

/** Local bring-up, agent picker, skills, and node setup state. */
export function useOnboardingFlowState({
	nodeOnboardingState,
	phase,
}: OnboardingFlowStateInput) {
	// The line currently on screen for an auto-advancing phase. It is set by the
	// rotation tick below, which alternates the flavour copy with whatever is
	// REALLY happening, so the loop is never pure theatre.
	const [loopLine, setLoopLine] = useState<string | null>(null);
	// Managed adoption is polling the control plane for a provisioned node.
	const [managedBusy, setManagedBusy] = useState(false);
	// Webapp-only: the local reachability probe behind the "local" pick. The
	// desktop gates the whole `choose` step on its own Core already running, but
	// the webapp's `get_ryu_status` reports the HOSTED core, so `choose` renders
	// even with nothing on 127.0.0.1 — picking local there used to burn the 45s
	// waitForLocalStack budget and then drop the user into a broken app.
	const [localChecking, setLocalChecking] = useState(false);
	const [localUnreachable, setLocalUnreachable] = useState(false);
	// Why the local pick failed, in Core's own words ("HTTP 404" on a missing
	// release asset, a write error, …). The card used to say only "something went
	// wrong", which is unactionable for the one path that installs software.
	const [localError, setLocalError] = useState<string | null>(null);
	// What the local bring-up is doing RIGHT NOW ("Installing the model gateway"),
	// and the things it has already finished ("Ryu Core installed"). Refs, not
	// state: installer events can arrive frequently and the rotation tick samples
	// them, while the progress bar tracks the script's structured percentage live.
	const liveStatusRef = useRef<string | null>(null);
	const doneStatusRef = useRef<string[]>([]);
	const [localPercent, setLocalPercent] = useState<number | null>(null);
	// Which path the user picked on `choose`, or null while they are still on the
	// fork. Only the local path cares whether this device's Core came up, so this
	// is what gates the "Couldn't start Ryu" screen — a user on a remote or cloud
	// node must never be blocked by a Core they deliberately did not install.
	const [mode, setMode] = useState<"local" | "managed" | "remote" | null>(null);
	// The connect-to-an-existing-node form: probe in flight, and why the last
	// attempt failed.
	const [remoteChecking, setRemoteChecking] = useState(false);
	const [remoteError, setRemoteError] = useState<string | null>(null);
	// Guards the async local/managed setup against a late state update after the
	// page unmounts (it unmounts when the first Ryu chat tab opens).
	const cancelledRef = useRef(false);
	// Agents found on the user's system (pre-selected) and the curated suggested
	// set (opt-in). Only the flagship Ryu agent is installed by default.
	const [foundAgents, setFoundAgents] = useState<AgentCatalogEntry[]>([]);
	const [suggestedAgents, setSuggestedAgents] = useState<AgentCatalogEntry[]>(
		[]
	);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	// The catalog call failed, so the rows on screen are the curated fallback and
	// "Found on your system" could not be computed. Drives an inline notice with a
	// Retry — the step is still shown, because a step is not a query result.
	const [agentsUnavailable, setAgentsUnavailable] = useState(false);
	// Which node the agents step is talking to, so Retry can re-ask the same one.
	const [agentsNode, setAgentsNode] = useState<Node | null>(null);
	const [agentsRetrying, setAgentsRetrying] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [laneSaveError, setLaneSaveError] = useState<string | null>(null);
	const [onboardingSkills, setOnboardingSkills] =
		useState<OnboardingSkillsSnapshot | null>(null);
	const [selectedSkillPackIds, setSelectedSkillPackIds] = useState<Set<string>>(
		new Set()
	);
	const [skillsLoading, setSkillsLoading] = useState(() => phase === "skills");
	const [skillsSubmitting, setSkillsSubmitting] = useState(false);
	const [skillsError, setSkillsError] = useState<string | null>(null);
	const skillsLoadStartedRef = useRef(false);
	const [nodeSetupKind, setNodeSetupKind] = useState<NodeSetupKind | null>(
		() => nodeOnboardingState?.setupKind ?? null
	);
	const [companyContext, setCompanyContext] = useState(
		() => nodeOnboardingState?.personalization.companyContext ?? ""
	);
	const [companyKnowledgeEnabled, setCompanyKnowledgeEnabled] = useState(() =>
		nodeOnboardingState?.setupKind === "team"
			? nodeOnboardingState.personalization.companyKnowledgeEnabled
			: true
	);
	const [userPersonalization, setUserPersonalization] =
		useState<UserPersonalization>(DEFAULT_USER_PERSONALIZATION);
	const [nodeSetupError, setNodeSetupError] = useState<string | null>(null);
	const lastExternalNodeState = useRef<
		NodeOnboardingSnapshot | null | undefined
	>(undefined);
	// Agents chosen on the picker, held while the later steps are shown.
	const [allowedAgentIds, setAllowedAgentIds] = useState<string[]>(["ryu"]);
	const [localSelection, setLocalSelection] = useState<AgentSelection>(
		EMPTY_AGENT_SELECTION
	);
	const [cloudSelection, setCloudSelection] = useState<AgentSelection>(
		EMPTY_AGENT_SELECTION
	);
	return {
		agentsNode,
		agentsRetrying,
		agentsUnavailable,
		allowedAgentIds,
		cancelledRef,
		cloudSelection,
		companyContext,
		companyKnowledgeEnabled,
		doneStatusRef,
		foundAgents,
		laneSaveError,
		lastExternalNodeState,
		liveStatusRef,
		localChecking,
		localError,
		localPercent,
		localSelection,
		localUnreachable,
		loopLine,
		managedBusy,
		mode,
		nodeSetupError,
		nodeSetupKind,
		onboardingSkills,
		remoteChecking,
		remoteError,
		selected,
		selectedSkillPackIds,
		setAgentsNode,
		setAgentsRetrying,
		setAgentsUnavailable,
		setAllowedAgentIds,
		setCloudSelection,
		setCompanyContext,
		setCompanyKnowledgeEnabled,
		setFoundAgents,
		setLaneSaveError,
		setLocalChecking,
		setLocalError,
		setLocalPercent,
		setLocalSelection,
		setLocalUnreachable,
		setLoopLine,
		setManagedBusy,
		setMode,
		setNodeSetupError,
		setNodeSetupKind,
		setOnboardingSkills,
		setRemoteChecking,
		setRemoteError,
		setSelected,
		setSelectedSkillPackIds,
		setSkillsError,
		setSkillsLoading,
		setSkillsSubmitting,
		setSubmitting,
		setSuggestedAgents,
		setUserPersonalization,
		skillsError,
		skillsLoadStartedRef,
		skillsLoading,
		skillsSubmitting,
		submitting,
		suggestedAgents,
		userPersonalization,
	};
}

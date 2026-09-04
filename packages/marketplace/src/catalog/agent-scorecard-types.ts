/**
 * The small, host-neutral input contract for the configured-agent scorecard.
 * Desktop maps its editor state into this shape; the rules never import a host
 * API type or make a network call.
 */

export type AgentRuntimeStatus = "custom" | "ready" | "missing" | "unavailable";

export type AgentLifecycleStatus = "active" | "draft" | "trial";

export type AgentSafetyProfile =
	| "approval_required"
	| "autonomous"
	| "read_only"
	| "verified_plan_only";

export interface AgentRuntimeHealth {
	label?: string | null;
	status: AgentRuntimeStatus;
}

export interface AgentModelHealth {
	/** True when the editor has a concrete model id in the agent's chat slot. */
	configured: boolean;
	/** Whether this runtime normally benefits from a model selection. */
	required?: boolean;
}

export interface AgentCapabilityHealth {
	/** True when the editor has every currently available item selected. */
	allSelected: boolean;
	/** Number of currently available items in the host catalog. */
	availableCount: number;
	/** True once the host has finished loading the catalog. */
	loaded: boolean;
	/** Number of items selected in the editor. */
	selectedCount: number;
}

export interface AgentAccessHealth {
	composioActionCount: number;
	/** Count of capability paths that can make an external or durable change. */
	highImpactCount: number;
	identityProfileCount: number;
}

export interface AgentAutomationHealth {
	scheduleEnabled: boolean;
	triggerCount: number;
}

export interface AgentHealthInput {
	access: AgentAccessHealth;
	automation: AgentAutomationHealth;
	description?: string | null;
	instructions?: string | null;
	lifecycleStatus: AgentLifecycleStatus;
	memoryWriteEnabled: boolean;
	model: AgentModelHealth;
	name: string;
	runtime: AgentRuntimeHealth;
	safetyProfile: AgentSafetyProfile;
	skills: AgentCapabilityHealth;
	tools: AgentCapabilityHealth;
}

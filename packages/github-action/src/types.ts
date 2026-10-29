import type { JsonRecord, JsonValue } from "./json.ts";

export type TargetMode = "auto" | "self-hosted" | "managed";

export type Operation = "setup" | "run" | "tool" | "eval";

export interface ActionInputs {
	agent: string | null;
	conversationId: string | null;
	cwd: string | null;
	enableLongTerm: boolean;
	/** Runner-relative eval dataset file (JSON, JSONL, or CSV). */
	evalDataset: string | null;
	/** Judge model for model-graded eval scorers. */
	evalJudgeModel: string | null;
	/** Runner-relative path for the eval JUnit XML report. */
	evalJunitFile: string | null;
	/** Model the eval dataset is replayed against. */
	evalModel: string | null;
	/** Gateway evaluator ids / built-in metrics to score and gate. */
	evalScorers: string[];
	/** Raw `n` / `scorer=n` threshold specs. */
	evalThresholds: string[];
	exportEnv: boolean;
	inference: JsonRecord | null;
	managedNodeToken: string | null;
	managedNodeUrl: string | null;
	nodeToken: string | null;
	nodeUrl: string | null;
	operation: Operation;
	persist: boolean;
	pluginFlags: Record<string, boolean> | null;
	prompt: string | null;
	responseFile: string | null;
	/** Vault values to export as masked environment variables. */
	secrets: VaultSecretRef[];
	target: TargetMode;
	team: string | null;
	timeoutMs: number;
	tool: string | null;
	toolArguments: JsonValue;
	userId: string | null;
	/** Audience requested for the GitHub OIDC token used in JWT login. */
	vaultJwtAudience: string | null;
	/** Vault machine identity name for GitHub OIDC (JWT) login. */
	vaultJwtIdentity: string | null;
	vaultRoleId: string | null;
	vaultSecretId: string | null;
	workflow: string | null;
	worktreeIsolation: boolean;
	writeSummary: boolean;
}

/** One `secrets` input line: `NAME`, `/folder/NAME`, `ENV:NAME`, or
 *  `ENV:/folder/NAME`. Omitted environment = the node's active environment. */
export interface VaultSecretRef {
	environment: string | null;
	name: string;
	path: string;
	/** The line as written, for error messages (never a value). */
	reference: string;
}

export interface ResolvedTarget {
	mode: TargetMode;
	token: string | null;
	url: string;
}

export interface NodeHealth {
	capabilities: JsonValue[];
	channel: string | null;
	status: string;
	version: string | null;
}

export interface NodeInfo {
	hostname: string | null;
	managed: boolean;
	orgId: string | null;
	orgName: string | null;
	os: string | null;
	[key: string]: JsonValue;
}

export interface NodeSnapshot {
	health: NodeHealth;
	info: NodeInfo;
	mode: TargetMode;
	url: string;
}

export interface ToolEvent {
	input?: JsonValue;
	output?: JsonValue;
	status?: string | null;
	toolCallId: string | null;
	toolName: string | null;
	type: "input" | "output";
}

export interface ChatResult {
	conversationId: string;
	finished: boolean;
	runId: string | null;
	text: string;
	toolEvents: ToolEvent[];
	workflowEvents: JsonValue[];
}

export interface ToolResult {
	error: string | null;
	ok: boolean;
	output: JsonValue | undefined;
}

/** The `eval` operation's run and threshold gate (see eval.ts). */
export interface EvalResult {
	gate: {
		checks: {
			metric: string;
			model: string | null;
			pass: boolean;
			threshold: number;
			value: number | null;
		}[];
		failures: string[];
		ok: boolean;
	};
	run: JsonRecord;
}

export interface ActionResult {
	conversationId: string | null;
	node: NodeSnapshot;
	operation: Operation;
	result: ChatResult | EvalResult | ToolResult | null;
	runId: string | null;
	text: string;
	toolEvents: ToolEvent[];
}

export interface ChatRequest {
	acp_config?: Record<string, string>;
	acp_mode?: string;
	acp_model?: string;
	agent_id?: string;
	conversation_id: string;
	cwd?: string;
	enable_long_term: boolean;
	inference?: JsonRecord;
	messages: Array<{
		content: Array<{ text: string; type: "text" }>;
		role: "user";
	}>;
	persist: boolean;
	plugin_flags?: Record<string, boolean>;
	team_id?: string;
	workflow_id?: string;
	worktree_isolation?: boolean;
}

export interface ToolRequest {
	agent_id: string;
	arguments: JsonValue;
	tool: string;
	user_id?: string;
}

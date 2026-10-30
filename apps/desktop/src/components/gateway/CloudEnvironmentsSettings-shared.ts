import {
	type CloudEnvironmentRuntime,
	DEFAULT_CLOUD_ENVIRONMENT_RUNTIME,
} from "@ryuhq/protocol/cloud-environments";
import { ApiError } from "@/src/lib/api/client.ts";
import type { CloudEnvironment } from "@/src/lib/api/cloud-environments.ts";

export const lines = (value: string) =>
	value
		.split(/\r?\n|,/)
		.map((item) => item.trim())
		.filter(Boolean);

export const errorMessage = <TError>(error: TError) =>
	error instanceof ApiError && error.serverMessage
		? error.serverMessage
		: error instanceof Error
			? error.message
			: "Could not update cloud environments";

// Parser/validation messages ("Invalid cloud environment state", a serialized
// issue list) are not sentences a person can act on. They headline as a plain
// sentence and stay available on hover; server messages read as written.
const TECHNICAL_ERROR = /^(?:invalid cloud environment|[[{])/iu;

export const paneErrorHeadline = (error: string) =>
	TECHNICAL_ERROR.test(error.trim())
		? "Couldn’t read the saved cloud environment settings."
		: error;

export const createEnvironment = (): CloudEnvironment => ({
	id: crypto.randomUUID(),
	name: "New environment",
	repositories: [],
	installScript: "",
	startInstructions: "",
	internet: { enabled: true, domainPolicy: "all", allowedDomains: [] },
	privacy: "private",
	vaultKeys: [],
	tailscaleVaultKey: null,
	published: false,
	runtime: { ...DEFAULT_CLOUD_ENVIRONMENT_RUNTIME },
});

export const RUNTIME_AGENT_OPTIONS = [
	["ryu", "Ryu"],
	["claude-code", "Claude Code"],
	["codex", "Codex"],
	["opencode", "OpenCode"],
	["cursor", "Cursor"],
] as const satisfies readonly (readonly [
	CloudEnvironmentRuntime["executor"],
	string,
])[];

export const runtimeExecutor = (
	value: string
): CloudEnvironmentRuntime["executor"] | null =>
	RUNTIME_AGENT_OPTIONS.find(([option]) => option === value)?.[0] ?? null;

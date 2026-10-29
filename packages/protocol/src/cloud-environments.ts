import { z } from "zod";

export const CLOUD_ENVIRONMENT_BACKENDS = ["auto", "box"] as const;
export const CLOUD_ENVIRONMENT_EXECUTORS = [
	"ryu",
	"claude-code",
	"codex",
	"opencode",
	"cursor",
] as const;
export const CLOUD_ENVIRONMENT_LIFETIME_MINUTES = { min: 5, max: 240 } as const;

/** How a cloud task runs: which backend creates the workspace and which agent drives it. */
export interface CloudEnvironmentRuntime {
	backend: (typeof CLOUD_ENVIRONMENT_BACKENDS)[number];
	executor: (typeof CLOUD_ENVIRONMENT_EXECUTORS)[number];
	lifetimeMinutes: number;
}

export const DEFAULT_CLOUD_ENVIRONMENT_RUNTIME: CloudEnvironmentRuntime =
	Object.freeze({
		backend: "auto",
		executor: "ryu",
		lifetimeMinutes: 30,
	});

/** Node-owned cloud setup profiles. Vault values are write-only on the wire. */
export interface CloudEnvironment {
	id: string;
	installScript: string;
	internet: {
		enabled: boolean;
		domainPolicy: "all" | "packageManagers" | "custom";
		allowedDomains: string[];
	};
	name: string;
	privacy: "private" | "shared";
	published: boolean;
	repositories: string[];
	/** Optional on input; parsed environments always carry it (defaulted when absent). */
	runtime?: CloudEnvironmentRuntime;
	startInstructions: string;
	tailscaleVaultKey: string | null;
	vaultKeys: string[];
}

export interface CloudVaultEntry {
	domains: string[];
	environmentIds: string[];
	hasValue: boolean;
	id: string;
	key: string;
	kind: "variable" | "networkSecret";
}

export type CloudVaultEntryWrite = Omit<CloudVaultEntry, "hasValue"> & {
	value?: string;
};

export interface CloudEnvironmentState {
	environments: CloudEnvironment[];
	revision: number;
	schemaVersion: 1;
	vault: CloudVaultEntry[];
}

export type CloudEnvironmentWrite = Omit<CloudEnvironmentState, "vault"> & {
	vault: CloudVaultEntryWrite[];
};

export interface CloudEnvironmentLaunchResult {
	environmentId: string;
	exitCode: number;
	startInstructions: string;
	status: "completed" | "failed";
	stderr: string;
	stdout: string;
}

function parseOrThrow<S extends z.ZodType>(
	schema: S,
	value: Parameters<S["parse"]>[0]
) {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new Error(
			result.error.issues[0]?.message ?? "Invalid cloud environment response"
		);
	}
	return result.data;
}
const ownRecordSchema = z
	.custom<object>(
		(value) => {
			const wrapped = new Object(value);
			return (
				wrapped === value &&
				!Array.isArray(value) &&
				!z.function().safeParse(value).success
			);
		},
		{ error: "Invalid cloud environment response" }
	)
	.transform((value) => Object.fromEntries(Object.entries(value)));
function text(limit = 65_536) {
	return z
		.string({ error: "Invalid cloud environment text" })
		.max(limit, { error: "Invalid cloud environment text" });
}
const flag = z.boolean({ error: "Invalid cloud environment flag" });
/** A sparse native array keeps its holes while each present element is decoded. */
function nativeList<S extends z.ZodType>(
	item: S,
	limit: number,
	message: string
) {
	return z
		.custom<z.input<S>[]>(
			(value) => Array.isArray(value) && value.length <= limit,
			{ error: message }
		)
		.transform((value) => value.map((entry) => parseOrThrow(item, entry)));
}
function strings(limit = 100) {
	return nativeList(text(1024), limit, "Invalid cloud environment list");
}
const policySchema = z.object({
	domainPolicy: z.enum(["all", "packageManagers", "custom"], {
		error: "Invalid cloud environment policy",
	}),
	privacy: z.enum(["private", "shared"], {
		error: "Invalid cloud environment policy",
	}),
});
const runtimeSchema = z.object({
	backend: z.enum(CLOUD_ENVIRONMENT_BACKENDS, {
		error: "Invalid cloud environment runtime",
	}),
	executor: z.enum(CLOUD_ENVIRONMENT_EXECUTORS, {
		error: "Invalid cloud environment runtime",
	}),
	lifetimeMinutes: z
		.number({ error: "Invalid cloud environment runtime" })
		.int({ error: "Invalid cloud environment runtime" })
		.min(CLOUD_ENVIRONMENT_LIFETIME_MINUTES.min, {
			error: "Invalid cloud environment runtime",
		})
		.max(CLOUD_ENVIRONMENT_LIFETIME_MINUTES.max, {
			error: "Invalid cloud environment runtime",
		}),
});
const environmentSchema = z.preprocess(
	(value) => {
		const entry = parseOrThrow(ownRecordSchema, value);
		const internet = parseOrThrow(ownRecordSchema, entry.internet);
		const policy = parseOrThrow(policySchema, {
			domainPolicy: internet.domainPolicy,
			privacy: entry.privacy,
		});
		// Older Core documents omit runtime; fill the default so a save round-trip keeps it.
		const runtime =
			"runtime" in entry && entry.runtime !== undefined
				? parseOrThrow(ownRecordSchema, entry.runtime)
				: { ...DEFAULT_CLOUD_ENVIRONMENT_RUNTIME };
		return {
			...entry,
			internet: { ...internet, domainPolicy: policy.domainPolicy },
			privacy: policy.privacy,
			runtime,
		};
	},
	z.object({
		id: text(128),
		name: text(120),
		repositories: strings(20),
		installScript: text(),
		startInstructions: text(),
		internet: z.object({
			enabled: flag,
			domainPolicy: policySchema.shape.domainPolicy,
			allowedDomains: strings(),
		}),
		privacy: policySchema.shape.privacy,
		vaultKeys: strings(),
		tailscaleVaultKey: text(128).nullable(),
		published: flag,
		runtime: runtimeSchema,
	})
);

/**
 * Client-side mirror of the Core runtime rules that can be checked without the node.
 * Core remains authoritative (domain allowlists and Box availability are checked there).
 */
export function cloudEnvironmentRuntimeIssue(
	environment: Pick<
		CloudEnvironment,
		"internet" | "runtime" | "tailscaleVaultKey" | "vaultKeys"
	>,
	vault: readonly Pick<CloudVaultEntry, "key" | "kind">[] = []
): string | null {
	const runtime = environment.runtime ?? DEFAULT_CLOUD_ENVIRONMENT_RUNTIME;
	if (!CLOUD_ENVIRONMENT_BACKENDS.includes(runtime.backend)) {
		return "Choose a supported backend.";
	}
	if (!CLOUD_ENVIRONMENT_EXECUTORS.includes(runtime.executor)) {
		return "Choose a supported agent.";
	}
	if (
		!Number.isInteger(runtime.lifetimeMinutes) ||
		runtime.lifetimeMinutes < CLOUD_ENVIRONMENT_LIFETIME_MINUTES.min ||
		runtime.lifetimeMinutes > CLOUD_ENVIRONMENT_LIFETIME_MINUTES.max
	) {
		return `Session length must be a whole number of minutes from ${CLOUD_ENVIRONMENT_LIFETIME_MINUTES.min} to ${CLOUD_ENVIRONMENT_LIFETIME_MINUTES.max}.`;
	}
	if (runtime.executor !== "ryu" && runtime.backend !== "box") {
		return "Managed agents require the Fresh cloud box backend.";
	}
	if (runtime.executor !== "ryu" && !environment.internet.enabled) {
		return "Managed agents require internet access.";
	}
	if (runtime.backend !== "box") {
		return null;
	}
	if (environment.tailscaleVaultKey) {
		return "Fresh cloud boxes do not support Tailscale VPN. Remove the VPN key.";
	}
	const bound = new Set(environment.vaultKeys);
	const secret = vault.find(
		(entry) => entry.kind === "networkSecret" && bound.has(entry.key)
	);
	if (secret) {
		return `Fresh cloud boxes do not support network secrets. Unselect ${secret.key}.`;
	}
	const reserved = environment.vaultKeys.filter(isBoxReservedVariable);
	if (reserved.length > 0) {
		return `Fresh cloud boxes reserve these variable names: ${reserved.join(", ")}. Rename them.`;
	}
	if (environment.vaultKeys.length > MAX_BOX_VARIABLES) {
		return `Fresh cloud boxes accept at most ${MAX_BOX_VARIABLES} variables. Unselect some.`;
	}
	return null;
}

/** Box's per-command environment limit. */
const MAX_BOX_VARIABLES = 64;
const BOX_RESERVED_VARIABLES = new Set(["HOSTNAME", "PWD", "USER"]);

/** Names the Box service reserves (case-sensitive) beyond Core's own list. */
function isBoxReservedVariable(key: string): boolean {
	return (
		BOX_RESERVED_VARIABLES.has(key) ||
		key.startsWith("DOCKER_") ||
		key.startsWith("RYU_BOX_")
	);
}
const vaultKind = z.enum(["variable", "networkSecret"], {
	error: "Invalid cloud vault type",
});
const vaultSchema = z.preprocess(
	(value) => {
		const entry = parseOrThrow(ownRecordSchema, value);
		const kind = parseOrThrow(vaultKind, entry.kind);
		if ("value" in entry) {
			throw new Error("Cloud vault response exposed a value");
		}
		return { ...entry, kind };
	},
	z.object({
		id: text(128),
		key: text(128),
		kind: vaultKind,
		environmentIds: strings(),
		domains: strings(),
		hasValue: flag,
	})
);
const stateAdmissionSchema = z.object({
	schemaVersion: z.literal(1, { error: "Invalid cloud environment state" }),
	revision: z
		.number({ error: "Invalid cloud environment state" })
		.int({ error: "Invalid cloud environment state" })
		.min(0, { error: "Invalid cloud environment state" }),
	environments: z.custom<z.input<typeof environmentSchema>[]>(
		(value) => Array.isArray(value) && value.length <= 100,
		{ error: "Invalid cloud environment state" }
	),
	vault: z.custom<z.input<typeof vaultSchema>[]>(
		(value) => Array.isArray(value) && value.length <= 100,
		{ error: "Invalid cloud environment state" }
	),
});
const stateSchema = z.preprocess(
	(value) =>
		parseOrThrow(stateAdmissionSchema, parseOrThrow(ownRecordSchema, value)),
	z.object({
		schemaVersion: z.literal(1),
		revision: z.number(),
		environments: nativeList(
			environmentSchema,
			100,
			"Invalid cloud environment state"
		),
		vault: nativeList(vaultSchema, 100, "Invalid cloud environment state"),
	})
);
export function parseCloudEnvironmentState(
	value: Parameters<typeof stateSchema.parse>[0]
) {
	return parseOrThrow(stateSchema, value);
}
const launchGate = z
	.object({
		status: z.enum(["completed", "failed"], {
			error: "Invalid cloud setup result",
		}),
		exitCode: z
			.number({ error: "Invalid cloud setup result" })
			.int({ error: "Invalid cloud setup result" }),
	})
	.refine(
		(value) => (value.status === "completed") === (value.exitCode === 0),
		{ error: "Invalid cloud setup result" }
	);
const launchSchema = z.preprocess(
	(value) => {
		const entry = parseOrThrow(ownRecordSchema, value);
		const gate = parseOrThrow(launchGate, entry);
		return { ...entry, ...gate };
	},
	z.object({
		environmentId: text(128),
		status: launchGate.shape.status,
		exitCode: launchGate.shape.exitCode,
		stdout: text(1_048_576),
		stderr: text(1_048_576),
		startInstructions: text(),
	})
);
export function parseCloudEnvironmentLaunchResult(
	value: Parameters<typeof launchSchema.parse>[0]
) {
	return parseOrThrow(launchSchema, value);
}

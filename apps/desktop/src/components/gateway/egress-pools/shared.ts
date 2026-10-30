import type { GatewayEgressConfig } from "@/src/lib/api/gateway.ts";

type Pool = GatewayEgressConfig["pools"][string];
export type Endpoint = Pool["endpoints"][number];
type DraftEndpoint = Endpoint & { draftId: string };
export type DraftPool = Omit<Pool, "endpoints"> & {
	endpoints: DraftEndpoint[];
};

export const SUPPORTED = new Set([
	"openai",
	"edge-tts",
	"google-tts",
	"google-translate-tts",
	"polly",
	"anthropic",
	"openrouter",
	"cohere",
	"deepgram",
	"assemblyai",
	"elevenlabs",
	"inworld",
	"modal",
	"replicate",
	"fal",
	"recraft",
	"stability",
	"bfl",
	"minimax",
	"runway",
	"topaz",
	"genai",
	"cloudflare",
	"bedrock",
	"vertex",
	"openai-credits",
	"anthropic-credits",
	"voyage",
	"jina",
	"mistral",
	"huggingface",
	"nvidia",
	"together",
	"fireworks",
	"qwen",
	"chutes",
	"hyperbolic",
	"siliconflow",
	"venice",
	"featherless",
]);
export const EMPTY_EGRESS: GatewayEgressConfig = { assignments: {}, pools: {} };
/** The Gateway accepts new credential variable names only with this prefix. */
const WRITABLE_CREDENTIAL_ENV_PREFIX = "RYU_PROXY_";
const WELL_FORMED_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** Every credential variable name the saved config already uses. */
export function savedCredentialEnvNames(
	egress: GatewayEgressConfig | null
): ReadonlySet<string> {
	const names = new Set<string>();
	for (const saved of Object.values(egress?.pools ?? {})) {
		for (const endpoint of saved.endpoints) {
			for (const env of [endpoint.username_env, endpoint.password_env]) {
				if (env) {
					names.add(env);
				}
			}
		}
	}
	return names;
}

export function validatePool(
	name: string,
	pool: Pool,
	savedEnvNames: ReadonlySet<string> = new Set()
): string | null {
	if (pool.direct_fallback_only && !pool.include_direct) {
		return "Include a direct connection before enabling direct fallback.";
	}
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
		return "Use 1–64 letters, numbers, hyphens, or underscores for the pool name.";
	}
	if (
		!(
			pool.include_direct || pool.endpoints.some((endpoint) => endpoint.enabled)
		)
	) {
		return "Enable a proxy endpoint or include a direct connection.";
	}
	if (pool.endpoints.length + Number(pool.include_direct) > 32) {
		return "A pool supports at most 32 connections.";
	}
	const ids = new Set<string>();
	for (const endpoint of pool.endpoints) {
		if (
			!Number.isInteger(endpoint.priority ?? 0) ||
			(endpoint.priority ?? 0) < 0 ||
			(endpoint.priority ?? 0) > 65_535
		) {
			return "Priority must be an integer from 0 to 65535.";
		}
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(endpoint.id) || ids.has(endpoint.id)) {
			return "Proxy endpoint IDs must be unique and use letters, numbers, hyphens, or underscores.";
		}
		ids.add(endpoint.id);
		if (endpoint.enabled) {
			let url: URL;
			try {
				url = new URL(endpoint.url);
			} catch {
				return `Enter a valid URL for ${endpoint.id}.`;
			}
			if (
				!(url.protocol === "http:" || url.protocol === "https:") ||
				url.username ||
				url.password ||
				url.pathname !== "/" ||
				url.search ||
				url.hash
			) {
				return `Use an HTTP or HTTPS proxy origin without credentials or a path for ${endpoint.id}.`;
			}
		}
		if (Boolean(endpoint.username_env) !== Boolean(endpoint.password_env)) {
			return `Set both credential environment variable names for ${endpoint.id}.`;
		}
		for (const env of [endpoint.username_env, endpoint.password_env]) {
			if (
				env &&
				WELL_FORMED_ENV_NAME.test(env) &&
				!env.startsWith(WRITABLE_CREDENTIAL_ENV_PREFIX) &&
				!savedEnvNames.has(env)
			) {
				return `Credential variable names for ${endpoint.id} must start with ${WRITABLE_CREDENTIAL_ENV_PREFIX}.`;
			}
		}
	}
	return null;
}

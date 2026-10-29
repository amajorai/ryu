import {
	gatewayAccountErrorMessage,
	ProviderRow,
} from "@/src/components/gateway/GatewayProviderKeyRow.tsx";
import { ProviderKeySafetyNotice } from "@/src/components/settings/shared/provider-key-safety.tsx";
import {
	SettingsGroup,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	addGatewayProviderAccount,
	type ByokProvider,
	clearGatewayProvider,
	configureGatewayProviderAccount,
	type GatewayProviderAccount,
	type GatewayProviderEditResult,
	type GatewayProvidersConfig,
	removeGatewayProviderAccount,
	replaceGatewayProviderAccount,
	requireGatewayProviderReload,
	setGatewayProvider,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { syncGatewayProviderKey } from "@/src/lib/api/secrets.ts";

const BYOK_PROVIDERS: {
	slug: ByokProvider;
	label: string;
	placeholder: string;
}[] = [
	{ slug: "openai", label: "OpenAI", placeholder: "sk-…" },
	{ slug: "anthropic", label: "Anthropic", placeholder: "sk-ant-…" },
	{ slug: "openrouter", label: "OpenRouter", placeholder: "sk-or-…" },
	{ slug: "gemini", label: "Gemini", placeholder: "AIza…" },
	{ slug: "voyage", label: "Voyage AI", placeholder: "pa-…" },
	{ slug: "jina", label: "Jina AI", placeholder: "jina_…" },
	{ slug: "mistral", label: "Mistral", placeholder: "…" },
	{ slug: "huggingface", label: "Hugging Face", placeholder: "hf_…" },
	{ slug: "nvidia", label: "NVIDIA NIM", placeholder: "nvapi-…" },
	{ slug: "together", label: "Together AI", placeholder: "…" },
	{ slug: "fireworks", label: "Fireworks AI", placeholder: "fw_…" },
	{ slug: "qwen", label: "Qwen (Singapore)", placeholder: "sk-…" },
	{ slug: "cohere", label: "Cohere", placeholder: "…" },
	{ slug: "deepgram", label: "Deepgram", placeholder: "…" },
	{ slug: "assemblyai", label: "AssemblyAI", placeholder: "…" },
	{ slug: "elevenlabs", label: "ElevenLabs", placeholder: "…" },
	{
		slug: "inworld",
		label: "Inworld",
		placeholder: "Base64 Portal credentials",
	},
	{ slug: "modal", label: "Modal", placeholder: "Deployment bearer token" },
	{ slug: "replicate", label: "Replicate", placeholder: "r8_…" },
	{ slug: "fal", label: "Fal", placeholder: "…" },
	{ slug: "recraft", label: "Recraft", placeholder: "…" },
	{ slug: "stability", label: "Stability AI", placeholder: "sk-…" },
	{ slug: "bfl", label: "Black Forest Labs", placeholder: "API key" },
	{ slug: "minimax", label: "MiniMax", placeholder: "API key" },
	{ slug: "runway", label: "Runway", placeholder: "API key" },
	{ slug: "topaz", label: "Topaz Labs", placeholder: "API key" },
];

// Projection of the native transports accepted by supports_chat_account_routing.
const ACCOUNT_ROUTING_PROVIDERS = new Set<ByokProvider>([
	"openai",
	"anthropic",
	"openrouter",
	"mistral",
	"huggingface",
	"nvidia",
	"together",
	"fireworks",
	"qwen",
]);

/** Resolve a redacted native provider view without indexing non-provider config. */
function providerView(
	providers: GatewayProvidersConfig | null,
	slug: ByokProvider
) {
	switch (slug) {
		case "voyage":
		case "jina":
		case "mistral":
		case "huggingface":
		case "nvidia":
		case "together":
		case "fireworks":
		case "qwen":
			return providers?.compatible?.[slug];
		case "openai":
		case "anthropic":
		case "openrouter":
		case "cohere":
		case "deepgram":
		case "assemblyai":
		case "elevenlabs":
		case "inworld":
		case "modal":
		case "replicate":
		case "fal":
		case "recraft":
		case "stability":
		case "bfl":
		case "minimax":
		case "runway":
		case "topaz":
			return providers?.[slug];
		default:
			return undefined;
	}
}

function isByokProviderSet(
	providers: GatewayProvidersConfig | null,
	slug: ByokProvider
): boolean {
	if (slug.startsWith("genai-")) {
		return (
			(providers?.genai?.sdk_providers?.find(
				(value) => value.account_scope === slug
			)?.account_count ?? 0) > 0
		);
	}
	if (slug === "modal") {
		return (providers?.modal?.api_key_count ?? 0) > 0;
	}
	if (slug === "gemini") {
		return (
			(providers?.genai?.gemini_account_count ?? 0) > 0 ||
			(providers?.genai?.keys.includes("gemini") ?? false)
		);
	}
	return providerView(providers, slug) != null;
}

function byokAccountCount(
	providers: GatewayProvidersConfig | null,
	slug: ByokProvider
): number {
	if (slug.startsWith("genai-")) {
		return (
			providers?.genai?.sdk_providers?.find(
				(value) => value.account_scope === slug
			)?.account_count ?? 0
		);
	}
	if (slug === "gemini") {
		return (
			providers?.genai?.gemini_account_count ??
			(providers?.genai?.keys.includes("gemini") ? 1 : 0)
		);
	}
	return Number(providerView(providers, slug)?.api_key_count) || 0;
}

/** What a persisted Gateway write did to the provider's first key. */
type KeychainMirror =
	| { key: string; outcome: "saved" }
	| { key: null; outcome: "removed" };

/**
 * Mirror a persisted Gateway key change into the desktop OS credential store.
 * The Gateway already holds the change, so a mirror failure is returned instead
 * of thrown: the caller must still refresh the card before reporting it.
 */
async function mirrorProviderKey(
	slug: ByokProvider,
	mirror: KeychainMirror
): Promise<Error | null> {
	try {
		await syncGatewayProviderKey(slug, mirror.key);
		return null;
	} catch (cause) {
		const detail = gatewayAccountErrorMessage(cause, "unknown error");
		const change = mirror.outcome === "saved" ? "saved to" : "removed from";
		return new Error(
			`Key ${change} the Gateway, but the OS credential store could not be updated: ${detail}`,
			{ cause }
		);
	}
}

export function ByokCard({
	target,
	providers,
	onRefresh,
	managed = false,
	canConfigure = true,
	expectedRevision,
}: {
	target: ApiTarget;
	providers: GatewayProvidersConfig | null;
	onRefresh: () => Promise<void>;
	/** Managed (Ryu Cloud) node: read-only, and the key writers are no-ops so a
	 *  personal key can never be POSTed to the shared hosted fleet. */
	managed?: boolean;
	/** When false the caller lacks `gateway.configure`; writers disabled. */
	canConfigure?: boolean;
	expectedRevision?: string;
}) {
	/**
	 * Settle a Gateway key write. Once the Gateway persisted the change the card
	 * refreshes even when the keychain mirror fails, so the row reflects the key
	 * the Gateway holds; the mirror failure is then surfaced to the row.
	 */
	const settleProviderWrite = async (
		slug: ByokProvider,
		result: GatewayProviderEditResult,
		mirror: KeychainMirror | null
	) => {
		const persisted = result.persisted ?? result.success;
		const mirrorError =
			persisted && mirror ? await mirrorProviderKey(slug, mirror) : null;
		requireGatewayProviderReload(result);
		await onRefresh();
		if (mirrorError) {
			throw mirrorError;
		}
	};

	const handleSave = async (slug: ByokProvider, key: string) => {
		// Security gate (WS4): on a managed node the fleet holds keys server-side;
		// never let a personal key leave the client to the shared gateway.
		if (managed || !canConfigure) {
			return;
		}
		const result = await setGatewayProvider(
			target,
			slug,
			key,
			undefined,
			expectedRevision
		);
		await settleProviderWrite(slug, result, { key, outcome: "saved" });
	};

	const handleClear = async (slug: ByokProvider) => {
		if (managed || !canConfigure) {
			return;
		}
		const result = await clearGatewayProvider(
			target,
			slug,
			undefined,
			expectedRevision
		);
		await settleProviderWrite(slug, result, { key: null, outcome: "removed" });
	};

	const handleAdd = async (slug: ByokProvider, key: string) => {
		if (managed || !canConfigure) {
			return;
		}
		const result = await addGatewayProviderAccount(
			target,
			slug,
			key,
			expectedRevision
		);
		requireGatewayProviderReload(result);
		await onRefresh();
	};

	const handleRemove = async (slug: ByokProvider, index: number) => {
		if (managed || !canConfigure) {
			return;
		}
		const result = await removeGatewayProviderAccount(
			target,
			slug,
			index,
			providers?.accounts?.[slug]?.[index]?.id,
			expectedRevision
		);
		await settleProviderWrite(
			slug,
			result,
			index === 0 ? { key: null, outcome: "removed" } : null
		);
	};
	const handleReplace = async (
		slug: ByokProvider,
		account: GatewayProviderAccount,
		key: string
	) => {
		if (managed || !canConfigure) {
			return;
		}
		const result = await replaceGatewayProviderAccount(
			target,
			slug,
			account.id,
			key,
			expectedRevision
		);
		await settleProviderWrite(
			slug,
			result,
			providers?.accounts?.[slug]?.[0]?.id === account.id
				? { key, outcome: "saved" }
				: null
		);
	};

	return (
		<SettingsSection
			caption="Add your own provider keys for chat, embeddings, speech, images, and video. Ryu installs every key in this node's Gateway configuration. The desktop also mirrors the first key into its OS credential store. Keys are masked on later reads; Ryu Cloud nodes keep their provider keys server-side."
			title="Provider keys (BYOK)"
		>
			{managed ? null : <ProviderKeySafetyNotice storage="gateway" />}
			<SettingsGroup>
				{BYOK_PROVIDERS.filter(
					({ slug }) => slug !== "modal" || providers?.modal != null
				).map(({ slug, label, placeholder }) => (
					<ProviderRow
						accountCount={byokAccountCount(providers, slug)}
						accountStrategy={providers?.accountStrategies?.[slug]}
						accounts={providers?.accounts?.[slug]}
						canConfigure={canConfigure}
						drainThreshold={providers?.accountDrainThresholds?.[slug]}
						isSet={isByokProviderSet(providers, slug)}
						key={slug}
						label={label}
						onAdd={handleAdd}
						onClear={handleClear}
						onConfigure={async (provider, account) => {
							if (managed || !canConfigure) {
								return;
							}
							await configureGatewayProviderAccount(
								target,
								provider,
								account,
								expectedRevision
							);
							await onRefresh();
						}}
						onDrainThresholdChange={
							ACCOUNT_ROUTING_PROVIDERS.has(slug)
								? async (provider, percent) => {
										if (managed || !canConfigure) {
											return;
										}
										await updateGatewayConfig(target, {
											expectedRevision,
											providerAccountDrainThresholds: { [provider]: percent },
										});
										await onRefresh();
									}
								: undefined
						}
						onRemove={handleRemove}
						onReplace={handleReplace}
						onSave={handleSave}
						onStrategyChange={
							ACCOUNT_ROUTING_PROVIDERS.has(slug) || slug === "gemini"
								? async (provider, strategy) => {
										if (managed || !canConfigure) {
											return;
										}
										await updateGatewayConfig(target, {
											expectedRevision,
											providerAccountStrategies: { [provider]: strategy },
										});
										await onRefresh();
									}
								: undefined
						}
						placeholder={placeholder}
						quotaRouting={slug !== "gemini"}
						readOnly={managed}
						slug={slug}
					/>
				))}
			</SettingsGroup>
		</SettingsSection>
	);
}

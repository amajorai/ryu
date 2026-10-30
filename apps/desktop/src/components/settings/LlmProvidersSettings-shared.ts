import type { ProviderAccountTarget } from "@/components/agent-elements/input/provider-account-section.tsx";
import type { useLlmProviders } from "@/src/hooks/useLlmProviders.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import type {
	PiCatalog,
	PiConfig,
	PiProvider,
} from "@/src/lib/api/pi-config.ts";

export const GATEWAY = "gateway";
export const DIRECT = "direct";
export const DEFAULT_API = "openai-completions";
export function errMessage<TError>(e: TError, fallback: string): string {
	// Prefer Core's own reason over the generic "<path> failed: <status>" text.
	if (e instanceof ApiError && e.serverMessage) {
		return e.serverMessage;
	}
	return e instanceof Error ? e.message : fallback;
}

// Order the catalog so the managed provider leads (the recommended default),
// then configured providers, then the rest — configuring "many at once" reads
// best when what is set up already floats to the top.
export function orderProviders(providers: PiProvider[]): PiProvider[] {
	return [...providers].sort((a, b) => {
		const rank = (p: PiProvider) => {
			if (p.managed) {
				return 0;
			}
			if (p.configured) {
				return 1;
			}
			return 2;
		};
		return rank(a) - rank(b);
	});
}

export function supportsOAuth(provider: PiProvider): boolean {
	return provider.supportsOAuth ?? provider.authKind === "subscription";
}

export interface ProviderCardProps {
	activeConfig: PiConfig | null;
	/** Whether this caller may set a BYOK account for the Gateway. */
	canSetGatewayAccount?: boolean;
	/** Live connectivity probe (latency + model count). */
	check: ReturnType<typeof useLlmProviders>["check"];
	discover: ReturnType<typeof useLlmProviders>["discover"];
	/** Whether this org has unrestricted prepaid credits for retail Ryu models. */
	hasPrepaidManagedBalance: boolean;
	onActivate: (input: {
		api?: string | null;
		model: string;
		provider: string;
		thinkingLevel: string | null;
	}) => Promise<void>;
	onConfigure: (input: {
		apiKey?: string | null;
		provider: string;
		routing?: string | null;
	}) => Promise<void>;
	/** Refresh the catalog so `configured` (login state) flips after a login. */
	onReload: () => void;
	onRemove: (id: string) => Promise<void>;
	/** Remove one saved account without removing the provider. */
	onRemoveAccount: (provider: string, accountId: string) => Promise<PiCatalog>;
	/** Rename one saved account without changing its credentials. */
	onRenameAccount: (
		provider: string,
		accountId: string,
		label: string
	) => Promise<void>;
	/** Switch one saved account for yourself or the shared Gateway. */
	onSwitchAccount: (
		provider: string,
		accountId: string,
		target: ProviderAccountTarget
	) => Promise<void>;
	/** Enable/disable a single model within this provider. */
	onToggleModel: (
		provider: string,
		model: string,
		enabled: boolean
	) => Promise<void>;
	provider: PiProvider;
	thinkingLevels: string[];
}

/** The one managed pool with no donated allowance behind it — retail
 *  pass-through, paid for out of subscription/top-up credit. Every OTHER pool is
 *  donated supply that grants land in, so it needs no plan. Mirrors the
 *  `openrouter` id in `packages/auth/src/lib/credit-pools.ts`. */
export const RETAIL_CREDIT_POOL = "openrouter";

/** What a managed row's chip says.
 *
 *  Three states, not two: a pool-backed row is neither "included with your plan"
 *  (it is not — it is donated supply you may hold a grant of) nor "requires a
 *  subscription" (it does not). Saying either of the old two about it is wrong in
 *  a way that costs the user the credit they already have. */
export function managedBadgeLabel(
	needsCredits: boolean,
	poolBacked: boolean
): string {
	if (poolBacked) {
		return "Org credit pool";
	}
	return needsCredits ? "Add prepaid credits" : "Ryu managed";
}

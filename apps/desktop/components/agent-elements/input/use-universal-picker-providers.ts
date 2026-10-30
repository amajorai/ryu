"use client";

import {
	ALL_CREDIT_POOLS,
	type CreditPool,
	type CreditPoolId,
} from "@ryu/auth/lib/credit-pools";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { totalFreeCredit } from "@/components/agent-elements/input/free-model-tag.ts";
import { modelMenuItem } from "@/components/agent-elements/input/model-router.ts";
import type { ProviderEntry } from "@/components/agent-elements/input/universal-picker-body.tsx";
import type { usePiConfig } from "@/src/hooks/usePiConfig.ts";
import {
	filterEnabledModels,
	gatewayProviderSlug,
	type PiProvider,
} from "@/src/lib/api/pi-config.ts";
import type {
	BrowserSurface,
	useBrowserProviderSnapshot,
} from "@/src/lib/extension-host.ts";

/** The flagship agent id (mirrors Core `DEFAULT_AGENT_ID`). */
export const RYU_AGENT_ID = "ryu";

/**
 * The synthetic "Local" row's id, and the REAL Pi provider it routes through.
 *
 * There is no `local` provider in Core's `PROVIDERS` table and there should not
 * be: talking to weights on this machine is not a credential-bearing vendor, it
 * is the governed `gateway` route pointed at whichever model the local engine is
 * currently serving. So the row is assembled here from the two endpoints that
 * already own that state — `/api/models/installed` (what is on disk) and
 * `/api/models/active` (what is loaded) — and a pick writes BOTH halves: the
 * served model (`setActiveModel`) and the Pi route (`provider: "gateway"`).
 * Writing only one is the failure mode `RyuPiConfig` already guards against —
 * a config naming a model the engine never loaded.
 */
export const LOCAL_PROVIDER_ID = "local";
export const GATEWAY_PROVIDER_ID = "gateway";
export const BROWSER_PROVIDER_ID = "browser";

/** Map a Pi provider id to the engine key its brand logo is registered under. */
export const PROVIDER_ENGINE_KEY = new Map<string, string>([
	["google", "gemini"],
	["claude-pro-max", "claude"],
	["openai-codex", "codex"],
	["chatgpt", "chatgpt"],
	["anthropic", "anthropic"],
	["openai", "openai"],
	["mistral", "mistral"],
	["openrouter", "openrouter"],
]);

export function providerEngineKey(providerId: string): string {
	return PROVIDER_ENGINE_KEY.get(providerId) ?? providerId;
}

/**
 * The credit pools a user may be offered as a route ("Ryu Fast", "Ryu Frontier"),
 * straight from the pool catalog. Filtering on `visible` here is the whole point:
 * adding, hiding or renaming a pool is then a data change in
 * `@ryu/auth/lib/credit-pools`, never an edit to this picker. It also
 * deliberately excludes the pass-through `openrouter` pool, which is invisible —
 * that supply is what the ORIGINAL managed Ryu row already sells, and offering it
 * twice under two names would be the same route pretending to be a choice.
 */
export const OFFERED_CREDIT_POOLS: readonly CreditPool[] =
	ALL_CREDIT_POOLS.filter((pool) => pool.visible);

/**
 * The pool a managed catalog row is backed by, or null for a row that is not
 * pool-backed (today: the default managed OpenRouter route, and every BYO-key
 * provider).
 *
 * `managed` is a REQUIRED part of the match, not an accelerator. A user's own
 * Bedrock or Cloudflare credential is a perfectly ordinary BYO-key provider whose
 * id collides with a pool's `gatewayProviders` entry; treating that as Ryu's
 * donated supply would relabel the user's own account "Ryu Frontier" and gate it
 * behind our subscription upsell.
 *
 * Three id spellings are accepted because Core owns the provider id and this
 * surface does not: whichever of `bedrock` / `managed-bedrock` Core publishes,
 * the row binds. Core publishes the `managed-<poolId>` form for every pool
 * (`managed-vertex`, `managed-openai-credits`, `managed-anthropic-credits`
 * included), so a new pool needs no edit here. A row that matches nothing keeps
 * today's behaviour exactly.
 */
export function creditPoolForProvider(provider: PiProvider): CreditPool | null {
	if (!provider.managed) {
		return null;
	}
	return (
		OFFERED_CREDIT_POOLS.find(
			(pool) =>
				provider.id === pool.id ||
				provider.id === `managed-${pool.id}` ||
				pool.gatewayProviders.includes(provider.id)
		) ?? null
	);
}

/**
 * Upsell copy for a pool row. Names the TIER and nothing else — the pool catalog's
 * standing rule is that a user never reads the name of the provider behind a pool,
 * so the supplier can be swapped without changing what anyone was promised.
 * There is no bring-your-own-key half: Ryu's pooled capacity is not something a
 * user can hold a key for, so offering one would be a dead end.
 */
export function poolUpsellCopy(pool: CreditPool) {
	return {
		upgrade: `${pool.label} runs on Ryu's own capacity — included with a Ryu subscription, no API keys.`,
		byoKey: null,
	};
}

export interface BuildProviderEntriesParams {
	activeProviderId: string | null;
	agentId: string | null;
	browserSnapshot: ReturnType<typeof useBrowserProviderSnapshot>;
	config: ReturnType<typeof usePiConfig>["config"];
	freeCredit: ReturnType<typeof totalFreeCredit>;
	grantByPoolId: Map<
		CreditPoolId,
		{ expiresAt: string | null; remainingMicroUsd: number }
	>;
	grantedPoolIds: Set<CreditPoolId>;
	hasManagedPlan: boolean;
	localActive: boolean;
	localStems: string[];
	servedStem: string | null;
	shownProviders: PiProvider[];
	surface: BrowserSurface;
	tl: LiteralMessage;
}

/**
 * The picker's provider rows: every shown Pi provider, plus the synthetic
 * Browser and Local rows unshifted in front when they apply.
 */
export function buildProviderEntries({
	activeProviderId,
	agentId,
	browserSnapshot,
	config,
	freeCredit,
	grantByPoolId,
	grantedPoolIds,
	hasManagedPlan,
	localActive,
	localStems,
	servedStem,
	shownProviders,
	surface,
	tl,
}: BuildProviderEntriesParams): ProviderEntry[] {
	const providers: ProviderEntry[] = shownProviders.map((p) => {
		const isActive = activeProviderId === p.id;
		const pool = creditPoolForProvider(p);
		// The single managed Ryu Router row (not a legacy pool-bound row).
		const isRyuRouter = Boolean(p.managed) && pool === null;
		return {
			id: p.id,
			// For a pool-backed row the pool catalog owns the name, not Core:
			// `label` is defined there as the one string a user ever reads for a
			// pool, so the tier stays consistent wherever it is rendered and the
			// supplier behind it stays invisible.
			label: pool ? pool.label : p.label,
			engineKey: providerEngineKey(p.id),
			authKind: p.authKind,
			managed: Boolean(p.managed),
			supportsDiscovery: p.supportsDiscovery !== false,
			gatewayAccountSupported:
				p.authKind === "api-key" && gatewayProviderSlug(p.id) !== null,
			// Every account the provider holds in the sealed vault (labels
			// only). Renders the submenu's switchable Account section.
			accounts: p.accounts ?? [],
			// Only the default managed row borrows OpenRouter's catalog (it has no
			// model list of its own and routes there). A pool row enumerates under
			// its OWN id or not at all — inheriting OpenRouter's list would have it
			// advertise models its pool cannot serve.
			discoveryProviderId:
				p.managed && pool === null ? "openrouter" : undefined,
			// A managed row is always `configured` server-side (it is wallet-gated
			// at the Gateway), so the upsell is gated on entitlement, not on
			// `configured`. A pool row adds two escapes: the free-reach pool is the
			// give-it-away tier and must never be upsold, and a user already
			// holding granted credit in this pool has already paid the toll.
			upsell: pool
				? !(
						hasManagedPlan ||
						pool.tier === "free" ||
						grantedPoolIds.has(pool.id)
					)
				: Boolean(p.managed) && !hasManagedPlan && freeCredit === null,
			upsellCopy: pool ? poolUpsellCopy(pool) : undefined,
			// The pool's own remaining granted credit, shown on the row as "$50.00"
			// so "how much Frontier is left?" is answerable where the choice is
			// made. Looked up by pool id, so a grant row this build can't map back
			// to the catalog contributes nothing rather than landing on the wrong
			// pool — the same rule `grantedPoolIds` applies to the upsell.
			poolGrant: pool
				? grantByPoolId.get(pool.id)
				: isRyuRouter
					? (freeCredit ?? undefined)
					: undefined,
			// "Free" tags come from Core's `freeModels` (the Gateway's own
			// equivalence table) and show only while free credit remains.
			freeModelIds:
				isRyuRouter && freeCredit !== null && p.freeModels?.length
					? new Set(p.freeModels)
					: undefined,
			// Pooled capacity is Ryu's own, so there is no credential for a user
			// to hold and a pool row is `configured` by definition — the wallet
			// (and the pool's grant balance) is what gates it, at the Gateway.
			// Forced rather than trusted because `configured` comes from Core,
			// where the managed check is still a single-id equality; a pool row
			// that arrived `false` would fall through to the unconfigured branch
			// and offer "Sign in with Ryu Frontier", which is a dead end.
			configured: pool ? true : p.configured,
			isActive,
			currentModel: isActive ? (config?.model ?? null) : null,
			currentThinking: isActive ? (config?.thinkingLevel ?? null) : null,
			modelOverrides: p.modelOverrides,
			// Models the user turned off in Settings are not offered here. The
			// row's own current model is exempt (see `filterEnabledModels`), and
			// the submenu applies the same rule to the live-discovered list.
			models: filterEnabledModels(
				p.suggestedModels.map((m) => modelMenuItem(m)),
				p.modelOverrides,
				isActive ? config?.model : null
			),
		};
	});

	// Browser is a synthetic provider owned by the extension adapter. It sits
	// beside Core-local and cloud routes in the same universal picker, but its
	// picks never call `saveProvider` or send an inference request to Core.
	if (browserSnapshot) {
		const browserModelId =
			browserSnapshot.currentModelBySurface[surface] ??
			browserSnapshot.models[0]?.id ??
			null;
		const browserModel = browserSnapshot.models.find(
			(model) => model.id === browserModelId
		);
		if (browserModel) {
			providers.unshift({
				id: BROWSER_PROVIDER_ID,
				label: "Browser",
				engineKey: "browser",
				authKind: "none",
				managed: false,
				supportsDiscovery: false,
				configured: true,
				upsell: false,
				isActive:
					browserSnapshot.activeAgentId === agentId &&
					browserSnapshot.activeSurface === surface,
				currentModel: browserModelId,
				currentThinking: null,
				status: browserModel.status,
				statusMessage: browserModel.statusMessage,
				browserCapabilities: browserModel.capabilities,
				models: browserSnapshot.models.map((model) => ({
					id: model.id,
					name: `${model.name} · ${
						model.status === "ready" ? "Ready" : model.status
					}`,
					description: model.capabilities.actionSupport
						? tl("Browser actions · {status}", { status: model.status })
						: `Chat-only · ${model.status}`,
				})),
			});
		}
	}

	// The Local route, offered as its own provider row so "run this on my
	// machine" is a first-class choice next to the vendors rather than a few
	// bare stems buried in Ryu's flat model list. Hidden entirely when no
	// chat-capable weights are installed — an empty row would be a dead end
	// with no in-place way to fill it (models are installed from the Store).
	// It leads the list: it is the one route that needs no account at all.
	if (localStems.length > 0) {
		providers.unshift({
			id: LOCAL_PROVIDER_ID,
			label: "Local",
			engineKey: LOCAL_PROVIDER_ID,
			// No credential exists to hold for weights on this disk, so the row is
			// configured by definition and never upsells.
			authKind: "none",
			managed: false,
			supportsDiscovery: false,
			configured: true,
			upsell: false,
			isActive: localActive,
			currentModel: localActive ? (config?.model ?? null) : null,
			currentThinking: localActive ? (config?.thinkingLevel ?? null) : null,
			// The served model is listed even when it is not a chat stem by name,
			// so a picker can always show what the engine actually has loaded.
			models: (servedStem && !localStems.includes(servedStem)
				? [servedStem, ...localStems]
				: localStems
			).map((stem) => ({ id: stem, name: stem })),
		});
	}

	return providers;
}

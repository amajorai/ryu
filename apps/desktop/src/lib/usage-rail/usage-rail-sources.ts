// apps/desktop/src/lib/usage-rail/usage-rail-sources.ts
//
// The sources of usage the side rings stand for. A bot draws from a pool of
// accounts now, so "this bot has X left" says nothing true: the rings follow
// the accounts instead. One ring per custom account pool, one per provider
// for its saved accounts that sit in no pool (what Auto and "all accounts"
// rotate over), and one per agent that reads its own CLI sign-in and has no
// saved Ryu account.
//
// Pure: it only shapes what Core already returned (the subscriptions
// snapshot, the pool catalog and the agent usage snapshots).

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import type { AccountPool } from "@/src/lib/api/account-pools.ts";
import type {
	SubscriptionAccount,
	SubscriptionProvider,
	UsageSnapshot,
} from "@/src/lib/api/usage.ts";

const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;

/** One limit window of an account. */
export interface RailWindow {
	key: string;
	/** Short axis label: "5h", "7d", or the vendor's own name. */
	label: string;
	/** The model the window limits. Null for an account-wide window. */
	model: string | null;
	resetsAt: string | null;
	/** 0 to 100. */
	usedPercent: number;
	windowSeconds: number | null;
}

/** Why an account has no number, or "ok" when it has one. */
export type RailAccountState =
	| "needs_reauth"
	| "no_reading"
	| "ok"
	| "pending"
	| "pool_disabled"
	| "unavailable"
	| "unsupported";

export interface RailAccount {
	active: boolean;
	id: string;
	/** Core's label, often an email address. Display only, never stored. */
	label: string | null;
	/** What the tightest account-wide window has left. Null with no reading. */
	leftPercent: number | null;
	/** An account-wide window is used up. */
	limited: boolean;
	/** When the last used-up window resets. Null when unknown or not limited. */
	limitedUntil: string | null;
	state: RailAccountState;
	/** Account-wide windows first, each group the shortest first. */
	windows: RailWindow[];
}

export type RailLogo =
	| {
			kind: "agent";
			avatarUrl: string | null;
			engine: string | null;
			glyph?: GlyphValue;
	  }
	| { kind: "initial"; text: string }
	| { kind: "provider"; key: string };

/** One arc of a ring. The first track is the outer one. */
export interface RailTrack {
	/** The window the arc stands for. Null for the mean of several accounts. */
	label: string | null;
	usedPercent: number;
}

export interface UsageRailSource {
	accounts: RailAccount[];
	id: string;
	kind: "agent" | "pool" | "provider";
	/**
	 * What the source has left. One readable account: its tightest window.
	 * Several: the mean of what each has left in its tightest window, the same
	 * figure the Usage page calls pooled headroom.
	 */
	leftPercent: number;
	logo: RailLogo;
	name: string;
	/** The accounts with a readable account-wide window. */
	readable: number;
	tracks: RailTrack[];
}

/** An installed agent with the usage Core read for it. */
export interface RailAgentUsage {
	avatarGlyph?: GlyphValue;
	avatarUrl: string | null;
	/** The engine key the agent logo is drawn from. */
	engine: string | null;
	id: string;
	name: string;
	snapshot: UsageSnapshot | null;
}

export interface WindowInput {
	label: string;
	model?: string | null;
	resetsAt?: string | null;
	usedPercent: number;
	/** Core's short label, on a provider reading. */
	window?: string;
	windowSeconds?: number | null;
}

function clampPercent(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/**
 * "5h" and "7d" for the two rolling windows every vendor reports, by their own
 * length when the vendor says it. Any other window keeps the vendor's name
 * ("Sonnet", "Spark"), because Core names windows from the data.
 */
export function shortWindowLabel(input: WindowInput): string {
	if (input.window) {
		return input.window;
	}
	if (input.label !== "Session" && input.label !== "Weekly") {
		return input.label;
	}
	const seconds = input.windowSeconds ?? null;
	if (seconds === null || seconds <= 0) {
		return input.label === "Session" ? "5h" : "7d";
	}
	const hours = Math.round(seconds / SECONDS_PER_HOUR);
	return hours < HOURS_PER_DAY
		? `${hours}h`
		: `${Math.round(hours / HOURS_PER_DAY)}d`;
}

function railWindows(inputs: readonly WindowInput[]): RailWindow[] {
	const windows = inputs.map((input, index) => ({
		index,
		window: {
			key: `${input.label}:${input.model ?? ""}:${input.windowSeconds ?? "?"}`,
			label: shortWindowLabel(input),
			model: input.model ?? null,
			resetsAt: input.resetsAt ?? null,
			usedPercent: clampPercent(input.usedPercent),
			windowSeconds: input.windowSeconds ?? null,
		} satisfies RailWindow,
	}));
	const length = (window: RailWindow) =>
		window.windowSeconds ?? Number.POSITIVE_INFINITY;
	return windows
		.sort(
			(a, b) =>
				Number(a.window.model !== null) - Number(b.window.model !== null) ||
				length(a.window) - length(b.window) ||
				a.index - b.index
		)
		.map((entry) => entry.window);
}

function accountWide(windows: readonly RailWindow[]): RailWindow[] {
	return windows.filter((window) => window.model === null);
}

/** The latest reset among the used-up windows, when every one names a reset. */
function limitedUntil(spent: readonly RailWindow[]): string | null {
	let latest: string | null = null;
	for (const window of spent) {
		const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
		if (Number.isNaN(at)) {
			return null;
		}
		if (latest === null || at > Date.parse(latest)) {
			latest = window.resetsAt;
		}
	}
	return latest;
}

function accountFromWindows(
	base: Pick<RailAccount, "active" | "id" | "label">,
	inputs: readonly WindowInput[],
	emptyState: RailAccountState
): RailAccount {
	const windows = railWindows(inputs);
	const wide = accountWide(windows);
	if (wide.length === 0) {
		return {
			...base,
			leftPercent: null,
			limited: false,
			limitedUntil: null,
			state: emptyState,
			windows: [],
		};
	}
	const spent = wide.filter((window) => window.usedPercent >= 100);
	return {
		...base,
		leftPercent: Math.min(...wide.map((window) => 100 - window.usedPercent)),
		limited: spent.length > 0,
		limitedUntil: limitedUntil(spent),
		state: "ok",
		windows,
	};
}

/** One saved account of a provider, with the reading Core put in the snapshot. */
function savedAccount(account: SubscriptionAccount): RailAccount {
	const base = {
		active: account.active,
		id: account.accountId,
		label: account.label ?? null,
	};
	// An account Core will not route to has no number, also when an old reading
	// is still cached: the ring must not count headroom nobody can use.
	if (
		account.state === "needs_reauth" ||
		account.state === "pool_disabled" ||
		account.state === "unsupported"
	) {
		return accountFromWindows(base, [], account.state);
	}
	const reading = account.usage;
	let emptyState: RailAccountState = "no_reading";
	if (account.state === "pending") {
		emptyState = "pending";
	} else if (reading?.available === false) {
		emptyState = "unavailable";
	}
	return accountFromWindows(
		base,
		reading?.available ? reading.windows : [],
		emptyState
	);
}

function sourceFrom(
	base: Pick<UsageRailSource, "id" | "kind" | "logo" | "name">,
	accounts: RailAccount[]
): UsageRailSource | null {
	const readable = accounts.filter((account) => account.leftPercent !== null);
	const [only] = readable;
	if (!only) {
		return null;
	}
	if (readable.length === 1) {
		const wide = accountWide(only.windows);
		const shortest = wide.at(0);
		const longest = wide.at(-1);
		const tracks: RailTrack[] = [];
		if (longest) {
			tracks.push({ label: longest.label, usedPercent: longest.usedPercent });
		}
		if (shortest && shortest !== longest) {
			tracks.push({ label: shortest.label, usedPercent: shortest.usedPercent });
		}
		return {
			...base,
			accounts,
			leftPercent: only.leftPercent ?? 0,
			readable: 1,
			tracks,
		};
	}
	const total = readable.reduce(
		(sum, account) => sum + (account.leftPercent ?? 0),
		0
	);
	const leftPercent = total / readable.length;
	return {
		...base,
		accounts,
		leftPercent,
		readable: readable.length,
		tracks: [{ label: null, usedPercent: 100 - leftPercent }],
	};
}

function memberKey(providerId: string, accountId: string): string {
	return `${providerId}\u0000${accountId}`;
}

/** A provider whose saved accounts Ryu owns and reads (not a managed pool). */
function ownSubscription(provider: SubscriptionProvider): boolean {
	return provider.kind === "subscription" && !provider.managed;
}

function poolSources(
	pools: readonly AccountPool[],
	providers: readonly SubscriptionProvider[]
): UsageRailSource[] {
	const sources: UsageRailSource[] = [];
	for (const pool of pools) {
		const providerIds = new Set<string>();
		const accounts = pool.accounts.map((member): RailAccount => {
			providerIds.add(member.providerId);
			const provider = providers.find(
				(entry) => entry.providerId === member.providerId
			);
			const account = provider?.accounts.find(
				(entry) => entry.accountId === member.accountId
			);
			return account
				? savedAccount(account)
				: accountFromWindows(
						{ active: false, id: member.accountId, label: null },
						[],
						// A member of a provider Core lists no usage for (an API key).
						provider ? "no_reading" : "unsupported"
					);
		});
		const [providerId] = providerIds;
		const provider = providers.find((entry) => entry.providerId === providerId);
		const source = sourceFrom(
			{
				id: `pool:${pool.id}`,
				kind: "pool",
				logo:
					providerIds.size === 1 && providerId
						? {
								kind: "provider",
								key: `${providerId} ${provider?.label ?? ""}`,
							}
						: { kind: "initial", text: pool.name.trim().slice(0, 1) },
				name: pool.name,
			},
			accounts
		);
		if (source) {
			sources.push(source);
		}
	}
	return sources;
}

function providerSources(
	pools: readonly AccountPool[],
	providers: readonly SubscriptionProvider[]
): UsageRailSource[] {
	const pooled = new Set(
		pools.flatMap((pool) =>
			pool.accounts.map((member) =>
				memberKey(member.providerId, member.accountId)
			)
		)
	);
	const sources: UsageRailSource[] = [];
	for (const provider of providers) {
		const accounts = provider.accounts
			.filter(
				(account) =>
					!pooled.has(memberKey(provider.providerId, account.accountId))
			)
			.map(savedAccount);
		const source = sourceFrom(
			{
				id: `provider:${provider.providerId}`,
				kind: "provider",
				logo: {
					kind: "provider",
					key: `${provider.providerId} ${provider.label}`,
				},
				name: provider.label,
			},
			accounts
		);
		if (source) {
			sources.push(source);
		}
	}
	return sources;
}

/**
 * One ring per CLI sign-in. Two agents on the same engine read the same
 * sign-in, so they share a ring. An agent whose reading came from a saved Ryu
 * account has no ring of its own: that account's pool or provider shows it.
 */
function agentSources(agents: readonly RailAgentUsage[]): UsageRailSource[] {
	const sources = new Map<string, UsageRailSource>();
	for (const agent of agents) {
		const snapshot = agent.snapshot;
		if (!snapshot?.available || snapshot.accountId) {
			continue;
		}
		const id = `agent:${snapshot.engine || agent.id}`;
		if (sources.has(id)) {
			continue;
		}
		const source = sourceFrom(
			{
				id,
				kind: "agent",
				logo: {
					kind: "agent",
					avatarUrl: agent.avatarUrl,
					engine: agent.engine,
					glyph: agent.avatarGlyph,
				},
				name: agent.name,
			},
			[
				accountFromWindows(
					{ active: true, id: agent.id, label: null },
					snapshot.windows,
					"no_reading"
				),
			]
		);
		if (source) {
			sources.set(id, source);
		}
	}
	return [...sources.values()];
}

/**
 * Every source that has a number to show: the pools, then the providers with
 * accounts outside every pool, then the agents on their own sign-in. A source
 * with no readable account has no ring, so nothing is ever drawn from a guess.
 */
export function buildUsageRailSources({
	agents,
	pools,
	providers,
}: {
	agents: readonly RailAgentUsage[];
	pools: readonly AccountPool[];
	providers: readonly SubscriptionProvider[];
}): UsageRailSource[] {
	const own = providers.filter(ownSubscription);
	return [
		...poolSources(pools, own),
		...providerSources(pools, own),
		...agentSources(agents),
	];
}

/** The accounts of a source that cannot serve until a window resets. */
export function limitedAccounts(source: UsageRailSource): RailAccount[] {
	return source.accounts.filter((account) => account.limited);
}

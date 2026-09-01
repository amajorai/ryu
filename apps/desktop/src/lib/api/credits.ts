// apps/desktop/src/lib/api/credits.ts
//
// Typed client for the platform-credits wallet (marketplace monetization #487,
// spec §4). The "Ryu $" closed-loop prepaid balance.
//
// Like channels.ts (and unlike the Core-node clients), this targets the
// identity/control-plane server (:3000, BACKEND_URL), authenticated with the
// Better-Auth session bearer token. Credits are a "what is measured/paid for"
// concern and live in the control plane (packages/api `/api/credits`, MongoDB),
// alongside billing. Wallets are ORG-level: the server resolves the caller's
// active org from the session, so these routes need no org argument.
//
//   GET  /api/credits/wallet  -> the active org's balance + recent ledger
//   POST /api/credits/topup   -> a Polar checkout URL + fee breakdown for a pack
//
// Top-ups go through Polar (epic #496, Unit B2). The buyer is CHARGED
// `face + deposit fee` (the plan's current percentage/floor quote) and the wallet
// is CREDITED the FACE value;
// the topup response carries the {@link TopupQuote} so the UI can show the fee
// before sending the buyer to checkout. Balances and ledger deltas are in
// micro-USD (millionths of a dollar) integers to avoid float drift;
// {@link microUsdToUsd} converts for display. The actual crediting happens
// asynchronously via a Polar webhook on the server, so after returning from
// checkout the UI re-fetches the wallet (the balance may lag a moment behind a
// completed payment).

import { formatMicroUsd as formatSharedMicroUsd } from "@ryu/ui/lib/number-format.ts";
import { openSse, SseConnectError, type SseMessage } from "@ryuhq/protocol/sse";
import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

/** Micro-USD (millionths of a dollar) per US cent; the server's wallet unit. */
export const MICRO_USD_PER_DOLLAR = 1_000_000;

/** Convert a micro-USD integer (wallet balance / ledger delta) to dollars. */
export function microUsdToUsd(microUsd: number): number {
	return microUsd / MICRO_USD_PER_DOLLAR;
}

/** Format a micro-USD amount as a localized USD currency string. */
export function formatMicroUsd(microUsd: number, currency = "usd"): string {
	return formatSharedMicroUsd(microUsd, currency);
}

/** The named credit packs the top-up checkout offers, in whole dollars. */
export const CREDIT_PACKS = [10, 25, 100] as const;
export type CreditPack = (typeof CREDIT_PACKS)[number];

/** Custom top-up bounds, mirroring the server's 500–100000 cents clamp. */
export const MIN_TOPUP_DOLLARS = 5;
export const MAX_TOPUP_DOLLARS = 1000;

/**
 * Why a ledger entry was written. Mirrors the server's `LedgerReason` in
 * `@ryu/db/models/credits.model`. Nothing enforces the mirror — this union
 * narrows JSON the server already sent, it does not validate it — so a reason
 * added there and forgotten here renders as an UNLABELED row rather than a type
 * error. Adding a `LEDGER_REASONS` member is therefore always a two-file edit.
 */
export type LedgerReason =
	| "topup"
	| "plan_grant"
	| "gateway_usage"
	| "openrouter"
	| "composio"
	| "treg"
	| "subscription_offset"
	| "adjustment"
	| "campaign_grant"
	| "referral_grant";

/** Reasons that CREDIT the wallet (positive delta). Mirrors the server's
 * `CREDIT_REASONS`; used so the ledger badges a credit consistently. */
export const CREDIT_LEDGER_REASONS: readonly LedgerReason[] = [
	"topup",
	"plan_grant",
	"campaign_grant",
	"referral_grant",
];

/** Human label for each ledger reason, for the ledger list. */
export const LEDGER_REASON_LABELS: Record<LedgerReason, string> = {
	topup: "Top-up",
	plan_grant: "Plan credit",
	gateway_usage: "Gateway usage",
	openrouter: "OpenRouter usage",
	composio: "Composio action",
	treg: "Treg tool",
	subscription_offset: "Subscription offset",
	adjustment: "Adjustment",
	// Campaign and referral money is POOL-RESTRICTED, but the label deliberately
	// does not say which pool: the pool is a supply-side fact, and the user-facing
	// promise is one Ryu-native unit. The per-pool breakdown lives on the balance
	// card, not on every ledger row.
	campaign_grant: "Campaign credit",
	referral_grant: "Referral credit",
};

/** The materialized prepaid balance for the caller's active org. */
export interface CreditWallet {
	balanceMicroUsd: number;
	currency: string;
	id: string;
	ownerId: string;
	ownerType: string;
	/** Remaining included plan credit for the current billing period. */
	subscriptionBalanceMicroUsd: number;
	/** Remaining purchased credit; this balance rolls over. */
	topupBalanceMicroUsd: number;
	updatedAt: string;
}

/** One append-only ledger entry (credit or debit). */
export interface LedgerEntry {
	balanceAfter: number;
	createdAt: string;
	/** Signed micro-USD change: positive for top-ups, negative for usage. */
	delta: number;
	/** Wall-clock ms the billed work took; null when not measured. */
	durationMs: number | null;
	/** Whether the amount came from a provider/catalog estimate. */
	estimated: boolean | null;
	id: string;
	inputTokens: number | null;
	/** Model or resource id that produced the charge. */
	model: string | null;
	orgId: string | null;
	outputTokens: number | null;
	/** Upstream provider that served the work. NOT the credit pool. */
	provider: string | null;
	reason: LedgerReason;
	refId: string | null;
	/** Human-facing label for what the spend was for. */
	taskLabel: string | null;
	userId: string | null;
	walletId: string;
}

/** One grouped row of a usage breakdown. */
export interface UsageBreakdownRow {
	/** Micro-USD SPENT, as a positive number. */
	amountMicroUsd: number;
	count: number;
	key: string | null;
}

/** Aggregates for a usage window. */
export interface UsageStats {
	byModel: UsageBreakdownRow[];
	byProvider: UsageBreakdownRow[];
	byReason: UsageBreakdownRow[];
	creditedMicroUsd: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	spentMicroUsd: number;
	transactions: number;
}

/** The `/usage` response: one keyset page plus the window's aggregates. */
export interface UsageResponse {
	entries: LedgerEntry[];
	/** Pass back as `before` for the next page; null when exhausted. */
	nextCursor: string | null;
	stats: UsageStats;
}

/** Filters accepted by `/usage`. All optional. */
export interface UsageFilters {
	before?: string | null;
	limit?: number;
	model?: string | null;
	provider?: string | null;
	reason?: string | null;
	since?: string | null;
	until?: string | null;
}

/** The `/wallet` response: balance + a newest-first window of the ledger. */
export interface WalletResponse {
	ledger: LedgerEntry[];
	wallet: CreditWallet;
}

/** The Better-Auth session bearer token, or null when signed out / no storage. */
function authToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		// No storage — treated as signed out.
		return null;
	}
}

/** True when the user has a session token; credits require sign-in. */
export function hasCreditsAuth(): boolean {
	return Boolean(authToken());
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const token = authToken();
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/credits`;

/**
 * Distinguishes the degrade-cleanly states (per the hard rules) from generic
 * failures so the UI can render a tailored message:
 *   - "auth":   401, not signed in.
 *   - "no_org": 409, the active org is missing (wallets are org-level).
 *   - "billing": 503, the payment provider is not configured (top-up disabled).
 */
export type CreditsErrorKind = "auth" | "no_org" | "billing" | "unknown";

export class CreditsError extends Error {
	readonly kind: CreditsErrorKind;
	constructor(kind: CreditsErrorKind, message: string) {
		super(message);
		this.name = "CreditsError";
		this.kind = kind;
	}
}

/**
 * Classify an HTTP status into a {@link CreditsErrorKind} and its fallback copy,
 * used for both the request path ({@link toError}) and the SSE connect path
 * (`openWalletStream`), which has no body to read a server message from.
 */
function classifyStatus(status: number): {
	kind: CreditsErrorKind;
	message: string;
} {
	if (status === 401) {
		return { kind: "auth", message: "Sign in to view credits." };
	}
	if (status === 409) {
		return {
			kind: "no_org",
			message:
				"Credits wallets are org-level. Create or select an organization first.",
		};
	}
	if (status === 503) {
		return {
			kind: "billing",
			message: "Credit top-up is unavailable: billing is not configured.",
		};
	}
	return { kind: "unknown", message: `Request failed: ${status}` };
}

/** True when this failure will keep failing until the ACCOUNT changes — a retry
 *  loop must not treat it as a transient blip. `no_org` and `auth` are both
 *  fixed by user action elsewhere (create/select an org, sign in), never by
 *  reconnecting. */
export function isTerminalCreditsError(e: unknown): boolean {
	return (
		e instanceof CreditsError && (e.kind === "no_org" || e.kind === "auth")
	);
}

async function toError(resp: Response): Promise<CreditsError> {
	let message: string | undefined;
	try {
		const body = (await resp.json()) as { message?: string; error?: string };
		message = body.message ?? body.error;
	} catch {
		// Non-JSON body.
	}
	const classified = classifyStatus(resp.status);
	return new CreditsError(classified.kind, message ?? classified.message);
}

/** Fetch the active org's wallet balance + recent ledger (newest 50). */
export async function fetchWallet(): Promise<WalletResponse> {
	const resp = await fetch(`${BASE}/wallet`, { headers: authHeaders() });
	if (!resp.ok) {
		throw await toError(resp);
	}
	return (await resp.json()) as WalletResponse;
}

/**
 * One page of the org's usage statement.
 *
 * Keyset-paged on `createdAt`: pass the previous response's `nextCursor` as
 * `before`. Never a page NUMBER — the ledger grows at the head, so an offset page
 * would repeat a row at every boundary as new spend lands mid-read.
 */
export async function fetchUsage(
	filters: UsageFilters = {}
): Promise<UsageResponse> {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(filters)) {
		if (value !== null && value !== undefined && value !== "") {
			params.set(key, String(value));
		}
	}
	const query = params.toString();
	const resp = await fetch(`${BASE}/usage${query ? `?${query}` : ""}`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	return (await resp.json()) as UsageResponse;
}

/**
 * A live wallet-balance snapshot pushed by `GET /api/credits/wallet/stream`
 * (SSE `event: "wallet"`). This is the server's minimal, org-safe balance view —
 * a SUBSET of {@link CreditWallet} (no `ownerType`), so consumers merge these
 * fields into the last full wallet rather than replacing it wholesale.
 */
export interface WalletUpdate {
	balanceMicroUsd: number;
	currency: string;
	id: string;
	ownerId: string;
	updatedAt: string;
}

/** A claimed low-balance transition from the cloud credit-alert stream. */
export interface CreditAlertEvent {
	balanceMicroUsd: number;
	createdAt: string;
	level: "warning";
	thresholdMicroUsd: number;
	title: string;
}

/**
 * Open the org wallet's live-balance stream and async-iterate its frames. Sends
 * the session bearer token in the `Authorization` header (fetch + ReadableStream
 * via `openSse`, not EventSource). Yields one {@link WalletUpdate} per frame and
 * ends when `signal` aborts.
 *
 * A failed connect is re-thrown as a {@link CreditsError} so the reconnect loop
 * can read the KIND rather than guess: a 409 (`no_org`) is permanent until the
 * user creates or selects an organization, and retrying it on the transient
 * cadence was a 409 every few seconds for the whole session.
 */
export async function* openWalletStream(
	signal: AbortSignal
): AsyncGenerator<SseMessage<WalletUpdate>> {
	try {
		yield* openSse<WalletUpdate>(`${BASE}/wallet/stream`, {
			token: authToken(),
			signal,
		});
	} catch (e) {
		if (e instanceof SseConnectError) {
			const classified = classifyStatus(e.status);
			throw new CreditsError(classified.kind, classified.message);
		}
		throw e;
	}
}

/** Open the edge-triggered cloud low-balance notification stream. */
export async function* openCreditAlertStream(
	signal: AbortSignal
): AsyncGenerator<SseMessage<CreditAlertEvent>> {
	yield* openSse<CreditAlertEvent>(`${BASE}/alert/stream`, {
		token: authToken(),
		signal,
	});
}

export interface TopupInput {
	/** A custom FACE amount in cents — credited to the wallet (clamped 500–100000). */
	amountCents?: number;
	/** A named pack (10 | 25 | 100), or omit and pass `amountCents`. */
	pack?: CreditPack;
	/** Where Polar returns the buyer; defaults to the web frontend's receipt page. */
	successUrl?: string;
}

/**
 * The deposit-fee breakdown for a top-up (all integer cents). The buyer is
 * charged `chargeCents` (= face + fee); the wallet is credited `faceCents`.
 * Surfaced so the UI can show the fee BEFORE sending the buyer to checkout.
 */
export interface TopupQuote {
	chargeCents: number;
	faceCents: number;
	feeCents: number;
}

export interface TopupResult {
	quote: TopupQuote | null;
	url: string;
}

/**
 * Create a Polar checkout to buy credits and return its hosted URL + the fee
 * quote. The buyer is CHARGED `face + deposit fee`; the wallet is CREDITED the
 * FACE value. The caller opens the URL externally; the wallet is credited
 * asynchronously by the server's Polar webhook, so re-fetch the wallet on
 * return.
 */
export async function createTopup(input: TopupInput): Promise<TopupResult> {
	const body: Record<string, unknown> = {};
	if (input.pack !== undefined) {
		body.pack = String(input.pack);
	}
	if (input.amountCents !== undefined) {
		body.amountCents = input.amountCents;
	}
	if (input.successUrl) {
		body.successUrl = input.successUrl;
	}
	const resp = await fetch(`${BASE}/topup`, {
		method: "POST",
		headers: {
			...authHeaders(),
			"Idempotency-Key": crypto.randomUUID(),
		},
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as { url?: string; quote?: TopupQuote };
	if (!json.url) {
		throw new CreditsError("unknown", "Checkout session has no URL.");
	}
	return { url: json.url, quote: json.quote ?? null };
}

// --- Automatic recharge (auto top-up) ---------------------------------------
// OpenRouter-style off-session refill: when the org's balance drops below a
// threshold, the server charges a fixed Polar product (the buyer's saved card)
// and credits the wallet. Threshold + top-up amount are held in cents (the
// server's `/autotopup` wire unit, converted to micro-USD on save); the optional
// monthly cap bounds total auto-recharge spend per calendar month (0 = no cap).
// Enabling is ADMIN-ONLY and requires a saved payment method: enabling with no
// Polar customer returns 409 ("make a manual top-up first"), and with the
// product unconfigured returns 503 — both surfaced as tailored messages.

/**
 * The org's auto-recharge settings as the server returns them
 * (`serializeAutoTopup`). All money fields are integer cents / micro-USD; status
 * fields report the last off-session attempt and the running monthly spend.
 */
export interface AutoTopupSettings {
	amountCents: number;
	consecutiveFailures: number;
	cooldownSec: number;
	enabled: boolean;
	lastAttemptAt: string | null;
	lastError: string | null;
	/** Total auto-recharge charged so far in the current `monthKey`, micro-USD. */
	monthChargedMicroUsd: number;
	/** Calendar-month bucket for {@link monthChargedMicroUsd}, e.g. "2026-07". */
	monthKey: string | null;
	/** Per-calendar-month spend cap in cents; 0 = no cap. */
	monthlyCapCents: number;
	thresholdCents: number;
}

/** The `PUT /autotopup` body: enable/disable + the recharge parameters. */
export interface AutoTopupInput {
	/** Fixed top-up amount charged each recharge, cents (bounds $5–$1000). */
	amountCents: number;
	/** Minimum seconds between off-session charges (server floors at 60). */
	cooldownSec?: number;
	enabled: boolean;
	/** Per-calendar-month spend cap in cents; 0 = no cap. */
	monthlyCapCents?: number;
	/** Recharge fires when the balance falls below this, cents (must be > 0). */
	thresholdCents: number;
}

/** Coerce the server's `{ settings }` envelope into a typed view (or null). */
function toAutoTopupSettings(raw: unknown): AutoTopupSettings | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const s = raw as Record<string, unknown>;
	const num = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	return {
		amountCents: num(s.amountCents),
		consecutiveFailures: num(s.consecutiveFailures),
		cooldownSec: num(s.cooldownSec),
		enabled: Boolean(s.enabled),
		lastAttemptAt: typeof s.lastAttemptAt === "string" ? s.lastAttemptAt : null,
		lastError: typeof s.lastError === "string" ? s.lastError : null,
		monthChargedMicroUsd: num(s.monthChargedMicroUsd),
		monthKey: typeof s.monthKey === "string" ? s.monthKey : null,
		monthlyCapCents: num(s.monthlyCapCents),
		thresholdCents: num(s.thresholdCents),
	};
}

/** Fetch the active org's auto-recharge settings, or null when unset. */
export async function fetchAutoTopup(): Promise<AutoTopupSettings | null> {
	const resp = await fetch(`${BASE}/autotopup`, { headers: authHeaders() });
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as { settings?: unknown };
	return toAutoTopupSettings(json.settings);
}

/**
 * Enable/update or disable auto-recharge (admin only). Enabling validates the
 * amounts server-side and requires a saved Polar card; 409 (no card) and 503
 * (product unconfigured) are surfaced via {@link CreditsError}.
 */
export async function putAutoTopup(
	input: AutoTopupInput
): Promise<AutoTopupSettings | null> {
	const body: Record<string, unknown> = {
		enabled: input.enabled,
		amountCents: input.amountCents,
		thresholdCents: input.thresholdCents,
	};
	if (input.monthlyCapCents !== undefined) {
		body.monthlyCapCents = input.monthlyCapCents;
	}
	if (input.cooldownSec !== undefined) {
		body.cooldownSec = input.cooldownSec;
	}
	const resp = await fetch(`${BASE}/autotopup`, {
		method: "PUT",
		headers: authHeaders(),
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as { settings?: unknown };
	return toAutoTopupSettings(json.settings);
}

// --- Low-balance email alert -------------------------------------------------
// Email the org's owners (or owners+admins) when the managed wallet balance
// drops below a threshold. `recipients: "none"` is the OFF state. Independent of
// auto-recharge: no saved card required, and the threshold is its own line.

/** Who is emailed on low balance. Mirrors the server's `CreditAlertRecipients`. */
export type CreditAlertRecipients = "none" | "owners" | "owners_admins";

/** The org's low-balance alert settings as the server returns them. */
export interface CreditAlertSettings {
	/** Non-null once an alert has fired for the current below-threshold episode. */
	belowSince: string | null;
	lastError: string | null;
	notifiedAt: string | null;
	recipients: CreditAlertRecipients;
	thresholdCents: number;
}

/** The `PUT /alert` body: who to email + the balance threshold. */
export interface CreditAlertInput {
	recipients: CreditAlertRecipients;
	/** Alert fires when the balance falls below this, cents (required unless "none"). */
	thresholdCents: number;
}

/** Coerce the server's `{ settings }` envelope into a typed view (or null). */
function toCreditAlertSettings(raw: unknown): CreditAlertSettings | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const s = raw as Record<string, unknown>;
	const recipients =
		s.recipients === "owners" || s.recipients === "owners_admins"
			? s.recipients
			: "none";
	return {
		recipients,
		thresholdCents:
			typeof s.thresholdCents === "number" && Number.isFinite(s.thresholdCents)
				? s.thresholdCents
				: 0,
		notifiedAt: typeof s.notifiedAt === "string" ? s.notifiedAt : null,
		belowSince: typeof s.belowSince === "string" ? s.belowSince : null,
		lastError: typeof s.lastError === "string" ? s.lastError : null,
	};
}

/** Fetch the active org's low-balance alert settings, or null when unset. */
export async function fetchCreditAlert(): Promise<CreditAlertSettings | null> {
	const resp = await fetch(`${BASE}/alert`, { headers: authHeaders() });
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as { settings?: unknown };
	return toCreditAlertSettings(json.settings);
}

/**
 * Set who is emailed on low balance + the threshold (admin only). Setting a live
 * config re-arms the alert and fires immediately if the balance is already below.
 */
export async function putCreditAlert(
	input: CreditAlertInput
): Promise<CreditAlertSettings | null> {
	const resp = await fetch(`${BASE}/alert`, {
		method: "PUT",
		headers: authHeaders(),
		body: JSON.stringify({
			recipients: input.recipients,
			thresholdCents: input.thresholdCents,
		}),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as { settings?: unknown };
	return toCreditAlertSettings(json.settings);
}

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

import {
	CREDIT_TOPUP_MAX_CENTS,
	CREDIT_TOPUP_MIN_CENTS,
	CREDIT_TOPUP_PACKS_USD,
	type CreditTopupPackUsd,
} from "@ryu/auth/lib/plans";
import { formatMicroUsd as formatSharedMicroUsd } from "@ryu/ui/lib/number-format.ts";
import { openSse, SseConnectError, type SseMessage } from "@ryuhq/protocol/sse";
import { z } from "zod";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";
import type {
	AutoTopupInput,
	AutoTopupSettings,
	CreditAlertInput,
	CreditAlertSettings,
} from "./credits-settings.ts";
import type {
	UsageFilters,
	UsageResponse,
	WalletResponse,
} from "./credits-wallet.ts";
import {
	autoTopupSettingsSchema,
	creditAlertEventSchema,
	creditAlertSettingsSchema,
	creditsErrorWireSchema,
	creditsSettingsWireSchema,
	topupCheckoutSchema,
	usageResponseSchema,
	walletResponseSchema,
	walletUpdateSchema,
} from "./credits-wire-contracts.ts";

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
export const CREDIT_PACKS = CREDIT_TOPUP_PACKS_USD;
export type CreditPack = CreditTopupPackUsd;

/** Custom top-up bounds, mirroring the server's 500–100000 cents clamp. */
export const MIN_TOPUP_DOLLARS = CREDIT_TOPUP_MIN_CENTS / 100;
export const MAX_TOPUP_DOLLARS = CREDIT_TOPUP_MAX_CENTS / 100;

export {
	CREDIT_LEDGER_REASONS,
	isCreditLedgerReason,
	LEDGER_REASON_LABELS,
	type LedgerReason,
	ledgerReasonLabel,
} from "./credits-ledger.ts";
export type {
	AutoTopupInput,
	AutoTopupSettings,
	CreditAlertInput,
	CreditAlertRecipients,
	CreditAlertSettings,
} from "./credits-settings.ts";
export {
	type CreditProviderAllocation,
	type CreditWallet,
	type LedgerEntry,
	type UsageBreakdownRow,
	type UsageFilters,
	type UsageResponse,
	type UsageStats,
	unrestrictedCreditBalanceMicroUsd,
	type WalletResponse,
} from "./credits-wallet.ts";

/** The Better-Auth session bearer token, or null when signed out / no storage. */
function authToken(): string | null {
	try {
		return getActiveToken();
	} catch {
		// No storage — treated as signed out.
		return null;
	}
}

/** True when the user has a session token; credits require sign-in. */
export function hasCreditsAuth(): boolean {
	return Boolean(authToken());
}

function authHeaders() {
	const headers = new Headers({ "Content-Type": "application/json" });
	const token = authToken();
	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	return headers;
}

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/credits`;

/**
 * Distinguishes the degrade-cleanly states (per the hard rules) from generic
 * failures so the UI can render a tailored message:
 *   - "auth":   401, not signed in.
 *   - "access_policy": 403, the organization's access policy (IP allowlist,
 *     required 2FA, session age) refused this session.
 *   - "no_org": 409, the active org is missing (wallets are org-level).
 *   - "billing": 503, the payment provider is not configured (top-up disabled).
 */
export type CreditsErrorKind =
	| "auth"
	| "access_policy"
	| "no_org"
	| "billing"
	| "unknown";

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
interface CreditsFailureStatus {
	kind: CreditsErrorKind;
	message: string;
}
function classifyStatus(status: number): CreditsFailureStatus {
	if (status === 401) {
		return { kind: "auth", message: "Sign in to view credits." };
	}
	if (status === 403) {
		return {
			kind: "access_policy",
			message: "Your organization's access policy blocked this request.",
		};
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
 *  loop must not treat it as a transient blip. `no_org`, `auth` and
 *  `access_policy` are all fixed by user action elsewhere (create/select an
 *  org, sign in, satisfy the org's policy), never by reconnecting. */
const creditsFailureSchema = z.instanceof(CreditsError);
export function isTerminalCreditsError(
	e: Parameters<typeof creditsFailureSchema.safeParse>[0]
): boolean {
	const parsed = creditsFailureSchema.safeParse(e);
	return (
		parsed.success &&
		(parsed.data.kind === "no_org" ||
			parsed.data.kind === "auth" ||
			parsed.data.kind === "access_policy")
	);
}

async function toError(resp: Response): Promise<CreditsError> {
	let message: string | undefined;
	try {
		const body = creditsErrorWireSchema.parse(await resp.json());
		const detail = body.message ?? body.error;
		if (detail !== undefined && detail !== null) {
			message = String(detail);
		}
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
	return walletResponseSchema.parse(await resp.json());
}

/**
 * One page of the org's usage statement.
 *
 * Keyset-paged on `createdAt`: pass the previous response's `nextCursor` as
 * `before`. Never a page NUMBER — the ledger grows at the head, so an offset page
 * would repeat a row at every boundary as new spend lands mid-read.
 */
export async function fetchUsage(
	filters: UsageFilters = {},
	signal?: AbortSignal
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
		signal,
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	return usageResponseSchema.parse(await resp.json());
}

/**
 * A live wallet-balance snapshot pushed by `GET /api/credits/wallet/stream`
 * (SSE `event: "wallet"`). This is the server's minimal, org-safe balance view —
 * a SUBSET of {@link CreditWallet} (no `ownerType`), so consumers merge these
 * fields into the last full wallet rather than replacing it wholesale.
 */
export interface WalletUpdate {
	/** Sent on the snapshot frame only; balance-change frames omit it. */
	availableMicroUsd?: number;
	balanceMicroUsd: number;
	currency: string;
	/** Sent on the snapshot frame only; balance-change frames omit it. */
	heldMicroUsd?: number;
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

/** Re-throw an SSE connect failure as the {@link CreditsError} kind its HTTP
 *  status means, so a reconnect loop can tell a terminal refusal from a blip. */
function toStreamError(e: unknown): unknown {
	if (e instanceof SseConnectError) {
		const classified = classifyStatus(e.status);
		return new CreditsError(classified.kind, classified.message);
	}
	return e;
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
			decode: walletUpdateSchema.parse,
			token: authToken(),
			signal,
		});
	} catch (e) {
		throw toStreamError(e);
	}
}

/**
 * Open the edge-triggered cloud low-balance notification stream. A failed
 * connect is re-thrown as a {@link CreditsError}, as in `openWalletStream`.
 */
export async function* openCreditAlertStream(
	signal: AbortSignal
): AsyncGenerator<SseMessage<CreditAlertEvent>> {
	try {
		yield* openSse<CreditAlertEvent>(`${BASE}/alert/stream`, {
			decode: creditAlertEventSchema.parse,
			token: authToken(),
			signal,
		});
	} catch (e) {
		throw toStreamError(e);
	}
}

export interface TopupInput {
	/** A custom FACE amount in cents — credited to the wallet (clamped 500–100000). */
	amountCents?: number;
	/** A named pack (100 | 250 | 1000), or omit and pass `amountCents`. */
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

interface TopupWireRequest extends Omit<TopupInput, "pack"> {
	pack?: string;
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
	const body: TopupWireRequest = {};
	if (input.pack !== undefined) {
		body.pack = String(input.pack);
	}
	if (input.amountCents !== undefined) {
		body.amountCents = input.amountCents;
	}
	if (input.successUrl) {
		body.successUrl = input.successUrl;
	}
	const headers = authHeaders();
	headers.set("Idempotency-Key", crypto.randomUUID());
	const resp = await fetch(`${BASE}/topup`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = topupCheckoutSchema.parse(await resp.json());
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


/** Coerce the server's `{ settings }` envelope into a typed view (or null). */
/** Fetch the active org's auto-recharge settings, or null when unset. */
export async function fetchAutoTopup(): Promise<AutoTopupSettings | null> {
	const resp = await fetch(`${BASE}/autotopup`, { headers: authHeaders() });
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = creditsSettingsWireSchema.parse(await resp.json());
	return autoTopupSettingsSchema.parse(json.settings);
}

/**
 * Enable/update or disable auto-recharge (admin only). Enabling validates the
 * amounts server-side and requires a saved Polar card; 409 (no card) and 503
 * (product unconfigured) are surfaced via {@link CreditsError}.
 */
export async function putAutoTopup(
	input: AutoTopupInput
): Promise<AutoTopupSettings | null> {
	const body: AutoTopupInput = {
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
	const json = creditsSettingsWireSchema.parse(await resp.json());
	return autoTopupSettingsSchema.parse(json.settings);
}

// --- Low-balance email alert -------------------------------------------------
// Email the org's owners (or owners+admins) when the managed wallet balance
// drops below a threshold. `recipients: "none"` is the OFF state. Independent of
// auto-recharge: no saved card required, and the threshold is its own line.


/** Coerce the server's `{ settings }` envelope into a typed view (or null). */
/** Fetch the active org's low-balance alert settings, or null when unset. */
export async function fetchCreditAlert(): Promise<CreditAlertSettings | null> {
	const resp = await fetch(`${BASE}/alert`, { headers: authHeaders() });
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = creditsSettingsWireSchema.parse(await resp.json());
	return creditAlertSettingsSchema.parse(json.settings);
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
	const json = creditsSettingsWireSchema.parse(await resp.json());
	return creditAlertSettingsSchema.parse(json.settings);
}

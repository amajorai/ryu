import type { Badge } from "@ryu/ui/components/badge.tsx";
import {
	formatMinorCurrency,
	formatCount as formatSharedCount,
} from "@ryu/ui/lib/number-format.ts";
import type { AppJsonValue } from "@ryuhq/core-client/app-request-json.ts";
import { type ComponentProps, useCallback, useMemo } from "react";
import { z } from "zod";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { makeHeaders } from "@/src/lib/api/client.ts";
import { formatDate as formatDateInZone } from "@/src/lib/timezone.ts";
import { createUgcCall, type UgcCall } from "../ugc-request.ts";
import {
	type CampaignStatus,
	type PayoutRule,
	platformViewSchema,
	type RefreshCounts,
	readUgcList,
	type SubmissionRefreshReport,
	type SubmissionStatus,
	ugcDocumentSchema,
} from "../ugc-wire-contracts.ts";

/** The app that owns this panel. Feature detection keys off it, so a disabled
 *  app renders an enable hint instead of hammering a sidecar that is not there. */
export const UGC_PLUGIN_ID = "@ryu/ugc";

/** Server caps this too; asking for a sane page keeps the panel snappy. */
export const LEADERBOARD_LIMIT = 10;

// ── Formatting ───────────────────────────────────────────────────────────────

/** Integer cents in, display string out. This single division is the ONLY place
 *  money touches a float, and it happens after all arithmetic is done. A field
 *  the sidecar did not send renders as "—" rather than "$NaN". */
export function formatCents(cents: number): string {
	return formatMinorCurrency(cents, "USD");
}

export function formatCount(value: number): string {
	return formatSharedCount(value) ?? "—";
}

export function formatDate(iso: string | null | undefined): string {
	if (!iso) {
		return "—";
	}
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) {
		return iso;
	}
	return formatDateInZone(parsed);
}

/** Accepts `12`, `12.5`, `$12.50`. Returns integer cents, or null when the text
 *  is not a money amount — parsed digit-wise so a typed amount never round-trips
 *  through a float. */
const DOLLARS_RE = /^\s*\$?\s*(\d+)(?:\.(\d{1,2}))?\s*$/;

export function dollarsToCents(input: string): number | null {
	const match = DOLLARS_RE.exec(input);
	if (!match) {
		return null;
	}
	const whole = Number.parseInt(match[1], 10);
	const fraction = (match[2] ?? "").padEnd(2, "0");
	return whole * 100 + Number.parseInt(fraction, 10);
}

/** A counter is a whole number of people, not money, so it never goes through
 *  `dollarsToCents`. Digit-only on purpose: `1e4`, `12.5` and `1,200` all parse
 *  to something under `Number.parseInt` that is not what was typed, and the
 *  sidecar rejects a negative with a 400 rather than storing it. A blank box is
 *  0 — the POST appends a whole snapshot, so there is no "leave this one alone". */
const COUNT_RE = /^\d{1,15}$/;

export function parseCount(input: string): number | null {
	const trimmed = input.trim();
	if (trimmed === "") {
		return 0;
	}
	if (!COUNT_RE.test(trimmed)) {
		return null;
	}
	return Number.parseInt(trimmed, 10);
}

/** The campaign's pricing rule in words. A campaign the sidecar priced at zero
 *  says so out loud — that is the state a mis-sent rule leaves behind, and it is
 *  invisible if the panel only ever shows the resulting $0.00 accruals. */
export function formatPayoutRule(rule: PayoutRule | undefined): string {
	if (!rule) {
		return "No payout rule";
	}
	return rule.type === "cpm"
		? `${formatCents(rule.cpm_cents)} per 1,000 views`
		: `${formatCents(rule.flat_cents)} per approved post`;
}

/** Spend as a whole percentage of budget, in integer cents. A 0 budget means
 *  "uncapped" in this app's schema, so there is no percentage to show. */
export function spendPercent(
	spentCents: number,
	budgetCents: number
): number | null {
	if (budgetCents <= 0) {
		return null;
	}
	return Math.min(100, Math.round((spentCents * 100) / budgetCents));
}

// ── Transport ────────────────────────────────────────────────────────────────

/** Pull the sidecar's own message out of a failed response.
 *
 *  The Browser panel throws the bare status code because its only failure mode is
 *  "sidecar unreachable". Ours has failures the operator must read: a 409 for a
 *  post already submitted to this campaign, a 409 for approving an already-paid
 *  payout, a 400 for a platform with no curated Composio source, a 502 carrying
 *  Composio's own error. Swallowing those into "409" would be a fake explanation. */
/** Resolve the selected node and retain its native public-mount HTTP contract. */
export function useUgcCall(): UgcCall {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;
	const userJwt = node.userJwt ?? null;
	const headers = useMemo(() => makeHeaders(token, userJwt), [token, userJwt]);
	return useCallback(createUgcCall({ token, url, userJwt }, headers), [
		headers,
		token,
		url,
		userJwt,
	]);
}

export const describeError = z
	.instanceof(Error)
	.transform((error) => error.message)
	.catch("Request failed").parse;

// ── Refresh + provider status readers ────────────────────────────────────────

/** `/platforms` owns both the curated metric sources and the managed provider
 *  status. The satellite does not own a Composio credential or key-setting API. */
export function readPlatformCatalog(data: AppJsonValue) {
	const document = ugcDocumentSchema.safeParse(data);
	return {
		composioConfigured: z
			.boolean()
			.nullable()
			.catch(null)
			.parse(document.success ? document.data.composio_configured : null),
		platforms: readUgcList(data, "platforms", platformViewSchema),
	};
}

/** Tally the rows this panel is about to render. Used when the sidecar sent no
 *  well-formed `counts`, so the summary line can never disagree with the list
 *  underneath it. */
export function tallyRefresh(
	results: SubmissionRefreshReport[]
): RefreshCounts {
	const counts: RefreshCounts = { error: 0, needs_connection: 0, ok: 0 };
	for (const row of results) {
		if (row.status === "ok") {
			counts.ok += 1;
		} else if (row.status === "needs_connection") {
			counts.needs_connection += 1;
		} else {
			counts.error += 1;
		}
	}
	return counts;
}

/** What a refresh run actually did, in words, from the real three-way split.
 *
 *  Never "refreshed 12 submissions" when 4 of those 12 wrote nothing: an
 *  unlinked account and a read that failed are separate outcomes with separate
 *  fixes, so both are named. */
export function describeRefreshCounts(counts: RefreshCounts): string {
	const parts = [`${counts.ok} refreshed`];
	if (counts.needs_connection > 0) {
		parts.push(
			`${counts.needs_connection} need${
				counts.needs_connection === 1 ? "s" : ""
			} a connection`
		);
	}
	if (counts.error > 0) {
		parts.push(`${counts.error} failed`);
	}
	return parts.join(" · ");
}

// ── Small shared pieces ──────────────────────────────────────────────────────

export const CAMPAIGN_STATUS_VARIANT = {
	active: "default",
	draft: "outline",
	ended: "secondary",
	paused: "secondary",
} satisfies Record<CampaignStatus, ComponentProps<typeof Badge>["variant"]>;

export const SUBMISSION_STATUS_VARIANT = {
	approved: "default",
	paid: "secondary",
	pending: "outline",
	rejected: "destructive",
} satisfies Record<SubmissionStatus, ComponentProps<typeof Badge>["variant"]>;

export const PAYOUT_STATUS_VARIANT = new Map<
	string,
	ComponentProps<typeof Badge>["variant"]
>([
	["accrued", "outline"],
	["approved", "default"],
	["paid", "secondary"],
]);

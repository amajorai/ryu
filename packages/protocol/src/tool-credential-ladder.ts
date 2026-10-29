/**
 * Tool credential ladder (Treg parity B5): which key pays for one call to a
 * third-party tool vendor endpoint, and whether Ryu meters it.
 *
 * TypeScript twin of `crates/gateway/contracts/src/tool_credential_ladder.rs`.
 * Both assert `crates/gateway/contracts/fixtures/tool-credential-ladder-cases-v1.json`.
 *
 * Rungs, most specific first: `team` (the team's own `tool:<vendor>` key),
 * `org` (the organization's own key), `operator` (Ryu's key, metered, only for
 * a verified price, or a documented one when the deployment allows it), and
 * `treg` (Treg's relay, metered by the Gateway, only for an endpoint Ryu does
 * not serve or a call that named Treg).
 *
 * - A call on the tenant's own key is never metered.
 * - The caller chooses the provider; Treg is never a silent failover for an
 *   endpoint Ryu serves.
 * - A tenant key that is not active never falls through to the operator key
 *   (`credential_invalid`); it may fall through to the other tenant rung.
 * - An operator key whose price is not verified is never used
 *   (`operator_price_unverified`).
 */

import { z } from "zod";
import {
	type CandidateStatus,
	type CredentialRef,
	type CredentialSlot,
	isValidCredentialSlot,
	parseCredentialSlot,
} from "./credential-scope.ts";

export const TOOL_LADDER_CONTRACT_VERSION = 1 as const;

export const LADDER_REFUSED_INVALID_SLOT = "invalid_slot";
export const LADDER_REFUSED_ENDPOINT_NOT_SERVED = "endpoint_not_served";
export const LADDER_REFUSED_CREDENTIAL_INVALID = "credential_invalid";
export const LADDER_REFUSED_OPERATOR_PRICE_UNVERIFIED =
	"operator_price_unverified";
export const LADDER_REFUSED_CREDENTIAL_REQUIRED = "credential_required";

export type LadderRefusalCode =
	| typeof LADDER_REFUSED_INVALID_SLOT
	| typeof LADDER_REFUSED_ENDPOINT_NOT_SERVED
	| typeof LADDER_REFUSED_CREDENTIAL_INVALID
	| typeof LADDER_REFUSED_OPERATOR_PRICE_UNVERIFIED
	| typeof LADDER_REFUSED_CREDENTIAL_REQUIRED;

export type Rung = "team" | "org" | "operator" | "treg";
export const RUNGS: readonly Rung[] = ["team", "org", "operator", "treg"];

export type ProviderChoice = "any" | "ryu" | "treg";
export type RungPrice = "verified" | "documented" | "unverified" | "missing";

export type RungStatus =
	| "not_in_scope"
	| "empty"
	| "inactive"
	| "selected"
	| "shadowed"
	| "skipped"
	| "no_key"
	| "price_missing"
	| "price_unverified"
	| "price_documented_only"
	| "not_served"
	| "ryu_serves"
	| "not_requested";

export interface RungCandidate {
	credentialRef: CredentialRef;
	status: CandidateStatus;
}

export interface TenantRung {
	candidate: RungCandidate | null;
	/** The caller has an owner at this level, bound server-side. */
	inScope: boolean;
}

export interface LadderInput {
	/** The deployment admits documented (not yet verified) operator prices. */
	allowDocumented: boolean;
	operator: { hasKey: boolean; price: RungPrice };
	org: TenantRung;
	provider: ProviderChoice;
	/** Ryu can call the endpoint itself. */
	ryuServes: boolean;
	slot: CredentialSlot;
	team: TenantRung;
	treg: { serves: boolean };
}

export interface RungTrace {
	rung: Rung;
	status: RungStatus;
}

export type LadderOutcome =
	| {
			type: "selected";
			rung: Rung;
			/** The tenant key used; absent for the operator and Treg rungs. */
			credentialRef?: CredentialRef;
			/** Whether Ryu meters the call. Always false on a tenant rung. */
			metered: boolean;
	  }
	| { type: "refused"; code: LadderRefusalCode };

export interface LadderResolution {
	outcome: LadderOutcome;
	trace: RungTrace[];
}

const refused = (code: LadderRefusalCode): LadderOutcome => ({
	type: "refused",
	code,
});

/** Resolve which rung pays for one vendor call. See the module docs. */
export const resolveToolLadder = (input: LadderInput): LadderResolution => {
	if (
		input.slot.purpose !== "tool_vendor" ||
		!isValidCredentialSlot(input.slot)
	) {
		return { outcome: refused(LADDER_REFUSED_INVALID_SLOT), trace: [] };
	}
	const ryuPath = input.provider !== "treg";
	const trace: RungTrace[] = [];
	let outcome: LadderOutcome | null = null;
	let inactiveSeen = false;

	for (const [rung, tenant] of [
		["team", input.team],
		["org", input.org],
	] as const) {
		let status: RungStatus;
		const candidate = tenant.candidate;
		if (!ryuPath) {
			status = "not_requested";
		} else if (!input.ryuServes) {
			status = "not_served";
		} else if (!tenant.inScope) {
			status = "not_in_scope";
		} else if (candidate === null) {
			status = "empty";
		} else if (candidate.status !== "active") {
			inactiveSeen = true;
			status = "inactive";
		} else if (outcome === null) {
			outcome = {
				type: "selected",
				rung,
				credentialRef: candidate.credentialRef,
				metered: false,
			};
			status = "selected";
		} else {
			status = "shadowed";
		}
		trace.push({ rung, status });
	}

	const { operator } = input;
	let operatorStatus: RungStatus;
	if (!ryuPath) {
		operatorStatus = "not_requested";
	} else if (!input.ryuServes) {
		operatorStatus = "not_served";
	} else if (!operator.hasKey) {
		operatorStatus = "no_key";
	} else if (operator.price === "missing") {
		operatorStatus = "price_missing";
	} else if (operator.price === "unverified") {
		operatorStatus = "price_unverified";
	} else if (operator.price === "documented" && !input.allowDocumented) {
		operatorStatus = "price_documented_only";
	} else if (outcome !== null) {
		operatorStatus = "shadowed";
	} else if (inactiveSeen) {
		operatorStatus = "skipped";
	} else {
		outcome = { type: "selected", rung: "operator", metered: true };
		operatorStatus = "selected";
	}
	trace.push({ rung: "operator", status: operatorStatus });

	let tregStatus: RungStatus;
	if (input.provider === "ryu") {
		tregStatus = "not_requested";
	} else if (input.provider === "any" && input.ryuServes) {
		tregStatus = "ryu_serves";
	} else if (input.treg.serves) {
		outcome = { type: "selected", rung: "treg", metered: true };
		tregStatus = "selected";
	} else {
		tregStatus = "not_served";
	}
	trace.push({ rung: "treg", status: tregStatus });

	if (outcome !== null) {
		return { outcome, trace };
	}
	if (!(ryuPath && input.ryuServes)) {
		return { outcome: refused(LADDER_REFUSED_ENDPOINT_NOT_SERVED), trace };
	}
	if (inactiveSeen) {
		return { outcome: refused(LADDER_REFUSED_CREDENTIAL_INVALID), trace };
	}
	return {
		outcome: refused(
			operator.hasKey
				? LADDER_REFUSED_OPERATOR_PRICE_UNVERIFIED
				: LADDER_REFUSED_CREDENTIAL_REQUIRED
		),
		trace,
	};
};

const credentialRefSchema = z.strictObject({
	fingerprint: z.string(),
	id: z.string(),
	version: z.number().int().nonnegative(),
});

const tenantRungSchema = z.strictObject({
	candidate: z
		.strictObject({
			credentialRef: credentialRefSchema,
			status: z.enum(["active", "disabled", "expired", "revoked"]),
		})
		.nullable(),
	inScope: z.boolean(),
});

const slotSchema = z.string().transform((value, context) => {
	const parsed = parseCredentialSlot(value);
	if (!parsed.ok) {
		context.addIssue({ code: "custom", message: parsed.error.reason });
		return z.NEVER;
	}
	return parsed.value;
});

const inputSchema = z.strictObject({
	allowDocumented: z.boolean().default(false),
	operator: z.strictObject({
		hasKey: z.boolean(),
		price: z.enum(["verified", "documented", "unverified", "missing"]),
	}),
	org: tenantRungSchema,
	provider: z.enum(["any", "ryu", "treg"]).default("any"),
	ryuServes: z.boolean(),
	slot: slotSchema,
	team: tenantRungSchema,
	treg: z.strictObject({ serves: z.boolean() }),
});

/** Decode a wire `LadderInput` (camelCase, the slot as its id string). */
export const decodeLadderInput = (value: unknown): LadderInput =>
	inputSchema.parse(value);

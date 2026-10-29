import { OrganizationSeatEntitlement } from "@ryu/db/models/organization-seat-entitlement.model";
import { z } from "zod";
import { PLANS } from "./plans.ts";

export interface TeamsSeatAllowance {
	/** Seats represented by the active Polar quantity and invoice. */
	billedSeats: number;
	/** When the private capacity ends, or null for an ongoing grant. */
	bonusExpiresAt: Date | null;
	/** Active private capacity granted without changing the invoice. */
	bonusSeats: number;
	/** The admission ceiling for organization members. */
	includedSeats: number;
}

export interface TeamsSeatContractLike {
	bonusExpiresAt?: Date | string | null;
	bonusSeats?: number | null;
	contractedSeats?: number | null;
}

const teamsSeatContractSchema = z
	.object({
		bonusExpiresAt: z.union([z.date(), z.string()]).nullish().catch(null),
		bonusSeats: z.coerce.number().nullish().catch(0),
		contractedSeats: z.coerce.number().nullish().catch(0),
	})
	.nullish()
	.catch(null);

/** The minimum billed quantity for the Teams product. */
export const teamsSeatMinimum = (): number => {
	const model = PLANS.teams.seatModel;
	return model.kind === "per_seat" ? model.minSeats : 1;
};

const normalizedWholeNumber = (
	value: number | null | undefined,
	fallback: number
): number => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
};

/** Parse a persisted support-grant expiry without trusting an invalid date. */
export const teamsSeatBonusExpiry = z
	.union([
		z.date(),
		z
			.string()
			.trim()
			.min(1)
			.transform((value) => new Date(value))
			.pipe(z.date()),
	])
	.nullable()
	.catch(null).parse;

/**
 * Resolve the effective Teams seat allowance from a billed quantity and an
 * optional private grant. Bonus capacity is access-only: it never changes the
 * billed quantity, the credit pool, or the node tier.
 */
export const teamsSeatAllowanceFromContract = (
	contract: z.input<typeof teamsSeatContractSchema>,
	now = new Date()
): TeamsSeatAllowance => {
	const parsed = teamsSeatContractSchema.parse(contract);
	const minimum = teamsSeatMinimum();
	const billedSeats = Math.max(
		minimum,
		normalizedWholeNumber(parsed?.contractedSeats, minimum)
	);
	const bonusExpiresAt = teamsSeatBonusExpiry(parsed?.bonusExpiresAt);
	const bonusIsActive =
		bonusExpiresAt === null || bonusExpiresAt.getTime() > now.getTime();
	const bonusSeats = bonusIsActive
		? normalizedWholeNumber(parsed?.bonusSeats, 0)
		: 0;
	return {
		billedSeats,
		bonusSeats,
		includedSeats: billedSeats + bonusSeats,
		bonusExpiresAt,
	};
};

/**
 * Read the active negotiated seat row. A database failure is intentionally
 * allowed to reject the caller: membership admission must not make a blind
 * authorization decision when the private contract cannot be verified.
 */
export async function activeTeamsSeatAllowance(
	organizationId: string,
	billedSeats: number,
	now = new Date()
): Promise<TeamsSeatAllowance> {
	const contract = await OrganizationSeatEntitlement.findOne({
		organizationId,
		status: "active",
	})
		.lean<TeamsSeatContractLike>()
		.exec();
	return teamsSeatAllowanceFromContract(
		{ ...contract, contractedSeats: billedSeats },
		now
	);
}

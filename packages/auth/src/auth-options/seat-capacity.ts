import { createHash } from "node:crypto";
import { APIError } from "better-auth/api";
import { isSelfHostedDeployment } from "../lib/deployment-mode.ts";
import {
	type OrganizationSeatCopy,
	organizationSeatCopy,
} from "../lib/family-admission.ts";
import { familySharingCapacity } from "../lib/family-sharing.ts";
import { normalizeInvitationEmail } from "../lib/organization-invitation-policy.ts";
import {
	FAMILY_ORGANIZATION_KIND,
	type OrganizationKind,
	readOrganizationKind,
} from "../lib/organization-kind.ts";
import { activeTeamsSeatAllowance } from "../lib/organization-seat-entitlement.ts";
import { polarClient } from "../lib/payments.ts";
import {
	ORGANIZATION_PLAN_IDS,
	PLANS,
	planByProductId,
	resolveProductId,
} from "../lib/plans.ts";
import { resolveOrganizationPolarCustomerId } from "../lib/polar-customer-identity.ts";
import {
	type SelfHostedSeatAllowance,
	selfHostedSeatCopy,
} from "../lib/self-hosted-member-limit.ts";

import { polarPageItems } from "./schemas.ts";
import { selfHostedInstallAllowance } from "./self-hosted-seats.ts";

// Organization seat capacity: how many seats a Teams or family organization
// may hold, from its Polar subscriptions and entitlements, or from the
// install's member allowance when the control plane is explicitly self-hosted.

/** The admitting capacity of one organization and what it was resolved from. */
export interface OrganizationSeatCapacity {
	kind: OrganizationKind | null;
	seatCapacity: number | null;
	/**
	 * Present only when `RYU_DEPLOYMENT_MODE=self-hosted` and the organization
	 * is not a family: the capacity is the install's member allowance, not a
	 * paid plan. Absent (not even `undefined`) on the hosted cloud, so the cloud
	 * result has exactly the two fields it always had.
	 */
	selfHosted?: SelfHostedSeatAllowance;
}

const ORGANIZATION_PRODUCT_IDS = (): Set<string> =>
	new Set(
		ORGANIZATION_PLAN_IDS.flatMap((planId) =>
			Object.values(PLANS[planId].bindings)
				.filter((binding): binding is NonNullable<typeof binding> =>
					Boolean(binding)
				)
				.map((binding) => resolveProductId(binding))
				.filter((productId) => !productId.startsWith("polar_product_"))
		)
	);

/**
 * Resolve the live admitting capacity for an organization, with the org kind
 * it was resolved for (the kind picks the refusal copy).
 *
 * - family: the Ryu Max family-sharing capacity registered by the API (six
 *   people when the owner's plan and the rollout flag allow it, else null). It
 *   never reads a Polar seat quantity or bonus seats: a family's plan is the
 *   owner's personal Max subscription, not a seat contract.
 * - self-hosted install (`RYU_DEPLOYMENT_MODE=self-hosted`, and only then):
 *   the install's member allowance, three people or the seat count of its
 *   license. Polar is not read. See `self-hosted-member-limit.ts`.
 * - otherwise: the live Teams seat quantity. A missing active Teams
 *   subscription returns null (shared membership has no paid capacity).
 *
 * A Polar or database failure is a hard error because allowing a paid-org
 * membership change while the meter is unknown would be an authorization
 * decision made blind.
 */
export async function activeOrganizationSeatCapacity(
	organizationId: string
): Promise<OrganizationSeatCapacity> {
	try {
		const kind = await readOrganizationKind(organizationId);
		if (kind === FAMILY_ORGANIZATION_KIND) {
			return {
				kind,
				seatCapacity: await familySharingCapacity(organizationId),
			};
		}
		if (isSelfHostedDeployment()) {
			const selfHosted = await selfHostedInstallAllowance();
			return { kind, seatCapacity: selfHosted.limit, selfHosted };
		}
		const customerId = await resolveOrganizationPolarCustomerId(organizationId);
		if (!customerId) {
			return { kind, seatCapacity: null };
		}

		const subscriptions = await polarClient.subscriptions.list({
			customerId,
			// Keep invitation authorization aligned with the billing router's
			// organization subscription resolver; old records must not hide a live plan.
			limit: 100,
		});
		const productIds = ORGANIZATION_PRODUCT_IDS();
		for await (const page of subscriptions) {
			const active = polarPageItems(page).find((subscription) => {
				const status = (subscription.status ?? "").toLowerCase();
				const productId =
					subscription.productId ?? subscription.product?.id ?? null;
				return (
					(status === "active" || status === "trialing") &&
					Boolean(productId && productIds.has(productId))
				);
			});
			if (active) {
				const productId = active.productId ?? active.product?.id ?? null;
				const activePlan = productId
					? planByProductId().get(productId)?.plan
					: null;
				const requested = Number(active.seats ?? active.quantity);
				const minimum =
					activePlan?.seatModel.kind === "per_seat"
						? activePlan.seatModel.minSeats
						: 1;
				const billedSeats = Number.isFinite(requested)
					? Math.max(Math.floor(requested), minimum)
					: minimum;
				return {
					kind,
					seatCapacity: (
						await activeTeamsSeatAllowance(organizationId, billedSeats)
					).includedSeats,
				};
			}
		}
		return { kind, seatCapacity: null };
	} catch (error) {
		console.error("Failed to verify organization seat capacity:", error);
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message:
				"We could not verify the organization’s seat capacity. Try again.",
		});
	}
}

/**
 * The live PAID capacity alone (Teams seats or family capacity); see
 * {@link activeOrganizationSeatCapacity}. Organization deletion reads it to
 * refuse while a plan is active. A self-hosted install's member allowance is
 * not a plan, so it reports null here and never blocks a deletion.
 */
export async function activeTeamsSeatCount(
	organizationId: string
): Promise<number | null> {
	const capacity = await activeOrganizationSeatCapacity(organizationId);
	return capacity.selfHosted ? null : capacity.seatCapacity;
}

export const SEAT_CLAIM_TTL_MS = 2 * 60 * 1000;
export const ORGANIZATION_INVITATION_EXPIRES_IN_SEC = 48 * 60 * 60;
const PENDING_INVITATION_CLAIM_PREFIX = "pending_invitation:";
const DIRECT_MEMBER_CLAIM_PREFIX = "direct_member:";

export const pendingInvitationClaimId = (
	organizationId: string,
	email: string
): string =>
	`${PENDING_INVITATION_CLAIM_PREFIX}${createHash("sha256")
		.update(`${organizationId}:${normalizeInvitationEmail(email)}`)
		.digest("hex")}`;

export const directMemberClaimId = (userId: string): string =>
	`${DIRECT_MEMBER_CLAIM_PREFIX}${userId}`;

/** Seat refusal copy; the self-hosted copy also carries a stable code. */
export type SeatRefusalCopy = OrganizationSeatCopy & {
	readonly code?: string;
};

/**
 * The body of a seat refusal: the sentence, plus the stable code when the copy
 * has one. Teams and family copy have none, so their body is `{ message }`
 * exactly as before.
 */
export const seatRefusal = (
	copy: SeatRefusalCopy,
	message: string
): { code?: string; message: string } =>
	copy.code ? { code: copy.code, message } : { message };

export async function requireActiveOrganizationSeatCapacity(
	organizationId: string
): Promise<{
	copy: SeatRefusalCopy;
	seatCapacity: number;
	selfHosted?: SelfHostedSeatAllowance;
}> {
	const { kind, seatCapacity, selfHosted } =
		await activeOrganizationSeatCapacity(organizationId);
	const copy: SeatRefusalCopy = selfHosted
		? selfHostedSeatCopy(selfHosted)
		: organizationSeatCopy(kind);
	if (seatCapacity === null) {
		throw new APIError("FORBIDDEN", seatRefusal(copy, copy.noCapacity));
	}
	return selfHosted
		? { copy, seatCapacity, selfHosted }
		: { copy, seatCapacity };
}

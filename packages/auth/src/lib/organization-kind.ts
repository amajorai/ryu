import { Member, Organization } from "@ryu/db/models/control-plane.model";
import { z } from "zod";
import {
	claimFamilyMembershipSlot,
	confirmFamilyMembershipSlot,
	releaseFamilyMembershipSlot,
	releaseFamilyMembershipSlotsForOrganization,
} from "./family-membership-slots.ts";
import { businessEmailDomainDecision } from "./organization-email-policy.ts";

export const ORGANIZATION_KIND_KEY = "organizationKind" as const;
export const PERSONAL_ORGANIZATION_KIND = "personal" as const;
export const TEAMS_ORGANIZATION_KIND = "teams" as const;
/**
 * The owner's personal organization promoted in place for Ryu Max family
 * sharing. Same id, wallet, data and Polar subscription as the personal org it
 * came from; it is never created through `/organization/create`.
 */
export const FAMILY_ORGANIZATION_KIND = "family" as const;

const BA_OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

export type OrganizationKind =
	| typeof PERSONAL_ORGANIZATION_KIND
	| typeof TEAMS_ORGANIZATION_KIND
	| typeof FAMILY_ORGANIZATION_KIND;

const ORGANIZATION_KINDS: readonly OrganizationKind[] = [
	PERSONAL_ORGANIZATION_KIND,
	TEAMS_ORGANIZATION_KIND,
	FAMILY_ORGANIZATION_KIND,
];

function isOrganizationKind(value: unknown): value is OrganizationKind {
	return ORGANIZATION_KINDS.some((kind) => kind === value);
}

const organizationMetadataSchema = z
	.record(z.string(), z.json())
	.catch(() => ({}));
const organizationMetadataBoundarySchema = z.preprocess(
	(value) => value,
	z.union([
		z
			.string()
			.transform((source) => {
				try {
					return JSON.parse(source);
				} catch {
					return {};
				}
			})
			.pipe(organizationMetadataSchema),
		organizationMetadataSchema,
	])
);
export type OrganizationMetadata = z.infer<typeof organizationMetadataSchema>;
export type OrganizationMetadataInput = z.input<
	typeof organizationMetadataBoundarySchema
>;

export const parseOrganizationMetadata =
	organizationMetadataBoundarySchema.parse;

export function organizationKindFromMetadata(
	metadata: OrganizationMetadataInput
): OrganizationKind | null {
	const value = parseOrganizationMetadata(metadata)[ORGANIZATION_KIND_KEY];
	return isOrganizationKind(value) ? value : null;
}

/** The organization fields a kind is read from. */
export interface OrganizationKindRecord {
	metadata?: OrganizationMetadataInput;
	organizationKind?: unknown;
}

/** The projection that loads an {@link OrganizationKindRecord}. */
export const ORGANIZATION_KIND_RECORD_FIELDS = "metadata organizationKind";

/**
 * The kind of a stored organization: the authoritative top-level
 * `organizationKind` field when present, else the metadata key.
 *
 * WHY TWO PLACES: Better Auth's organization update rewrites the whole
 * metadata string from a read it took before its write, so a family
 * enable/disable landing in between can be silently undone in metadata.
 * `setOrganizationKind` writes both in one compare-and-set and Better Auth
 * never writes the field, so it survives; `reconcileOrganizationKindMetadata`
 * then restores the metadata key. Orgs whose kind never changed after creation
 * carry only the metadata key.
 */
export function organizationKindFromRecord(
	record: OrganizationKindRecord | null | undefined
): OrganizationKind | null {
	if (!record) {
		return null;
	}
	return isOrganizationKind(record.organizationKind)
		? record.organizationKind
		: organizationKindFromMetadata(record.metadata);
}

/**
 * Whether a Better Auth member role string (comma-separated for additive roles
 * such as `owner,billing`) carries the owner role.
 */
export function memberRoleIncludesOwner(
	role: string | null | undefined
): boolean {
	return (role ?? "")
		.split(",")
		.map((part) => part.trim())
		.includes("owner");
}

/**
 * The personal-org decision both `resolvePersonalOrgId` copies share, applied to
 * a user's EARLIEST membership. A paid Teams conversion is never personal. A
 * family org stays the OWNER's personal org (their Max subscription, gifts and
 * payouts stay on it) but is never a non-owner member's, so a member's payouts
 * cannot land in the family pool.
 */
export function personalOrganizationIdForEarliestMembership(input: {
	kind: OrganizationKind | null;
	organizationId: string;
	role: string | null | undefined;
}): string | null {
	if (input.kind === TEAMS_ORGANIZATION_KIND) {
		return null;
	}
	if (
		input.kind === FAMILY_ORGANIZATION_KIND &&
		!memberRoleIncludesOwner(input.role)
	) {
		return null;
	}
	return input.organizationId;
}

/**
 * Whether a durable kind transition is allowed. Family is entered only from a
 * personal (or legacy-unset) org and is left only for personal; Teams is never
 * entered from family, so neither a business-email change nor a stray Teams
 * subscription event can turn a family into an unpaid or unexpected Teams org.
 */
export function organizationKindTransitionAllowed(
	from: OrganizationKind | null,
	to: OrganizationKind
): boolean {
	if (from === to) {
		return true;
	}
	if (to === FAMILY_ORGANIZATION_KIND) {
		return from === null || from === PERSONAL_ORGANIZATION_KIND;
	}
	if (to === TEAMS_ORGANIZATION_KIND) {
		return from !== FAMILY_ORGANIZATION_KIND;
	}
	return from === FAMILY_ORGANIZATION_KIND;
}

/** The stored kind of one organization, or null when absent, unset or unknown. */
export async function readOrganizationKind(
	organizationId: string
): Promise<OrganizationKind | null> {
	if (!BA_OBJECT_ID_RE.test(organizationId)) {
		return null;
	}
	const organization = await Organization.findById(organizationId)
		.select(ORGANIZATION_KIND_RECORD_FIELDS)
		.lean<StoredKindRecord>();
	return organizationKindFromRecord(organization);
}

interface StoredKindRecord {
	metadata?: string;
	organizationKind?: unknown;
}

/**
 * Restore the metadata kind from the authoritative field when they disagree:
 * Better Auth's organization update can write back a metadata string read
 * before a concurrent kind change. Compare-and-set over the pair it read, so
 * it never overwrites a newer update; retried a few times if one lands.
 * Returns whether it repaired anything.
 */
export async function reconcileOrganizationKindMetadata(
	organizationId: string
): Promise<boolean> {
	if (!BA_OBJECT_ID_RE.test(organizationId)) {
		return false;
	}
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const organization = await Organization.findById(organizationId)
			.select(ORGANIZATION_KIND_RECORD_FIELDS)
			.lean<StoredKindRecord>();
		const authoritative = isOrganizationKind(organization?.organizationKind)
			? organization.organizationKind
			: null;
		if (
			!(organization && authoritative) ||
			organizationKindFromMetadata(organization.metadata) === authoritative
		) {
			return false;
		}
		const result = await Organization.updateOne(
			{
				_id: organizationId,
				metadata: organization.metadata ?? null,
				organizationKind: authoritative,
			},
			{
				$set: {
					metadata: JSON.stringify(
						metadataWithOrganizationKind(organization.metadata, authoritative)
					),
				},
			}
		);
		if (result.modifiedCount === 1) {
			return true;
		}
	}
	return false;
}

interface FamilyOrganizationRow extends StoredKindRecord {
	_id: unknown;
	name?: string | null;
}

/**
 * The family orgs among `organizationIds`, mapped to their display names. The
 * kind is read as {@link organizationKindFromRecord} reads it, not queried.
 */
export async function familyOrganizationNamesAmong(
	organizationIds: readonly string[]
): Promise<Map<string, string>> {
	if (organizationIds.length === 0) {
		return new Map();
	}
	const organizations = await Organization.find({
		_id: { $in: [...organizationIds] },
	})
		.select(`${ORGANIZATION_KIND_RECORD_FIELDS} name`)
		.lean<FamilyOrganizationRow[]>();
	return new Map(
		organizations
			.filter(
				(organization) =>
					organizationKindFromRecord(organization) === FAMILY_ORGANIZATION_KIND
			)
			.map((organization) => [
				String(organization._id),
				organization.name?.trim() ?? "",
			])
	);
}

/**
 * The family orgs a user is a member of, in membership order, optionally
 * excluding one. `userFamilyOrganizationIds` in `family-sharing.ts` is the
 * public name; it lives here so the family promotion can claim the owner's
 * family place without an import cycle.
 */
export async function familyOrganizationIdsForUser(
	userId: string,
	options: { excludeOrganizationId?: string | null } = {}
): Promise<string[]> {
	const memberships = await Member.find({ userId })
		.select("organizationId")
		.lean<Array<{ organizationId: unknown }>>();
	const candidateIds = [
		...new Set(
			memberships.map((membership) => String(membership.organizationId))
		),
	].filter(
		(organizationId) => organizationId !== options.excludeOrganizationId
	);
	const families = await familyOrganizationNamesAmong(candidateIds);
	return candidateIds.filter((organizationId) => families.has(organizationId));
}

export function metadataWithOrganizationKind(
	metadata: OrganizationMetadataInput,
	kind: OrganizationKind,
	extra: OrganizationMetadata = {}
): OrganizationMetadata {
	return {
		...parseOrganizationMetadata(metadata),
		...extra,
		[ORGANIZATION_KIND_KEY]: kind,
	};
}

async function setOrganizationKind(
	organizationId: string,
	kind: OrganizationKind,
	extra: OrganizationMetadata = {}
): Promise<boolean> {
	if (!BA_OBJECT_ID_RE.test(organizationId)) {
		return false;
	}
	const organization = await Organization.findById(organizationId)
		.select(ORGANIZATION_KIND_RECORD_FIELDS)
		.lean<StoredKindRecord>();
	if (!organization) {
		return false;
	}
	const current = organizationKindFromRecord(organization);
	if (current === kind) {
		return true;
	}
	if (!organizationKindTransitionAllowed(current, kind)) {
		return false;
	}

	const metadata = metadataWithOrganizationKind(
		organization.metadata,
		kind,
		extra
	);
	// Compare-and-set on the metadata and authoritative kind the transition was
	// decided from, so a concurrent writer (a family enable racing a Teams
	// promotion) cannot overwrite a kind this check never saw. The loser
	// reports false. The authoritative field is written in the same update so
	// a Better Auth organization update that later writes back stale metadata
	// cannot undo the kind (see `organizationKindFromRecord`).
	const result = await Organization.updateOne(
		{
			_id: organizationId,
			metadata: organization.metadata ?? null,
			organizationKind: organization.organizationKind ?? null,
		},
		{ $set: { metadata: JSON.stringify(metadata), organizationKind: kind } }
	);
	return result.modifiedCount === 1;
}

/**
 * A completed change from a personal mailbox to a company-domain mailbox also
 * changes the org boundary. This keeps a company address from remaining on a
 * personal org before the customer reaches checkout; it preserves the same
 * organization id and does not imply that a paid Teams subscription exists.
 * A family org is left alone: only a personal or legacy-unset org moves to Teams.
 */
export async function promotePersonalOrganizationForBusinessEmail(
	userId: string,
	email: string
): Promise<boolean> {
	if (!businessEmailDomainDecision(email).allowed) {
		return false;
	}
	const firstMember = await Member.findOne({ userId })
		.sort({ createdAt: 1 })
		.select("organizationId")
		.lean<Pick<ReturnType<typeof Member.hydrate>, "organizationId">>();
	if (!firstMember) {
		return false;
	}
	return setOrganizationKind(String(firstMember.organizationId), "teams", {
		organizationKindSource: "business_email",
		organizationKindChangedAt: new Date().toISOString(),
	});
}

/**
 * Convert the original personal org into a Teams org after Polar confirms the
 * paid subscription. The id and all data remain unchanged; only the durable
 * organization-kind marker changes, so membership and wallets keep their
 * existing ownership boundary. Returns false for a family org: Teams checkout
 * refuses one, so a Teams event for it is stray and must not flip its members
 * onto a Teams boundary.
 */
export async function promoteOrganizationToTeams(
	organizationId: string
): Promise<boolean> {
	// Better Auth stores organization ids as ObjectIds. Test doubles and
	// pre-control-plane webhook fixtures may carry symbolic ids; they are not a
	// reason to turn an otherwise valid payment webhook into a retry storm.
	return setOrganizationKind(organizationId, TEAMS_ORGANIZATION_KIND, {
		upgradedFromPersonalAt: new Date().toISOString(),
	});
}

/**
 * Turn the owner's personal org into a family org for Ryu Max family sharing.
 * Only a personal (or legacy-unset) org with exactly one member (the owner)
 * qualifies, mirroring the revert: admission applies the family cap, the
 * families-per-account cap and the family roles only to people who join
 * later, so an org already holding others must not become a family. A Teams
 * org never becomes a family. Idempotent for an org that is already a family.
 * Eligibility (Max plan, rollout flag, ownership) is the caller's decision.
 */
export async function promoteOrganizationToFamily(
	organizationId: string
): Promise<boolean> {
	if (!BA_OBJECT_ID_RE.test(organizationId)) {
		return false;
	}
	if (
		(await readOrganizationKind(organizationId)) === FAMILY_ORGANIZATION_KIND
	) {
		return true;
	}
	if ((await Member.countDocuments({ organizationId })) !== 1) {
		return false;
	}
	const owner = await Member.findOne({ organizationId })
		.select("userId")
		.lean<{ userId?: unknown }>();
	if (!owner?.userId) {
		return false;
	}
	// The owner's own family counts against their families-per-account cap.
	// Claim the place atomically, so an accept into another family racing this
	// enable cannot take the owner past the cap; the caller's read-based check
	// gives the friendly refusal, this is the authority.
	const slot = { organizationId, userId: String(owner.userId) };
	if (
		!(await claimFamilyMembershipSlot({
			...slot,
			listFamilyOrganizationIds: familyOrganizationIdsForUser,
		}))
	) {
		return false;
	}
	const promoted = await setOrganizationKind(
		organizationId,
		FAMILY_ORGANIZATION_KIND,
		{ familySharingEnabledAt: new Date().toISOString() }
	);
	await settleOwnerFamilyPlace(slot, promoted);
	return promoted;
}

/**
 * Confirm (after a promotion) or release (after a refused one) the owner's
 * claimed family place. Best effort: once the kind write has happened its
 * result is the outcome, so a failure here must not turn a completed enable
 * into an error that skips the caller's post-enable work. A place left
 * unconfirmed still holds the cap until it expires, and the owner's next claim
 * reconciles it from their real memberships (`claimFamilyMembershipSlot` gives
 * every family they are in a confirmed place before counting), so the owner's
 * own family always counts against their cap. An unreleased claim simply
 * expires.
 */
async function settleOwnerFamilyPlace(
	slot: { organizationId: string; userId: string },
	promoted: boolean
): Promise<void> {
	try {
		await (promoted
			? confirmFamilyMembershipSlot(slot)
			: releaseFamilyMembershipSlot({ ...slot, reservedOnly: true }));
	} catch (error) {
		console.error(
			promoted
				? "Failed to confirm a new family owner's place; the next claim reconciles it"
				: "Failed to release a refused family enable's place; it expires",
			{ error, organizationId: slot.organizationId }
		);
	}
}

/**
 * Turn family sharing off by restoring the personal kind. Refused unless the
 * org is a family with exactly one member (the owner): a personal org admits no
 * one else, so reverting with members still present would strand them. Pending
 * invitations are the caller's check.
 *
 * `admissionInFlight` is that check (the API passes live seat claims and
 * members): asked immediately before the kind write and again after it. An
 * admission writes its seat claim before it re-reads the kind, so one whose
 * family check passed before the write shows up the second time; the family
 * kind is then put back and the revert refused, before the owner's family
 * place is released.
 */
export async function revertFamilyOrganizationToPersonal(
	organizationId: string,
	options: {
		admissionInFlight?: (phase: "after" | "before") => Promise<boolean>;
	} = {}
): Promise<boolean> {
	if (
		(await readOrganizationKind(organizationId)) !== FAMILY_ORGANIZATION_KIND
	) {
		return false;
	}
	const memberCount = await Member.countDocuments({ organizationId });
	if (memberCount !== 1 || (await options.admissionInFlight?.("before"))) {
		return false;
	}
	const reverted = await setOrganizationKind(
		organizationId,
		PERSONAL_ORGANIZATION_KIND,
		{ familySharingDisabledAt: new Date().toISOString() }
	);
	if (reverted && (await options.admissionInFlight?.("after"))) {
		if (
			!(await setOrganizationKind(organizationId, FAMILY_ORGANIZATION_KIND))
		) {
			// Another kind write won; admission's after hook removes a member who
			// landed in an org that is no longer a family.
			console.error("Failed to restore a family after a refused revert", {
				organizationId,
			});
		}
		return false;
	}
	if (reverted) {
		// The owner's family place goes with the family. Unconfirmed claims stay
		// until they expire: they mark an admission that raced this revert, which
		// its after hook then undoes (see `organization-admission.ts`).
		try {
			await releaseFamilyMembershipSlotsForOrganization(organizationId, {
				confirmedOnly: true,
			});
		} catch (error) {
			// The owner's next family claim reconciles a place left behind.
			console.error("Failed to release a reverted family's places:", error);
		}
	}
	return reverted;
}

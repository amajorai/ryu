import type { LanguagePackSummary } from "@ryu/i18n/core";
import type { MarketplaceCommunityStats } from "@ryu/marketplace/catalog/bundle-types";
import type { MarketplacePublishPreflightReport } from "@ryu/marketplace/catalog/publish-preflight";
import type {
	CategoryScore,
	CheckStatus,
	ScorecardCategory,
	ScorecardCheck,
	ScorecardGrade,
	ScorecardRulesetVersion,
} from "@ryu/marketplace/catalog/scorecard";
import type {
	MarketplaceCreator,
	MarketplaceCreatorProfileFields,
	MarketplaceOwnCreatorProfile,
} from "@ryu/marketplace/creators/types";
import type {
	VerificationDetails,
	VerificationMethod,
	VerificationMethodKind,
} from "@ryu/ui/components/verification-popover.tsx";
import {
	PUBLISHER_TRUST_LEVELS,
	PUBLISHER_TRUST_SOURCES,
} from "@ryuhq/protocol/publisher-trust";
import { z } from "zod";
import type {
	GithubInstallationResult,
	LicenseStatus,
	MarketplaceCardWire,
	MarketplaceKind,
	MarketplaceMembershipPublisherReport,
	MarketplaceMembershipRevenueCurrency,
	MarketplaceMembershipUsageResult,
	MarketplaceReportView,
	OwnedLicense,
	PortablePackageState,
	PostReviewResult,
	PricingModel,
	PricingView,
	PublishResult,
	ReportReason,
	ReportSource,
	ReportStatus,
	Review,
	ReviewsPage,
	VerificationStatus,
} from "./marketplace.ts";
import {
	marketplaceDocumentSchema,
	marketplaceValueSchema,
} from "./marketplace-wire-values.ts";

const publisherTrustLevelSchema = z.enum(PUBLISHER_TRUST_LEVELS);
const publisherTrustSourceSchema = z.enum(PUBLISHER_TRUST_SOURCES);
export const marketplaceCommunityStatsSchema = z
	.object({ downloads: z.number(), instances: z.number(), runs: z.number() })
	.catchall(
		marketplaceValueSchema
	) satisfies z.ZodType<MarketplaceCommunityStats>;

export const marketplaceKindSchema = z.enum([
	"app",
	"plugin",
	"skill",
	"model",
	"mcp",
	"knowledge",
	"agent",
	"stack_template",
	"workflow",
	"theme",
	"language_pack",
	"space",
	"profile",
	"output_style",
	"bundle",
]) satisfies z.ZodType<MarketplaceKind>;

export const languagePackSummarySchema = z
	.object({
		baseLocale: z.string(),
		direction: z.enum(["ltr", "rtl"]),
		locale: z.string(),
		messageCount: z.number(),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<LanguagePackSummary>;

export const pricingModelSchema = z.enum([
	"one_time",
	"subscription",
	"bounded_updates",
]) satisfies z.ZodType<PricingModel>;

export const pricingViewSchema = z
	.object({
		amountMinor: z.number(),
		currency: z.string(),
		interval: z.enum(["month", "year"]),
		maxUpdates: z.union([z.number(), z.null()]),
		model: pricingModelSchema,
		platformFeeBps: z.number(),
		sellerOrgId: z.string(),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<PricingView>;

export const verificationMethodKindSchema = z.enum([
	"custom",
	"domain",
	"email",
	"identity",
	"organization",
	"platform",
]) satisfies z.ZodType<VerificationMethodKind>;

export const verificationMethodSchema = z
	.object({ kind: verificationMethodKindSchema, label: z.string() })
	.catchall(marketplaceValueSchema) satisfies z.ZodType<VerificationMethod>;

export const verificationDetailsSchema = z
	.object({
		methods: z.array(verificationMethodSchema),
		verifiedSince: z.union([z.string(), z.null()]).optional(),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<VerificationDetails>;

export const verificationStatusSchema = z.enum([
	"verified",
	"unsigned",
	"invalid",
	"unknown",
]) satisfies z.ZodType<VerificationStatus>;

export const marketplaceCardWireSchema = z
	.object({
		author: z.union([z.string(), z.null()]),
		category: z.union([z.string(), z.null()]),
		description: z.union([z.string(), z.null()]),
		firstParty: z.boolean(),
		iconUrl: z.union([z.string(), z.null()]),
		id: z.string(),
		installSource: z.union([z.string(), z.null()]),
		kind: marketplaceKindSchema,
		name: z.string(),
		pricing: z.union([pricingViewSchema, z.null()]),
		ratingAverage: z.number(),
		ratingCount: z.number(),
		version: z.string(),
		artifactKinds: z.union([z.array(z.string()), z.null()]).optional(),
		bundleMemberCount: z.union([z.number(), z.null()]).optional(),
		communityStats: z
			.union([marketplaceCommunityStatsSchema.partial(), z.null()])
			.optional(),
		downloadUrl: z.union([z.string(), z.null()]).optional(),
		githubSource: z.union([marketplaceDocumentSchema, z.null()]).optional(),
		installedVersion: z.union([z.string(), z.null()]).optional(),
		languagePack: z.union([languagePackSummarySchema, z.null()]).optional(),
		latestVersion: z.union([z.string(), z.null()]).optional(),
		likeCount: z.union([z.number(), z.null()]).optional(),
		likedByMe: z.union([z.boolean(), z.null()]).optional(),
		membershipIncluded: z.union([z.boolean(), z.null()]).optional(),
		orgVerified: z.union([z.boolean(), z.null()]).optional(),
		orgVerifiedTier: z.union([z.string(), z.null()]).optional(),
		packageChecksum: z.union([z.string(), z.null()]).optional(),
		packageKind: z.union([z.string(), z.null()]).optional(),
		packageSecurity: z.union([marketplaceDocumentSchema, z.null()]).optional(),
		packageSource: z
			.union([marketplaceDocumentSchema, z.string(), z.null()])
			.optional(),
		publisherTrust: z.union([publisherTrustLevelSchema, z.null()]).optional(),
		publisherTrustSource: z
			.union([publisherTrustSourceSchema, z.null()])
			.optional(),
		publisherVerification: z
			.union([verificationDetailsSchema, z.null()])
			.optional(),
		requirements: z.union([marketplaceDocumentSchema, z.null()]).optional(),
		scopes: z.union([z.array(z.string()), z.null()]).optional(),
		signature: z.union([z.string(), z.null()]).optional(),
		targets: z.union([z.array(z.string()), z.null()]).optional(),
		updateAvailable: z.union([z.boolean(), z.null()]).optional(),
		updatePreview: z.union([marketplaceDocumentSchema, z.null()]).optional(),
		verified: z
			.union([verificationStatusSchema, z.boolean(), z.null()])
			.optional(),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<MarketplaceCardWire>;

export const licenseStatusSchema = z.enum([
	"active",
	"expired",
	"refunded",
	"disputed",
]) satisfies z.ZodType<LicenseStatus>;

export const ownedLicenseSchema = z
	.object({
		buyerOrgId: z.string(),
		buyerUserId: z.string(),
		cancelAtPeriodEnd: z.boolean().optional(),
		currency: z.string(),
		entitlementUntil: z.union([z.string(), z.null()]),
		id: z.string(),
		itemId: z.string(),
		itemKind: marketplaceKindSchema,
		itemName: z.union([z.string(), z.null()]),
		itemVersion: z.string(),
		platformFeeMinor: z.number(),
		priceMinor: z.number(),
		purchasedAt: z.string(),
		status: licenseStatusSchema,
		stripePaymentIntentId: z.union([z.string(), z.null()]),
		stripeSubscriptionId: z.union([z.string(), z.null()]),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<OwnedLicense>;

export const reviewSchema = z
	.object({
		body: z.union([z.string(), z.null()]),
		createdAt: z.string(),
		id: z.string(),
		rating: z.number(),
		title: z.union([z.string(), z.null()]),
		updatedAt: z.string(),
		userId: z.string(),
		userImage: z.union([z.string(), z.null()]),
		userName: z.union([z.string(), z.null()]),
		verifiedPurchase: z.boolean(),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<Review>;

export const reviewsPageSchema = z
	.object({
		nextCursor: z.union([z.string(), z.null()]),
		ratingAverage: z.number(),
		ratingCount: z.number(),
		reviews: z.array(reviewSchema),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<ReviewsPage>;

export const marketplaceMembershipUsageResultSchema = z
	.object({ created: z.boolean(), ok: z.boolean(), periodId: z.string() })
	.catchall(
		marketplaceValueSchema
	) satisfies z.ZodType<MarketplaceMembershipUsageResult>;

export const marketplaceMembershipRevenueCurrencySchema = z
	.object({
		currency: z.string(),
		failedMinor: z.number(),
		paidMinor: z.number(),
		pendingMinor: z.number(),
		usageCount: z.number(),
	})
	.catchall(
		marketplaceValueSchema
	) satisfies z.ZodType<MarketplaceMembershipRevenueCurrency>;

export const marketplaceMembershipPublisherReportSchema = z
	.object({
		currencies: z.array(marketplaceMembershipRevenueCurrencySchema),
		eligibleListingCount: z.number(),
		organizationId: z.string(),
	})
	.catchall(
		marketplaceValueSchema
	) satisfies z.ZodType<MarketplaceMembershipPublisherReport>;

export const postReviewResultSchema = z
	.object({
		ok: z.boolean(),
		ratingAverage: z.number(),
		ratingCount: z.number(),
		verifiedPurchase: z.boolean(),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<PostReviewResult>;

export const publishResultSchema = z
	.object({
		approved: z.array(z.string()),
		id: z.string(),
		kind: marketplaceKindSchema,
		status: z.string(),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<PublishResult>;

export const githubInstallationResultSchema = z
	.object({
		installationProof: z.string(),
		ready: z.literal(true),
		repository: z.string(),
	})
	.catchall(
		marketplaceValueSchema
	) satisfies z.ZodType<GithubInstallationResult>;

export const reportReasonSchema = z.enum([
	"malicious",
	"spam",
	"inappropriate",
	"ip",
	"broken",
	"other",
]) satisfies z.ZodType<ReportReason>;

export const reportSourceSchema = z.enum([
	"mongo",
	"github-curated",
	"github-community",
	"installed",
	"unknown",
]) satisfies z.ZodType<ReportSource>;

export const reportStatusSchema = z.enum([
	"open",
	"reviewing",
	"resolved",
	"dismissed",
]) satisfies z.ZodType<ReportStatus>;

export const marketplaceReportViewSchema = z
	.object({
		audience: z.enum(["platform", "seller", "both"]),
		createdAt: z.union([z.string(), z.null()]),
		details: z.union([z.string(), z.null()]),
		homepage: z.union([z.string(), z.null()]),
		id: z.string(),
		installSource: z.union([z.string(), z.null()]),
		issuesUrl: z.union([z.string(), z.null()]),
		itemId: z.string(),
		itemKind: z.string(),
		itemName: z.union([z.string(), z.null()]),
		reason: reportReasonSchema,
		// Platform-admin views only; the seller inbox omits who filed a report.
		reporterEmail: z.union([z.string(), z.null()]).optional(),
		reporterName: z.union([z.string(), z.null()]).optional(),
		reporterUserId: z.string().optional(),
		resolutionNote: z.union([z.string(), z.null()]),
		resolvedAt: z.union([z.string(), z.null()]),
		sellerOrgId: z.union([z.string(), z.null()]),
		source: reportSourceSchema,
		status: reportStatusSchema,
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<MarketplaceReportView>;

export const marketplaceCreatorSchema = z
	.object({
		bio: z.union([z.string(), z.null()]),
		featuredCount: z.number(),
		firstPublishedAt: z.union([z.string(), z.null()]),
		followerCount: z.number(),
		githubHandle: z.union([z.string(), z.null()]),
		id: z.string(),
		kinds: z.array(z.string()),
		lastPublishedAt: z.union([z.string(), z.null()]),
		listingCount: z.number(),
		logo: z.union([z.string(), z.null()]),
		name: z.string(),
		publisherTrust: z.union([publisherTrustLevelSchema, z.null()]),
		publisherVerification: z.union([verificationDetailsSchema, z.null()]),
		ratingAverage: z.number(),
		ratingCount: z.number(),
		slug: z.union([z.string(), z.null()]),
		website: z.union([z.string(), z.null()]),
		xHandle: z.union([z.string(), z.null()]),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<MarketplaceCreator>;

export const marketplaceCreatorProfileFieldsSchema = z
	.object({
		bio: z.union([z.string(), z.null()]),
		githubHandle: z.union([z.string(), z.null()]),
		website: z.union([z.string(), z.null()]),
		xHandle: z.union([z.string(), z.null()]),
	})
	.catchall(
		marketplaceValueSchema
	) satisfies z.ZodType<MarketplaceCreatorProfileFields>;

export const marketplaceOwnCreatorProfileSchema = z
	.object({
		name: z.string(),
		organizationId: z.string(),
		profile: marketplaceCreatorProfileFieldsSchema,
		slug: z.union([z.string(), z.null()]),
	})
	.catchall(
		marketplaceValueSchema
	) satisfies z.ZodType<MarketplaceOwnCreatorProfile>;

export const scorecardCategorySchema = z.enum([
	"capabilities",
	"configuration",
	"design-system",
	"hygiene",
	"maintenance",
	"operations",
	"review",
	"runtime",
	"safety",
	"disclosures",
	"errors",
]) satisfies z.ZodType<ScorecardCategory>;

export const categoryScoreSchema = z
	.object({
		category: scorecardCategorySchema,
		fail: z.number(),
		pass: z.number(),
		score: z.union([z.number(), z.null()]),
		unknown: z.number(),
		warn: z.number(),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<CategoryScore>;

export const checkStatusSchema = z.enum([
	"pass",
	"warn",
	"fail",
	"unknown",
]) satisfies z.ZodType<CheckStatus>;

export const scorecardCheckSchema = z
	.object({
		category: scorecardCategorySchema,
		detail: z.string(),
		id: z.string(),
		label: z.string(),
		status: checkStatusSchema,
		weight: z.number(),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<ScorecardCheck>;

export const scorecardGradeSchema = z.enum([
	"A",
	"B",
	"C",
	"D",
	"F",
]) satisfies z.ZodType<ScorecardGrade>;

export const scorecardRulesetVersionSchema = z.enum([
	"agent-config-1",
	"design-system-1",
	"marketplace-publish-1",
	"marketplace-plugin-1",
	"marketplace-plugin-2",
	"marketplace-skill-1",
]) satisfies z.ZodType<ScorecardRulesetVersion>;

export const marketplacePublishPreflightReportSchema = z
	.object({
		categories: z.array(categoryScoreSchema),
		checks: z.array(scorecardCheckSchema),
		evaluated: z.number(),
		grade: z.union([scorecardGradeSchema, z.null()]),
		rulesetVersion: scorecardRulesetVersionSchema,
		schemaVersion: z.literal("1"),
		score: z.union([z.number(), z.null()]),
		summary: z.string(),
		packageDigest: z.string().optional(),
		packageKind: z.string(),
		passed: z.boolean(),
		releaseTag: z.string().optional(),
		sourceCommit: z.string().optional(),
		uiDetected: z.boolean(),
		uiGrade: z.union([
			z.literal("A"),
			z.literal("B"),
			z.literal("C"),
			z.literal("D"),
			z.literal("F"),
			z.null(),
		]),
		uiHostRendered: z.boolean(),
		uiScore: z.union([z.number(), z.null()]),
		verifiedAt: z.string().optional(),
	})
	.catchall(
		marketplaceValueSchema
	) satisfies z.ZodType<MarketplacePublishPreflightReport>;

export const catalogEnvelopeSchema = z
	.object({
		items: z.array(marketplaceCardWireSchema).optional(),
		/** Opaque cursor for the next `/catalog` page; null on the last page and
		 * absent from servers that predate catalog paging. */
		nextCursor: z.union([z.string(), z.null()]).optional(),
	})
	.catchall(marketplaceValueSchema);
export const creatorProfileEnvelopeSchema = z
	.object({
		creator: marketplaceCreatorSchema,
		listings: z
			.array(
				marketplaceCardWireSchema.extend({ featured: z.boolean().optional() })
			)
			.optional(),
	})
	.catchall(marketplaceValueSchema);
export const purchaseWireSchema = z
	.object({
		url: z.string().optional(),
		sessionId: z.string().optional(),
		alreadyLicensed: z.boolean().optional(),
		license: ownedLicenseSchema.nullable().optional(),
	})
	.catchall(marketplaceValueSchema);
export const licensesEnvelopeSchema = z
	.object({ licenses: z.array(ownedLicenseSchema).optional() })
	.catchall(marketplaceValueSchema);
export const creatorsEnvelopeSchema = z
	.object({ creators: z.array(marketplaceCreatorSchema).optional() })
	.catchall(marketplaceValueSchema);
export const creatorFieldsEnvelopeSchema = z
	.object({ profile: marketplaceCreatorProfileFieldsSchema })
	.catchall(marketplaceValueSchema);
export const reportsEnvelopeSchema = z
	.object({ reports: z.array(marketplaceReportViewSchema).optional() })
	.catchall(marketplaceValueSchema);
export const reportEnvelopeSchema = z
	.object({ report: marketplaceReportViewSchema.optional() })
	.catchall(marketplaceValueSchema);
export const reviewFailureSchema = z
	.object({
		error: z.string().optional(),
		message: z.string().optional(),
		requiresPurchase: z.boolean().optional(),
	})
	.catchall(marketplaceValueSchema);
export const urlResponseSchema = z
	.object({ url: z.string().optional() })
	.catchall(marketplaceValueSchema);
export const reportSubmissionSchema = z
	.object({ suggestIssuesUrl: z.string().nullable().optional() })
	.catchall(marketplaceValueSchema);
export const likesEnvelopeSchema = z
	.object({ likes: z.array(marketplaceValueSchema).optional() })
	.catchall(marketplaceValueSchema);
export const githubPublishWireSchema = z
	.object({
		githubSource: marketplaceDocumentSchema.nullable().optional(),
		id: z.string().optional(),
		kind: marketplaceKindSchema.optional(),
		preflight: marketplacePublishPreflightReportSchema.nullable().optional(),
		status: z.string().optional(),
		version: z.string().optional(),
	})
	.catchall(marketplaceValueSchema);
export const githubCompletionWireSchema = z
	.object({
		installationProof: z.string().optional(),
		repository: z.string().optional(),
		ready: z.boolean().optional(),
	})
	.catchall(marketplaceValueSchema);
export const marketplaceBundleKindSchema = z.enum([
	"app",
	"plugin",
	"skill",
	"model",
	"mcp",
	"knowledge",
	"agent",
	"stack_template",
	"workflow",
	"theme",
	"language_pack",
	"space",
	"profile",
	"output_style",
]);
export const marketplaceDetailWireSchema = marketplaceCardWireSchema
	.partial()
	.extend({
		author: marketplaceValueSchema.optional(),
		banner: marketplaceValueSchema.optional(),
		bannerUrl: z.string().nullable().optional(),
		bundleMembers: marketplaceValueSchema.optional(),
		bundleSourceUrl: z.string().nullable().optional(),
		capabilities: marketplaceValueSchema.optional(),
		communityStats: marketplaceValueSchema.optional(),
		developer: marketplaceValueSchema.optional(),
		examplePrompts: marketplaceValueSchema.optional(),
		homepage: marketplaceValueSchema.optional(),
		identityMode: marketplaceValueSchema.optional(),
		permission_grants: marketplaceValueSchema.optional(),
		permissionGrants: marketplaceValueSchema.optional(),
		privacyPolicyUrl: z.string().nullable().optional(),
		runnables: marketplaceValueSchema.optional(),
		screenshots: marketplaceValueSchema.optional(),
		setup: marketplaceValueSchema.optional(),
		tagline: z.string().nullable().optional(),
		termsOfServiceUrl: z.string().nullable().optional(),
		website: z.string().nullable().optional(),
	});

/** Response schemas only validate; retaining the received value preserves future
 * JSON fields, property order, and nested documents through client projection. */
export function parseMarketplaceResponse<S extends z.ZodType>(
	schema: S,
	value: Parameters<S["parse"]>[0]
): z.output<S> {
	return z
		.custom<z.output<S>>(
			(candidate) =>
				marketplaceValueSchema.safeParse(candidate).success &&
				schema.safeParse(candidate).success
		)
		.parse(value);
}
export const portablePackageStateSchema = z
	.object({
		enabled: z.boolean(),
		id: z.string(),
		installed_at_unix_ms: z.number(),
		kind: z.string(),
		package_digest: z.string(),
		version: z.string(),
	})
	.catchall(marketplaceValueSchema) satisfies z.ZodType<PortablePackageState>;
export const portablePackageEnvelopeSchema = z
	.object({ package: portablePackageStateSchema })
	.catchall(marketplaceValueSchema);
export const installedPortablePackagesSchema = z
	.object({ packages: z.array(portablePackageStateSchema).optional() })
	.catchall(marketplaceValueSchema);

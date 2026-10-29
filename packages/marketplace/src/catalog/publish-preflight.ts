// Marketplace submission preflight. This is separate from the buyer-facing
// trust score: it checks the immutable package that is about to enter Ryu's
// review queue, without requiring a human review signal before that review.

import {
	type DesignSystemAuditInput,
	type DesignSystemEvidence,
	type DesignSystemSurface,
	designSystemChecks,
} from "./design-system-scorecard.ts";
import {
	buildScorecard,
	check,
	type Scorecard,
	type ScorecardCheck,
} from "./scorecard-contract.ts";

export const MARKETPLACE_PUBLISH_PACKAGE_KINDS = [
	"agent",
	"app",
	"bundle",
	"language_pack",
	"output_style",
	"plugin",
	"profile",
	"skill",
	"space",
	"theme",
	"workflow",
] as const;

export type MarketplacePublishPackageKind =
	(typeof MARKETPLACE_PUBLISH_PACKAGE_KINDS)[number];

export interface MarketplacePublishPreflightInput {
	/** Counts come from the validated package tree, before it is signed. */
	declaredArtifactCount: number;
	gatewayGrantsApproved: boolean;
	/** True only after source/release package digests have been compared. */
	immutableSourceVerified: boolean;
	/** The package-kind reader accepted the declared artifact contents. */
	kindArtifactsValid: boolean;
	/** Package kind from the parsed portable manifest. */
	packageKind: string;
	/** True only after publishability and Gateway permission checks pass. */
	packageSecurityPassed: boolean;
	presentArtifactCount: number;
	/** Detected from the inspected package files and UI declarations. */
	uiDetected: boolean;
	uiEvidence?: DesignSystemEvidence | null;
	/** False when the bounded scanner could not include every detected UI file. */
	uiEvidenceComplete?: boolean;
	/** True when the UI uses only Ryu-owned host renderers. */
	uiHostRendered?: boolean;
	uiSurface?: DesignSystemSurface;
}

export interface MarketplacePublishPreflightReport extends Scorecard {
	packageDigest?: string;
	packageKind: string;
	passed: boolean;
	releaseTag?: string;
	sourceCommit?: string;
	uiDetected: boolean;
	uiGrade: "A" | "B" | "C" | "D" | "F" | null;
	uiHostRendered: boolean;
	uiScore: number | null;
	verifiedAt?: string;
}

const packageKindSet = new Set<string>(MARKETPLACE_PUBLISH_PACKAGE_KINDS);

function baseChecks(input: MarketplacePublishPreflightInput): ScorecardCheck[] {
	const supportedKind = packageKindSet.has(input.packageKind);
	const artifactsPresent =
		input.declaredArtifactCount > 0 &&
		input.presentArtifactCount === input.declaredArtifactCount;
	return [
		check(
			"package-kind",
			"configuration",
			"Uses a supported package profile",
			3,
			supportedKind ? "pass" : "fail",
			supportedKind
				? `The ${input.packageKind} package has a defined Ryu publish profile.`
				: "This package kind has no publish scorecard profile."
		),
		check(
			"declared-artifacts",
			"errors",
			"Includes every declared artifact",
			3,
			artifactsPresent ? "pass" : "fail",
			artifactsPresent
				? `${input.presentArtifactCount} declared artifact(s) are present in the inspected package.`
				: "The package must declare at least one artifact and include each declared file."
		),
		check(
			"kind-artifacts",
			"configuration",
			"Passes its package-type checks",
			3,
			input.kindArtifactsValid ? "pass" : "fail",
			input.kindArtifactsValid
				? `The declared ${input.packageKind} artifacts passed their format checks.`
				: `The declared ${input.packageKind} artifacts are incomplete or invalid.`
		),
		check(
			"immutable-source",
			"errors",
			"Matches the immutable release",
			4,
			input.immutableSourceVerified ? "pass" : "fail",
			input.immutableSourceVerified
				? "The pinned GitHub package and release asset contain the same bytes."
				: "The source tree and immutable release asset could not be verified as identical."
		),
		check(
			"package-security",
			"safety",
			"Passes package security checks",
			4,
			input.packageSecurityPassed ? "pass" : "fail",
			input.packageSecurityPassed
				? "The package has no declared secrets, private-content flag, or sensitive package path."
				: "Remove secret-bearing or private content before submitting this package."
		),
		check(
			"gateway-grants",
			"capabilities",
			"Uses Gateway-approved permissions",
			4,
			input.gatewayGrantsApproved ? "pass" : "fail",
			input.gatewayGrantsApproved
				? "Every requested capability is approved by the Gateway."
				: "The Gateway did not approve every requested capability."
		),
	];
}

interface PublishUiAssessment {
	checks: ScorecardCheck[];
	grade: MarketplacePublishPreflightReport["uiGrade"];
	score: number | null;
}

function uiChecks(
	input: MarketplacePublishPreflightInput
): PublishUiAssessment {
	if (!input.uiDetected) {
		return {
			checks: [
				check(
					"ui-applicability",
					"design-system",
					"Detects UI applicability",
					2,
					"pass",
					`No rendered UI was found; the ${input.packageKind} package uses its non-UI publish profile.`
				),
			],
			grade: null,
			score: null,
		};
	}
	if (input.uiHostRendered) {
		const checks = [
			check(
				"host-ui-renderer",
				"design-system",
				"Uses Ryu-owned host UI renderers",
				3,
				"pass",
				"This manifest declares a host-rendered UI contribution and ships no custom UI source."
			),
			check(
				"host-ui-theme-accessibility",
				"design-system",
				"Inherits host theme and interaction behavior",
				3,
				"pass",
				"Ryu's shared renderer owns the contribution's theme, semantic controls, and keyboard behavior."
			),
			check(
				"ui-evidence-complete",
				"design-system",
				"Provides complete UI evidence",
				4,
				"pass",
				"The complete UI is described by supported Ryu host contributions; the package ships no custom UI source."
			),
		];
		const scored = buildScorecard(checks, "design-system-1");
		return { checks, grade: scored.grade, score: scored.score };
	}

	const auditInput: DesignSystemAuditInput = {
		evidence: input.uiEvidence,
		surface: input.uiSurface ?? "unknown",
	};
	const checks = designSystemChecks(auditInput);
	const scored = buildScorecard(checks, "design-system-1");
	const evidenceComplete =
		input.uiEvidenceComplete !== false &&
		checks.every((finding) => finding.status !== "unknown");
	return {
		checks: [
			...checks,
			check(
				"ui-evidence-complete",
				"design-system",
				"Provides complete UI evidence",
				4,
				evidenceComplete ? "pass" : "fail",
				evidenceComplete
					? "The scorecard evaluated every required UI check."
					: "The UI surface or source evidence is incomplete, so it cannot receive a publish grade."
			),
		],
		grade: evidenceComplete ? scored.grade : "F",
		score: evidenceComplete ? scored.score : 0,
	};
}

/** Build the deterministic preflight report for a portable Marketplace package.
 * UI rules are applied only when UI source or a UI declaration is present.
 * Every package kind still gets the manifest, artifact, integrity, security,
 * and Gateway checks; an unregistered kind or missing evidence fails closed. */
export function runMarketplacePublishPreflight(
	input: MarketplacePublishPreflightInput
): MarketplacePublishPreflightReport {
	const checks = baseChecks(input);
	const ui = uiChecks(input);
	checks.push(...ui.checks);
	const scorecard = buildScorecard(checks, "marketplace-publish-1");
	const passed =
		scorecard.grade === "A" &&
		scorecard.score !== null &&
		checks.every(
			(finding) => finding.status !== "fail" && finding.status !== "unknown"
		);

	return {
		...scorecard,
		packageKind: input.packageKind,
		uiDetected: input.uiDetected,
		uiHostRendered: input.uiDetected && input.uiHostRendered === true,
		uiGrade: ui.grade,
		uiScore: ui.score,
		passed,
	};
}

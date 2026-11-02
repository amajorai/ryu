import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { PublisherTrustLevel } from "@ryuhq/protocol/publisher-trust";

export type PublisherSignatureStatus =
	| "verified"
	| "unsigned"
	| "invalid"
	| "unknown";

export interface PublisherHealthInput {
	capabilities?: string[] | null;
	packageChecksum?: string | null;
	publisherTrust: PublisherTrustLevel;
	ratingAverage?: number | null;
	ratingCount?: number | null;
	reviewed?: boolean | null;
	signatureStatus?: PublisherSignatureStatus;
}

/** Which disclosure row a signal fills; the card owns each row's label. */
export type PublisherHealthSignalId =
	| "identity"
	| "signature"
	| "review"
	| "integrity"
	| "capabilities"
	| "ratings";

/**
 * A signal's verdict as a message id, never English text: the card renders it
 * with `tl()` so the safety-relevant words translate with the labels beside
 * them. `capabilities` and `rating` carry raw numbers the card formats for the
 * UI locale.
 */
export type PublisherHealthValue =
	| { id: "staff-verified" }
	| { id: "identity-verified" }
	| { id: "not-verified" }
	| { id: "signature-verified" }
	| { id: "signature-invalid" }
	| { id: "unsigned" }
	| { id: "not-reported" }
	| { id: "reviewed" }
	| { id: "not-reviewed" }
	| { id: "checksum-recorded" }
	| { id: "checksum-missing" }
	| { count: number; id: "capabilities" }
	| { average: number; count: number; id: "rating" };

export interface PublisherHealthSignal {
	id: PublisherHealthSignalId;
	status: "good" | "neutral" | "warning";
	value: PublisherHealthValue;
}

export interface PublisherHealth {
	score: number;
	signals: PublisherHealthSignal[];
}

/** Calculate a transparent signal score, not a security guarantee or Ryu
 * endorsement. Missing evidence stays neutral or warning; it never becomes a
 * hidden positive. */
export function calculatePublisherHealth(
	input: PublisherHealthInput
): PublisherHealth {
	const trustScore =
		input.publisherTrust === "gold"
			? 35
			: input.publisherTrust === "blue"
				? 25
				: 8;
	const signatureStatus = input.signatureStatus ?? "unknown";
	const signatureScore =
		signatureStatus === "verified"
			? 30
			: signatureStatus === "unknown"
				? 12
				: signatureStatus === "unsigned"
					? 6
					: 0;
	const reviewScore =
		input.reviewed === true ? 20 : input.reviewed === false ? 4 : 10;
	const integrityScore = input.packageChecksum ? 10 : 3;
	const score = Math.max(
		0,
		Math.min(100, trustScore + signatureScore + reviewScore + integrityScore)
	);
	const signals: PublisherHealthSignal[] = [
		{
			id: "identity",
			status: input.publisherTrust === "dotted" ? "warning" : "good",
			value: {
				id:
					input.publisherTrust === "gold"
						? "staff-verified"
						: input.publisherTrust === "blue"
							? "identity-verified"
							: "not-verified",
			},
		},
		{
			id: "signature",
			status:
				signatureStatus === "verified"
					? "good"
					: signatureStatus === "invalid"
						? "warning"
						: "neutral",
			value: {
				id:
					signatureStatus === "verified"
						? "signature-verified"
						: signatureStatus === "invalid"
							? "signature-invalid"
							: signatureStatus === "unsigned"
								? "unsigned"
								: "not-reported",
			},
		},
		{
			id: "review",
			status:
				input.reviewed === true
					? "good"
					: input.reviewed === false
						? "warning"
						: "neutral",
			value: {
				id:
					input.reviewed === true
						? "reviewed"
						: input.reviewed === false
							? "not-reviewed"
							: "not-reported",
			},
		},
		{
			id: "integrity",
			status: input.packageChecksum ? "good" : "neutral",
			value: {
				id: input.packageChecksum ? "checksum-recorded" : "checksum-missing",
			},
		},
	];
	if (input.capabilities && input.capabilities.length > 0) {
		signals.push({
			id: "capabilities",
			status: input.capabilities.length > 4 ? "warning" : "neutral",
			value: { count: input.capabilities.length, id: "capabilities" },
		});
	}
	if (
		isNativeNumber(input.ratingCount) &&
		input.ratingCount > 0 &&
		isNativeNumber(input.ratingAverage)
	) {
		signals.push({
			id: "ratings",
			status: input.ratingAverage >= 4 ? "good" : "neutral",
			value: {
				average: input.ratingAverage,
				count: input.ratingCount,
				id: "rating",
			},
		});
	}
	return { score, signals };
}

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

export interface PublisherHealthSignal {
	label: string;
	status: "good" | "neutral" | "warning";
	value: string;
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
			label: "Publisher identity",
			status: input.publisherTrust === "dotted" ? "warning" : "good",
			value:
				input.publisherTrust === "gold"
					? "Ryu staff verified"
					: input.publisherTrust === "blue"
						? "Stripe identity verified"
						: "Not verified",
		},
		{
			label: "Release signature",
			status:
				signatureStatus === "verified"
					? "good"
					: signatureStatus === "invalid"
						? "warning"
						: "neutral",
			value:
				signatureStatus === "verified"
					? "Verified"
					: signatureStatus === "invalid"
						? "Invalid"
						: signatureStatus === "unsigned"
							? "Unsigned"
							: "Not reported",
		},
		{
			label: "Ryu code review",
			status:
				input.reviewed === true
					? "good"
					: input.reviewed === false
						? "warning"
						: "neutral",
			value:
				input.reviewed === true
					? "Reviewed"
					: input.reviewed === false
						? "Not reviewed"
						: "Not reported",
		},
		{
			label: "Package integrity",
			status: input.packageChecksum ? "good" : "neutral",
			value: input.packageChecksum
				? "SHA-256 recorded"
				: "Checksum not reported",
		},
	];
	if (input.capabilities && input.capabilities.length > 0) {
		signals.push({
			label: "Declared capabilities",
			status: input.capabilities.length > 4 ? "warning" : "neutral",
			value: `${input.capabilities.length} requested`,
		});
	}
	if (
		isNativeNumber(input.ratingCount) &&
		input.ratingCount > 0 &&
		isNativeNumber(input.ratingAverage)
	) {
		signals.push({
			label: "Community ratings",
			status: input.ratingAverage >= 4 ? "good" : "neutral",
			value: `${input.ratingAverage.toFixed(1)} / 5 (${input.ratingCount})`,
		});
	}
	return { score, signals };
}

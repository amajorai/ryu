import type { MarketplacePublishPreflightReport } from "@ryu/marketplace/catalog/publish-preflight";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type {
	GithubPublishPricing,
	MarketplaceError,
} from "@/src/lib/api/marketplace.ts";
import { marketplacePublishPreflightReportSchema } from "@/src/lib/api/marketplace-response-contracts.ts";

// Offer pricing, GitHub-install prompt and preflight helpers for PublishDialog.

export type OfferModel = "free" | GithubPublishPricing["model"];

export function buildOfferPricing(input: {
	amount: string;
	currency: string;
	maxUpdates: string;
	model: OfferModel;
	interval: "month" | "year";
}): GithubPublishPricing | undefined {
	if (input.model === "free") {
		return undefined;
	}
	const amountText = input.amount.trim();
	if (!amountText) {
		throw new Error("Enter a positive price in your selected currency.");
	}
	const amountParts = /^(-?\d+)(?:\.(\d{1,2}))?$/u.exec(amountText);
	if (!amountParts) {
		throw new Error("Price must use no more than two decimal places.");
	}
	const wholeUnits = Number(amountParts[1]);
	const fractionalUnits = Number((amountParts[2] ?? "").padEnd(2, "0"));
	const amountMinor = wholeUnits * 100 + fractionalUnits;
	if (!Number.isSafeInteger(amountMinor)) {
		throw new Error("Price is too large to represent safely in minor units.");
	}
	if (amountMinor <= 0) {
		throw new Error("Enter a positive price in your selected currency.");
	}
	const currency = input.currency.trim().toLowerCase();
	if (!/^[a-z]{3}$/.test(currency)) {
		throw new Error("Currency must be a three-letter ISO code, such as USD.");
	}
	const pricing: GithubPublishPricing = {
		amountMinor,
		currency,
		distribution: "github_release",
		model: input.model,
	};
	if (input.model === "subscription") {
		pricing.interval = input.interval;
	}
	if (input.model === "bounded_updates") {
		const maxUpdatesText = input.maxUpdates.trim();
		const maxUpdates = /^\d+$/u.test(maxUpdatesText)
			? Number(maxUpdatesText)
			: Number.NaN;
		if (
			!Number.isSafeInteger(maxUpdates) ||
			maxUpdates < 1 ||
			maxUpdates > 10_000
		) {
			throw new Error("Included updates must be an integer from 1 to 10,000.");
		}
		pricing.maxUpdates = maxUpdates;
	}
	return pricing;
}

export interface GithubInstallPrompt {
	installationUrl: string;
	repository: string;
	state: string;
}

export function githubInstallPrompt(
	error: MarketplaceError
): GithubInstallPrompt | null {
	if (error.kind !== "github") {
		return null;
	}
	const installationUrl = error.details.installationUrl;
	const repository = error.details.repository;
	const state = error.details.installationState;
	return isNativeText(installationUrl) &&
		isNativeText(repository) &&
		isNativeText(state)
		? { installationUrl, repository, state }
		: null;
}

export function publishPreflightFromError(
	error: MarketplaceError
): MarketplacePublishPreflightReport | null {
	const parsed = marketplacePublishPreflightReportSchema.safeParse(
		error.details.preflight
	);
	return parsed.success ? parsed.data : null;
}

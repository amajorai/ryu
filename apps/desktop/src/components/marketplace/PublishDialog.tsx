import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// apps/desktop/src/components/marketplace/PublishDialog.tsx
//
// Seller-side GitHub bridge. A listing is created from the seller's own
// repository/package URL; the control plane validates ryu.package.json and the
// immutable .ryupack release, then stores only the GitHub binding and offer.
// Buyers never see or need a GitHub credential.

import { Rocket01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MarketplacePublishPreflightReport } from "@ryu/marketplace/catalog/publish-preflight";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { type ReactNode, useCallback, useState } from "react";
import { openExternal } from "@/lib/tauri-bridge.ts";
import {
	completeGithubInstallation,
	type GithubPublishPricing,
	hasMarketplaceAuth,
	MarketplaceError,
	publishGithubPackage,
} from "@/src/lib/api/marketplace.ts";
import { marketplacePublishPreflightReportSchema } from "@/src/lib/api/marketplace-response-contracts.ts";

type OfferModel = "free" | GithubPublishPricing["model"];

function buildOfferPricing(input: {
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

interface GithubInstallPrompt {
	installationUrl: string;
	repository: string;
	state: string;
}

export interface PublishDialogProps {
	/** Why publishing is unavailable for the current editor context. */
	blockedReason?: string | null;
	/** Retained for callers that still build a local preview; GitHub is now the
	 * source of truth and this disclosure is shown only as optional context. */
	disclosure?: ReactNode;
	/** Human label for the package being published. */
	kindLabel: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

function githubInstallPrompt(
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

function publishPreflightFromError(
	error: MarketplaceError
): MarketplacePublishPreflightReport | null {
	const parsed = marketplacePublishPreflightReportSchema.safeParse(
		error.details.preflight
	);
	return parsed.success ? parsed.data : null;
}

export function PublishDialog({
	blockedReason = null,
	disclosure,
	kindLabel,
	open,
	onOpenChange,
}: PublishDialogProps) {
	const [repositoryUrl, setRepositoryUrl] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [offerModel, setOfferModel] = useState<OfferModel>("free");
	const [offerAmount, setOfferAmount] = useState("");
	const [offerCurrency, setOfferCurrency] = useState("USD");
	const [offerInterval, setOfferInterval] = useState<"month" | "year">("month");
	const [offerMaxUpdates, setOfferMaxUpdates] = useState("3");
	const [installPrompt, setInstallPrompt] =
		useState<GithubInstallPrompt | null>(null);
	const [published, setPublished] = useState<{
		id: string;
		kind: string;
		version: string;
		preflight: MarketplacePublishPreflightReport | null;
	} | null>(null);
	const [preflightReport, setPreflightReport] =
		useState<MarketplacePublishPreflightReport | null>(null);
	const signedIn = hasMarketplaceAuth();

	const handlePublish = useCallback(
		async (installationProof?: string) => {
			if (!signedIn) {
				setError("Sign in to publish to the marketplace.");
				return;
			}
			if (blockedReason) {
				setError(blockedReason);
				return;
			}
			const url = repositoryUrl.trim();
			if (!url) {
				setError("Paste a GitHub repository or package URL.");
				return;
			}
			setSubmitting(true);
			setError(null);
			setPreflightReport(null);
			try {
				const pricing = buildOfferPricing({
					amount: offerAmount,
					currency: offerCurrency,
					interval: offerInterval,
					maxUpdates: offerMaxUpdates,
					model: offerModel,
				});
				const result = await publishGithubPackage({
					installationProof,
					pricing,
					url,
				});
				setInstallPrompt(null);
				setPublished({
					id: result.id,
					kind: result.kind,
					version: result.version,
					preflight: result.preflight,
				});
			} catch (cause) {
				if (cause instanceof MarketplaceError) {
					setPreflightReport(publishPreflightFromError(cause));
					const prompt = githubInstallPrompt(cause);
					if (prompt) {
						setInstallPrompt(prompt);
						setError(
							"GitHub needs one-time repository access. Install the Ryu App, then check again."
						);
						return;
					}
					setError(cause.message);
					return;
				}
				setError(cause instanceof Error ? cause.message : "Failed to publish.");
			} finally {
				setSubmitting(false);
			}
		},
		[
			blockedReason,
			offerAmount,
			offerCurrency,
			offerInterval,
			offerMaxUpdates,
			offerModel,
			repositoryUrl,
			signedIn,
		]
	);

	const openGithubInstall = useCallback(async () => {
		if (!installPrompt) {
			return;
		}
		try {
			await openExternal(installPrompt.installationUrl);
			setError("Finish the GitHub App installation, then choose Check again.");
		} catch {
			setError(
				"Could not open GitHub. Copy the installation link and open it in a browser."
			);
		}
	}, [installPrompt]);

	const checkGithubInstall = useCallback(async () => {
		if (!installPrompt) {
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const result = await completeGithubInstallation({
				repository: installPrompt.repository,
				state: installPrompt.state,
			});
			await handlePublish(result.installationProof);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "GitHub installation is not ready yet."
			);
		} finally {
			setSubmitting(false);
		}
	}, [handlePublish, installPrompt]);

	const handleOpenChange = useCallback(
		(next: boolean) => {
			if (!next) {
				setError(null);
				setRepositoryUrl("");
				setInstallPrompt(null);
				setPublished(null);
				setPreflightReport(null);
				setOfferModel("free");
				setOfferAmount("");
				setOfferCurrency("USD");
				setOfferInterval("month");
				setOfferMaxUpdates("3");
			}
			onOpenChange(next);
		},
		[onOpenChange]
	);

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle layout="inline">
						<HugeiconsIcon className="size-4" icon={Rocket01Icon} />
						Publish {kindLabel} from GitHub
					</DialogTitle>
					<DialogDescription>
						Paste the repository or package URL. Ryu validates the package
						manifest and immutable release, detects UI automatically, and runs a
						Grade A preflight before sending it to Ryu admins.
					</DialogDescription>
				</DialogHeader>

				{published ? (
					<div className="flex flex-col gap-3 py-2">
						<div className="rounded-2xl bg-secondary/60 p-4 text-sm">
							<p className="font-medium">Submitted for review</p>
							<p className="mt-1 text-muted-foreground">
								<span className="font-mono">{published.id}</span> ({kindLabel}{" "}
								{published.version}){" "}
								{published.preflight?.passed
									? `passed Grade ${published.preflight.grade} preflight and is in the Ryu admin review queue.`
									: "is in the Ryu admin review queue, but its preflight report was not returned."}{" "}
								Future releases stay in the linked GitHub repository.
							</p>
							{published.preflight ? (
								<p className="mt-2 text-status-success text-xs">
									Grade {published.preflight.grade} ·{" "}
									{published.preflight.score}/100 ·{" "}
									{published.preflight.rulesetVersion}
								</p>
							) : null}
						</div>
						<DialogFooter>
							<Button onClick={() => handleOpenChange(false)}>Done</Button>
						</DialogFooter>
					</div>
				) : (
					<div className="flex flex-col gap-4 py-1">
						{signedIn ? null : (
							<p className="rounded-xl bg-destructive/10 p-3 text-sm text-status-destructive">
								Sign in to your Ryu account to publish to the marketplace.
							</p>
						)}

						<div className="rounded-xl bg-secondary/50 p-3 text-muted-foreground text-sm">
							The repository must use the <code>ryu-app</code>,{" "}
							<code>ryu-plugin</code>, <code>ryu-language-pack</code>, or{" "}
							<code>ryu-marketplace</code> topic and contain a{" "}
							<code>ryu.package.json</code>. Buyers install through Ryu; they do
							not need GitHub access.
						</div>

						{disclosure ? (
							<div className="rounded-xl border p-3 text-sm">{disclosure}</div>
						) : null}

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-github-url">
								GitHub repository or package URL
							</Label>
							<Input
								autoComplete="url"
								id="publish-github-url"
								onChange={(event) => setRepositoryUrl(event.target.value)}
								placeholder="https://github.com/acme/my-app"
								value={repositoryUrl}
							/>
							<p className="text-muted-foreground text-xs">
								For a collection repository, paste the package folder URL or the
								repository root to scan all package folders.
							</p>
						</div>

						<div className="flex flex-col gap-3 rounded-xl border p-3">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="publish-offer-model">Offer</Label>
								<Select<OfferModel>
									items={[
										{ label: "Free", value: "free" },
										{ label: "One-time purchase", value: "one_time" },
										{ label: "Subscription", value: "subscription" },
										{ label: "Bounded updates", value: "bounded_updates" },
									]}
									onValueChange={(value) => {
										if (value) {
											setOfferModel(value);
										}
									}}
									value={offerModel}
								>
									<SelectTrigger id="publish-offer-model">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="free">Free</SelectItem>
										<SelectItem value="one_time">One-time purchase</SelectItem>
										<SelectItem value="subscription">Subscription</SelectItem>
										<SelectItem value="bounded_updates">
											Bounded updates
										</SelectItem>
									</SelectContent>
								</Select>
							</div>

							{offerModel === "free" ? (
								<p className="text-muted-foreground text-xs">
									Free packages need no seller payout setup.
								</p>
							) : (
								<>
									<div className="grid grid-cols-[1fr_7rem] gap-2">
										<div className="flex flex-col gap-1.5">
											<Label htmlFor="publish-offer-amount">Price</Label>
											<Input
												id="publish-offer-amount"
												inputMode="decimal"
												min="0.01"
												onChange={(event) => setOfferAmount(event.target.value)}
												placeholder="12.00"
												step="0.01"
												type="number"
												value={offerAmount}
											/>
										</div>
										<div className="flex flex-col gap-1.5">
											<Label htmlFor="publish-offer-currency">Currency</Label>
											<Input
												id="publish-offer-currency"
												maxLength={3}
												onChange={(event) =>
													setOfferCurrency(event.target.value.toUpperCase())
												}
												placeholder="USD"
												value={offerCurrency}
											/>
										</div>
									</div>

									{offerModel === "subscription" ? (
										<div className="flex flex-col gap-1.5">
											<Label htmlFor="publish-offer-interval">
												Billing interval
											</Label>
											<Select
												items={[
													{ label: "Monthly", value: "month" },
													{ label: "Yearly", value: "year" },
												]}
												onValueChange={(value) => {
													if (value === "month" || value === "year") {
														setOfferInterval(value);
													}
												}}
												value={offerInterval}
											>
												<SelectTrigger id="publish-offer-interval">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="month">Monthly</SelectItem>
													<SelectItem value="year">Yearly</SelectItem>
												</SelectContent>
											</Select>
										</div>
									) : null}

									{offerModel === "bounded_updates" ? (
										<div className="flex flex-col gap-1.5">
											<Label htmlFor="publish-offer-updates">
												Included updates
											</Label>
											<Input
												id="publish-offer-updates"
												max="10000"
												min="1"
												onChange={(event) =>
													setOfferMaxUpdates(event.target.value)
												}
												step="1"
												type="number"
												value={offerMaxUpdates}
											/>
											<p className="text-muted-foreground text-xs">
												One-time charge; each update is authorized separately.
											</p>
										</div>
									) : null}
									<p className="text-muted-foreground text-xs">
										Paid offers require completed Stripe Connect seller payouts.
										Ryu keeps the offer and entitlement; Stripe handles checkout
										and payouts.
									</p>
								</>
							)}
						</div>

						{installPrompt ? (
							<div className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
								<p className="font-medium">One-time GitHub access</p>
								<p className="text-muted-foreground">
									This private repository needs the Ryu GitHub App. It grants
									Ryu read-only release access for this seller; no GitHub token
									is saved in the desktop.
								</p>
								<div className="flex flex-wrap gap-2">
									<Button
										onClick={() => openGithubInstall()}
										size="sm"
										variant="secondary"
									>
										Install GitHub access
									</Button>
									<Button
										onClick={() => checkGithubInstall()}
										size="sm"
										variant="outline"
									>
										Check again
									</Button>
								</div>
							</div>
						) : null}

						{preflightReport ? (
							<section
								aria-live="polite"
								className="flex flex-col gap-2 rounded-xl border border-status-destructive/30 bg-destructive/5 p-3"
								role="alert"
							>
								<p className="font-medium text-sm">
									Preflight: Grade {preflightReport.grade ?? "unavailable"} ·{" "}
									{preflightReport.score ?? "—"}/100
								</p>
								<p className="text-muted-foreground text-xs">
									Only Grade A packages enter Ryu's admin review queue. Fix the
									items below and submit again.
								</p>
								<ul className="flex flex-col gap-1 text-xs">
									{preflightReport.checks
										.filter((check) => check.status !== "pass")
										.map((check) => (
											<li className="text-status-destructive" key={check.id}>
												<span className="font-medium">{check.label}:</span>{" "}
												{check.detail}
											</li>
										))}
								</ul>
							</section>
						) : null}
						{error && !preflightReport ? (
							<p className="text-sm text-status-destructive" role="alert">
								{error}
							</p>
						) : null}

						<DialogFooter>
							<Button onClick={() => handleOpenChange(false)} variant="ghost">
								Cancel
							</Button>
							<Button
								disabled={!signedIn || Boolean(blockedReason) || submitting}
								loading={submitting}
								onClick={() => handlePublish()}
							>
								{submitting
									? "Checking Grade A preflight…"
									: "Submit GitHub package"}
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

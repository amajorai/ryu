import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { MarketplacePromptBanner } from "@ryu/marketplace/catalog/chrome/marketplace-prompt-banner";
import VerifiedBadge from "@ryu/marketplace/catalog/chrome/verified-badge";
import { ListingSection } from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import {
	fetchDetail,
	type MarketplaceDetail,
	type MarketplaceKind,
} from "@/src/lib/api/marketplace.ts";
import {
	BundleContents,
	DetailLogo,
	MarketplacePreviewDetails,
	OverflowMenu,
} from "./DetailSections.tsx";

export function DetailBody({
	kind,
	id,
	initialName,
	initialIconUrl,
	onInstallBundle,
	onScreenshotOpenChange,
	bundleInstalling,
}: {
	kind: MarketplaceKind;
	id: string;
	initialName?: string;
	initialIconUrl?: string | null;
	onInstallBundle?: () => void;
	onScreenshotOpenChange: (open: boolean) => void;
	bundleInstalling: boolean;
}) {
	const [detail, setDetail] = useState<MarketplaceDetail | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { resolvedTheme } = useTheme();

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		fetchDetail(kind, id)
			.then((d) => {
				if (cancelled) {
					return;
				}
				setDetail(d);
				setError(null);
			})
			.catch((e) => {
				if (!cancelled) {
					setError(e instanceof Error ? e.message : "Could not load listing.");
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [kind, id]);

	const name = detail?.name || initialName || id;
	const iconUrl = detail?.iconUrl ?? initialIconUrl ?? null;
	// The header's primary CTA opens the first setup step that carries a link.
	const primaryAction = detail?.setup.find((s) => s.actionUrl) ?? null;
	const copyPrompt = useCallback((prompt: string) => {
		navigator.clipboard
			?.writeText(prompt)
			.then(() => sileo.success({ title: "Prompt copied" }))
			.catch(() => sileo.error({ title: "Could not copy prompt" }));
	}, []);

	return (
		<div className="flex flex-col gap-6 p-5 lg:p-7">
			<header className="flex items-start gap-4 pr-10">
				<div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted ring-1 ring-border">
					<DetailLogo iconUrl={iconUrl} name={name} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-start justify-between gap-4">
						<div className="min-w-0">
							<div className="flex min-w-0 items-center gap-2">
								<h2
									className="truncate font-medium text-2xl tracking-tight"
									title={name}
								>
									{name}
								</h2>
								<VerifiedBadge
									orgVerified={detail?.orgVerified}
									publisherTrust={detail?.publisherTrust}
									tier={detail?.orgVerifiedTier}
									verificationDetails={detail?.publisherVerification}
								/>
							</div>
							{detail?.tagline ? (
								<p className="mt-1 text-muted-foreground text-sm leading-relaxed">
									{detail.tagline}
								</p>
							) : null}
							{detail?.category ? (
								<p className="mt-2 text-muted-foreground text-xs">
									{detail.category}
								</p>
							) : null}
						</div>
						<div className="flex shrink-0 items-center gap-1.5">
							{primaryAction?.actionUrl ? (
								<Button
									nativeButton={false}
									render={
										<a
											href={primaryAction.actionUrl}
											rel="noopener noreferrer"
											target="_blank"
										/>
									}
									size="sm"
								>
									{primaryAction.actionLabel || "Open"}
									<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
								</Button>
							) : null}
							{detail ? <OverflowMenu detail={detail} /> : null}
						</div>
					</div>
				</div>
			</header>

			{loading && !detail ? <SkeletonRows spacing="section" /> : null}
			{error ? (
				<p className="text-sm text-status-destructive">{error}</p>
			) : null}

			{detail && detail.examplePrompts.length > 0 ? (
				<MarketplacePromptBanner
					banner={detail.banner}
					isDark={resolvedTheme !== "light"}
					name={name}
					onPrompt={copyPrompt}
					prompts={detail.examplePrompts}
					seed={detail.id}
				/>
			) : null}

			{detail?.description ? (
				<ListingSection title="About">
					<p className="whitespace-pre-wrap text-muted-foreground text-sm leading-relaxed">
						{detail.description}
					</p>
				</ListingSection>
			) : null}
			{detail ? (
				<>
					<CommunityStatsSection detail={detail} />
					{detail.kind === "bundle" ? (
						<BundleContents
							detail={detail}
							installing={bundleInstalling}
							onInstall={onInstallBundle}
						/>
					) : null}
				</>
			) : null}

			{detail ? (
				<MarketplacePreviewDetails
					detail={detail}
					id={id}
					kind={kind}
					onScreenshotOpenChange={onScreenshotOpenChange}
				/>
			) : null}
		</div>
	);
}

export function CommunityStatsSection({
	detail,
}: {
	detail: MarketplaceDetail;
}) {
	return (
		<section>
			<h3 className="mb-1 font-semibold text-sm">Community usage</h3>
			<p className="text-detail text-muted-foreground">
				Anonymous aggregate counts. No account, prompt or content is collected.
			</p>
			<div className="mt-3 grid grid-cols-3 gap-6">
				<CommunityStat
					label="Downloads"
					value={detail.communityStats.downloads}
				/>
				<CommunityStat label="Runs" value={detail.communityStats.runs} />
				<CommunityStat
					label="Anonymous instances"
					value={detail.communityStats.instances}
				/>
			</div>
		</section>
	);
}

export function CommunityStat({
	label,
	value,
}: {
	label: string;
	value: number;
}) {
	return (
		<div className="flex flex-col gap-1">
			<p className="text-detail text-muted-foreground">{label}</p>
			<p className="font-medium text-xl tabular-nums">{formatCount(value)}</p>
		</div>
	);
}

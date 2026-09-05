// apps/desktop/src/components/marketplace/MarketplaceDetailDialog.tsx
//
// App-Store / ChatGPT-plugin-style listing preview. Renders ONE canonical detail
// payload (lib/api/marketplace.ts `MarketplaceDetail`) produced by all three
// detail sources (built-in manifest, git MarketplaceSource, Ryu Mongo). The
// default view is intentionally small: identity, a manifest-driven sample-prompt
// banner, and the short description. Screenshots, setup, bundled skills, trust
// metadata, links, and reviews stay behind "More details" so the preview answers
// what the item does before asking the user to inspect its implementation.
//
// Every section renders ONLY when its data is present, so an older listing
// missing the richer fields still renders gracefully. The write form is gated to
// signed-in users; paid items are verified-purchasers-only server-side (surfaced
// as a "purchase" error), and a user may edit or delete their own review.

import {
	CheckmarkCircle02Icon,
	Delete02Icon,
	InformationCircleIcon,
	Layers01Icon,
	LegalDocument01Icon,
	LinkSquare02Icon,
	MoreHorizontalIcon,
	Rocket01Icon,
	Shield01Icon,
	SourceCodeIcon,
	SquareLock01Icon,
	UserIcon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ImageLightbox } from "@ryu/blocks/desktop/agent-elements/image-lightbox";
import { MarketplacePromptBanner } from "@ryu/marketplace/catalog/chrome/marketplace-prompt-banner";
import VerifiedBadge from "@ryu/marketplace/catalog/chrome/verified-badge";
import {
	ListingAsideCard,
	ListingInfoGrid,
	ListingSection,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { Avatar, AvatarFallback, AvatarImage } from "@ryu/ui/components/avatar";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { Textarea } from "@ryu/ui/components/textarea";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { ChevronDown } from "lucide-react";
import { useTheme } from "next-themes";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { sileo } from "sileo";
import { useSession } from "@/lib/auth-client.ts";
import {
	type DetailRunnable,
	type DetailSetupStep,
	deleteReview,
	fetchDetail,
	fetchReviews,
	type MarketplaceDetail,
	type MarketplaceError,
	type MarketplaceKind,
	postReview,
	type Review,
} from "@/src/lib/api/marketplace.ts";
import { StarRating, StarRatingInput } from "./StarRating.tsx";

const REVIEW_PAGE_LIMIT = 20;

interface RatingAggregate {
	average: number;
	count: number;
}

export default function MarketplaceDetailDialog({
	open,
	onClose,
	kind,
	id,
	initialName,
	initialIconUrl,
	onInstallBundle,
	bundleInstalling = false,
}: {
	open: boolean;
	onClose: () => void;
	kind: MarketplaceKind;
	id: string;
	/** Optional seed so the header shows a name before detail loads. */
	initialName?: string;
	initialIconUrl?: string | null;
	onInstallBundle?: () => void;
	bundleInstalling?: boolean;
}) {
	return (
		<Dialog
			onOpenChange={(next: boolean) => (next ? undefined : onClose())}
			open={open}
		>
			{/* The paid preview is intentionally a focused 720px card: identity,
			    sample prompts, and a short description first. Advanced install and trust
			    metadata stays behind the in-card disclosure below. */}
			<DialogContent className="max-h-[88vh] w-[min(45rem,94vw)] max-w-[min(45rem,94vw)] overflow-hidden p-0 sm:max-w-[min(45rem,94vw)]">
				<DialogHeader className="sr-only">
					<DialogTitle>{initialName ?? "Listing"}</DialogTitle>
				</DialogHeader>
				<div className="scroll-fade max-h-[88vh] overflow-y-auto overflow-x-hidden">
					{open ? (
						<DetailBody
							bundleInstalling={bundleInstalling}
							id={id}
							initialIconUrl={initialIconUrl}
							initialName={initialName}
							kind={kind}
							onInstallBundle={onInstallBundle}
						/>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function DetailBody({
	kind,
	id,
	initialName,
	initialIconUrl,
	onInstallBundle,
	bundleInstalling,
}: {
	kind: MarketplaceKind;
	id: string;
	initialName?: string;
	initialIconUrl?: string | null;
	onInstallBundle?: () => void;
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
			.catch((e: unknown) => {
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
				<div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted ring-1 ring-border/60">
					<DetailLogo iconUrl={iconUrl} name={name} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-start justify-between gap-4">
						<div className="min-w-0">
							<div className="flex min-w-0 items-center gap-2">
								<h2 className="truncate font-medium text-2xl tracking-tight">
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

			{loading && !detail ? (
				<div className="flex justify-center py-8">
					<Spinner className="size-5" />
				</div>
			) : null}
			{error ? <p className="text-destructive text-sm">{error}</p> : null}

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
				<MarketplacePreviewDetails detail={detail} id={id} kind={kind} />
			) : null}
		</div>
	);
}

function CommunityStatsSection({ detail }: { detail: MarketplaceDetail }) {
	return (
		<section className="rounded-xl border border-border/60 bg-muted/20 p-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h3 className="font-medium text-sm">Community usage</h3>
					<p className="mt-1 text-muted-foreground text-xs">
						Anonymous aggregate counts. No account, hostname, prompt, or content
						is collected.
					</p>
				</div>
				<HugeiconsIcon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
					icon={Shield01Icon}
				/>
			</div>
			<div className="mt-4 grid grid-cols-3 gap-2">
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

function CommunityStat({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-lg border border-border/60 bg-background/70 px-3 py-2">
			<p className="font-medium text-base tabular-nums">{formatCount(value)}</p>
			<p className="mt-0.5 text-[11px] text-muted-foreground">{label}</p>
		</div>
	);
}

function BundleContents({
	detail,
	onInstall,
	installing,
}: {
	detail: MarketplaceDetail;
	onInstall?: () => void;
	installing: boolean;
}) {
	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h3 className="font-medium text-sm">Bundle contents</h3>
					<p className="mt-1 text-muted-foreground text-xs">
						These existing Marketplace items install through their own trusted
						kind-specific paths.
					</p>
					{detail.bundleSourceUrl ? (
						<a
							className="mt-2 inline-block text-muted-foreground text-xs underline underline-offset-4 hover:text-foreground"
							href={detail.bundleSourceUrl}
							rel="noopener noreferrer"
							target="_blank"
						>
							View topic source
						</a>
					) : null}
				</div>
				{onInstall ? (
					<Button loading={installing} onClick={onInstall} size="sm">
						Install bundle
					</Button>
				) : null}
			</div>
			{detail.bundleMembers.length > 0 ? (
				<ul className="grid gap-2 sm:grid-cols-2">
					{detail.bundleMembers.map((member) => (
						<li
							className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
							key={`${member.kind}:${member.id}`}
						>
							<div className="min-w-0">
								<p className="truncate font-medium text-sm">
									{member.name ?? member.id}
								</p>
								<p className="truncate text-[11px] text-muted-foreground">
									{member.kind} · {member.id}
								</p>
							</div>
							<Badge variant={member.required ? "secondary" : "outline"}>
								{member.required ? "Required" : "Optional"}
							</Badge>
						</li>
					))}
				</ul>
			) : (
				<p className="text-muted-foreground text-sm">
					No installable members are declared for this bundle.
				</p>
			)}
		</section>
	);
}

/** Progressive disclosure for listing metadata, setup, bundled skills, and
 * reviews. The preview answers "what is this?" first; operators can still open
 * the complete trust/install context without making every listing a long form. */
function MarketplacePreviewDetails({
	detail,
	id,
	kind,
}: {
	detail: MarketplaceDetail;
	id: string;
	kind: MarketplaceKind;
}) {
	const [open, setOpen] = useState(false);
	const hasDetails =
		detail.setup.length > 0 ||
		detail.runnables.length > 0 ||
		detail.screenshots.length > 0 ||
		externalLinks(detail).length > 0 ||
		detail.capabilities.length > 0 ||
		Boolean(detail.languagePack) ||
		Boolean(detail.developer || detail.category || detail.version);
	if (!hasDetails) {
		return null;
	}

	return (
		<section className="border-border/60 border-t pt-4">
			<button
				aria-expanded={open}
				className="flex w-full items-center justify-between gap-3 text-left text-muted-foreground text-sm transition-colors hover:text-foreground"
				onClick={() => setOpen((value) => !value)}
				type="button"
			>
				<span>More details</span>
				<ChevronDown
					className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
				/>
			</button>
			{open ? (
				<div className="mt-4 flex flex-col gap-6">
					{detail.screenshots.length > 0 ? (
						<ScreenshotGallery
							name={detail.name}
							screenshots={detail.screenshots}
						/>
					) : null}
					{detail.setup.length > 0 ? (
						<SetupSection steps={detail.setup} />
					) : null}
					{detail.runnables.length > 0 ? (
						<RunnablesSection runnables={detail.runnables} />
					) : null}
					<InformationBlock detail={detail} />
					<ReviewsSection id={id} kind={kind} />
				</div>
			) : null}
		</section>
	);
}

/** Overflow (...) menu holding the listing's external links. Renders nothing when
 *  the listing carries no links. */
function OverflowMenu({ detail }: { detail: MarketplaceDetail }) {
	const links = externalLinks(detail);
	if (links.length === 0) {
		return null;
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button aria-label="More options" size="icon-sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
					</Button>
				}
			/>
			<DropdownMenuContent align="end">
				{links.map((link) => (
					<DropdownMenuItem
						key={link.href}
						render={
							<a href={link.href} rel="noopener noreferrer" target="_blank">
								<HugeiconsIcon className="size-4" icon={link.icon} />
								{link.label}
							</a>
						}
					/>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

interface ExternalLink {
	href: string;
	icon: IconSvgElement;
	label: string;
}

/** The listing's external links (website / privacy / terms), in display order,
 *  filtered to those actually present. */
function externalLinks(detail: MarketplaceDetail): ExternalLink[] {
	const links: ExternalLink[] = [];
	if (detail.website) {
		links.push({
			href: detail.website,
			icon: LinkSquare02Icon,
			label: "Website",
		});
	}
	if (detail.privacyPolicyUrl) {
		links.push({
			href: detail.privacyPolicyUrl,
			icon: Shield01Icon,
			label: "Privacy Policy",
		});
	}
	if (detail.termsOfServiceUrl) {
		links.push({
			href: detail.termsOfServiceUrl,
			icon: LegalDocument01Icon,
			label: "Terms of Service",
		});
	}
	return links;
}

function DetailLogo({
	iconUrl,
	name,
}: {
	iconUrl: string | null;
	name: string;
}) {
	// Fills the hero's icon tile rather than sizing itself: the tile owns the box,
	// the radius and the ring, so every realm's hero art is the same square.
	if (iconUrl) {
		return (
			<img
				alt={`${name} logo`}
				className="size-full object-cover"
				src={iconUrl}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="font-medium text-2xl text-foreground uppercase"
		>
			{name.trim().charAt(0) || "?"}
		</span>
	);
}

function ScreenshotGallery({
	screenshots,
	name,
}: {
	screenshots: string[];
	name: string;
}) {
	const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
	const lightboxOriginRef = useRef<HTMLElement | null>(null);
	const images = useMemo(
		() =>
			screenshots.map((url, i) => ({
				id: `${i}`,
				url,
				filename: `${name} screenshot ${i + 1}`,
			})),
		[screenshots, name]
	);

	return (
		<section className="flex flex-col gap-2">
			<h3 className="font-medium text-sm">Screenshots</h3>
			<div className="scroll-fade-x flex gap-3 overflow-x-auto pb-2">
				{screenshots.map((url, i) => (
					<button
						className="shrink-0 overflow-hidden rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						key={url}
						onClick={(event) => {
							lightboxOriginRef.current = event.currentTarget;
							setLightboxIndex(i);
						}}
						type="button"
					>
						<img
							alt={`${name} screenshot ${i + 1}`}
							className="h-40 w-auto object-cover"
							loading="lazy"
							src={url}
						/>
					</button>
				))}
			</div>
			<ImageLightbox
				images={images}
				initialIndex={lightboxIndex ?? 0}
				onClose={() => setLightboxIndex(null)}
				open={lightboxIndex !== null}
				originRef={lightboxOriginRef}
			/>
		</section>
	);
}

/** The "Setup" section: one card per companion/config step, each with an optional
 *  external action button. */
function SetupSection({ steps }: { steps: DetailSetupStep[] }) {
	return (
		<section className="flex flex-col gap-2">
			<h3 className="flex items-center gap-1.5 font-medium text-sm">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={Rocket01Icon}
				/>
				Setup
			</h3>
			<ul className="flex flex-col gap-2">
				{steps.map((step, i) => (
					<li
						className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3"
						key={step.title ?? step.actionUrl ?? `step-${i}`}
					>
						<div className="min-w-0 flex-1">
							{step.title ? (
								<p className="font-medium text-sm">{step.title}</p>
							) : null}
							{step.description ? (
								<p className="mt-0.5 text-muted-foreground text-sm">
									{step.description}
								</p>
							) : null}
						</div>
						{step.actionUrl ? (
							// Base UI: `render=`, not an `asChild` child (same rule as the
							// header CTA above) — otherwise this is an <a> inside a <button>.
							<Button
								nativeButton={false}
								render={
									<a
										href={step.actionUrl}
										rel="noopener noreferrer"
										target="_blank"
									/>
								}
								size="sm"
								variant="ghost"
							>
								{step.actionLabel || "Open"}
								<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
							</Button>
						) : null}
					</li>
				))}
			</ul>
		</section>
	);
}

/** Icon for a bundled runnable, keyed by its `kind`. */
function runnableIcon(kind: string): IconSvgElement {
	switch (kind.toLowerCase()) {
		case "skill":
			return SourceCodeIcon;
		case "tool":
			return Wrench01Icon;
		case "agent":
			return Rocket01Icon;
		default:
			return Layers01Icon;
	}
}

/** The "Skills N" section: bundled runnables with a name, description, and a
 *  toggle reflecting their enable state. The toggle is a read-only preview
 *  affordance (disabled) but is labelled for screen readers. */
function RunnablesSection({ runnables }: { runnables: DetailRunnable[] }) {
	return (
		<section className="flex flex-col gap-2">
			<h3 className="flex items-center gap-1.5 font-medium text-sm">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={Layers01Icon}
				/>
				Skills {formatCount(runnables.length) ?? "—"}
			</h3>
			<ul className="flex flex-col gap-2">
				{runnables.map((r) => (
					<li
						className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3"
						key={r.id}
					>
						<div className="flex min-w-0 flex-1 items-start gap-2.5">
							<HugeiconsIcon
								className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								icon={runnableIcon(r.kind)}
							/>
							<div className="min-w-0">
								<p className="truncate font-medium text-sm">{r.name}</p>
								{r.description ? (
									<p className="mt-0.5 text-muted-foreground text-xs">
										{r.description}
									</p>
								) : null}
							</div>
						</div>
						<Switch
							aria-label={`${r.name} enabled`}
							checked={r.enabled}
							disabled
						/>
					</li>
				))}
			</ul>
		</section>
	);
}

/** The "Information" block: a two-column key/value list of capabilities,
 *  developer, category, and version, followed by the listing's external links
 *  rendered as external-link icons. Each row renders only when its value exists. */
function InformationBlock({ detail }: { detail: MarketplaceDetail }) {
	const rows: { label: string; icon: IconSvgElement; value: ReactNode }[] = [];
	if (detail.capabilities.length > 0) {
		rows.push({
			label: "Capabilities",
			icon: CheckmarkCircle02Icon,
			value: (
				<span className="flex flex-wrap justify-end gap-1">
					{detail.capabilities.map((c) => (
						<Badge className="text-[11px]" key={c} variant="secondary">
							{c}
						</Badge>
					))}
				</span>
			),
		});
	}
	if (detail.developer) {
		rows.push({
			label: "Developer",
			icon: UserIcon,
			value: detail.developer,
		});
	}
	if (detail.category) {
		rows.push({
			label: "Category",
			icon: Layers01Icon,
			value: detail.category,
		});
	}
	if (detail.version) {
		rows.push({
			label: "Version",
			icon: InformationCircleIcon,
			value: detail.version,
		});
	}
	if (detail.languagePack) {
		rows.push({
			label: "Language",
			icon: InformationCircleIcon,
			value: `${detail.languagePack.locale} · ${detail.languagePack.baseLocale} · ${detail.languagePack.direction.toUpperCase()} · ${detail.languagePack.messageCount} strings`,
		});
	}

	const links = externalLinks(detail);
	if (rows.length === 0 && links.length === 0) {
		return null;
	}

	// Rendered inside the collapsed preview's advanced section. The information
	// stays available for trust/install decisions without leading every listing
	// with a long metadata rail.
	return (
		<ListingAsideCard title="Information">
			<ListingInfoGrid
				rows={[
					...rows.map((row) => ({ label: row.label, value: row.value })),
					...(links.length > 0
						? [
								{
									label: "Links",
									value: (
										<span className="flex items-center justify-end gap-1">
											{links.map((link) => (
												<a
													aria-label={link.label}
													className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
													href={link.href}
													key={link.href}
													rel="noopener noreferrer"
													target="_blank"
													title={link.label}
												>
													<HugeiconsIcon className="size-4" icon={link.icon} />
												</a>
											))}
										</span>
									),
								},
							]
						: []),
				]}
			/>
		</ListingAsideCard>
	);
}

// ── Reviews ─────────────────────────────────────────────────────────────────

function ReviewsSection({
	kind,
	id,
	onRatingChange,
}: {
	kind: MarketplaceKind;
	id: string;
	onRatingChange?: (rating: RatingAggregate) => void;
}) {
	const { data: session } = useSession();
	const currentUserId = session?.user?.id ?? null;

	const [reviews, setReviews] = useState<Review[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const page = await fetchReviews(kind, id, { limit: REVIEW_PAGE_LIMIT });
			setReviews(page.reviews);
			setNextCursor(page.nextCursor);
			onRatingChange?.({
				average: page.ratingAverage,
				count: page.ratingCount,
			});
		} catch {
			// Reviews are non-critical; leave the list empty on failure.
		} finally {
			setLoading(false);
		}
	}, [kind, id, onRatingChange]);

	useEffect(() => {
		load().catch(() => undefined);
	}, [load]);

	const loadMore = useCallback(async () => {
		if (!nextCursor) {
			return;
		}
		setLoadingMore(true);
		try {
			const page = await fetchReviews(kind, id, {
				limit: REVIEW_PAGE_LIMIT,
				cursor: nextCursor,
			});
			setReviews((prev) => [...prev, ...page.reviews]);
			setNextCursor(page.nextCursor);
		} catch {
			// Ignore — the "Load more" button stays available for a retry.
		} finally {
			setLoadingMore(false);
		}
	}, [kind, id, nextCursor]);

	const myReview = useMemo(
		() => reviews.find((r) => r.userId === currentUserId) ?? null,
		[reviews, currentUserId]
	);

	return (
		<section className="flex flex-col gap-4">
			<h3 className="font-medium text-sm">Reviews</h3>

			<WriteReviewForm
				existing={myReview}
				id={id}
				kind={kind}
				onSubmitted={load}
				signedIn={Boolean(currentUserId)}
			/>

			{loading && reviews.length === 0 ? (
				<div className="flex justify-center py-4">
					<Spinner className="size-4" />
				</div>
			) : null}

			{!loading && reviews.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					No reviews yet. Be the first to review this item.
				</p>
			) : null}

			<ul className="flex flex-col gap-4">
				{reviews.map((review) => (
					<ReviewItem
						isOwn={review.userId === currentUserId}
						key={review.id}
						review={review}
					/>
				))}
			</ul>

			{nextCursor ? (
				<Button
					className="self-start"
					loading={loadingMore}
					onClick={() => loadMore()}
					size="sm"
					variant="ghost"
				>
					Load more
				</Button>
			) : null}
		</section>
	);
}

function ReviewItem({ review, isOwn }: { review: Review; isOwn: boolean }) {
	return (
		<li className="flex gap-3">
			<Avatar className="size-8 shrink-0">
				{review.userImage ? (
					<AvatarImage
						alt={review.userName ?? "Reviewer"}
						src={review.userImage}
					/>
				) : null}
				<AvatarFallback className="overflow-hidden bg-transparent p-0">
					<DitherAvatar
						className="size-full"
						name={review.userId ?? review.userName ?? "anonymous"}
					/>
				</AvatarFallback>
			</Avatar>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium text-sm">
						{review.userName ?? "Anonymous"}
					</span>
					{isOwn ? (
						<Badge className="text-[10px]" variant="secondary">
							You
						</Badge>
					) : null}
					{review.verifiedPurchase ? (
						<Badge className="text-[10px]" variant="outline">
							Verified purchase
						</Badge>
					) : null}
					<StarRating size="size-3.5" value={review.rating} />
				</div>
				{review.title ? (
					<p className="mt-1 font-medium text-sm">{review.title}</p>
				) : null}
				{review.body ? (
					<p className="mt-0.5 text-muted-foreground text-sm">{review.body}</p>
				) : null}
			</div>
		</li>
	);
}

function WriteReviewForm({
	kind,
	id,
	signedIn,
	existing,
	onSubmitted,
}: {
	kind: MarketplaceKind;
	id: string;
	signedIn: boolean;
	existing: Review | null;
	onSubmitted: () => Promise<void>;
}) {
	const [rating, setRating] = useState(existing?.rating ?? 0);
	const [title, setTitle] = useState(existing?.title ?? "");
	const [body, setBody] = useState(existing?.body ?? "");
	const [busy, setBusy] = useState(false);
	const [purchaseRequired, setPurchaseRequired] = useState(false);

	// Re-seed the form whenever the user's existing review changes (e.g. after a
	// reload surfaces it, or a different item is opened in the same dialog).
	useEffect(() => {
		setRating(existing?.rating ?? 0);
		setTitle(existing?.title ?? "");
		setBody(existing?.body ?? "");
	}, [existing]);

	const submit = useCallback(async () => {
		if (rating < 1) {
			sileo.error({ title: "Pick a star rating first." });
			return;
		}
		setBusy(true);
		setPurchaseRequired(false);
		try {
			await postReview({
				kind,
				id,
				rating,
				title: title.trim() || undefined,
				body: body.trim() || undefined,
			});
			sileo.success({ title: existing ? "Review updated." : "Review posted." });
			await onSubmitted();
		} catch (e) {
			if ((e as MarketplaceError).kind === "purchase") {
				setPurchaseRequired(true);
			} else {
				const message =
					e instanceof Error ? e.message : "Could not post your review.";
				sileo.error({ title: message });
			}
		} finally {
			setBusy(false);
		}
	}, [kind, id, rating, title, body, existing, onSubmitted]);

	const remove = useCallback(async () => {
		setBusy(true);
		try {
			await deleteReview(kind, id);
			setRating(0);
			setTitle("");
			setBody("");
			sileo.success({ title: "Review removed." });
			await onSubmitted();
		} catch (e) {
			const message =
				e instanceof Error ? e.message : "Could not remove your review.";
			sileo.error({ title: message });
		} finally {
			setBusy(false);
		}
	}, [kind, id, onSubmitted]);

	if (!signedIn) {
		return (
			<p className="rounded-md bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
				Sign in to write a review.
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-3 rounded-lg bg-card p-4">
			<div className="flex items-center justify-between gap-2">
				<span className="font-medium text-sm">
					{existing ? "Edit your review" : "Write a review"}
				</span>
				<StarRatingInput disabled={busy} onChange={setRating} value={rating} />
			</div>
			<Input
				aria-label="Review title"
				disabled={busy}
				maxLength={120}
				onChange={(e) => setTitle(e.target.value)}
				placeholder="Title (optional)"
				value={title}
			/>
			<Textarea
				aria-label="Review body"
				disabled={busy}
				maxLength={2000}
				onChange={(e) => setBody(e.target.value)}
				placeholder="Share what you think (optional)"
				rows={3}
				value={body}
			/>
			{purchaseRequired ? (
				<p className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
					<HugeiconsIcon className="size-4 shrink-0" icon={SquareLock01Icon} />
					Only verified purchasers can review this paid item. Buy it first to
					leave a review.
				</p>
			) : null}
			<div className="flex items-center gap-2">
				<Button loading={busy} onClick={() => submit()} size="sm">
					{existing ? "Update review" : "Post review"}
				</Button>
				{existing ? (
					<Button
						disabled={busy}
						onClick={() => remove()}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="mr-2 size-4" icon={Delete02Icon} />
						Delete
					</Button>
				) : null}
			</div>
		</div>
	);
}

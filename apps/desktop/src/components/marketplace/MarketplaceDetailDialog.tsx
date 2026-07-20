// apps/desktop/src/components/marketplace/MarketplaceDetailDialog.tsx
//
// App-Store / ChatGPT-plugin-style listing detail. Renders ONE canonical detail
// payload (lib/api/marketplace.ts `MarketplaceDetail`) produced by all three
// detail sources (built-in manifest, git MarketplaceSource, Ryu Mongo). Layout,
// top to bottom: a header (logo, name, tagline, an overflow menu of external
// links, and a primary "Open" CTA when the payload carries a setup action), a row
// of example-prompt chips, a screenshot gallery, the long description, a Setup
// section (companion/config cards), a Skills section (bundled runnables with an
// enable-state toggle), an Information block (capabilities / developer / category
// / version + external links), and finally the reviews list + write-review form.
//
// Every section renders ONLY when its data is present, so an older listing
// missing the richer fields still renders gracefully. The write form is gated to
// signed-in users; paid items are verified-purchasers-only server-side (surfaced
// as a "purchase" error), and a user may edit or delete their own review.

import {
	ArrowRight01Icon,
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
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
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
}: {
	open: boolean;
	onClose: () => void;
	kind: MarketplaceKind;
	id: string;
	/** Optional seed so the header shows a name before detail loads. */
	initialName?: string;
	initialIconUrl?: string | null;
}) {
	return (
		<Dialog
			onOpenChange={(next: boolean) => (next ? undefined : onClose())}
			open={open}
		>
			<DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
				<DialogHeader className="sr-only">
					<DialogTitle>{initialName ?? "Listing"}</DialogTitle>
				</DialogHeader>
				{open ? (
					<DetailBody
						id={id}
						initialIconUrl={initialIconUrl}
						initialName={initialName}
						kind={kind}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function DetailBody({
	kind,
	id,
	initialName,
	initialIconUrl,
}: {
	kind: MarketplaceKind;
	id: string;
	initialName?: string;
	initialIconUrl?: string | null;
}) {
	const [detail, setDetail] = useState<MarketplaceDetail | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [rating, setRating] = useState<RatingAggregate>({
		average: 0,
		count: 0,
	});

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		fetchDetail(kind, id)
			.then((d) => {
				if (cancelled) {
					return;
				}
				setDetail(d);
				setRating({ average: d.ratingAverage, count: d.ratingCount });
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

	return (
		<div className="flex flex-col gap-6">
			<header className="flex items-start gap-4">
				<DetailLogo iconUrl={iconUrl} name={name} />
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-lg">{name}</h2>
					{detail?.tagline ? (
						<p className="mt-0.5 truncate text-muted-foreground text-sm">
							{detail.tagline}
						</p>
					) : null}
					<div className="mt-1.5 flex flex-wrap items-center gap-2">
						{detail?.category ? (
							<Badge variant="outline">{detail.category}</Badge>
						) : null}
						{detail?.version ? (
							<Badge className="text-[10px]" variant="outline">
								v{detail.version}
							</Badge>
						) : null}
						{rating.count > 0 ? (
							<StarRating
								count={rating.count}
								showValue
								value={rating.average}
							/>
						) : (
							<span className="text-muted-foreground text-xs">
								No reviews yet
							</span>
						)}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{detail ? <OverflowMenu detail={detail} /> : null}
					{primaryAction?.actionUrl ? (
						<Button asChild size="sm">
							<a
								href={primaryAction.actionUrl}
								rel="noopener noreferrer"
								target="_blank"
							>
								{primaryAction.actionLabel || "Open"}
								<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
							</a>
						</Button>
					) : null}
				</div>
			</header>

			{loading && !detail ? (
				<div className="flex justify-center py-8">
					<Spinner className="size-5" />
				</div>
			) : null}
			{error ? <p className="text-destructive text-sm">{error}</p> : null}

			{detail && detail.examplePrompts.length > 0 ? (
				<ExamplePrompts name={name} prompts={detail.examplePrompts} />
			) : null}

			{detail && detail.screenshots.length > 0 ? (
				<ScreenshotGallery name={name} screenshots={detail.screenshots} />
			) : null}

			{detail?.description ? (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">About</h3>
					<p className="whitespace-pre-wrap text-muted-foreground text-sm leading-relaxed">
						{detail.description}
					</p>
				</section>
			) : null}

			{detail && detail.setup.length > 0 ? (
				<SetupSection steps={detail.setup} />
			) : null}

			{detail && detail.runnables.length > 0 ? (
				<RunnablesSection runnables={detail.runnables} />
			) : null}

			{detail ? <InformationBlock detail={detail} /> : null}

			<ReviewsSection id={id} kind={kind} onRatingChange={setRating} />
		</div>
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
	if (iconUrl) {
		return (
			<img
				alt={`${name} logo`}
				className="size-16 shrink-0 rounded-xl border object-cover"
				src={iconUrl}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-muted font-semibold text-2xl text-muted-foreground uppercase"
		>
			{name.trim().charAt(0) || "?"}
		</span>
	);
}

/** Horizontal row of example-prompt chips. Each chip is a keyboard-reachable
 *  button that copies its prompt to the clipboard — a cheap, no-dependency
 *  default action for a preview surface. The chip shows the app-name pill, the
 *  prompt text, and a trailing arrow, mirroring the ChatGPT-plugin reference. */
function ExamplePrompts({
	prompts,
	name,
}: {
	prompts: string[];
	name: string;
}) {
	const copy = useCallback((prompt: string) => {
		navigator.clipboard
			?.writeText(prompt)
			.then(() => sileo.success({ title: "Prompt copied" }))
			.catch(() => sileo.error({ title: "Could not copy prompt" }));
	}, []);

	return (
		<section className="flex flex-col gap-2">
			<h3 className="font-medium text-sm">Try it</h3>
			<div className="flex gap-2 overflow-x-auto pb-1">
				{prompts.map((prompt) => (
					<button
						className="group flex shrink-0 items-center gap-2 rounded-full border bg-card py-1.5 pr-2.5 pl-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						key={prompt}
						onClick={() => copy(prompt)}
						title="Copy prompt"
						type="button"
					>
						<span className="rounded-full bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
							{name}
						</span>
						<span className="max-w-[16rem] truncate text-sm">{prompt}</span>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
							icon={ArrowRight01Icon}
						/>
					</button>
				))}
			</div>
		</section>
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
			<div className="flex gap-3 overflow-x-auto pb-2">
				{screenshots.map((url, i) => (
					<button
						className="shrink-0 overflow-hidden rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						key={url}
						onClick={() => setLightboxIndex(i)}
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
							<Button asChild size="sm" variant="outline">
								<a
									href={step.actionUrl}
									rel="noopener noreferrer"
									target="_blank"
								>
									{step.actionLabel || "Open"}
									<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
								</a>
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
				Skills {runnables.length}
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

	const links = externalLinks(detail);
	if (rows.length === 0 && links.length === 0) {
		return null;
	}

	return (
		<section className="flex flex-col gap-2">
			<h3 className="font-medium text-sm">Information</h3>
			<dl className="flex flex-col divide-y divide-border rounded-lg border">
				{rows.map((row) => (
					<div
						className="flex items-start justify-between gap-3 px-3 py-2.5"
						key={row.label}
					>
						<dt className="flex items-center gap-1.5 text-muted-foreground text-sm">
							<HugeiconsIcon className="size-4" icon={row.icon} />
							{row.label}
						</dt>
						<dd className="min-w-0 text-right text-sm">{row.value}</dd>
					</div>
				))}
				{links.length > 0 ? (
					<div className="flex items-center justify-between gap-3 px-3 py-2.5">
						<dt className="flex items-center gap-1.5 text-muted-foreground text-sm">
							<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
							Links
						</dt>
						<dd className="flex items-center gap-1">
							{links.map((link) => (
								<a
									aria-label={link.label}
									className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									href={link.href}
									key={link.href}
									rel="noopener noreferrer"
									target="_blank"
									title={link.label}
								>
									<HugeiconsIcon className="size-4" icon={link.icon} />
								</a>
							))}
						</dd>
					</div>
				) : null}
			</dl>
		</section>
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
	onRatingChange: (rating: RatingAggregate) => void;
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
			onRatingChange({ average: page.ratingAverage, count: page.ratingCount });
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
					disabled={loadingMore}
					onClick={() => loadMore()}
					size="sm"
					variant="outline"
				>
					{loadingMore ? <Spinner className="mr-2 size-4" /> : null}
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
						name={review.userName ?? "anonymous"}
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
				<Button disabled={busy} onClick={() => submit()} size="sm">
					{busy ? <Spinner className="mr-2 size-4" /> : null}
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

// The Reviews detail tab: the item's rating aggregate, the user-submitted reviews,
// and the caller's own write/edit/delete form.
//
// The review data lives on the CONTROL PLANE, not on the Core node the catalog is
// browsed from, so every call crosses the `host.reviews` seam
// (see `MarketplaceReviewsService`). That is also why this panel owns its own
// loading/error state instead of receiving reviews as props: the catalog's detail
// fetch talks to Core and knows nothing about ratings.
//
// Failure posture: signed-out or offline callers still see loaded reviews, and
// the form says why it is unavailable. A paid item's 403 (`requiresPurchase`)
// gates review eligibility only and shows the server's message, never pre-judged.

import {
	Alert02Icon,
	CheckmarkBadge01Icon,
	MessageMultiple01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	STORE_LOAD_ERROR_SENTENCE,
	StoreErrorDetails,
} from "@ryu/blocks/desktop/store-error-details.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
	MarketplaceReview,
	MarketplaceReviewsService,
} from "../../host.tsx";
import { StarRating, StarRatingInput } from "../../star-rating.tsx";
import type { MarketplaceKind } from "../../types.ts";
import { formatDate } from "./detail-panels.tsx";

/** Page size for the review list. One page is the tab's initial read; "Load more"
 *  walks the cursor rather than fetching an unbounded list into a side panel. */
const REVIEWS_PAGE_SIZE = 20;

/** Cap mirroring the server's own `MAX_REVIEW_BODY` guard, so the textarea cannot
 *  build a body the write will silently truncate. */
const MAX_BODY_CHARS = 4000;
const MAX_TITLE_CHARS = 120;

/** The default rating a fresh form opens on — deliberately the top of the scale is
 *  NOT the default; an unset rating (0) forces a deliberate pick. */
const UNRATED = 0;

interface ReviewsState {
	error: string | null;
	hasLoaded: boolean;
	loading: boolean;
	loadingMore: boolean;
	nextCursor: string | null;
	ratingAverage: number;
	ratingCount: number;
	reviews: MarketplaceReview[];
}

const EMPTY_STATE: ReviewsState = {
	error: null,
	hasLoaded: false,
	loading: true,
	loadingMore: false,
	nextCursor: null,
	ratingAverage: 0,
	ratingCount: 0,
	reviews: [],
};

/**
 * Ratings + reviews for one catalog listing.
 *
 * `kind`/`id` address the item on the control plane. `service` is the injected
 * review client; when the host provides none this component is not rendered at all
 * (the tab is omitted upstream), so `service` is required here rather than
 * optional — an always-empty Reviews tab would be worse than no tab.
 */
export default function ReviewsPanel({
	id,
	kind,
	service,
}: {
	id: string;
	kind: MarketplaceKind;
	service: MarketplaceReviewsService;
}) {
	return (
		<ListingReviews
			id={id}
			key={`${kind}:${id}`}
			kind={kind}
			service={service}
		/>
	);
}

function ListingReviews({
	id,
	kind,
	service,
}: {
	id: string;
	kind: MarketplaceKind;
	service: MarketplaceReviewsService;
}) {
	const [state, setState] = useState<ReviewsState>(EMPTY_STATE);
	const [writing, setWriting] = useState(false);
	const requestVersion = useRef(0);

	const load = useCallback(
		(cursor: string | null) => {
			const version = ++requestVersion.current;
			setState((prev) =>
				cursor
					? { ...prev, loadingMore: true, error: null }
					: { ...EMPTY_STATE, loading: true }
			);
			service
				.list({ id, kind, cursor, limit: REVIEWS_PAGE_SIZE })
				.then((page) => {
					if (version !== requestVersion.current) {
						return;
					}
					setState((prev) => ({
						error: null,
						hasLoaded: true,
						loading: false,
						loadingMore: false,
						nextCursor: page.nextCursor,
						ratingAverage: page.ratingAverage,
						ratingCount: page.ratingCount,
						// Appending on a cursor read keeps the already-rendered page stable
						// while "Load more" resolves.
						reviews: cursor ? [...prev.reviews, ...page.reviews] : page.reviews,
					}));
				})
				.catch((e) => {
					if (version !== requestVersion.current) {
						return;
					}
					setState((prev) => ({
						...prev,
						loading: false,
						loadingMore: false,
						error: e instanceof Error ? e.message : "Could not load reviews.",
					}));
				});
		},
		[id, kind, service]
	);

	// Reload when the selected listing changes — the panel is remounted per
	// selection in the side pane, but the dialog preview reuses it.
	useEffect(() => {
		setWriting(false);
		load(null);
		return () => {
			requestVersion.current++;
		};
	}, [load]);

	const mine = state.reviews.find((r) => r.mine) ?? null;

	if (state.loading) {
		return (
			<div className="flex items-center justify-center p-6">
				<Spinner className="size-5" />
			</div>
		);
	}

	if (state.error && !state.hasLoaded) {
		return (
			<Empty inset="dense" role="alert">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Alert02Icon} />
					</EmptyMedia>
					<EmptyTitle>Could not load reviews</EmptyTitle>
					<EmptyDescription>{STORE_LOAD_ERROR_SENTENCE}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={() => load(null)} size="sm" variant="outline">
						Try again
					</Button>
					<StoreErrorDetails message={state.error} />
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			<RatingSummary
				average={state.ratingAverage}
				count={state.ratingCount}
				onWrite={service.canWrite() ? () => setWriting(true) : null}
				writingOpen={writing || mine != null}
			/>

			{state.error ? (
				<p
					className="flex items-center gap-1.5 text-sm text-status-destructive"
					role="alert"
				>
					<HugeiconsIcon className="size-4" icon={Alert02Icon} />
					{state.error}
				</p>
			) : null}

			{writing || mine ? (
				<WriteReviewForm
					existing={mine}
					id={id}
					kind={kind}
					onClose={() => setWriting(false)}
					onSaved={() => {
						setWriting(false);
						load(null);
					}}
					service={service}
				/>
			) : null}

			{state.reviews.length === 0 ? (
				<Empty inset="dense">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={MessageMultiple01Icon} />
						</EmptyMedia>
						<EmptyTitle>No reviews yet</EmptyTitle>
						<EmptyDescription>
							{service.canWrite()
								? "Be the first to say how this worked for you."
								: "Sign in to write the first review."}
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						{service.canWrite() ? (
							<Button onClick={() => setWriting(true)} size="sm">
								Write the first review
							</Button>
						) : service.onSignIn ? (
							<Button onClick={() => void service.onSignIn?.()} size="sm">
								Sign in to review
							</Button>
						) : null}
					</EmptyContent>
				</Empty>
			) : (
				<ul className="flex flex-col gap-3">
					{state.reviews.map((review) => (
						<ReviewRow key={review.id} review={review} />
					))}
				</ul>
			)}

			{state.nextCursor ? (
				<Button
					className="self-start"
					loading={state.loadingMore}
					onClick={() => load(state.nextCursor)}
					size="sm"
					variant="ghost"
				>
					Load more reviews
				</Button>
			) : null}
		</div>
	);
}

/** The aggregate header: the mean, the star row, the count, and the write CTA. */
function RatingSummary({
	average,
	count,
	onWrite,
	writingOpen,
}: {
	average: number;
	count: number;
	/** `null` when the surface has no signed-in session to write with. */
	onWrite: (() => void) | null;
	writingOpen: boolean;
}) {
	return (
		<div className="flex items-start justify-between gap-4">
			<div className="flex flex-col gap-1">
				{count === 0 ? (
					<p className="text-muted-foreground text-sm">Not rated yet</p>
				) : (
					<>
						<div className="flex items-baseline gap-2">
							<span className="font-medium text-3xl tabular-nums">
								{(Math.round(average * 10) / 10).toFixed(1)}
							</span>
							<span className="text-muted-foreground text-sm">out of 5</span>
						</div>
						<StarRating count={count} value={average} />
					</>
				)}
			</div>
			{onWrite && !writingOpen ? (
				<Button onClick={onWrite} size="sm" variant="ghost">
					Write a review
				</Button>
			) : null}
			{onWrite === null ? (
				<p className="max-w-48 text-right text-muted-foreground text-xs">
					Sign in to your Ryu account to write a review.
				</p>
			) : null}
		</div>
	);
}

/** One submitted review. */
function ReviewRow({ review }: { review: MarketplaceReview }) {
	const date = formatDate(review.createdAt);
	return (
		<li className="flex flex-col gap-1.5 rounded-lg bg-muted p-3">
			<div className="flex items-center gap-2">
				<StarRating size="size-3.5" value={review.rating} />
				<span className="min-w-0 truncate font-medium text-sm">
					{review.userName ?? "Anonymous"}
				</span>
				{review.verifiedPurchase ? (
					<Badge className="shrink-0" variant="secondary">
						<HugeiconsIcon
							className="size-3 text-status-success"
							icon={CheckmarkBadge01Icon}
						/>
						Verified purchase
					</Badge>
				) : null}
				{review.mine ? (
					<Badge className="shrink-0" variant="outline">
						Yours
					</Badge>
				) : null}
				{date ? (
					<span className="ml-auto shrink-0 text-muted-foreground text-xs">
						{date}
					</span>
				) : null}
			</div>
			{review.title ? (
				<p className="font-medium text-sm">{review.title}</p>
			) : null}
			{review.body ? (
				<p className="whitespace-pre-wrap text-muted-foreground text-sm leading-relaxed">
					{review.body}
				</p>
			) : null}
		</li>
	);
}

/** Write / edit / delete the caller's own review. The write is an upsert, so an
 *  existing review pre-fills the form and re-posting edits it in place. */
function WriteReviewForm({
	existing,
	id,
	kind,
	onClose,
	onSaved,
	service,
}: {
	existing: MarketplaceReview | null;
	id: string;
	kind: MarketplaceKind;
	onClose: () => void;
	onSaved: () => void;
	service: MarketplaceReviewsService;
}) {
	const titleId = useId();
	const bodyId = useId();
	const [rating, setRating] = useState(existing?.rating ?? UNRATED);
	const [title, setTitle] = useState(existing?.title ?? "");
	const [body, setBody] = useState(existing?.body ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = () => {
		if (rating === UNRATED) {
			setError("Pick a star rating first.");
			return;
		}
		setBusy(true);
		setError(null);
		service
			.post({
				id,
				kind,
				rating,
				title: title.trim() || undefined,
				body: body.trim() || undefined,
			})
			.then(() => onSaved())
			// The server's message is the useful one here — it distinguishes "verified
			// purchasers only" from a transport failure, and only it knows which.
			.catch((e) => {
				setError(
					e instanceof Error ? e.message : "Could not save your review."
				);
			})
			.finally(() => setBusy(false));
	};

	const remove = () => {
		setBusy(true);
		setError(null);
		service
			.remove({ id, kind })
			.then(() => onSaved())
			.catch((e) => {
				setError(
					e instanceof Error ? e.message : "Could not delete your review."
				);
			})
			.finally(() => setBusy(false));
	};

	const cancel = () => {
		if (existing) {
			setRating(existing.rating);
			setTitle(existing.title ?? "");
			setBody(existing.body ?? "");
			setError(null);
		}
		onClose();
	};

	return (
		<div className="flex flex-col gap-3 rounded-lg bg-muted p-3">
			<div className="flex flex-col gap-1.5">
				<span className="font-medium text-sm">
					{existing ? "Your review" : "Write a review"}
				</span>
				<StarRatingInput disabled={busy} onChange={setRating} value={rating} />
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor={titleId}>Title (optional)</Label>
				<Input
					id={titleId}
					maxLength={MAX_TITLE_CHARS}
					onChange={(e) => setTitle(e.target.value)}
					placeholder="Sums it up in a line"
					value={title}
				/>
			</div>
			<div className="flex flex-col gap-1">
				<Label htmlFor={bodyId}>Review (optional)</Label>
				<Textarea
					id={bodyId}
					maxLength={MAX_BODY_CHARS}
					onChange={(e) => setBody(e.target.value)}
					placeholder="What worked, what didn't, who it's for."
					rows={4}
					value={body}
				/>
			</div>
			{error ? (
				<p className="text-sm text-status-destructive">{error}</p>
			) : null}
			<div className="flex items-center gap-2">
				<Button loading={busy} onClick={submit} size="sm">
					{existing ? "Update review" : "Post review"}
				</Button>
				<Button disabled={busy} onClick={cancel} size="sm" variant="ghost">
					Cancel
				</Button>
				{existing ? (
					<Button
						className="ml-auto"
						disabled={busy}
						onClick={remove}
						size="sm"
						variant="ghost"
					>
						Delete
					</Button>
				) : null}
			</div>
		</div>
	);
}

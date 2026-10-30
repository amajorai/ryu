import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "@/lib/auth-client.ts";
import {
	fetchReviews,
	type MarketplaceKind,
	type Review,
} from "@/src/lib/api/marketplace.ts";
import { StarRating } from "../StarRating.tsx";
import { type RatingAggregate, REVIEW_PAGE_LIMIT } from "./detail-constants.ts";
import { WriteReviewForm } from "./WriteReviewForm.tsx";

// ── Reviews ─────────────────────────────────────────────────────────────────

export function ReviewsSection({
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
	const [reviewsError, setReviewsError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setReviewsError(null);
		try {
			const page = await fetchReviews(kind, id, { limit: REVIEW_PAGE_LIMIT });
			setReviews(page.reviews);
			setNextCursor(page.nextCursor);
			onRatingChange?.({
				average: page.ratingAverage,
				count: page.ratingCount,
			});
		} catch {
			setReviewsError("Couldn't load reviews. Try again.");
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
		setReviewsError(null);
		try {
			const page = await fetchReviews(kind, id, {
				limit: REVIEW_PAGE_LIMIT,
				cursor: nextCursor,
			});
			setReviews((prev) => [...prev, ...page.reviews]);
			setNextCursor(page.nextCursor);
		} catch {
			setReviewsError("Couldn't load more reviews. Try again.");
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
			{reviewsError && (
				<div
					className="flex items-center justify-between gap-2 text-sm text-status-destructive"
					role="alert"
				>
					<span>{reviewsError}</span>
					{reviews.length === 0 && (
						<Button onClick={() => void load()} size="sm" variant="outline">
							Retry reviews
						</Button>
					)}
				</div>
			)}

			<WriteReviewForm
				disabled={loading || (Boolean(reviewsError) && reviews.length === 0)}
				existing={myReview}
				id={id}
				kind={kind}
				onSubmitted={load}
				signedIn={Boolean(currentUserId)}
			/>

			{loading && reviews.length === 0 ? (
				<SkeletonRows spacing="spacious" />
			) : null}

			{!(loading || reviewsError) && reviews.length === 0 ? (
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

export function ReviewItem({
	review,
	isOwn,
}: {
	review: Review;
	isOwn: boolean;
}) {
	return (
		<li className="flex gap-3">
			<Avatar className="size-8 shrink-0">
				{review.userImage ? (
					<AvatarImage
						alt={review.userName ?? "Reviewer"}
						src={review.userImage}
					/>
				) : null}
				<AvatarFallback appearance="artwork" className="overflow-hidden">
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
						<Badge size="compact" variant="secondary">
							You
						</Badge>
					) : null}
					{review.verifiedPurchase ? (
						<Badge size="compact" variant="outline">
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

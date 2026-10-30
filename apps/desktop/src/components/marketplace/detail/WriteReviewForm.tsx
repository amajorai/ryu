import { Delete02Icon, SquareLock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import {
	deleteReview,
	MarketplaceError,
	type MarketplaceKind,
	postReview,
	type Review,
} from "@/src/lib/api/marketplace.ts";
import { StarRatingInput } from "../StarRating.tsx";

export function WriteReviewForm({
	kind,
	id,
	signedIn,
	disabled,
	existing,
	onSubmitted,
}: {
	kind: MarketplaceKind;
	id: string;
	signedIn: boolean;
	disabled: boolean;
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
			if (e instanceof MarketplaceError && e.kind === "purchase") {
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
			<p className="rounded-lg bg-muted px-3 py-2 text-muted-foreground text-sm">
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
				<StarRatingInput
					disabled={busy || disabled}
					onChange={setRating}
					value={rating}
				/>
			</div>
			<Input
				aria-label="Review title"
				disabled={busy || disabled}
				maxLength={120}
				onChange={(e) => setTitle(e.target.value)}
				placeholder="Title (optional)"
				value={title}
			/>
			<Textarea
				aria-label="Review body"
				disabled={busy || disabled}
				maxLength={2000}
				onChange={(e) => setBody(e.target.value)}
				placeholder="Share what you think (optional)"
				rows={3}
				value={body}
			/>
			{purchaseRequired ? (
				<p className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-muted-foreground text-sm">
					<HugeiconsIcon className="size-4 shrink-0" icon={SquareLock01Icon} />
					Only verified purchasers can review this paid item. Buy it first to
					leave a review.
				</p>
			) : null}
			<div className="flex items-center gap-2">
				<Button
					disabled={disabled}
					loading={busy}
					onClick={() => submit()}
					size="sm"
				>
					{existing ? "Update review" : "Post review"}
				</Button>
				{existing ? (
					<Button
						disabled={busy || disabled}
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

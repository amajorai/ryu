import {
	Alert02Icon,
	Download01Icon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { VerificationPopover } from "@ryu/ui/components/verification-popover.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useState } from "react";
import {
	type ConsentDecision,
	readConsentDecision,
	writeConsentDecision,
} from "./consent-decisions.ts";
import {
	type ConsentPluginCandidate,
	formatCompactCount,
	formatRating,
	type PluginTrustTier,
} from "./consent-tool.ts";

/** Sends the user's decision back to the agent as their next message. */
export type ConsentFollowUp = (text: string) => void | Promise<void>;

const TIER_LABEL = {
	official: "Official",
	verified: "Verified",
	community: "Community",
} satisfies Record<PluginTrustTier, string>;

const TIER_DESCRIPTION = {
	official: "Published by Ryu. Officially verified by Ryu staff.",
	verified: "The publisher's identity has been verified.",
	community:
		"Community publisher. Ryu has not verified who publishes this plugin.",
} satisfies Record<PluginTrustTier, string>;

const TIER_APPEARANCE = {
	official: "publisher-gold-card",
	verified: "publisher-blue-card",
	community: "publisher-dotted",
} as const satisfies Record<PluginTrustTier, string>;

const TIER_TEXT = {
	official:
		"text-publisher-verification-gold dark:text-publisher-verification-gold-dark",
	verified: "text-status-info",
	community: "text-muted-foreground",
} satisfies Record<PluginTrustTier, string>;

export const CARD_CLASS = "rounded-xl border border-border bg-card/60 text-sm";

export function isHttpUrl(value: string | null): value is string {
	return Boolean(value && /^https?:\/\//i.test(value));
}

export function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

export function ListingIcon({
	name,
	url,
}: {
	name: string;
	url: string | null;
}) {
	if (isHttpUrl(url)) {
		return (
			<img
				alt=""
				className="size-9 shrink-0 rounded-lg border border-border bg-background object-contain"
				height={36}
				loading="lazy"
				referrerPolicy="no-referrer"
				src={url}
				width={36}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted font-medium text-muted-foreground"
		>
			{name.slice(0, 1).toUpperCase()}
		</span>
	);
}

/** Publisher trust mark plus its tier word, using the store's verification marks. */
export function TrustTierMark({ tier }: { tier: PluginTrustTier }) {
	const tl = useLiteralMessages();
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-0.5 text-xs",
				TIER_TEXT[tier]
			)}
			data-tier={tier}
		>
			<VerificationPopover
				appearance={TIER_APPEARANCE[tier]}
				description={TIER_DESCRIPTION[tier]}
				details={
					tier === "community"
						? { methods: [] }
						: {
								methods: [
									{
										kind: tier === "official" ? "organization" : "identity",
										label: TIER_DESCRIPTION[tier],
									},
								],
							}
				}
				label={tl("{tier} publisher", { tier: TIER_LABEL[tier] })}
				title={tl("{tier} publisher", { tier: TIER_LABEL[tier] })}
				variant="badge"
			/>
			{TIER_LABEL[tier]}
		</span>
	);
}

/** Rating, installs, stars, version and author on one quiet line. */
export function PluginStats({
	candidate,
}: {
	candidate: ConsentPluginCandidate;
}) {
	const tl = useLiteralMessages();
	const rating = formatRating(candidate.ratingAverage, candidate.ratingCount);
	const ratingCount = formatCompactCount(candidate.ratingCount);
	const downloads = formatCompactCount(candidate.downloads);
	const stars = formatCompactCount(candidate.stars);
	const items: { key: string; node: ReactNode; label: string }[] = [];
	if (rating) {
		items.push({
			key: "rating",
			label: tl("Rated {rating} out of 5 from {ratingCount} reviews", {
				rating,
				ratingCount,
			}),
			node: (
				<>
					<HugeiconsIcon aria-hidden className="size-3.5" icon={StarIcon} />
					{rating}
					<span className="text-muted-foreground/70">({ratingCount})</span>
				</>
			),
		});
	}
	if (downloads) {
		items.push({
			key: "downloads",
			label: `${downloads} installs`,
			node: (
				<>
					<HugeiconsIcon
						aria-hidden
						className="size-3.5"
						icon={Download01Icon}
					/>
					{downloads}
				</>
			),
		});
	}
	if (stars) {
		items.push({
			key: "stars",
			label: tl("{stars} GitHub stars", { stars }),
			node: `${stars} stars`,
		});
	}
	if (candidate.version) {
		items.push({
			key: "version",
			label: `Version ${candidate.version}`,
			node: `v${candidate.version}`,
		});
	}
	if (candidate.author) {
		items.push({
			key: "author",
			label: `By ${candidate.author}`,
			node: `by ${candidate.author}`,
		});
	}
	if (items.length === 0) {
		return (
			<p className="text-muted-foreground/70 text-xs">
				No ratings or installs yet
			</p>
		);
	}
	return (
		<ul
			aria-label="Plugin stats"
			className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-muted-foreground text-xs tabular-nums"
		>
			{items.map((item) => (
				<li
					aria-label={item.label}
					className="inline-flex items-center gap-1"
					key={item.key}
				>
					{item.node}
				</li>
			))}
		</ul>
	);
}

export function CardHeader({
	icon,
	reason,
	title,
}: {
	icon: ReactNode;
	reason: string;
	title: string;
}) {
	return (
		<div className="flex items-start gap-2 px-3 pt-3 pb-2">
			<span
				aria-hidden="true"
				className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground"
			>
				{icon}
			</span>
			<div className="min-w-0 flex-1">
				<p className="font-medium">{title}</p>
				<p className="mt-0.5 text-muted-foreground text-xs">{reason}</p>
			</div>
		</div>
	);
}

export function InlineError({ message }: { message: string }) {
	return (
		<p
			className="flex items-center gap-1.5 text-status-destructive text-xs"
			role="alert"
		>
			<HugeiconsIcon
				aria-hidden
				className="size-3.5 shrink-0"
				icon={Alert02Icon}
			/>
			{message}
		</p>
	);
}

export type PluginListState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; candidates: ConsentPluginCandidate[] };

/** A decision whose message to the agent has not been delivered yet. */
interface PendingDelivery {
	decision: ConsentDecision;
	error: string | null;
	text: string;
}

/**
 * The card's final decision and its delivery to the agent.
 *
 * A decision is remembered (and the card closes) only after the follow-up
 * message was handed to the chat. If sending fails, the card keeps a retry so
 * the agent, which ended its turn to wait, always hears the answer.
 */
export function useDecisionDelivery(
	toolCallId: string | undefined,
	onFollowUp: ConsentFollowUp
) {
	const [decision, setDecision] = useState<ConsentDecision | null>(() =>
		readConsentDecision(toolCallId)
	);
	const [pending, setPending] = useState<PendingDelivery | null>(null);
	const [sending, setSending] = useState(false);

	const deliver = async (next: ConsentDecision, text: string) => {
		setSending(true);
		setPending({ decision: next, error: null, text });
		try {
			await onFollowUp(text);
			setDecision(next);
			setPending(null);
			writeConsentDecision(toolCallId, next);
		} catch (error) {
			setPending({
				decision: next,
				error: errorMessage(error, "Couldn't send your answer to the agent."),
				text,
			});
		} finally {
			setSending(false);
		}
	};

	const retry = () =>
		pending ? deliver(pending.decision, pending.text) : null;

	return { decision, deliver, pending, retry, sending };
}

export function DeliveryRetry({
	error,
	onRetry,
	sending,
}: {
	error: string;
	onRetry: () => void;
	sending: boolean;
}) {
	return (
		<div className="flex items-center justify-between gap-2 border-border border-t px-3 py-2">
			<InlineError message={error} />
			<Button disabled={sending} onClick={onRetry} size="xs" variant="outline">
				Send again
			</Button>
		</div>
	);
}

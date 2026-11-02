"use client";

// The author header of the localized tweet card. react-tweet's own header
// hard-codes "Follow", "View on Twitter" and "Verified account"; this one
// renders the same layout with translated chrome. Brand names stay English.

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type EnrichedQuotedTweet,
	type EnrichedTweet,
	Verified,
	VerifiedBusiness,
	VerifiedGovernment,
} from "react-tweet";
import styles from "./tweet-card.module.css";

type TweetUser = EnrichedTweet["user"] | EnrichedQuotedTweet["user"];

const X_LOGO_PATH =
	"M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";

function VerifiedMark({ user }: { user: TweetUser }) {
	const tl = useLiteralMessages();
	if (!(user.verified || user.is_blue_verified || user.verified_type)) {
		return null;
	}
	let icon = <Verified />;
	let tone: string | undefined = user.is_blue_verified
		? styles.verifiedBlue
		: styles.verifiedOld;
	if (user.verified_type === "Government") {
		icon = <VerifiedGovernment />;
		tone = styles.verifiedGovernment;
	} else if (user.verified_type === "Business") {
		icon = <VerifiedBusiness />;
		tone = undefined;
	}
	return (
		<span
			aria-label={tl("Verified account")}
			className={cn(styles.verified, tone)}
			role="img"
		>
			<span aria-hidden="true" className={styles.verified}>
				{icon}
			</span>
		</span>
	);
}

function AffiliateLabel({ user }: { user: TweetUser }) {
	const label = user.highlighted_label;
	const src = label?.badge?.url;
	if (!src) {
		return null;
	}
	return (
		<span className={styles.label}>
			<img alt={label?.description ?? ""} src={src} />
		</span>
	);
}

export function TweetCardHeader({ tweet }: { tweet: EnrichedTweet }) {
	const tl = useLiteralMessages();
	const { user } = tweet;
	return (
		<div className={styles.header}>
			<a
				className={cn(
					styles.avatar,
					user.profile_image_shape === "Square" && styles.avatarSquare
				)}
				href={tweet.url}
				rel="noopener noreferrer"
				target="_blank"
			>
				<img
					alt={user.name}
					height={48}
					src={user.profile_image_url_https}
					width={48}
				/>
			</a>
			<div className={styles.author}>
				<a
					className={styles.authorLink}
					href={tweet.url}
					rel="noopener noreferrer"
					target="_blank"
				>
					<span className={styles.authorName} title={user.name}>
						{user.name}
					</span>
					<VerifiedMark user={user} />
					<AffiliateLabel user={user} />
				</a>
				<div className={styles.authorMeta}>
					<a
						className={styles.username}
						dir="ltr"
						href={tweet.url}
						rel="noopener noreferrer"
						target="_blank"
					>
						@{user.screen_name}
					</a>
					<span aria-hidden="true" className={styles.separator}>
						·
					</span>
					<a
						className={styles.follow}
						href={user.follow_url}
						rel="noopener noreferrer"
						target="_blank"
					>
						{tl("Follow")}
					</a>
				</div>
			</div>
			<a
				aria-label={tl("View on X")}
				className={styles.brand}
				href={tweet.url}
				rel="noopener noreferrer"
				target="_blank"
			>
				<svg
					aria-hidden="true"
					className={styles.brandIcon}
					viewBox="0 0 24 24"
				>
					<path d={X_LOGO_PATH} />
				</svg>
			</a>
		</div>
	);
}

/** The "Replying to @name" link above a reply's text. */
export function TweetCardInReplyTo({ tweet }: { tweet: EnrichedTweet }) {
	const tl = useLiteralMessages();
	if (!tweet.in_reply_to_screen_name) {
		return null;
	}
	return (
		<a
			className={styles.inReplyTo}
			href={tweet.in_reply_to_url}
			rel="noopener noreferrer"
			target="_blank"
		>
			{tl("Replying to {handle}", {
				handle: `@${tweet.in_reply_to_screen_name}`,
			})}
		</a>
	);
}

/** The compact author line of a quoted tweet. */
export function QuotedTweetCardHeader({
	tweet,
}: {
	tweet: EnrichedQuotedTweet;
}) {
	const { user } = tweet;
	return (
		<div className={styles.quotedHeader}>
			<span className={styles.quotedAvatar}>
				<img
					alt={user.name}
					height={20}
					src={user.profile_image_url_https}
					width={20}
				/>
			</span>
			<span className={styles.quotedAuthor}>
				<span className={styles.authorName} title={user.name}>
					{user.name}
				</span>
				<VerifiedMark user={user} />
				<span className={styles.username} dir="ltr">
					@{user.screen_name}
				</span>
			</span>
		</div>
	);
}

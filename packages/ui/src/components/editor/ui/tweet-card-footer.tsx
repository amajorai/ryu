"use client";

// The timestamp, actions and replies rows of the localized tweet card.
// react-tweet formats the date in en-US and builds "Read N replies" by hand;
// these rows use the reader's locale and whole-sentence ICU plurals.

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useState } from "react";
import type { EnrichedTweet } from "react-tweet";
import styles from "./tweet-card.module.css";
import {
	formatTweetCount,
	formatTweetTimestamp,
	useTweetLocale,
} from "./tweet-card-format.ts";

const COPIED_RESET_MS = 6000;
const INFO_PATH =
	"M13.5 8.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5S11.17 7 12 7s1.5.67 1.5 1.5zM13 17v-5h-2v5h2zm-1 5.25c5.66 0 10.25-4.59 10.25-10.25S17.66 1.75 12 1.75 1.75 6.34 1.75 12 6.34 22.25 12 22.25zM20.25 12c0 4.56-3.69 8.25-8.25 8.25S3.75 16.56 3.75 12 7.44 3.75 12 3.75s8.25 3.69 8.25 8.25z";
const LIKE_PATH =
	"M20.884 13.19c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z";
const REPLY_PATH =
	"M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01z";
const COPY_PATH =
	"M18.36 5.64c-1.95-1.96-5.11-1.96-7.07 0L9.88 7.05 8.46 5.64l1.42-1.42c2.73-2.73 7.16-2.73 9.9 0 2.73 2.74 2.73 7.17 0 9.9l-1.42 1.42-1.41-1.42 1.41-1.41c1.96-1.96 1.96-5.12 0-7.07zm-2.12 3.53l-7.07 7.07-1.41-1.41 7.07-7.07 1.41 1.41zm-12.02.71l1.42-1.42 1.41 1.42-1.41 1.41c-1.96 1.96-1.96 5.12 0 7.07 1.95 1.96 5.11 1.96 7.07 0l1.41-1.41 1.42 1.41-1.42 1.42c-2.73 2.73-7.16 2.73-9.9 0-2.73-2.74-2.73-7.17 0-9.9z";
const CHECK_PATH =
	"M9.64 18.952l-5.55-4.861 1.317-1.504 3.951 3.459 8.459-10.948L19.4 6.32 9.64 18.952z";

function ActionIcon({ path }: { path: string }) {
	return (
		<span className={styles.actionIconWrapper}>
			<svg aria-hidden="true" className={styles.icon} viewBox="0 0 24 24">
				<path d={path} />
			</svg>
		</span>
	);
}

export function TweetCardInfo({ tweet }: { tweet: EnrichedTweet }) {
	const tl = useLiteralMessages();
	const locale = useTweetLocale();
	const createdAt = new Date(tweet.created_at);
	const valid = !Number.isNaN(createdAt.getTime());
	return (
		<div className={styles.info}>
			{valid ? (
				<a
					className={styles.createdAt}
					href={tweet.url}
					rel="noopener noreferrer"
					target="_blank"
				>
					<time dateTime={createdAt.toISOString()}>
						{formatTweetTimestamp(locale, createdAt)}
					</time>
				</a>
			) : null}
			<a
				aria-label={tl("X for Websites, ads information and privacy")}
				className={styles.infoLink}
				href="https://help.x.com/en/x-for-websites-ads-info-and-privacy"
				rel="noopener noreferrer"
				target="_blank"
			>
				<svg aria-hidden="true" className={styles.icon} viewBox="0 0 24 24">
					<path d={INFO_PATH} />
				</svg>
			</a>
		</div>
	);
}

function CopyLinkAction({ url }: { url: string }) {
	const tl = useLiteralMessages();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) {
			return;
		}
		const timeout = setTimeout(() => setCopied(false), COPIED_RESET_MS);
		return () => clearTimeout(timeout);
	}, [copied]);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
		} catch {
			// Clipboard refused (no permission or no secure context): stay as is.
		}
	};
	return (
		<button
			className={cn(styles.action, styles.copy)}
			onClick={copy}
			type="button"
		>
			<ActionIcon path={copied ? CHECK_PATH : COPY_PATH} />
			<span aria-live="polite" className={styles.actionText}>
				{copied ? tl("Copied!") : tl("Copy link")}
			</span>
		</button>
	);
}

export function TweetCardActions({ tweet }: { tweet: EnrichedTweet }) {
	const tl = useLiteralMessages();
	const locale = useTweetLocale();
	const count = tweet.favorite_count;
	return (
		<div className={styles.actions}>
			<a
				aria-label={tl(
					"{count, plural, one {Like. This post has # like.} other {Like. This post has # likes.}}",
					{ count }
				)}
				className={cn(styles.action, styles.like)}
				href={tweet.like_url}
				rel="noopener noreferrer"
				target="_blank"
			>
				<ActionIcon path={LIKE_PATH} />
				<span className={styles.actionText}>
					{formatTweetCount(locale, count)}
				</span>
			</a>
			<a
				aria-label={tl("Reply to this post on X")}
				className={cn(styles.action, styles.reply)}
				href={tweet.reply_url}
				rel="noopener noreferrer"
				target="_blank"
			>
				<ActionIcon path={REPLY_PATH} />
				<span className={styles.actionText}>{tl("Reply")}</span>
			</a>
			<CopyLinkAction url={tweet.url} />
		</div>
	);
}

export function TweetCardReplies({ tweet }: { tweet: EnrichedTweet }) {
	const tl = useLiteralMessages();
	return (
		<div className={styles.replies}>
			<a
				className={styles.repliesLink}
				href={tweet.url}
				rel="noopener noreferrer"
				target="_blank"
			>
				{tl(
					"{count, plural, =0 {Read more on X} one {Read # reply} other {Read # replies}}",
					{ count: tweet.conversation_count }
				)}
			</a>
		</div>
	);
}

"use client";

// A tweet embed whose chrome follows the reader's language. react-tweet's
// default <Tweet> renders English copy and an en-US date, and it mounts inside
// the editor's contenteditable root, which the DOM localizer skips. This card
// keeps react-tweet's data hook and its text-free building blocks
// (TweetContainer, TweetBody, the quoted-tweet container and body) and renders
// every labelled piece itself through tl().

import { useLiteralMessages } from "@ryu/i18n/react";
import { useMemo } from "react";
import {
	type EnrichedQuotedTweet,
	enrichTweet,
	QuotedTweetBody,
	QuotedTweetContainer,
	TweetBody,
	TweetContainer,
	TweetSkeleton,
	useTweet,
} from "react-tweet";
import type { Tweet } from "react-tweet/api";
import styles from "./tweet-card.module.css";
import {
	TweetCardActions,
	TweetCardInfo,
	TweetCardReplies,
} from "./tweet-card-footer.tsx";
import {
	QuotedTweetCardHeader,
	TweetCardHeader,
	TweetCardInReplyTo,
} from "./tweet-card-header.tsx";
import { TweetCardMedia } from "./tweet-card-media.tsx";

export function TweetCardNotFound() {
	const tl = useLiteralMessages();
	return (
		<TweetContainer>
			<div className={styles.notFound}>
				<h3>{tl("Post not found")}</h3>
				<p>{tl("The embedded post could not be found.")}</p>
			</div>
		</TweetContainer>
	);
}

function QuotedTweetCard({ tweet }: { tweet: EnrichedQuotedTweet }) {
	return (
		<QuotedTweetContainer tweet={tweet}>
			<QuotedTweetCardHeader tweet={tweet} />
			<QuotedTweetBody tweet={tweet} />
			<TweetCardMedia quoted={true} tweet={tweet} />
		</QuotedTweetContainer>
	);
}

/** A loaded tweet with localized chrome. */
export function LocalizedTweet({ tweet: data }: { tweet: Tweet }) {
	const tweet = useMemo(() => enrichTweet(data), [data]);
	return (
		<TweetContainer>
			<TweetCardHeader tweet={tweet} />
			<TweetCardInReplyTo tweet={tweet} />
			<TweetBody tweet={tweet} />
			<TweetCardMedia tweet={tweet} />
			{tweet.quoted_tweet ? (
				<QuotedTweetCard tweet={tweet.quoted_tweet} />
			) : null}
			<TweetCardInfo tweet={tweet} />
			<TweetCardActions tweet={tweet} />
			<TweetCardReplies tweet={tweet} />
		</TweetContainer>
	);
}

/** Fetch a tweet by id and render it with localized chrome. */
export function TweetCard({ id }: { id: string }) {
	const { data, error, isLoading } = useTweet(id);
	if (isLoading) {
		return <TweetSkeleton />;
	}
	if (error || !data) {
		return <TweetCardNotFound />;
	}
	return <LocalizedTweet tweet={data} />;
}

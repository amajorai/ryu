"use client";

// Photos and videos of the localized tweet card. react-tweet's media grid
// labels images "Image" and its video overlay "Watch on X" in English; this
// grid renders the same layout with translated labels.

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type CSSProperties, useRef, useState } from "react";
import {
	type EnrichedQuotedTweet,
	type EnrichedTweet,
	getMediaUrl,
	getMp4Video,
} from "react-tweet";
import type {
	MediaAnimatedGif,
	MediaDetails,
	MediaVideo,
} from "react-tweet/api";
import styles from "./tweet-card.module.css";

const PLAY_PATH = "M21 12L4 2v20l17-10z";
const WIDESCREEN_PERCENT = 56.25;

function spacerStyle(media: MediaDetails, count: number): CSSProperties {
	let percent = WIDESCREEN_PERCENT;
	const { height, width } = media.original_info;
	if (count === 1 && width > 0) {
		percent = (100 / width) * height;
	} else if (count === 2) {
		percent *= 2;
	}
	return {
		paddingBottom: `${percent}%`,
		width: media.type === "photo" ? undefined : "unset",
	};
}

function TweetCardVideo({
	media,
	url,
}: {
	media: MediaAnimatedGif | MediaVideo;
	url: string;
}) {
	const tl = useLiteralMessages();
	const videoRef = useRef<HTMLVideoElement>(null);
	const [started, setStarted] = useState(false);
	const [playing, setPlaying] = useState(false);
	const [ended, setEnded] = useState(false);
	const source = getMp4Video(media);
	const start = async () => {
		const video = videoRef.current;
		if (!video) {
			return;
		}
		setStarted(true);
		video.load();
		try {
			await video.play();
			video.focus();
		} catch {
			// Autoplay refused: show the play button again.
			setStarted(false);
		}
	};
	return (
		<>
			<video
				className={styles.mediaImage}
				controls={started}
				onEnded={() => setEnded(true)}
				onPause={() => setPlaying(false)}
				onPlay={() => {
					setPlaying(true);
					setEnded(false);
				}}
				playsInline={true}
				poster={getMediaUrl(media, "small")}
				preload="none"
				ref={videoRef}
				tabIndex={started ? 0 : -1}
			>
				<source src={source.url} type={source.content_type} />
			</video>
			{started ? null : (
				<button
					aria-label={tl("Play video")}
					className={styles.videoButton}
					onClick={start}
					type="button"
				>
					<svg aria-hidden="true" viewBox="0 0 24 24">
						<path d={PLAY_PATH} />
					</svg>
				</button>
			)}
			{playing || ended ? null : (
				<a
					className={styles.videoPill}
					href={url}
					rel="noopener noreferrer"
					target="_blank"
				>
					{started ? tl("Continue watching on X") : tl("Watch on X")}
				</a>
			)}
			{ended ? (
				<a
					className={styles.videoReplies}
					href={url}
					rel="noopener noreferrer"
					target="_blank"
				>
					{tl("View replies")}
				</a>
			) : null}
		</>
	);
}

export function TweetCardMedia({
	quoted = false,
	tweet,
}: {
	quoted?: boolean;
	tweet: EnrichedTweet | EnrichedQuotedTweet;
}) {
	const tl = useLiteralMessages();
	const items = tweet.mediaDetails ?? [];
	if (items.length === 0) {
		return null;
	}
	const count = items.length;
	return (
		<div className={cn(styles.media, !quoted && styles.mediaRounded)}>
			<div
				className={cn(
					styles.mediaGrid,
					count > 1 && styles.grid2Columns,
					count === 3 && styles.grid3,
					count > 4 && styles.grid2x2
				)}
			>
				{items.map((media) =>
					media.type === "photo" ? (
						<a
							className={styles.mediaItem}
							href={tweet.url}
							key={media.media_url_https}
							rel="noopener noreferrer"
							target="_blank"
						>
							<span
								className={styles.mediaSpacer}
								style={spacerStyle(media, count)}
							/>
							<img
								alt={media.ext_alt_text || tl("Image")}
								className={styles.mediaImage}
								src={getMediaUrl(media, "small")}
							/>
						</a>
					) : (
						<div className={styles.mediaItem} key={media.media_url_https}>
							<span
								className={styles.mediaSpacer}
								style={spacerStyle(media, count)}
							/>
							<TweetCardVideo media={media} url={tweet.url} />
						</div>
					)
				)}
			</div>
		</div>
	);
}

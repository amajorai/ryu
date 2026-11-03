import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Tweet } from "react-tweet/api";

// Tweet embeds render inside the editor's contenteditable root, where the DOM
// localizer never reaches, so the card translates its own chrome.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { LocalizedTweet, TweetCardNotFound } = await import("./tweet-card.tsx");
const { TweetCardReplies } = await import("./tweet-card-footer.tsx");
const { TweetCardHeader } = await import("./tweet-card-header.tsx");
const { TweetCardMedia } = await import("./tweet-card-media.tsx");
const { formatTweetCount, formatTweetTimestamp } = await import(
	"./tweet-card-format.ts"
);
const { enrichTweet } = await import("react-tweet");

const JA: Record<string, string> = {
	"Copy link": "リンクをコピー",
	Follow: "フォロー",
	Image: "画像",
	"Play video": "動画を再生",
	"Post not found": "ポストが見つかりません",
	"{count, plural, =0 {Read more on X} one {Read # reply} other {Read # replies}}":
		"{count, plural, =0 {Xでさらに読む} other {#件の返信を読む}}",
	"{count, plural, one {Like. This post has # like.} other {Like. This post has # likes.}}":
		"{count, plural, other {いいね。このポストには#件のいいねがあります。}}",
	Reply: "返信",
	"Replying to {handle}": "{handle}さんへの返信",
	"Verified account": "認証済みアカウント",
	"View on X": "Xで表示",
	"Watch on X": "Xで見る",
};

const CREATED_AT = "2025-03-01T15:04:00.000Z";

function tweetFixture(overrides: Partial<Tweet> = {}): Tweet {
	const user = {
		id_str: "1",
		is_blue_verified: true,
		name: "Ryu",
		profile_image_shape: "Circle" as const,
		profile_image_url_https: "https://pbs.twimg.com/profile.jpg",
		screen_name: "ryu",
		verified: false,
	};
	const tweet = {
		__typename: "Tweet",
		conversation_count: 12,
		created_at: CREATED_AT,
		display_text_range: [0, 5],
		edit_control: {
			edit_tweet_ids: ["42"],
			editable_until_msecs: "0",
			edits_remaining: "0",
			is_edit_eligible: false,
		},
		entities: { hashtags: [], symbols: [], urls: [], user_mentions: [] },
		favorite_count: 1234,
		id_str: "42",
		in_reply_to_screen_name: "someone",
		in_reply_to_status_id_str: "41",
		isEdited: false,
		isStaleEdit: false,
		lang: "en",
		mediaDetails: [
			{
				display_url: "pic.x.com/a",
				expanded_url: "https://x.com/ryu/status/42/photo/1",
				ext_media_availability: { status: "Available" },
				ext_media_color: { palette: [] },
				indices: [6, 6],
				media_url_https: "https://pbs.twimg.com/media/a.jpg",
				original_info: { focus_rects: [], height: 100, width: 100 },
				sizes: {
					large: { h: 100, resize: "fit", w: 100 },
					medium: { h: 100, resize: "fit", w: 100 },
					small: { h: 100, resize: "fit", w: 100 },
					thumb: { h: 100, resize: "crop", w: 100 },
				},
				type: "photo",
				url: "https://t.co/a",
			},
		],
		news_action_type: "conversation",
		text: "Hello",
		user,
	};
	return { ...(tweet as unknown as Tweet), ...overrides };
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	await cleanup?.();
	cleanup = undefined;
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mountInJapanese(node: React.ReactNode): Promise<HTMLElement> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	container.setAttribute("contenteditable", "true");
	document.body.append(container);
	const root: Root = createRoot(container);
	cleanup = async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	};
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<div contentEditable={false}>{node}</div>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

test("a tweet's chrome reads in the reader's language", async () => {
	const container = await mountInJapanese(
		<LocalizedTweet tweet={tweetFixture()} />
	);
	const text = container.textContent ?? "";
	expect(text).toContain("12件の返信を読む");
	expect(text).toContain("フォロー");
	expect(text).toContain("返信");
	expect(text).toContain("リンクをコピー");
	expect(text).toContain("@someoneさんへの返信");
	for (const english of ["Read 12", "Follow", "Copy link", "Replying to"]) {
		expect(text).not.toContain(english);
	}
	expect(container.querySelector('a[aria-label="Xで表示"]')).not.toBeNull();
	expect(
		container.querySelector('[role="img"][aria-label="認証済みアカウント"]')
	).not.toBeNull();
	expect(
		container.querySelector('a[aria-label^="いいね。このポストには"]')
	).not.toBeNull();
	expect(container.querySelector('img[alt="画像"]')).not.toBeNull();
});

test("the timestamp follows the reader's locale, not en-US", async () => {
	const container = await mountInJapanese(
		<LocalizedTweet tweet={tweetFixture()} />
	);
	const time = container.querySelector("time");
	expect(time?.getAttribute("datetime")).toBe(CREATED_AT);
	const expected = new Intl.DateTimeFormat("ja", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(CREATED_AT));
	expect(time?.textContent).toBe(expected);
	expect(time?.textContent).not.toContain("PM");
});

test("a tweet with no replies invites reading more on X", async () => {
	const container = await mountInJapanese(
		<LocalizedTweet
			tweet={tweetFixture({ conversation_count: 0, mediaDetails: [] })}
		/>
	);
	expect(container.textContent).toContain("Xでさらに読む");
	expect(container.querySelector("img[alt='画像']")).toBeNull();
});

test("a missing tweet says so in the reader's language", async () => {
	const container = await mountInJapanese(<TweetCardNotFound />);
	expect(container.textContent).toContain("ポストが見つかりません");
	expect(container.textContent).not.toContain("Tweet not found");
});

test("counts and timestamps format for the locale", () => {
	const date = new Date(CREATED_AT);
	expect(formatTweetTimestamp("ja", date)).toBe(
		new Intl.DateTimeFormat("ja", {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(date)
	);
	expect(formatTweetCount("en", 1234)).toBe("1.2K");
	expect(formatTweetCount("ja", 12_345)).toBe("1.2万");
});

test("a tweet video names its play button and X link in the reader's language", async () => {
	const tweet = tweetFixture();
	const [photo] = tweet.mediaDetails ?? [];
	const video = {
		...photo,
		type: "video",
		video_info: {
			aspect_ratio: [16, 9],
			variants: [
				{ bitrate: 1, content_type: "video/mp4", url: "https://v/a.mp4" },
			],
		},
	};
	const enriched = enrichTweet(
		tweetFixture({
			mediaDetails: [video as unknown as NonNullable<typeof photo>],
		})
	);
	const container = await mountInJapanese(
		<>
			<TweetCardHeader tweet={enriched} />
			<TweetCardMedia tweet={enriched} />
			<TweetCardReplies tweet={enriched} />
		</>
	);
	expect(
		container.querySelector('button[aria-label="動画を再生"]')
	).not.toBeNull();
	expect(container.textContent).toContain("Xで見る");
	expect(container.textContent).not.toContain("Watch on X");
	expect(container.textContent).toContain("12件の返信を読む");
});

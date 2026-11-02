import type { InterfaceThread } from "@ryuhq/protocol/interfaces";

/** Knowledge topics: the words that link conversations on the map. */

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

const MIN_TOPIC_LETTERS = 4;
const MIN_TOPIC_THREADS = 2;
/** Most topics kept, by reach, so a large workspace stays readable. */
export const MAX_TOPICS = 40;

/** Common words of four or more letters that never make a useful topic. */
const STOPWORDS = new Set([
	"about",
	"after",
	"again",
	"also",
	"been",
	"before",
	"being",
	"best",
	"could",
	"does",
	"done",
	"each",
	"from",
	"have",
	"here",
	"into",
	"just",
	"like",
	"make",
	"more",
	"most",
	"much",
	"need",
	"next",
	"only",
	"onto",
	"other",
	"over",
	"please",
	"same",
	"should",
	"some",
	"still",
	"such",
	"than",
	"that",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"thing",
	"things",
	"this",
	"those",
	"through",
	"today",
	"under",
	"upon",
	"very",
	"want",
	"were",
	"what",
	"when",
	"where",
	"which",
	"while",
	"will",
	"with",
	"within",
	"without",
	"would",
	"your",
]);

/** Lower-cased words of at least four letters, in order. */
export function topicWords(text: string): string[] {
	const words: string[] = [];
	for (const match of text.toLowerCase().matchAll(/\p{L}+/gu)) {
		const word = match[0];
		if (word.length >= MIN_TOPIC_LETTERS && !STOPWORDS.has(word)) {
			words.push(word);
		}
	}
	return words;
}

export interface Topic {
	/** Conversations that mention the topic only in their latest message. */
	messageIds: string[];
	threadIds: string[];
	word: string;
}

export interface TopicOptions {
	/**
	 * Also link conversations whose latest message (not only their title)
	 * mentions a title word. Off by default: topics come from titles.
	 */
	messages?: boolean;
}

/**
 * Topics, deterministically: a topic is a lower-cased word of four or more
 * letters (not a stopword) that appears in the titles of two or more
 * conversations, and it links every conversation whose title contains it.
 * Words match literally. With `messages`, a conversation whose latest
 * message contains a title word counts too; `messageIds` records those, so
 * the panel can say why. Sorted by reach, then alphabetically.
 */
export function extractTopics(
	threads: readonly InterfaceThread[],
	options: TopicOptions = {}
): Topic[] {
	const candidates = new Set<string>();
	for (const thread of threads) {
		for (const word of topicWords(thread.title)) {
			candidates.add(word);
		}
	}
	const mentions = new Map<string, string[]>();
	const viaMessage = new Map<string, string[]>();
	const record = (
		map: Map<string, string[]>,
		form: string,
		threadId: string
	) => {
		const list = map.get(form) ?? [];
		list.push(threadId);
		map.set(form, list);
	};
	for (const thread of threads) {
		const inTitle = new Set(topicWords(thread.title));
		const seen = new Set<string>();
		for (const form of inTitle) {
			seen.add(form);
			record(mentions, form, thread.id);
		}
		const message = options.messages ? (thread.lastMessage ?? "") : "";
		for (const word of topicWords(message)) {
			if (candidates.has(word) && !seen.has(word)) {
				seen.add(word);
				record(mentions, word, thread.id);
				record(viaMessage, word, thread.id);
			}
		}
	}
	const topics: Topic[] = [];
	for (const [word, threadIds] of mentions) {
		if (threadIds.length >= MIN_TOPIC_THREADS) {
			topics.push({ messageIds: viaMessage.get(word) ?? [], threadIds, word });
		}
	}
	topics.sort(
		(a, b) =>
			b.threadIds.length - a.threadIds.length || a.word.localeCompare(b.word)
	);
	return topics.slice(0, MAX_TOPICS);
}

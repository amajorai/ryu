import { Chat } from "@ai-sdk/react";
import type { ChatInit, ChatTransport, UIMessage } from "ai";
import {
	useCallback,
	useLayoutEffect,
	useRef,
	useSyncExternalStore,
} from "react";

// The AI SDK `Chat` behind this tab's transcript, with two message views:
//
// - the live view follows every (throttled) stream update and feeds only the
//   transcript, which subscribes to it on its own;
// - the page view is what ChatPage and its hooks render from. It skips updates
//   that only grow the text of a streaming text or reasoning part, so the page
//   shell, title bar and composer do not re-render per token. Any other change
//   (a new message or part, a tool or data part, a part's state, metadata) and
//   every turn end publishes the latest messages to the page as well.
//
// Callbacks that need the newest text (copying the transcript, building a send
// or side-chat payload) read `getLiveMessages()` rather than the page view.

type Listener = () => void;
type MessageRecord = Readonly<Record<string, unknown>>;

// A streaming text or reasoning part grows by appending deltas to `text`; a
// provider may also restamp `providerMetadata` per delta. Neither changes what
// the page renders outside the transcript. Text that is rewritten rather than
// grown (a host edit through setMessages) is a change.
function streamedTextGrew(left: unknown, right: unknown) {
	return (
		typeof left === "string" &&
		typeof right === "string" &&
		right.startsWith(left)
	);
}

function keysOf(left: MessageRecord, right: MessageRecord) {
	return new Set([...Object.keys(left), ...Object.keys(right)]);
}

function shallowChanged(left: unknown, right: unknown) {
	if (Object.is(left, right)) {
		return false;
	}
	if (
		typeof left !== "object" ||
		typeof right !== "object" ||
		left === null ||
		right === null ||
		Array.isArray(left) !== Array.isArray(right)
	) {
		return true;
	}
	const a = left as MessageRecord;
	const b = right as MessageRecord;
	for (const key of keysOf(a, b)) {
		if (!Object.is(a[key], b[key])) {
			return true;
		}
	}
	return false;
}

function partChanged(left: MessageRecord, right: MessageRecord) {
	if (left === right) {
		return false;
	}
	if (left.type !== right.type) {
		return true;
	}
	const streamedText =
		(right.type === "text" || right.type === "reasoning") &&
		left.state === "streaming" &&
		right.state === "streaming";
	for (const key of keysOf(left, right)) {
		if (
			streamedText &&
			(key === "providerMetadata" ||
				(key === "text" && streamedTextGrew(left.text, right.text)))
		) {
			continue;
		}
		if (!Object.is(left[key], right[key])) {
			return true;
		}
	}
	return false;
}

function messageChanged(left: UIMessage, right: UIMessage) {
	if (left === right) {
		return false;
	}
	const a = left as unknown as MessageRecord;
	const b = right as unknown as MessageRecord;
	for (const key of keysOf(a, b)) {
		if (key === "parts") {
			const leftParts = left.parts as unknown as MessageRecord[];
			const rightParts = right.parts as unknown as MessageRecord[];
			if (leftParts.length !== rightParts.length) {
				return true;
			}
			for (const [index, part] of rightParts.entries()) {
				const previous = leftParts[index];
				if (!previous || partChanged(previous, part)) {
					return true;
				}
			}
		} else if (key === "metadata") {
			// The SDK clones metadata into every streamed snapshot.
			if (shallowChanged(a.metadata, b.metadata)) {
				return true;
			}
		} else if (!Object.is(a[key], b[key])) {
			return true;
		}
	}
	return false;
}

/**
 * True when `next` differs from `previous` in more than the text of streaming
 * text or reasoning parts. The SDK keeps settled messages' identities and
 * shallow-copies only the message it is streaming into, so this is an identity
 * walk plus one message's parts.
 *
 * `previous` must not hold the SDK's working message: the SDK pushes that
 * object itself when a reply starts and keeps mutating it, so compare against
 * {@link frozenForComparison} of the earlier array instead.
 */
export function changesBeyondStreamedText(
	previous: readonly UIMessage[],
	next: readonly UIMessage[]
) {
	if (previous === next) {
		return false;
	}
	if (previous.length !== next.length) {
		return true;
	}
	for (const [index, message] of next.entries()) {
		const before = previous[index];
		if (!before || messageChanged(before, message)) {
			return true;
		}
	}
	return false;
}

/**
 * `messages` with its last message copied (message, parts and metadata, one
 * level deep): the only message the SDK may still be mutating in place.
 */
export function frozenForComparison(messages: UIMessage[]): UIMessage[] {
	const last = messages.at(-1);
	if (!last) {
		return messages;
	}
	const frozen = {
		...last,
		parts: last.parts.map((part) => ({ ...part })),
	} as UIMessage;
	if (last.metadata && typeof last.metadata === "object") {
		frozen.metadata = Array.isArray(last.metadata)
			? [...last.metadata]
			: { ...last.metadata };
	}
	return [...messages.slice(0, -1), frozen];
}

/** One transcript's Chat with a page view and a live view of its messages. */
export class ChatSession {
	readonly chat: Chat<UIMessage>;
	#page: UIMessage[];
	// What the page view is compared against: `#page` as it was when published.
	#pageAtPublish: UIMessage[];
	#live: UIMessage[];
	#followText = false;
	#throttleMs: number | undefined;
	readonly #pageListeners = new Set<Listener>();
	readonly #liveListeners = new Set<Listener>();
	readonly #statusListeners = new Set<Listener>();
	readonly #errorListeners = new Set<Listener>();
	#disconnect: (() => void) | null = null;
	#disconnectMessages: (() => void) | null = null;

	constructor(chat: Chat<UIMessage>, throttleMs: number | undefined) {
		this.chat = chat;
		this.#page = chat.messages;
		this.#pageAtPublish = frozenForComparison(chat.messages);
		this.#live = chat.messages;
		this.#throttleMs = throttleMs;
	}

	readonly getPageMessages = () => this.#page;
	readonly getLiveMessages = () => this.#live;
	readonly getStatus = () => this.chat.status;
	readonly getError = () => this.chat.error;

	readonly subscribePage = (listener: Listener) =>
		this.#listen(this.#pageListeners, listener);
	readonly subscribeLive = (listener: Listener) =>
		this.#listen(this.#liveListeners, listener);
	readonly subscribeStatus = (listener: Listener) =>
		this.#listen(this.#statusListeners, listener);
	readonly subscribeError = (listener: Listener) =>
		this.#listen(this.#errorListeners, listener);

	/** While on (find in chat), the page view follows every text delta too. */
	setFollowText(follow: boolean) {
		if (this.#followText === follow) {
			return;
		}
		this.#followText = follow;
		if (follow) {
			this.#publish(this.#live, true);
		}
	}

	/** The stream update window; a background tab renders less often. */
	setThrottle(throttleMs: number | undefined) {
		if (this.#throttleMs === throttleMs) {
			return;
		}
		this.#throttleMs = throttleMs;
		if (this.#disconnectMessages) {
			this.#disconnectMessages();
			this.#disconnectMessages = this.#registerMessages();
		}
	}

	#listen(listeners: Set<Listener>, listener: Listener) {
		listeners.add(listener);
		this.#connect();
		return () => {
			listeners.delete(listener);
			if (
				this.#pageListeners.size +
					this.#liveListeners.size +
					this.#statusListeners.size +
					this.#errorListeners.size ===
				0
			) {
				this.#disconnect?.();
				this.#disconnect = null;
				this.#disconnectMessages = null;
			}
		};
	}

	#registerMessages() {
		return this.chat["~registerMessagesCallback"](() => {
			this.#publish(this.chat.messages, this.#followText);
		}, this.#throttleMs);
	}

	#connect() {
		if (this.#disconnect) {
			return;
		}
		this.#disconnectMessages = this.#registerMessages();
		const offStatus = this.chat["~registerStatusCallback"](() => {
			// A turn end publishes its final messages at once, not after the
			// throttle window, exactly as `useChat` does.
			const status = this.chat.status;
			if (status === "ready" || status === "error") {
				this.#publish(this.chat.messages, true);
			}
			this.#emit(this.#statusListeners);
		});
		const offError = this.chat["~registerErrorCallback"](() => {
			this.#emit(this.#errorListeners);
		});
		this.#disconnect = () => {
			this.#disconnectMessages?.();
			offStatus();
			offError();
		};
		// Catch up silently: a subscriber re-reads its snapshot after subscribing.
		this.#page = this.chat.messages;
		this.#pageAtPublish = frozenForComparison(this.#page);
		this.#live = this.chat.messages;
	}

	#publish(messages: UIMessage[], toPage: boolean) {
		const liveChanged = messages !== this.#live;
		this.#live = messages;
		const pageChanged =
			messages !== this.#page &&
			(toPage || changesBeyondStreamedText(this.#pageAtPublish, messages));
		if (pageChanged) {
			this.#page = messages;
			this.#pageAtPublish = frozenForComparison(messages);
			this.#emit(this.#pageListeners);
		}
		if (liveChanged) {
			this.#emit(this.#liveListeners);
		}
	}

	#emit(listeners: Set<Listener>) {
		for (const listener of [...listeners]) {
			listener();
		}
	}
}

export interface UseChatSessionOptions {
	id: string | undefined;
	onData?: ChatInit<UIMessage>["onData"];
	throttle: number | undefined;
	transport: ChatTransport<UIMessage>;
}

/**
 * `useChat` with the page view of the messages: the same Chat lifetime (one per
 * transcript id), the same latest-callback forwarding, and the same helpers.
 */
export function useChatSession({
	id,
	onData,
	throttle,
	transport,
}: UseChatSessionOptions) {
	const latest = useRef({ onData, transport });
	latest.current = { onData, transport };
	const sessionRef = useRef<ChatSession | null>(null);
	if (
		!sessionRef.current ||
		(id != null && sessionRef.current.chat.id !== id)
	) {
		const chat = new Chat<UIMessage>({
			id,
			transport: {
				sendMessages: (options) =>
					latest.current.transport.sendMessages(options),
				reconnectToStream: (options) =>
					latest.current.transport.reconnectToStream(options),
			},
			onData: (part) => latest.current.onData?.(part),
		});
		sessionRef.current = new ChatSession(chat, throttle);
	}
	const session = sessionRef.current;
	useLayoutEffect(() => {
		session.setThrottle(throttle);
	}, [session, throttle]);
	const messages = useSyncExternalStore(
		session.subscribePage,
		session.getPageMessages,
		session.getPageMessages
	);
	const status = useSyncExternalStore(
		session.subscribeStatus,
		session.getStatus,
		session.getStatus
	);
	const error = useSyncExternalStore(
		session.subscribeError,
		session.getError,
		session.getError
	);
	const setMessages = useCallback(
		(update: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => {
			const chat = (sessionRef.current as ChatSession).chat;
			chat.messages =
				typeof update === "function" ? update(chat.messages) : update;
		},
		[]
	);
	const { chat } = session;
	return {
		chatSession: session,
		messages,
		status,
		error,
		setMessages,
		sendMessage: chat.sendMessage,
		regenerate: chat.regenerate,
		stop: chat.stop,
		clearError: chat.clearError,
	} as const;
}

import type { UIMessage } from "ai";

interface DecorationOptions {
	council: boolean;
	fallbackLabel: string | null;
	labels: Readonly<Record<string, string>>;
	sentAt: Map<string, number>;
}

/** One cache per transcript. Immutable SDK messages are weak keys so removed
 * history and superseded streaming chunks are not retained by the cache. */
export function createMessageDecorator<Message extends UIMessage>() {
	const cache = new WeakMap<
		Message,
		{
			stamp: number;
			label: string | null;
			decorated: Message & { createdAt: Date };
		}
	>();
	return (messages: readonly Message[], options: DecorationOptions) => {
		let assistantIndex = 0;
		return messages.map((message) => {
			let stamp = options.sentAt.get(message.id);
			if (stamp === undefined) {
				stamp = Date.now();
				options.sentAt.set(message.id, stamp);
			}
			let label: string | null = null;
			if (message.role === "assistant" && message.parts) {
				if (options.council) {
					label =
						options.labels[String(assistantIndex)] || options.fallbackLabel;
				}
				assistantIndex += 1;
			}
			const previous = cache.get(message);
			if (previous?.stamp === stamp && previous.label === label) {
				return previous.decorated;
			}
			let parts = message.parts;
			if (label && parts) {
				const prefix = `**${label}**`;
				parts = parts.map((part) =>
					part.type === "text" && !part.text.startsWith(prefix)
						? { ...part, text: `${prefix}\n\n${part.text}` }
						: part
				);
			}
			const decorated = { ...message, parts, createdAt: new Date(stamp) };
			cache.set(message, { stamp, label, decorated });
			return decorated;
		});
	};
}

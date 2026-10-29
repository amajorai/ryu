// Chat activity the shell needs but does not own: which chat surface is
// focused, whether its turn is streaming, and the conversation title and model
// it shows. Chat surfaces publish here; the shell reads the focused entry to
// drive the terminal title and Herdr pane metadata. A tiny external store keeps
// chat state out of WorkspaceContext, which every tab re-renders on.

export interface ChatActivity {
	focused: boolean;
	model: string | null;
	streaming: boolean;
	/** The conversation title once resume or /rename provides one. */
	title: string | null;
}

function sameActivity(a: ChatActivity, b: ChatActivity): boolean {
	return (
		a.focused === b.focused &&
		a.model === b.model &&
		a.streaming === b.streaming &&
		a.title === b.title
	);
}

export class ChatActivityStore {
	private readonly entries = new Map<symbol, ChatActivity>();
	private readonly listeners = new Set<() => void>();
	private focusedEntry: ChatActivity | null = null;

	update(id: symbol, activity: ChatActivity): void {
		const previous = this.entries.get(id);
		if (previous && sameActivity(previous, activity)) {
			return;
		}
		this.entries.set(id, activity);
		this.publish();
	}

	remove(id: symbol): void {
		if (this.entries.delete(id)) {
			this.publish();
		}
	}

	/** The focused chat, or null when the focused tab is not a chat. Stable
	 * between changes, so it is a valid `useSyncExternalStore` snapshot. */
	readonly focused = (): ChatActivity | null => this.focusedEntry;

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	private publish(): void {
		let next: ChatActivity | null = null;
		for (const entry of this.entries.values()) {
			if (entry.focused) {
				next = entry;
				break;
			}
		}
		if (next === this.focusedEntry) {
			return;
		}
		this.focusedEntry = next;
		for (const listener of this.listeners) {
			listener();
		}
	}
}

export const chatActivity = new ChatActivityStore();

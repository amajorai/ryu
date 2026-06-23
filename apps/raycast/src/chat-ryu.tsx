// "Chat with Ryu" — a multi-turn conversation with the local Ryu Core. Type in
// the search bar and press Enter to send; replies stream into the list detail.

import {
	Action,
	ActionPanel,
	Icon,
	List,
	showToast,
	Toast,
} from "@raycast/api";
import { useCallback, useRef, useState } from "react";
import { type ChatMessage, streamChat } from "./lib/core";

interface Turn {
	id: string;
	role: "user" | "assistant";
	content: string;
}

let counter = 0;
function nextId(): string {
	counter += 1;
	return `turn-${counter}`;
}

export default function ChatRyu() {
	const [turns, setTurns] = useState<Turn[]>([]);
	const [searchText, setSearchText] = useState("");
	const [isStreaming, setIsStreaming] = useState(false);
	const conversationId = useRef<string>(`raycast-${Date.now()}`);

	const send = useCallback(async () => {
		const prompt = searchText.trim();
		if (prompt.length === 0 || isStreaming) {
			return;
		}
		setSearchText("");
		setIsStreaming(true);
		const userTurn: Turn = { id: nextId(), role: "user", content: prompt };
		const assistantId = nextId();
		const history: ChatMessage[] = [
			...turns.map((t) => ({ role: t.role, content: t.content })),
			{ role: "user", content: prompt },
		];
		setTurns((prev) => [
			...prev,
			userTurn,
			{ id: assistantId, role: "assistant", content: "" },
		]);

		try {
			await streamChat(
				history,
				(delta) =>
					setTurns((prev) =>
						prev.map((t) =>
							t.id === assistantId ? { ...t, content: t.content + delta } : t
						)
					),
				{ conversationId: conversationId.current }
			);
		} catch (err) {
			await showToast({
				style: Toast.Style.Failure,
				title: "Could not reach Ryu Core",
				message: err instanceof Error ? err.message : undefined,
			});
		} finally {
			setIsStreaming(false);
		}
	}, [searchText, isStreaming, turns]);

	// Newest turn first so the latest reply is selected/visible by default.
	const ordered = [...turns].reverse();

	return (
		<List
			actions={
				<ActionPanel>
					<Action icon={Icon.ArrowUp} onAction={send} title="Send" />
				</ActionPanel>
			}
			isLoading={isStreaming}
			isShowingDetail={turns.length > 0}
			onSearchTextChange={setSearchText}
			searchBarPlaceholder="Ask Ryu anything…"
			searchText={searchText}
		>
			{turns.length === 0 ? (
				<List.EmptyView
					description="Type a message and press Enter to chat with your local Ryu agent."
					icon={Icon.Stars}
					title="Chat with Ryu"
				/>
			) : (
				ordered.map((turn) => (
					<List.Item
						accessories={[{ text: turn.role === "user" ? "You" : "Ryu" }]}
						actions={
							<ActionPanel>
								<Action icon={Icon.ArrowUp} onAction={send} title="Send" />
								<Action.CopyToClipboard
									content={turn.content}
									title="Copy Message"
								/>
							</ActionPanel>
						}
						detail={<List.Item.Detail markdown={turn.content || "_…_"} />}
						icon={turn.role === "user" ? Icon.Person : Icon.Stars}
						key={turn.id}
						title={
							turn.content.length > 0
								? turn.content.slice(0, 60)
								: turn.role === "assistant"
									? "…"
									: ""
						}
					/>
				))
			)}
		</List>
	);
}

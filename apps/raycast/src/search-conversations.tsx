// "Search Conversations" — browse the local Ryu Core's conversation history.

import { Action, ActionPanel, Icon, List, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { listConversations, type RyuConversation } from "./lib/core";

export default function SearchConversations() {
	const [items, setItems] = useState<RyuConversation[]>([]);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		listConversations()
			.then((list) => {
				if (!cancelled) {
					setItems(list);
				}
			})
			.catch(async (err: unknown) => {
				await showToast({
					style: Toast.Style.Failure,
					title: "Could not reach Ryu Core",
					message: err instanceof Error ? err.message : undefined,
				});
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<List
			isLoading={isLoading}
			searchBarPlaceholder="Search conversations…"
		>
			<List.EmptyView
				description="Start chatting from the Ryu desktop app or the Chat with Ryu command."
				icon={Icon.SpeechBubble}
				title="No conversations yet"
			/>
			{items.map((conv) => (
				<List.Item
					actions={
						<ActionPanel>
							<Action.CopyToClipboard
								content={conv.id}
								title="Copy Conversation ID"
							/>
						</ActionPanel>
					}
					icon={Icon.SpeechBubble}
					key={conv.id}
					title={conv.title}
				/>
			))}
		</List>
	);
}

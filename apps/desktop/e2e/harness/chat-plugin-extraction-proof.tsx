import { MessageActionSurface } from "@ryu/blocks/desktop/agent-elements/message-action-surface.tsx";
import {
	isMessageReactionAction,
	MESSAGE_REACTION_DISPATCH,
	MESSAGE_REACTION_RENDERER,
} from "@ryu/blocks/desktop/agent-elements/message-action-types.ts";
import type {
	ContributedMessageAction,
	MessageActionRuntimeState,
} from "@ryu/blocks/desktop/agent-elements/types.ts";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PluginChatFeature } from "@/src/lib/api/plugins.ts";
import {
	buildSideChatContext,
	GHOST_CHAT_FEATURE_KIND,
	GHOST_CHATS_PLUGIN_ID,
	hasPluginChatFeature,
	SIDE_CHAT_FEATURE_KIND,
	SIDE_CHATS_PLUGIN_ID,
} from "@/src/lib/plugin-chat-features.ts";
import styles from "./chat-plugin-extraction-proof.module.css";
import "../../src/index.css";

const CHAT_FEATURES: PluginChatFeature[] = [
	{
		context: "main-chat",
		id: "side-chats",
		kind: SIDE_CHAT_FEATURE_KIND,
		persistence: "parent-conversation",
		plugin: SIDE_CHATS_PLUGIN_ID,
		command: "/btw",
	},
	{
		id: "ghost-chats",
		kind: GHOST_CHAT_FEATURE_KIND,
		persistence: "none",
		plugin: GHOST_CHATS_PLUGIN_ID,
		renderer: "temporary-chat",
		scope: "current-tab",
	},
];

const REACTION_ACTION: ContributedMessageAction = {
	args: {
		dispatch: MESSAGE_REACTION_DISPATCH,
		renderer: MESSAGE_REACTION_RENDERER,
	},
	capability: "reactions.toggle",
	icon: "smile",
	id: "reactions.picker",
	kind: "menu",
	label: "Add reaction",
	order: 100,
	plugin: "@ryu/reactions",
	target: "any",
};

const MAIN_CHAT_MESSAGES = [
	{
		content: "We chose the local model for the first pass.",
		role: "user",
	},
	{
		content: "The latest answer is still streaming in this main chat.",
		role: "assistant",
	},
];

const SIDE_CHAT_CONTEXT = buildSideChatContext(MAIN_CHAT_MESSAGES);

interface ReactionBucket {
	count: number;
	emoji: string;
	reactedByMe: boolean;
}

function StatusPill({ children }: { children: React.ReactNode }) {
	return <span className={styles.proofPill}>{children}</span>;
}

function FeatureRow({
	detail,
	feature,
	verified,
}: {
	detail: string;
	feature: string;
	verified: boolean;
}) {
	return (
		<div className={styles.featureRow} data-testid={`${feature}-feature-row`}>
			<div className={styles.featureRowMain}>
				<span
					className={[
						styles.featureDot,
						verified ? styles.featureDotOn : "",
					].join(" ")}
				/>
				<div>
					<strong>{feature}</strong>
					<span>{detail}</span>
				</div>
			</div>
			<StatusPill>{verified ? "Enabled" : "Missing"}</StatusPill>
		</div>
	);
}

function ChatPluginExtractionProof() {
	const [temporaryActive, setTemporaryActive] = useState(false);
	const [reactionBuckets, setReactionBuckets] = useState<ReactionBucket[]>([
		{ count: 2, emoji: "👍", reactedByMe: false },
	]);
	const reactionState = useMemo<MessageActionRuntimeState>(
		() => ({ reactionBuckets }),
		[reactionBuckets]
	);
	const sideChatsEnabled = hasPluginChatFeature(
		CHAT_FEATURES,
		SIDE_CHATS_PLUGIN_ID,
		SIDE_CHAT_FEATURE_KIND
	);
	const ghostChatsEnabled = hasPluginChatFeature(
		CHAT_FEATURES,
		GHOST_CHATS_PLUGIN_ID,
		GHOST_CHAT_FEATURE_KIND
	);

	return (
		<main className={styles.proofPage} data-testid="chat-plugin-proof">
			<header className={styles.proofHeader}>
				<div>
					<p className={styles.proofKicker}>RYU · CHAT PLUGIN EXTRACTION</p>
					<h1>Chat surfaces have clear owners.</h1>
					<p className={styles.proofLede}>
						One enabled-contribution feed drives side-chat context, message
						reactions, and temporary-chat privacy without hardcoded
						discoverability.
					</p>
				</div>
				<div className={styles.proofVerified} role="status">
					<span /> VERIFIED IN REACT
				</div>
			</header>

			<section className={styles.proofCard}>
				<div className={styles.cardHeading}>
					<div>
						<p className={styles.proofKicker}>ENABLED PLUGIN FEED</p>
						<h2>Three independent chat capabilities</h2>
					</div>
					<StatusPill>Feature-detected</StatusPill>
				</div>
				<div className={styles.featureList}>
					<FeatureRow
						detail="/btw · main-chat context · parent conversation persistence"
						feature={SIDE_CHATS_PLUGIN_ID}
						verified={sideChatsEnabled}
					/>
					<FeatureRow
						detail="message_actions · reactions.picker · reactions.toggle"
						feature="@ryu/reactions"
						verified={isMessageReactionAction(REACTION_ACTION)}
					/>
					<FeatureRow
						detail="temporary-chat · current tab · persistence none"
						feature={GHOST_CHATS_PLUGIN_ID}
						verified={ghostChatsEnabled}
					/>
				</div>
			</section>

			<section
				className={styles.proofCard}
				data-testid="side-chat-context-proof"
			>
				<div className={styles.cardHeading}>
					<div>
						<p className={styles.proofKicker}>@RYU/SIDE-CHATS</p>
						<h2>Side questions inherit the main chat</h2>
					</div>
					<StatusPill>Context attached</StatusPill>
				</div>
				<p className={styles.proofCopy}>
					The host sends the visible user and assistant turns with the `/btw`
					request. The server caps the handoff at the latest 30 messages.
				</p>
				<div className={styles.contextTrace}>
					<div className={styles.traceLabel}>
						<span>POST /api/btw</span>
						<code>conversation_id + messages[]</code>
					</div>
					<div
						className={styles.contextMessages}
						data-testid="side-chat-context-messages"
					>
						{SIDE_CHAT_CONTEXT.map((message, index) => (
							<div
								className={styles.contextMessage}
								key={`${message.role}-${index}`}
							>
								<span>{message.role}</span>
								<p>{message.content}</p>
							</div>
						))}
					</div>
					<code
						className={styles.contextJson}
						data-testid="side-chat-context-payload"
					>
						{JSON.stringify(SIDE_CHAT_CONTEXT)}
					</code>
				</div>
			</section>

			<section className={styles.proofCard} data-testid="ghost-chat-proof">
				<div className={styles.cardHeading}>
					<div>
						<p className={styles.proofKicker}>@RYU/GHOST-CHATS</p>
						<h2>Temporary chats stay private to this tab</h2>
					</div>
					<StatusPill>{temporaryActive ? "Active" : "Ready"}</StatusPill>
				</div>
				<p className={styles.proofCopy}>
					The plugin owns the lifecycle declaration; the host enforces the
					native privacy boundary for each turn.
				</p>
				<button
					aria-pressed={temporaryActive}
					className={[
						styles.temporaryToggle,
						temporaryActive ? styles.temporaryToggleActive : "",
					].join(" ")}
					data-testid="ghost-chat-toggle"
					onClick={() => setTemporaryActive((active) => !active)}
					type="button"
				>
					<span className={styles.toggleKnob} />
					Temporary chat
				</button>
				<div className={styles.privacyGrid} data-testid="ghost-chat-lifecycle">
					<span>persist</span>
					<strong>{temporaryActive ? "false" : "true"}</strong>
					<span>history / drafts / presence / reactions</span>
					<strong>{temporaryActive ? "skipped" : "normal"}</strong>
				</div>
			</section>

			<section className={styles.proofCard} data-testid="reaction-proof">
				<div className={styles.cardHeading}>
					<div>
						<p className={styles.proofKicker}>@RYU/REACTIONS</p>
						<h2>Reactions are a message-action plugin</h2>
					</div>
					<StatusPill>Native renderer</StatusPill>
				</div>
				<p className={styles.proofCopy}>
					The contribution enables the existing safe native picker and its Core
					persistence gate. No reaction declaration means no reaction row.
				</p>
				<div className={styles.reactionBubble}>
					<p>
						The message action receives the owning plugin’s declared dispatch.
					</p>
					<MessageActionSurface
						actions={[REACTION_ACTION]}
						messageId="0198b6fb-8ee1-7f4e-9a9e-3e0de0e78c6c"
						onAction={(action, context) => {
							if (isMessageReactionAction(action) && context.value) {
								setReactionBuckets((current) => [
									...current,
									{
										count: 1,
										emoji: context.value ?? "",
										reactedByMe: true,
									},
								]);
							}
						}}
						state={reactionState}
					/>
				</div>
				<div className={styles.reactionSummary}>
					{reactionBuckets.map((bucket) => (
						<span key={bucket.emoji}>
							{bucket.emoji} {bucket.count}
						</span>
					))}
					<code>reactions.picker → reactions.toggle</code>
				</div>
			</section>
		</main>
	);
}

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Chat plugin proof root is missing");
}
createRoot(rootElement).render(<ChatPluginExtractionProof />);

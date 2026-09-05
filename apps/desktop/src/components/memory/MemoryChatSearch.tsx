// apps/desktop/src/components/memory/MemoryChatSearch.tsx
//
// Semantic search over the encrypted chat history. Core owns the embedding
// lifecycle and returns decrypted snippets only after the caller passes the
// current node's visibility checks; this component is the Memory Library's
// user-facing window into that existing index.

import { Message01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type MessageSearchHit,
	type MessageSearchResult,
	searchConversations,
} from "@/src/lib/api/conversation-search.ts";
import {
	getChatMemoryEnabled,
	setChatMemoryEnabled,
} from "@/src/lib/api/preferences.ts";

const SEARCH_DEBOUNCE_MS = 250;

function formatRole(role: string): string {
	if (role === "user") {
		return "You";
	}
	if (role === "assistant") {
		return "Assistant";
	}
	const normalized = role.trim();
	return normalized
		? normalized.charAt(0).toUpperCase() + normalized.slice(1)
		: "Message";
}

function formatTimestamp(timestamp: number): string {
	if (!timestamp) {
		return "Unknown time";
	}
	try {
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(timestamp);
	} catch {
		return "Unknown time";
	}
}

function hitLabel(
	hit: MessageSearchHit,
	conversationTitle?: (conversationId: string) => string
): string {
	const title = conversationTitle?.(hit.conversationId)?.trim();
	return title || "Conversation";
}

function ChatSearchHitRow({
	conversationTitle,
	hit,
	onOpen,
}: {
	conversationTitle?: (conversationId: string) => string;
	hit: MessageSearchHit;
	onOpen: (conversationId: string) => void;
}) {
	const title = hitLabel(hit, conversationTitle);
	const relevance = Math.round(hit.score * 100);

	return (
		<li
			className="rounded-lg border border-border/60 bg-muted/30"
			data-testid="memory-chat-result"
		>
			<Button
				aria-label={`Open ${title}`}
				className="h-auto w-full justify-start whitespace-normal px-4 py-3 text-left"
				onClick={() => onOpen(hit.conversationId)}
				variant="ghost"
			>
				<div className="flex w-full min-w-0 items-start gap-3">
					<HugeiconsIcon
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						icon={Message01Icon}
					/>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-1.5">
							<span className="font-medium text-foreground text-sm">
								{title}
							</span>
							<Badge variant="secondary">{formatRole(hit.role)}</Badge>
							{relevance > 0 ? (
								<Badge variant="outline">{relevance}% match</Badge>
							) : null}
						</div>
						<p className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted-foreground text-sm leading-relaxed">
							{hit.content}
						</p>
						<p className="mt-2 text-muted-foreground text-xs">
							{formatTimestamp(hit.createdAt)}
						</p>
					</div>
				</div>
			</Button>
		</li>
	);
}

export function MemoryChatSearch({
	conversationTitle,
	onOpenDream,
	onOpenConversation,
	target,
}: {
	conversationTitle?: (conversationId: string) => string;
	onOpenDream: () => void;
	onOpenConversation: (conversationId: string) => void;
	target: ApiTarget;
}) {
	const [query, setQuery] = useState("");
	const searchInputRef = useRef<HTMLInputElement>(null);
	const [result, setResult] = useState<MessageSearchResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const [searchNonce, setSearchNonce] = useState(0);
	const [rememberChats, setRememberChats] = useState(false);
	const [loadingPreference, setLoadingPreference] = useState(true);
	const [savingPreference, setSavingPreference] = useState(false);
	const [preferenceError, setPreferenceError] = useState<
		"load" | "save" | null
	>(null);

	useEffect(() => {
		let cancelled = false;
		setLoadingPreference(true);
		void getChatMemoryEnabled(target)
			.then((enabled) => {
				if (cancelled) {
					return;
				}
				setRememberChats(enabled);
				setLoadingPreference(false);
				setPreferenceError(null);
			})
			.catch(() => {
				if (cancelled) {
					return;
				}
				setLoadingPreference(false);
				setPreferenceError("load");
			});
		return () => {
			cancelled = true;
		};
	}, [target.token, target.url]);

	useEffect(() => {
		const trimmed = query.trim();
		if (loadingPreference || !rememberChats || trimmed.length < 2) {
			setResult(null);
			setError(false);
			setLoading(false);
			return;
		}

		const controller = new AbortController();
		const timeout = window.setTimeout(() => {
			setLoading(true);
			void searchConversations(target, trimmed, 20, controller.signal)
				.then((next) => {
					if (controller.signal.aborted) {
						return;
					}
					setResult(next);
					setError(next === null);
				})
				.finally(() => {
					if (!controller.signal.aborted) {
						setLoading(false);
					}
				});
		}, SEARCH_DEBOUNCE_MS);

		return () => {
			controller.abort();
			window.clearTimeout(timeout);
		};
	}, [
		loadingPreference,
		query,
		rememberChats,
		searchNonce,
		target.token,
		target.url,
	]);

	const handleRememberChatsChange = async (next: boolean) => {
		setRememberChats(next);
		setSavingPreference(true);
		setPreferenceError(null);
		try {
			const saved = await setChatMemoryEnabled(target, next);
			if (!saved) {
				setRememberChats(!next);
				setPreferenceError("save");
			} else if (!next) {
				setResult(null);
			}
		} catch {
			setRememberChats(!next);
			setPreferenceError("save");
		} finally {
			setSavingPreference(false);
		}
	};

	const trimmed = query.trim();
	const hits = result?.hits ?? [];

	return (
		<div className="flex flex-col gap-4" data-testid="memory-chat-search">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="font-medium text-lg">Chat sources</h1>
					<p className="text-muted-foreground text-sm">
						Search the private source layer; Dream turns useful patterns into
						reviewable memories.
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<span className="font-medium text-sm">Remember chats</span>
					<Switch
						aria-label="Remember chats"
						checked={rememberChats}
						disabled={loadingPreference || savingPreference}
						onCheckedChange={handleRememberChatsChange}
					/>
				</div>
			</div>

			<div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
				<HugeiconsIcon
					className="mt-0.5 size-4 shrink-0 text-primary"
					icon={Message01Icon}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
					<p className="font-medium text-foreground">
						{rememberChats
							? "Chat sources are remembered"
							: "Chat remembering is off"}
					</p>
					<p className="mt-1 text-muted-foreground">
						{rememberChats
							? "New messages are embedded as you chat. Older conversations are securely backfilled when you search. Message text stays encrypted at rest, and nothing becomes a durable memory until you accept a Dream proposal."
							: "New messages will not be embedded, and existing chat embeddings have been cleared. Your conversations are still saved normally."}
					</p>
					{rememberChats ? (
						<div>
							<Button
								data-testid="memory-open-dream"
								onClick={onOpenDream}
								size="sm"
								variant="outline"
							>
								<Sparkles className="size-3.5" />
								Review in Dream
							</Button>
						</div>
					) : null}
				</div>
			</div>
			{preferenceError ? (
				<p className="text-destructive text-sm" role="alert">
					{preferenceError === "load"
						? "Couldn&apos;t load the Remember chats setting."
						: "Couldn&apos;t update chat remembering. Please try again."}
				</p>
			) : null}

			<div className="relative">
				<HugeiconsIcon
					className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					icon={Search01Icon}
				/>
				<Input
					aria-label="Search past chats"
					className="pl-9"
					disabled={loadingPreference || !rememberChats}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search past chats by meaning…"
					ref={searchInputRef}
					value={query}
				/>
			</div>

			{loadingPreference || loading ? (
				<div className="flex justify-center py-16">
					<Spinner />
				</div>
			) : rememberChats ? (
				error ? (
					<Empty className="py-12">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={Message01Icon} />
							</EmptyMedia>
							<EmptyTitle>Chat embeddings are unavailable</EmptyTitle>
							<EmptyDescription>
								Ryu couldn&apos;t reach the chat index right now. Your
								conversations are still saved, and this search will work again
								when the node is ready.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								onClick={() => setSearchNonce((nonce) => nonce + 1)}
								size="sm"
								variant="ghost"
							>
								Try again
							</Button>
						</EmptyContent>
					</Empty>
				) : result?.indexed === false ? (
					<Empty className="py-12">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={Message01Icon} />
							</EmptyMedia>
							<EmptyTitle>Chat embeddings are not enabled</EmptyTitle>
							<EmptyDescription>
								This node has no semantic chat index yet. New chats remain
								available; start the embedding provider and try again to search
								them here.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								onClick={() => setSearchNonce((nonce) => nonce + 1)}
								size="sm"
								variant="ghost"
							>
								Check again
							</Button>
						</EmptyContent>
					</Empty>
				) : trimmed.length < 2 ? (
					<Empty className="py-12">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={Message01Icon} />
							</EmptyMedia>
							<EmptyTitle>Search your past chats</EmptyTitle>
							<EmptyDescription>
								Ask a question or enter a topic to find the conversation where
								you talked about it.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button onClick={() => searchInputRef.current?.focus()} size="sm">
								Focus search
							</Button>
						</EmptyContent>
					</Empty>
				) : hits.length === 0 ? (
					<Empty className="py-12">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={Message01Icon} />
							</EmptyMedia>
							<EmptyTitle>No matching chat messages</EmptyTitle>
							<EmptyDescription>
								Try a broader question or a different phrase.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button onClick={() => setQuery("")} size="sm" variant="ghost">
								Clear search
							</Button>
						</EmptyContent>
					</Empty>
				) : (
					<ul className="flex flex-col gap-2" data-testid="memory-chat-results">
						{hits.map((hit) => (
							<ChatSearchHitRow
								conversationTitle={conversationTitle}
								hit={hit}
								key={hit.messageId}
								onOpen={onOpenConversation}
							/>
						))}
					</ul>
				)
			) : (
				<Empty className="py-12">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={Message01Icon} />
						</EmptyMedia>
						<EmptyTitle>Chat remembering is off</EmptyTitle>
						<EmptyDescription>
							Turn on Remember chats to embed new conversations and search older
							chats.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button onClick={() => handleRememberChatsChange(true)} size="sm">
							Turn on Remember chats
						</Button>
					</EmptyContent>
				</Empty>
			)}
		</div>
	);
}

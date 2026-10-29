import {
	type ConversationRow,
	listRecentConversations,
} from "../../core/conversations.ts";
import {
	nativeErrorMessage as errText,
	humanizeError,
} from "../../core/native-errors.ts";
/* @jsxImportSource @opentui/react */
// Spaces surface (/spaces) - the desktop Spaces (RAG) page, terminal edition.
// Ported from the legacy src/tabs/spaces.tsx so the new shell does not depend on
// src/tabs. Same reused fetch logic (GET /api/spaces, /api/spaces/:id/documents,
// /api/conversations), regrouped into a page:
//   - header "Spaces"
//   - left column: spaces list (top) + documents for the selected space (bottom)
//   - right column: conversation history, windowed by a scroll offset
//   - keys: ↑/k ↓/j select space (loads that space's docs, cached by id), r refresh
//     all (drops the doc cache), PageUp/PageDown scroll history
//   - read-only: spaces are created/edited in the desktop app.
//
// Contract adaptation: load gates on `active`; keyboard gates on
// `focused = active && focusedPaneId === paneId` (quiet while another input owns
// raw input).

import { useKeyboard } from "@opentui/react";
import {
	fetchDocuments,
	fetchSpaces,
	type Space,
	type SpaceDocument,
} from "@ryuhq/core-client/spaces";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { useInputFocused } from "../../core/InputFocusContext.tsx";
import { tf } from "../../i18n/translate.ts";
import { ErrorView } from "../../ui/ErrorView.tsx";
import { Loading } from "../../ui/Loading.tsx";
import { useToast } from "../../ui/toast.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

const SCROLL_STEP = 10;
const HISTORY_WINDOW = 14;

function SpacesSurface({ active, paneId }: SurfaceProps) {
	const { target } = useCore();
	const theme = useTheme();
	const { notify } = useToast();
	const { focusedPaneId } = useWorkspace();
	const inputFocused = useInputFocused();

	// Focused = this surface is the active tab AND its pane owns the keyboard.
	const focused = active && focusedPaneId === paneId;

	const [spaces, setSpaces] = useState<Space[]>([]);
	const [index, setIndex] = useState(0);
	const [docs, setDocs] = useState<Record<string, SpaceDocument[]>>({});
	const [conversations, setConversations] = useState<ConversationRow[]>([]);
	const [scroll, setScroll] = useState(0);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reloadKey, setReloadKey] = useState(0);

	// Guard against a stale in-flight load clobbering fresher data after a node
	// switch or rapid refreshes.
	const reqRef = useRef(0);
	const docsReqRef = useRef(0);
	// Read the document cache inside the doc-load effect without making it a
	// dependency (which would re-run the effect every time a space's docs land).
	const docsRef = useRef(docs);
	docsRef.current = docs;

	const selectedSpace = spaces[index];
	const selectedSpaceId = selectedSpace?.id ?? null;

	// Load the spaces list and conversation history together. The spaces fetch
	// failing surfaces an error view; the history fetch failing only flashes a
	// toast so the surface stays usable.
	const runLoad = useCallback(() => {
		const reqId = ++reqRef.current;
		setLoading(true);
		setError(null);
		fetchSpaces(target)
			.then((list) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setSpaces(list);
				setIndex((i) => (list.length === 0 ? 0 : Math.min(i, list.length - 1)));
				setLoaded(true);
			})
			.catch((err) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setError(errText(err));
				setLoaded(true);
			})
			.finally(() => {
				if (reqRef.current === reqId) {
					setLoading(false);
				}
			});

		listRecentConversations(target)
			.then((convs) => {
				if (reqRef.current === reqId) {
					setConversations(convs);
				}
			})
			.catch((err) => {
				if (reqRef.current === reqId) {
					notify(
						tf("conversations failed: {error}", { error: errText(err) }),
						"error"
					);
				}
			});
	}, [target, notify]);

	// Lazy first load on activation; reload on node switch (url/token) or 'r'. 'r'
	// also clears the doc cache (via reloadKey resetting docs below).
	useEffect(() => {
		if (active) {
			runLoad();
		}
		// `reloadKey` is load-bearing: 'r' only bumps it, so without it the reload
		// is dead. Add ONLY that — `runLoad` already changes identity on a node
		// switch, so re-adding `url, token` would double-load.
	}, [active, runLoad, reloadKey]);

	// Lazily fetch (and cache) documents for the selected space when the selection
	// changes. Already-cached spaces are skipped so reselecting is instant.
	useEffect(() => {
		if (!(active && selectedSpaceId)) {
			return;
		}
		if (docsRef.current[selectedSpaceId]) {
			return;
		}
		const reqId = ++docsReqRef.current;
		fetchDocuments(target, selectedSpaceId)
			.then((list) => {
				if (docsReqRef.current === reqId) {
					setDocs((prev) => ({ ...prev, [selectedSpaceId]: list }));
				}
			})
			.catch((err) => {
				if (docsReqRef.current === reqId) {
					notify(
						tf("documents failed: {error}", { error: errText(err) }),
						"error"
					);
				}
			});
		// target/notify are derived from url/token + stable context; depending on
		// url/token (primitives) avoids re-running this effect every render.
		// reloadKey invalidates the selected document cache when the user presses r.
	}, [active, selectedSpaceId, target, notify, reloadKey]);

	const refreshAll = useCallback(() => {
		setDocs({});
		setReloadKey((k) => k + 1);
	}, []);

	useKeyboard((key) => {
		if (!focused || inputFocused) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setIndex((i) => Math.max(0, i - 1));
		} else if (key.name === "down" || key.name === "j") {
			setIndex((i) => Math.min(Math.max(0, spaces.length - 1), i + 1));
		} else if (key.name === "r") {
			refreshAll();
		} else if (key.name === "pageup") {
			setScroll((s) => Math.max(0, s - SCROLL_STEP));
		} else if (key.name === "pagedown") {
			setScroll((s) => s + SCROLL_STEP);
		}
	});

	if (loading && !loaded) {
		return <Loading label="Loading spaces…" />;
	}
	if (error) {
		return (
			<ErrorView message={humanizeError(error, { url: target.url })} onRetry />
		);
	}

	const selectedDocs = selectedSpaceId ? docs[selectedSpaceId] : undefined;

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			<box flexDirection="row" gap={1}>
				<text fg={theme.colors.foreground}>
					<b>Spaces</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					↑↓ space · r refresh · PgUp/PgDn history
				</text>
			</box>
			<box flexDirection="row" flexGrow={1} gap={1} paddingTop={1}>
				<box flexDirection="column" flexGrow={3} gap={1}>
					<SpacesPane index={index} spaces={spaces} />
					<DocumentsPane
						docs={selectedDocs}
						hasSpace={selectedSpaceId !== null}
					/>
				</box>
				<box flexGrow={2}>
					<HistoryPane conversations={conversations} scroll={scroll} />
				</box>
			</box>
		</box>
	);
}

function SpacesPane({ spaces, index }: { spaces: Space[]; index: number }) {
	const theme = useTheme();
	return (
		<Card title="spaces">
			{spaces.length === 0 ? (
				<text fg={theme.colors.mutedForeground}>
					no spaces - create one in the desktop app
				</text>
			) : (
				spaces.map((space, i) => {
					const selected = i === index;
					const count =
						space.documentCount !== undefined && space.documentCount !== null
							? ` (${space.documentCount} docs)`
							: "";
					return (
						<box flexDirection="row" gap={1} key={space.id}>
							<text
								fg={
									selected ? theme.colors.primary : theme.colors.mutedForeground
								}
							>
								{selected ? "›" : " "}
							</text>
							<text
								fg={selected ? theme.colors.accent : theme.colors.foreground}
							>
								{selected ? <b>{space.name}</b> : space.name}
							</text>
							{count ? (
								<text fg={theme.colors.mutedForeground}>{count}</text>
							) : null}
						</box>
					);
				})
			)}
		</Card>
	);
}

function DocumentsPane({
	docs,
	hasSpace,
}: {
	docs: SpaceDocument[] | undefined;
	hasSpace: boolean;
}) {
	const theme = useTheme();
	let body: ReactNode;
	if (docs === undefined) {
		body = (
			<text fg={theme.colors.mutedForeground}>
				{hasSpace ? "loading documents…" : "select a space to see documents"}
			</text>
		);
	} else if (docs.length === 0) {
		body = (
			<text fg={theme.colors.mutedForeground}>no documents in this space</text>
		);
	} else {
		body = renderDocs(
			docs,
			theme.colors.foreground,
			theme.colors.mutedForeground
		);
	}
	return <Card title="documents">{body}</Card>;
}

function renderDocs(
	docs: SpaceDocument[],
	titleColor: string,
	mutedColor: string
) {
	return (
		<box flexDirection="column">
			{docs.map((doc) => (
				<box flexDirection="row" gap={1} key={doc.id}>
					<text fg={titleColor}>{doc.title}</text>
					<text fg={mutedColor}>
						{tf("{chunkCount} chunks", { chunkCount: String(doc.chunkCount) })}
					</text>
				</box>
			))}
		</box>
	);
}

function HistoryPane({
	conversations,
	scroll,
}: {
	conversations: ConversationRow[];
	scroll: number;
}) {
	const theme = useTheme();
	if (conversations.length === 0) {
		return (
			<Card title="history">
				<text fg={theme.colors.mutedForeground}>no conversations yet</text>
			</Card>
		);
	}
	const maxScroll = Math.max(0, conversations.length - HISTORY_WINDOW);
	const start = Math.min(scroll, maxScroll);
	const visible = conversations.slice(start, start + HISTORY_WINDOW);
	return (
		<Card title="history">
			{visible.map((conv) => {
				const meta = [
					conv.messageCount === null ? "" : `${conv.messageCount}msg`,
					conv.date ?? "",
				]
					.filter((part) => part.length > 0)
					.join(" ");
				return (
					<box flexDirection="row" gap={1} key={conv.id}>
						<text fg={theme.colors.foreground}>{conv.title}</text>
						{meta ? (
							<text fg={theme.colors.mutedForeground}>{meta}</text>
						) : null}
					</box>
				);
			})}
			{conversations.length > visible.length ? (
				<Badge bordered={false} variant="secondary">
					{`${start + 1}-${start + visible.length}/${conversations.length}`}
				</Badge>
			) : null}
		</Card>
	);
}

/** The Spaces surface module. Registered by src/workspace/router.ts (path
 * /spaces). */
export const spacesSurface: SurfaceModule = {
	id: "spaces",
	title: "Spaces",
	match: (path) => path === "/spaces" || path.startsWith("/spaces/"),
	Component: SpacesSurface,
};

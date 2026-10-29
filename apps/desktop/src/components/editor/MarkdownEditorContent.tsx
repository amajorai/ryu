import { YjsPlugin } from "@platejs/yjs/react";
import {
	type CollabCursor,
	createCollabEditorKit,
	EditorKit,
	type MyEditor,
} from "@ryu/ui/components/editor/editor-kit.tsx";
import { discussionPlugin } from "@ryu/ui/components/editor/plugins/discussion-kit.tsx";
import {
	Editor,
	EditorContainer,
} from "@ryu/ui/components/editor/ui/editor.tsx";
import { FixedToolbar } from "@ryu/ui/components/editor/ui/fixed-toolbar.tsx";
import { FixedToolbarButtons } from "@ryu/ui/components/editor/ui/fixed-toolbar-buttons.tsx";
import { Plate, usePlateEditor } from "platejs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { XmlText } from "yjs";
import { DiscussionCollabStore } from "@/src/lib/realtime/discussion-collab.ts";
import { RyuYjsProvider } from "@/src/lib/realtime/yjs-provider.ts";

type EditorKitPlugin = (typeof EditorKit)[number];
type MarkdownEditorPlugin = EditorKitPlugin & {
	api: { markdown: MyEditor["api"]["markdown"] };
	key: "markdown";
};
const markdownPlugin = EditorKit.find(
	(plugin): plugin is MarkdownEditorPlugin => plugin.key === "markdown"
);

/** The active node target a collaborative room connects through. */
interface CollabTarget {
	token: string | null;
	url: string;
	/** Managed-node user JWT, when the room is hosted on a cloud node. */
	userJwt?: string | null;
}

/** Everything {@link MarkdownEditor} needs to open a document collaboratively. */
export interface MarkdownCollab {
	/** The Core document id (also the realtime room id). */
	documentId: string;
	/** The user-identity JWT, or null for an anonymous (read-only) join. */
	jwt: string | null;
	/** Called when a server-side restore replaces the CRDT generation. */
	onReset?: (epoch: number) => void;
	/** Notified once the room finishes its first sync with Core (used by the
	 * page to switch off the markdown PUT fallback). */
	onSyncedChange?: (synced: boolean) => void;
	/** The active node (base url + node token). */
	target: CollabTarget;
	/** The local user's caret label + color. */
	user: CollabCursor;
}

/**
 * A full PlateJS rich-text editor that reads and writes Markdown, wrapping the
 * vendored `@ryu/ui` editor kit (toolbars, slash menu, tables, media, AI, …).
 *
 * Two modes:
 *
 *  - NON-collaborative (no `collab` prop): the page's canonical form is Markdown
 *    (what Core stores + embeds). We deserialize it into Plate on mount and
 *    serialize back on every change; the parent debounces the save. Unchanged
 *    from before — all existing callers keep this behaviour.
 *
 *  - COLLABORATIVE (`collab` given): the editor is bound to a Yjs CRDT through a
 *    {@link RyuYjsProvider} and `YjsPlugin`. The CRDT is the source of truth;
 *    `initialMarkdown` is used only to deterministically seed a brand-new room
 *    (idempotent across clients), and `onChangeMarkdown` still fires so the page
 *    can keep a materialized snapshot for the title save / offline fallback.
 *
 * Mount one instance per document (give it `key={documentId}`) so the seed value
 * and provider are stable for the editor's lifetime.
 */
export function MarkdownEditor({
	initialMarkdown,
	onChangeMarkdown,
	collab,
	compact = false,
	toolbar = "fixed",
	readOnly: readOnlyOverride = false,
}: {
	collab?: MarkdownCollab;
	/**
	 * Tighter padding for dialogs / inline surfaces (Prompt Studio, project
	 * settings). Full-page Spaces/file editors keep the default page layout.
	 */
	compact?: boolean;
	initialMarkdown: string;
	onChangeMarkdown: (markdown: string) => void;
	/** Compact quick actions with the full Space-page toolbar in a two-row grid. */
	toolbar?: "fixed" | "inline" | "two-row";
	/** Host-owned access can also lock a non-collaborative editor. */
	readOnly?: boolean;
}) {
	// Keep the page's sync callback fresh without rebuilding the provider/editor.
	const onSyncedChangeRef = useRef(collab?.onSyncedChange);
	onSyncedChangeRef.current = collab?.onSyncedChange;

	// The resolved access from join_ack. A read-only collaborator's edits are
	// dropped server-side (Core's write-ACL), so the editor must refuse edits
	// locally too — otherwise an edit would appear to apply, broadcast, get dropped,
	// and vanish on reload (silent data loss). Mirrors the grid's `readOnly` gate.
	const [access, setAccess] = useState<"read" | "write" | null>(null);
	const readOnly = readOnlyOverride || access === "read";

	// Whether the server granted THIS client the one-shot seed claim. Captured from
	// join_ack (which always precedes the first sync) and read inside the init
	// effect's sync handler. Only the single claim winner seeds an empty room, so
	// two concurrent first-opens cannot both seed and duplicate the body.
	const maySeedRef = useRef(false);

	// The provider fires sync changes before the editor exists, so it routes them
	// through a ref the init effect (which owns the editor) installs.
	const onProviderSyncRef = useRef<(synced: boolean) => void>(() => {
		// Replaced by the init effect; no-op until then.
	});

	const provider = useMemo(() => {
		if (!collab) {
			return null;
		}
		return new RyuYjsProvider({
			roomId: collab.documentId,
			target: {
				url: collab.target.url,
				token: collab.target.token,
				userJwt: collab.target.userJwt ?? null,
			},
			jwt: collab.jwt,
			handlers: {
				onJoinAck: (ack) => {
					maySeedRef.current = ack.maySeed;
					setAccess(ack.access);
				},
				onSyncChange: (synced) => onProviderSyncRef.current(synced),
				onReset: (epoch) => collab.onReset?.(epoch),
			},
		});
		// `collab` is memoized by the caller, so this rebuilds only when the room
		// identity / node / token actually changes.
	}, [collab]);
	const omitFixedToolbarPlugin = toolbar !== "fixed";
	const collabPlugins = useMemo(() => {
		if (!(provider && collab)) {
			return null;
		}
		const plugins = createCollabEditorKit({
			cursor: collab.user,
			provider,
		});
		return omitFixedToolbarPlugin
			? plugins.filter((plugin) => plugin.key !== "fixed-toolbar")
			: plugins;
	}, [collab, omitFixedToolbarPlugin, provider]);
	const standalonePlugins = useMemo(
		() =>
			omitFixedToolbarPlugin
				? EditorKit.filter((plugin) => plugin.key !== "fixed-toolbar")
				: EditorKit,
		[omitFixedToolbarPlugin]
	);

	const editor = usePlateEditor(
		provider && collab && collabPlugins
			? {
					plugins: collabPlugins,
					skipInitialization: true,
				}
			: {
					plugins: standalonePlugins,
					// `value` may be a function of the editor, which is how we reach the
					// MarkdownPlugin's deserializer to turn stored Markdown into nodes.
					value: (ed) =>
						ed
							.getApi(markdownPlugin)
							.markdown.deserialize(initialMarkdown || ""),
				}
	);

	useEffect(() => {
		if (!(provider && collab)) {
			return;
		}

		const store = new DiscussionCollabStore(provider.document);
		const applySharedState = () => {
			editor.setOption(
				discussionPlugin,
				"discussions",
				store.readDiscussions()
			);
			editor.setOption(discussionPlugin, "users", store.readUsers());
		};
		const currentUser = {
			avatarUrl: collab.user.avatarUrl,
			id: collab.user.id,
			name: collab.user.name,
		};

		editor.setOption(discussionPlugin, "currentUserId", currentUser.id);
		editor.setOption(discussionPlugin, "onDiscussionsChange", (discussions) =>
			store.writeDiscussions(discussions)
		);
		store.writeUser(currentUser);
		applySharedState();
		const stopObserving = store.observe(applySharedState);

		return () => {
			stopObserving();
			editor.setOption(discussionPlugin, "onDiscussionsChange", undefined);
		};
	}, [collab, editor, provider]);

	useEffect(() => {
		if (!provider) {
			return;
		}
		let disposed = false;
		let seeded = false;
		const yjs = editor.getApi(YjsPlugin).yjs;

		// Seed AFTER the first sync, and only when Core's copy is empty — never from
		// `initialMarkdown` unconditionally. Core never decodes the CRDT back into
		// the document `source`, so `source` (hence `initialMarkdown`) drifts from
		// the CRDT the moment the body is edited (e.g. a title save snapshots the
		// live body). Re-deriving the seed from a drifted `source` on every open
		// would fork the document; gating on an empty Core means exactly one client
		// ever seeds, so the stored `source` is free to move.
		onProviderSyncRef.current = (synced) => {
			if (synced && !seeded) {
				seeded = true;
				// Seed ONLY when the server granted this client the seed claim
				// (`maySeed`); the emptiness check stays as defense in depth. Without
				// the server gate, two clients opening the same empty room would both
				// seed and duplicate the body.
				const root = provider.document.get("content", XmlText);
				if (
					maySeedRef.current &&
					root.length === 0 &&
					initialMarkdown.trim().length > 0
				) {
					const nodes = editor
						.getApi(markdownPlugin)
						.markdown.deserialize(initialMarkdown);
					editor.tf.insertNodes(nodes, { at: [0] });
				}
			}
			onSyncedChangeRef.current?.(synced);
		};

		// `value:null` binds the editor to the (empty) shared root without seeding;
		// `autoConnect:false` keeps `init` from blocking on a round-trip — we open
		// the socket ourselves right after.
		yjs
			.init({ id: provider.roomId, value: null, autoConnect: false })
			.then(() => {
				if (!disposed) {
					provider.connect();
				}
			})
			.catch(() => {
				// A failed init/connect degrades to a local-only editor; nothing
				// actionable to surface here.
			});

		return () => {
			disposed = true;
			onProviderSyncRef.current = () => {
				// Detached; ignore late sync callbacks during teardown.
			};
			try {
				editor.getApi(YjsPlugin).yjs.destroy();
			} catch {
				// Editor may already be torn down; destroy is best-effort.
			}
			provider.destroy();
		};
	}, [editor, provider, initialMarkdown]);

	return (
		<Plate
			editor={editor}
			onChange={({ editor: ed }) =>
				onChangeMarkdown(ed.getApi(markdownPlugin).markdown.serialize())
			}
		>
			{toolbar === "inline" ? (
				<div className="border-border/60 border-b px-2 py-1">
					<FixedToolbar>
						<FixedToolbarButtons placement="inline" />
					</FixedToolbar>
				</div>
			) : toolbar === "two-row" ? (
				<FixedToolbar>
					<FixedToolbarButtons expandedLayout="grid" />
				</FixedToolbar>
			) : null}
			<EditorContainer
				className={compact ? "max-h-[min(50vh,360px)] min-h-48" : undefined}
				variant={compact ? "select" : "default"}
			>
				<Editor
					placeholder="Start writing, or press / for commands…"
					readOnly={readOnly}
					variant={compact ? "select" : "default"}
				/>
			</EditorContainer>
		</Plate>
	);
}

// Mounts a THIRD-PARTY plugin's bundled UI through the extension host, inside the
// null-origin sandboxed iframe, gated by the plugin's GATEWAY-APPROVED grants.
//
// This is the trusted-webview side of the third-party code path (the general
// sibling of `ExamplePluginPanel`, which mounts one fixed built-in demo). It:
//   - fetches the plugin's bundled code over the TRUSTED Core API (the host holds
//     the node token; the plugin never does),
//   - builds the granted capability set from the plugin's `approved_grants`
//     (Gateway-validated) — NEVER the manifest's `permission_grants` claim, and
//     DENY-SAFE (empty set) if anything is missing,
//   - implements the privileged host services (`listAgents` projected to
//     `{id,name}` only; `registerRoute` scoped to this plugin's own surface), and
//   - wraps the sandboxed frame in a visible "Plugin" attribution header so it is
//     never mistaken for system chrome (invariant #6).
//
// It renders NOTHING until the caller (PluginCompanionPage) decides the plugin
// actually carries a UI bundle.

import { PlugSocketIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	RyuCatalogModels,
	RyuCatalogSnapshot,
} from "@ryu/app-host/app-bridge";
import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	type ActivityRecord,
	type ApprovalRecord,
	type BackgroundProcess,
	type CalendarAgentRecord,
	type CalendarJobRecord,
	type CalendarWorkflowRecord,
	type Capability,
	type ChatConversationSummary,
	type ChatSendResult,
	type CryptoStatus,
	capabilitiesFromGrants,
	createI18nHostServices,
	type HostServices,
	isShellSafeRoute,
	type MailInbox,
	type MailMessage,
	type MeetingRecord,
	type NotificationRecord,
	type ProactiveSuggestionRecord,
	type QuestRecord,
	type UploadFileResult,
	validatePluginRoute,
	type WarmupDetectionRecord,
} from "@ryu/app-host/rpc";
import {
	htmlCompanionSrcdoc,
	thirdPartyPluginSrcdoc,
} from "@ryu/app-host/third-party-plugin";
import {
	createScopedToastHost,
	createSileoToastRenderer,
} from "@ryu/app-host/toast-host";
import { useI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import { iconToUrl } from "@ryu/ui/components/icon";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { RealtimeConnection } from "@ryuhq/core-client/realtime";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getActiveUserId, useSession } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import {
	useCurrentTabId,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { ApplicationRealtimeQueue } from "@/src/contributions/host/application-realtime-queue.ts";
import {
	type CommandEntry,
	contributionRegistry,
} from "@/src/contributions/registry.ts";
import { registerTabIcon } from "@/src/contributions/tab-icon-registry.ts";
import {
	useActiveNode,
	useActiveNodeGetter,
} from "@/src/hooks/useActiveNode.ts";
import { subscribeFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { listActivity } from "@/src/lib/api/activity.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import { ownAppRequest } from "@/src/lib/api/app-request.ts";
import {
	approveApproval,
	listApprovals,
	rejectApproval,
} from "@/src/lib/api/approvals.ts";
import { searchGifs } from "@/src/lib/api/assets.ts";
import { blueprintRequest } from "@/src/lib/api/blueprint.ts";
import {
	listChatBroadcastConversations,
	sendChatBroadcastTurn,
} from "@/src/lib/api/chat-broadcast.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	fetchComposioConnections,
	fetchComposioStatus,
	fetchComposioToolkits,
	fetchComposioTriggers,
} from "@/src/lib/api/composio.ts";
import { fetchEngineModels } from "@/src/lib/api/engines.ts";
import {
	type EventChannel,
	subscribeChannel,
} from "@/src/lib/api/eventStream.ts";
import { getHealingStatus } from "@/src/lib/api/healing.ts";
import { generateImage as apiGenerateImage } from "@/src/lib/api/images.ts";
import { getLearningConfig, listExperience } from "@/src/lib/api/learn.ts";
import {
	createInbox,
	deleteInbox,
	listInboxes,
	listMessages,
	rotateInboundSecret,
	sendMessage,
} from "@/src/lib/api/mail.ts";
import { fetchMcpServers, fetchMcpTools } from "@/src/lib/api/mcp.ts";
import {
	deleteMeeting,
	finalizeMeeting,
	getTranscript,
	importMeeting,
	listMeetings,
	renameMeeting,
	setMeetingIcon,
	startMeeting,
} from "@/src/lib/api/meetings.ts";
import {
	createMonitor,
	deleteMonitor,
	getMonitor,
	listMonitorAlerts,
	listMonitors,
	listSnapshots,
	runMonitor,
	updateMonitor,
} from "@/src/lib/api/monitors.ts";
import { newsRequest } from "@/src/lib/api/news.ts";
import { resolveNodeShareOrigins } from "@/src/lib/api/node-share.ts";
import {
	ackNotification,
	archiveNotification,
	listMentionTargetUsers,
	listNotifications,
	markNotificationRead,
	unarchiveNotification,
} from "@/src/lib/api/notifications.ts";
import {
	fetchApps,
	fetchPluginUiBundle,
	getPluginContributions,
	type PluginCompanion,
	pluginFinetuneStream,
	pluginHostInvoke,
	pluginHostInvokeStream,
} from "@/src/lib/api/plugins.ts";
import {
	acceptSuggestion as acceptQuestSuggestion,
	captureQuest,
	completeQuest,
	createQuest,
	deleteQuest,
	dismissQuest,
	dismissSuggestion as dismissQuestSuggestion,
	getScratchpad,
	judgeQuest,
	listQuests,
	pinQuest,
	type QuestInput,
	setScratchpad,
	updateQuest,
	useQuest,
} from "@/src/lib/api/quests.ts";
import { reasoningRequest } from "@/src/lib/api/reasoning.ts";
import {
	getRecordingStatus,
	listRecipes,
	startRecording,
	stopRecording,
} from "@/src/lib/api/recipes.ts";
import { rlmRequest } from "@/src/lib/api/rlm.ts";
import { safeActionsRequest } from "@/src/lib/api/safe-actions.ts";
import { fetchJobs } from "@/src/lib/api/schedules.ts";
import {
	frameUrl,
	getJournal,
	getProactiveInbox,
	getTimeline,
	postFeedback,
} from "@/src/lib/api/shadow.ts";
import {
	createSkill,
	getSkillSource,
	getSkillVersionSource,
	listSkills,
	listSkillVersions,
	restoreSkillVersion,
	snapshotSkill,
	updateSkill,
} from "@/src/lib/api/skills.ts";
import { socialRequest } from "@/src/lib/api/social.ts";
import {
	type SpaceMatch as DesktopSpaceMatch,
	searchSpace,
} from "@/src/lib/api/spaces.ts";
import { subtitlesRequest } from "@/src/lib/api/subtitles.ts";
import { tuitionRequest } from "@/src/lib/api/tuition.ts";
import { fileToDataUrl, uploadUserFile } from "@/src/lib/api/uploads.ts";
import { generateVideo as apiGenerateVideo } from "@/src/lib/api/video.ts";
import {
	speakText as apiSpeakText,
	transcribeAudio as apiTranscribeAudio,
	listTtsEngines,
} from "@/src/lib/api/voice.ts";
import {
	applyWarmupJobs,
	detectWarmupAgents,
	listWarmupJobs,
	runWarmupJobNow,
} from "@/src/lib/api/warmup.ts";
import {
	fetchWebhookIngressStatus,
	fetchWebhookSecret,
	fetchWebhooks,
	setWebhookSecret,
} from "@/src/lib/api/webhooks.ts";
import {
	createWorkflow,
	createWorkflowVersion,
	deleteWorkflow,
	fetchWorkflow,
	fetchWorkflows,
	fetchWorkflowTemplate,
	fetchWorkflowTemplates,
	getWorkflowRun,
	getWorkflowVersionDefinition,
	installWorkflowTemplate,
	listWorkflowVersions,
	restoreWorkflowVersion,
	resumeWorkflow,
	runWorkflow,
} from "@/src/lib/api/workflows.ts";
import { createScheduledAgentWorkflow } from "@/src/lib/automations.ts";
import { getRealtimeJwt } from "@/src/lib/realtime/jwt.ts";
import {
	enrichTimelineJournal,
	sanitizeTimelineEvents,
} from "@/src/lib/timeline-app-icons.ts";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";

const PLUGIN_TOAST_RENDERER = createSileoToastRenderer(toast);

/** Base64-encode a UTF-8 string (btoa is Latin-1 only). Used to inline the plugin
 *  bundle into the sandboxed `srcdoc` so a body containing `</script>` cannot
 *  break the tag (defense in depth; the sandbox is the real boundary). */
function toBase64Utf8(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** Read a Blob as a `data:` URL (FileReader) so a binary result crosses the
 *  MessagePort as a string the CSP-locked frame can render. */
function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error("read failed"));
		reader.readAsDataURL(blob);
	});
}

/** Open the OS file dialog for a WAV audio file on behalf of the sandboxed meetings
 *  companion (its frame carries no picker + cannot POST multipart under the CSP, so
 *  the host owns the import — the timeline host-owns-the-privileged-op pattern). The
 *  `accept` filter mirrors the desktop page's hidden `<input>`. Resolves to the chosen
 *  `File`, or `null` if the user cancels the dialog. */
function pickAudioFile(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "audio/wav,.wav";
		let settled = false;
		const onFocus = () => {
			// Fallback for webviews that never fire `cancel` (WKWebView on macOS, which
			// Tauri uses): when the window regains focus after the OS dialog closes, give
			// `change` a tick to arrive; if no file was chosen it was a cancel. Without
			// this the picker promise would hang and the frame's Import button would stay
			// stuck on "Importing…".
			window.setTimeout(() => {
				if (!input.files?.length) {
					done(null);
				}
			}, 300);
		};
		const done = (file: File | null) => {
			if (settled) {
				return;
			}
			settled = true;
			window.removeEventListener("focus", onFocus);
			input.remove();
			resolve(file);
		};
		input.addEventListener("change", () => done(input.files?.[0] ?? null));
		// Modern Chromium/Tauri webviews fire `cancel` when the dialog is dismissed.
		input.addEventListener("cancel", () => done(null));
		window.addEventListener("focus", onFocus);
		input.style.display = "none";
		document.body.appendChild(input);
		input.click();
	});
}

/** Open the OS file dialog for `ui.uploadFile`. Same cancel/focus fallback as
 *  {@link pickAudioFile}. Resolves to the chosen files, or `null` on cancel. */
function pickFiles(opts?: {
	accept?: string;
	multiple?: boolean;
}): Promise<File[] | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		if (opts?.accept) {
			input.accept = opts.accept;
		}
		input.multiple = opts?.multiple === true;
		let settled = false;
		const onFocus = () => {
			window.setTimeout(() => {
				if (!input.files?.length) {
					done(null);
				}
			}, 300);
		};
		const done = (files: File[] | null) => {
			if (settled) {
				return;
			}
			settled = true;
			window.removeEventListener("focus", onFocus);
			input.remove();
			resolve(files);
		};
		input.addEventListener("change", () => {
			const list = input.files ? Array.from(input.files) : [];
			done(list.length > 0 ? list : null);
		});
		input.addEventListener("cancel", () => done(null));
		window.addEventListener("focus", onFocus);
		input.style.display = "none";
		document.body.appendChild(input);
		input.click();
	});
}

/** Fetch the Shadow keyframe at `tsMicros` and return it as a `data:` URL (the
 *  timeline companion's frame, blocked from a direct `<img src>` by the frame CSP
 *  `img-src data: blob:`). The shell (unsandboxed) reaches device-local Shadow
 *  through the LOCAL Core's `/api/shadow` proxy (`frameUrl` — Shadow's own HTTP
 *  surface is bearer-gated and 403s browser requests; the `shadow.ts` INVARIANT
 *  still holds: never the per-tab node).
 *  Resolves to `null` when no keyframe exists near that moment (Shadow 404s), so the
 *  companion renders its "No frame recorded" placeholder — parity with the desktop
 *  page's `<img onError>` fallback. */
async function fetchFrameDataUrl(tsMicros: number): Promise<string | null> {
	try {
		const resp = await fetch(frameUrl(tsMicros), {
			headers: { Accept: "image/*" },
		});
		if (!resp.ok) {
			return null;
		}
		return await blobToDataUrl(await resp.blob());
	} catch {
		return null;
	}
}

/** Normalize a media URL to a `data:` URL. Local results are already `data:`;
 *  remote provider URLs (Replicate/Fal) are fetched HOST-side (the trusted webview
 *  has network; the frame does not) and inlined so `img/media-src data: blob:` can
 *  render them. */
async function inlineToDataUrl(url: string): Promise<string> {
	if (url.startsWith("data:")) {
		return url;
	}
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`failed to fetch media: ${resp.status}`);
	}
	return await blobToDataUrl(await resp.blob());
}

/** Module-level cache of resolved app icon tiles (`appId` → `{ name, glyph,
 *  background }`), so the notifications bridge never re-fetches the catalog or
 *  re-inlines the same icon on every row render. Keyed by `nodeUrl|appId` so two
 *  nodes with different catalogs cannot cross-pollute. */
const appIconTileCache = new Map<string, AppIconTile>();

interface AppIconTile {
	background: string | null;
	glyph: string;
	name: string;
}

/**
 * Resolve an app's notification tile (name + monochrome glyph as a `data:` URL +
 * flat plate background) for the CSP-locked companion frame. Falls back to a
 * neutral glyph for unknown / legacy producers (rows with no `source_app_id`),
 * so every notification row can render SOMETHING specific to its sender.
 */
async function resolveAppIconTile(
	target: ApiTarget,
	appId: string
): Promise<AppIconTile> {
	const cacheKey = `${target.url}|${appId}`;
	const cached = appIconTileCache.get(cacheKey);
	if (cached) {
		return cached;
	}
	let tile: AppIconTile;
	try {
		const apps = await fetchApps(target);
		const app = apps.find((a) => a.id === appId);
		if (app) {
			const rasterUrl =
				app.iconUrl ??
				iconToUrl(app.icon, {
					size: 28,
					// Muted-foreground zinc-500: reads on the neutral plate in both themes.
					color: "#71717b",
				});
			tile = {
				background: app.iconBackground ?? null,
				glyph: rasterUrl ? await inlineToDataUrl(rasterUrl) : "",
				name: app.name,
			};
		} else {
			tile = { background: null, glyph: "", name: appId };
		}
	} catch {
		tile = { background: null, glyph: "", name: appId };
	}
	appIconTileCache.set(cacheKey, tile);
	return tile;
}

/** Decode a `data:` URL back to a Blob (for STT upload). `fetch` on a data URL is
 *  synchronous-ish and stays in the trusted context. */
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
	const resp = await fetch(dataUrl);
	return await resp.blob();
}

/** The design-system semantic-color + radius/spacing tokens the theme-token bridge
 *  forwards into a sandboxed companion (matches the token block companions carry as
 *  their offline default; see `apps-store/<x>/ui/src/tailwind.css`). Kept in sync
 *  with `packages/ui/src/styles/globals.css`. */
const COMPANION_THEME_TOKENS = [
	"--background",
	"--foreground",
	"--card",
	"--card-foreground",
	"--popover",
	"--popover-foreground",
	"--primary",
	"--primary-foreground",
	"--secondary",
	"--secondary-foreground",
	"--muted",
	"--muted-foreground",
	"--accent",
	"--accent-foreground",
	"--destructive",
	"--success",
	"--success-foreground",
	"--warning",
	"--warning-foreground",
	"--info",
	"--info-foreground",
	"--border",
	"--input",
	"--ring",
	"--radius",
	"--spacing",
	// Typography, for the same reason as the colours: a companion that inherits
	// the surface's palette but not its type still reads as a foreign document
	// embedded in the app, which is exactly how the app UIs looked — every one of
	// them fell back to its own bundled default stack.
	//
	// Only the family STACK crosses this bridge, not the webfont bytes: the frame
	// is a null-origin `srcdoc` document, so an `@font-face` pointing at the
	// shell's origin is not fetchable from inside it. Forwarding the stack still
	// aligns the two on the same generic tail (`sans-serif`) instead of leaving
	// them on unrelated defaults; carrying the actual Inter/Geist faces in needs
	// them inlined as `data:` URIs under the companion CSP, which is a separate
	// change with a real bundle-size cost.
	"--font-sans",
	"--font-heading",
	"--font-code",
] as const;

/** The node event-stream channels a `shell.eventsSubscribe` call may request (grant
 *  `shell:integrate`). A companion's requested set is intersected with this — an
 *  unknown channel is silently dropped. Mirrors the `EventChannel` union. */
const SHELL_EVENT_CHANNELS: readonly EventChannel[] = [
	"activity",
	"notifications",
	"quests",
	"monitors",
	"approvals",
	"downloads",
];

/** Read the host's LIVE resolved theme tokens (the desktop's active light/dark/
 *  custom theme) so the theme-token bridge can inject them into the sandboxed
 *  companion at mount — one mechanism that makes every companion render native to
 *  the surface's current theme. Returns only the tokens the host actually resolves
 *  (a blank value is skipped, so the companion falls back to its own default for
 *  that token). Runs in the trusted webview (getComputedStyle on the host root). */
function readHostThemeTokens(): Record<string, string> {
	if (
		typeof document === "undefined" ||
		typeof getComputedStyle !== "function"
	) {
		return {};
	}
	const style = getComputedStyle(document.documentElement);
	const out: Record<string, string> = {};
	for (const name of COMPANION_THEME_TOKENS) {
		const value = style.getPropertyValue(name).trim();
		if (value.length > 0) {
			out[name] = value;
		}
	}
	return out;
}

/** How long the sandbox bridge may take to connect before the startup state stops
 *  claiming progress and offers a retry. Long enough that a cold, heavy bundle is
 *  not accused of being broken; short enough that a lost handshake is not a
 *  spinner you stare at. */
const STALL_AFTER_MS = 8000;
/** How long Retry stays disabled after a press. A reload is cheap but not free
 *  (re-fetch + re-parse the bundle), and a mashed button only ever makes a slow
 *  frame slower by restarting it. */
const RETRY_COOLDOWN_MS = 15_000;

interface ApplicationRealtimeSession {
	connection: RealtimeConnection;
	queue: ApplicationRealtimeQueue;
}

/**
 * The panel's centered state — startup, failure, and "nothing to show" all render
 * through this one shape so they cannot drift into three different-looking screens.
 * `busy` swaps the icon for a spinner; `onRetry` adds the action, disabled while
 * `retryDisabledFor` seconds remain (armed on press and counted down in place, so
 * the button says why it is dead).
 */
function PanelPlaceholder({
	busy,
	description,
	onRetry,
	retryDisabledFor = 0,
	title,
}: {
	busy?: boolean;
	description: string;
	onRetry?: () => void;
	retryDisabledFor?: number;
	title: string;
}) {
	return (
		<div className="flex h-full items-center justify-center p-6">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						{busy ? <Spinner /> : <HugeiconsIcon icon={PlugSocketIcon} />}
					</EmptyMedia>
					<EmptyTitle>{title}</EmptyTitle>
					<EmptyDescription>{description}</EmptyDescription>
				</EmptyHeader>
				{onRetry ? (
					<EmptyContent>
						<Button
							disabled={retryDisabledFor > 0}
							onClick={onRetry}
							size="sm"
							variant="ghost"
						>
							{retryDisabledFor > 0 ? `Retry in ${retryDisabledFor}s` : "Retry"}
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		</div>
	);
}

export function PluginHostPanel({
	companion,
	mountContext,
}: {
	companion: PluginCompanion;
	/** Optional host-supplied context baked into the frame as `window.ryu.context`
	 *  (e.g. `{ spaceId, docId }` when the app is opened as a Space document). */
	mountContext?: unknown;
}) {
	const node = useActiveNode();
	const getActiveNode = useActiveNodeGetter();
	const i18n = useI18n();
	const { distributeInstalledSkill } = useSkillDistributionFlow();
	const [connected, setConnected] = useState(false);
	const realtimeSessionsRef = useRef(
		new Map<string, ApplicationRealtimeSession>()
	);
	useEffect(() => {
		return () => {
			for (const session of realtimeSessionsRef.current.values()) {
				session.connection.close();
				session.queue.end();
			}
			realtimeSessionsRef.current.clear();
		};
	}, []);
	// The theme-token bridge (W7): seed the companion's first paint from the
	// desktop's resolved theme, then push subsequent changes into the already
	// mounted null-origin frame. Keeping the initial snapshot separate avoids
	// remounting a running app when the user changes appearance.
	const [initialThemeTokens] = useState(readHostThemeTokens);
	const [themeTokens, setThemeTokens] = useState(initialThemeTokens);
	useEffect(() => {
		if (typeof MutationObserver === "undefined") {
			return;
		}
		const observer = new MutationObserver(() => {
			setThemeTokens(readHostThemeTokens());
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "style", "data-theme"],
		});
		return () => observer.disconnect();
	}, []);
	// The shell Settings dialog opener — the `@ryu/quests` companion's detection-
	// settings gear opens Settings → Quests through the `questsOpenDetectionSettings`
	// bridge verb (the QuestsSettings tab stays a shell surface; the extracted page's
	// gear reaches it via this host-side navigation, preserving the old behavior).
	// Quests is an app: its settings render under the Apps header in the node-scoped
	// Gateway dialog, addressed by its `app:<id>` entity value.
	const openGateway = useGatewayDialog((s) => s.openGateway);
	// The shell tab opener — the `@ryu/activity` companion's clickable rows open the
	// chat tab for an item's session through the `activityOpenSession` bridge verb (the
	// extracted page used `useTabsContext().openTab` directly; the sandboxed frame reaches
	// it here). PluginHostPanel renders as tab content, so it sits under TabsProvider.
	const { openTab, updateTabTitle, updateTabsIconWhere } = useTabsContext();
	// The current tab id — the `@ryu/skill-editor` companion's `skills.setTitle` verb
	// renames its own owning tab (the desktop page's `updateTabTitle(currentTabId, …)`).
	const currentTabId = useCurrentTabId();
	// The signed-in user id, resolved HOST-SIDE for the `@ryu/approvals` companion's
	// Notifications section: the per-user feed is scoped by user id, but the sandboxed
	// frame has no Better Auth session, so the host reads it (the session query, falling
	// back to the local account vault) exactly as the deleted `useNotifications` hook did.
	const { data: session } = useSession();
	const meId = session?.user?.id ?? getActiveUserId() ?? null;

	// Fetch the plugin's bundled code over the trusted API. `null` (no bundle /
	// not enabled) or an error means we render the benign fallback, never code.
	const {
		data: code,
		isPending,
		isError,
		refetch,
	} = useQuery({
		queryKey: ["plugin-ui-bundle", node.url, node.token, companion.pluginId],
		// Fetch by the OWNING plugin id (the store key), not the companion id.
		queryFn: () => fetchPluginUiBundle(toTarget(node), companion.pluginId),
		retry: false,
		staleTime: 60_000,
	});

	// Retry generation. Bumping it mints a fresh nonce → a fresh `srcdoc` → the
	// iframe genuinely reloads (a re-render alone would not: React leaves an
	// unchanged `srcDoc` attribute alone, so the dead document would just sit
	// there). The nonce is also the ExtensionHost effect's key, so the bridge
	// listener is rebuilt in step with the document it is waiting on.
	const [attempt, setAttempt] = useState(0);
	const grantsKey = companion.approvedGrants.join(" ");
	// One nonce per attempt. Host-generated, never plugin/user input.
	const nonce = useMemo(
		() =>
			typeof crypto?.randomUUID === "function"
				? crypto.randomUUID()
				: `nonce-${attempt}-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
		[attempt, grantsKey]
	);

	// Startup progress: `stalled` flips when the bridge has not connected within
	// STALL_AFTER_MS, which is what turns the honest "Starting…" state into an
	// actionable one. Reset per attempt.
	const [stalled, setStalled] = useState(false);
	useEffect(() => {
		if (connected) {
			return;
		}
		setStalled(false);
		const id = setTimeout(() => setStalled(true), STALL_AFTER_MS);
		return () => clearTimeout(id);
	}, [connected, attempt]);

	// Retry cooldown, ticked only while it runs (an idle panel must not re-render
	// once a second forever). Armed on press, not on success: the press is what
	// costs a reload, whether or not the reload then works.
	const [cooldownUntil, setCooldownUntil] = useState(0);
	const [now, setNow] = useState(() => Date.now());
	const cooldownLeftMs = Math.max(0, cooldownUntil - now);
	const cooldownSeconds = Math.ceil(cooldownLeftMs / 1000);
	useEffect(() => {
		if (cooldownLeftMs <= 0) {
			return;
		}
		const id = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(id);
	}, [cooldownLeftMs]);

	const retry = useCallback(() => {
		setCooldownUntil(Date.now() + RETRY_COOLDOWN_MS);
		setNow(Date.now());
		setConnected(false);
		setAttempt((n) => n + 1);
		// Re-fetch too: a bundle that failed (or was served by a node still booting)
		// must be re-read, not re-mounted from the same cached miss.
		refetch();
	}, [refetch]);

	// The granted set comes from the plugin's GATEWAY-APPROVED grants, mapped to
	// capabilities (unmapped grants dropped). DENY-SAFE: an empty approved list
	// yields an empty set, so a plugin with no validated grants can call nothing.
	//
	// Keyed by grant CONTENT, not by the array's identity. `granted` is one of the
	// two ExtensionHost effect deps, and that effect's cleanup closes the live RPC
	// port — while the iframe, whose `srcdoc` did not change, never re-announces to
	// get a new one (`handshakeAnnounceScript` clears its retry interval once the
	// port lands, and again after HANDSHAKE_RETRY_WINDOW_MS). So an identity-only
	// change — the contributions query refetching on window focus hands back an
	// equal-but-new `approvedGrants` array — would silently kill the bridge of every
	// open app the first time the window is refocused. Same set ⇒ same Set ⇒ no
	// teardown.
	// biome-ignore lint/correctness/useExhaustiveDependencies: grantsKey is the content hash of approvedGrants.
	const granted = useMemo<ReadonlySet<Capability>>(
		() => capabilitiesFromGrants(companion.approvedGrants),
		[grantsKey]
	);

	// This app's assistant-context slice + takeover token. Scoped to the plugin id
	// so two companions of the same app share one slice (they are one app to the
	// user) while different apps stay isolated.
	const assistantOwner = `plugin:${companion.pluginId}`;
	const toastHost = useMemo(
		() =>
			createScopedToastHost({
				renderer: PLUGIN_TOAST_RENDERER,
				sourceId: `${companion.pluginId}:${companion.id}`,
			}),
		[companion.id, companion.pluginId]
	);

	useEffect(() => () => toastHost.dispose(), [toastHost]);

	// A closed page is not "what the user is looking at". Drop this app's slice and
	// its takeover when the panel unmounts — an app that crashed or was navigated
	// away from must not keep steering the assistant.
	useEffect(() => {
		return () => {
			const assistant = useAssistantStore.getState();
			assistant.clearContextOwner(assistantOwner);
			assistant.clearBuilder(assistantOwner);
		};
	}, [assistantOwner]);

	// The privileged services. `listAgents` holds the token and returns a minimal
	// projection; `registerRoute` accepts ONLY this plugin's own `/plugin/<id>`
	// path (anti-phishing), rejecting system/other-plugin paths.
	const services = useMemo<HostServices>(
		() => ({
			...createI18nHostServices(i18n),
			openExternal: ({ href }) => openExternal(href),
			uiToastDismiss: (input) => toastHost.dismiss(input),
			uiToastShow: (input) => toastHost.show(input),
			uiToastUpdate: (input) => toastHost.update(input),
			// ── Assistant bridge ───────────────────────────────────────────────────
			// The app tells the ONE global "Ask Ryu" surface what its page is showing,
			// and (optionally) lends it this page's own instructions while the page is
			// open. Everything is scoped by the owning plugin id: an app replaces its
			// OWN context slice and can clear only its OWN takeover, so two apps (or an
			// app and the page under it) never clobber each other. Nothing is readable
			// back — this is a write-only channel into the assistant's prompt.
			assistantPublishContext: async ({ items }) => {
				useAssistantStore.getState().publishContext(
					assistantOwner,
					// `source` is stamped HERE, by the shell, from the companion's real
					// name — never taken from the app's own payload, which could claim
					// to be anything.
					items.map((i) => ({ ...i, source: companion.name }))
				);
			},
			assistantClearContext: async () => {
				useAssistantStore.getState().clearContextOwner(assistantOwner);
			},
			assistantRegisterSurface: async (surface) => {
				useAssistantStore.getState().registerBuilder({
					conversationId: assistantOwner,
					// An app-defined kind, so `buildBuilderPreamble` uses the surface's
					// own `preamble` instead of a built-in builder's instructions.
					kind: `plugin:${companion.pluginId}`,
					label: surface.label,
					description: surface.description,
					preamble: surface.preamble,
					prompts: surface.prompts,
					tools: surface.tools,
					// Registering must not pop the panel open — see the store's `dock` doc.
					dock: false,
					snapshot: "",
					targetId: companion.id,
					targetName: surface.label,
					resolveId: () => Promise.resolve(companion.id),
					onChanged: () => undefined,
				});
			},
			assistantClearSurface: async () => {
				useAssistantStore.getState().clearBuilder(assistantOwner);
			},
			assistantOpen: async ({ mode, prompt }) => {
				useAssistantStore.getState().open(mode);
				if (prompt) {
					// Asking on the user's behalf is a real turn on their budget, and it
					// lands in the thread looking exactly like something they typed. So
					// the question is ATTRIBUTED here, by the shell, from the companion's
					// real name — the same rule the context path follows, applied to the
					// higher-power half. `assistant.open()` with no prompt just shows the
					// panel and writes nothing.
					useAssistantStore
						.getState()
						.setPendingPrompt(`[asked by ${companion.name}] ${prompt}`);
				}
			},
			listAgents: async () => {
				const agents = await fetchAgents(toTarget(node));
				return agents.map((a) => ({ id: a.id, name: a.name }));
			},
			nodeShareOrigins: () => resolveNodeShareOrigins(getActiveNode()),
			// Richer projection for a per-agent model picker (still no secrets — just
			// the public engine/model binding + flagship flag).
			listAgentsFull: async () => {
				const agents = await fetchAgents(toTarget(node));
				return agents.map((a) => ({
					id: a.id,
					name: a.name,
					engine: a.engine,
					model: a.model,
					recommended: a.recommended,
				}));
			},
			registerRoute: (claim) => {
				if (!validatePluginRoute(companion.id, claim)) {
					return Promise.reject(
						new Error(`route '${claim.path}' is not this plugin's own surface`)
					);
				}
				// The route is already minted by usePluginContributionRoutes; this is
				// the plugin CLAIMING it, and the host acknowledging the valid claim.
				return Promise.resolve({ path: claim.path });
			},
			// App host-bridge services. Each is ONE governed fetch to the Core endpoint
			// keyed by the OWNING plugin id (companion.pluginId, NOT companion.id). The
			// method is the DOTTED wire name the Core endpoint maps to the bridge
			// (`bridge_path_for`: model.complete→host.sideModel, storage.get→
			// host.storage_get, …); args are forwarded verbatim (already validated in
			// rpc.ts). The host holds the node token; the frame never does.
			modelComplete: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"model.complete",
					input
				) as Promise<string>,
			catalogSnapshot: () =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"catalog.snapshot",
					{}
				) as Promise<RyuCatalogSnapshot>,
			catalogModels: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"catalog.models",
					input
				) as Promise<RyuCatalogModels>,
			chatListConversations: () =>
				listChatBroadcastConversations(toTarget(node)) as Promise<
					ChatConversationSummary[]
				>,
			chatSend: (input) =>
				sendChatBroadcastTurn(toTarget(node), input) as Promise<ChatSendResult>,
			runAgent: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"agent.run",
					input
				) as Promise<string>,
			backgroundList: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"background.list",
					input
				) as Promise<BackgroundProcess[]>,
			backgroundStop: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"background.stop",
					input
				) as Promise<{
					ok: boolean;
					requested: boolean;
					process_id: string;
				}>,
			storageGet: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"storage.get",
					input
				) as Promise<string | null>,
			storageSet: async (input) => {
				await pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"storage.set",
					input
				);
			},
			storageDelete: async (input) => {
				await pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"storage.delete",
					input
				);
			},
			storageKeys: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"storage.keys",
					input
				) as Promise<string[]>,
			// Sealing: the app hands over plaintext and gets back an opaque envelope.
			// The key is derived per app inside Core and never crosses to the frame,
			// so these are host round-trips rather than a local crypto helper.
			cryptoSeal: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"crypto.seal",
					input
				) as Promise<string>,
			cryptoOpen: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"crypto.open",
					input
				) as Promise<string>,
			cryptoStatus: () =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"crypto.status",
					{}
				) as Promise<CryptoStatus>,
			// Streaming agent.run: reply text arrives token-by-token via `emit`; the
			// SSE fetch is aborted when `signal` fires (frame cancel).
			runAgentStream: (input, emit, signal) =>
				pluginHostInvokeStream(toTarget(node), companion.pluginId, input, {
					onChunk: emit,
					signal,
				}),
			// Creation runs through the caller-scoped app bridge; semantic retrieval
			// remains a host-direct Core API call. The frame never receives the node
			// token, and Core applies its normal user/organization visibility checks.
			spacesEnsureSpace: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.ensureSpace",
					input
				) as Promise<string>,
			spacesSearch: async (input) => {
				const matches = await searchSpace(
					toTarget(node),
					input.space_id,
					input.query,
					input.limit
				);
				return matches.map((match: DesktopSpaceMatch) => ({
					chunk_id: match.chunkId,
					content: match.content,
					distance: match.distance,
					document_id: match.documentId,
				}));
			},
			// Spaces documents — the app owns Space docs of kind app:<pluginId>.
			spacesCreateDoc: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.createDoc",
					input
				) as Promise<string>,
			spacesGetDoc: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.getDoc",
					input
				) as Promise<{
					id: string;
					title: string;
					source: string;
					kind: string;
				} | null>,
			spacesUpdateDoc: async (input) => {
				await pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.updateDoc",
					input
				);
			},
			spacesListDocs: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.listDocs",
					input
				) as Promise<{ id: string; title: string; updated_at: number }[]>,
			spacesDeleteDoc: async (input) => {
				await pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.deleteDoc",
					input
				);
			},
			// Media services — host-direct governed fetches (same pattern as
			// listAgents: the host holds the node token and calls the Gateway-governed
			// Core media endpoints). Every result is normalized to a `data:` URL so the
			// CSP-locked frame (img/media-src data: blob: only) can render it.
			generateImage: async (input) => {
				const urls = await apiGenerateImage(toTarget(node), input.prompt, {
					count: input.count,
					size: input.size,
					provider: input.provider,
					model: input.model,
					inputImages: input.input_images,
				});
				return await Promise.all(urls.map(inlineToDataUrl));
			},
			generateVideo: async (input) => {
				const clips = await apiGenerateVideo(toTarget(node), input.prompt, {
					provider: input.provider,
					model: input.model,
				});
				return await Promise.all(
					clips.map(async (c) => ({
						url: await inlineToDataUrl(c.url),
						mediaType: c.mediaType,
					}))
				);
			},
			ttsSpeak: async (input) => {
				const blob = await apiSpeakText(toTarget(node), input.text, {
					engine: input.engine,
					voice: input.voice,
					speed: input.speed,
					language: input.language,
				});
				return await blobToDataUrl(blob);
			},
			transcribeAudio: async (input) => {
				const blob = await dataUrlToBlob(input.audio);
				return await apiTranscribeAudio(
					toTarget(node),
					blob,
					input.filename ?? "recording.wav"
				);
			},
			// User file upload → Uploads system space. Host opens the picker (frame
			// cannot), uploads, and returns a data_url so CSP-locked frames can render.
			uploadFile: async (input) => {
				const files = await pickFiles({
					accept: input?.accept,
					multiple: input?.multiple,
				});
				if (!files || files.length === 0) {
					return null;
				}
				const target = toTarget(node);
				const base = node.url.replace(/\/$/, "");
				const results: UploadFileResult[] = [];
				for (const file of files) {
					const [dataUrl, uploaded] = await Promise.all([
						fileToDataUrl(file),
						uploadUserFile(target, file),
					]);
					results.push({
						id: uploaded.id,
						space_id: uploaded.spaceId,
						name: uploaded.fileName,
						size: uploaded.size,
						mime_type: uploaded.contentType,
						url: `${base}${uploaded.url}`,
						data_url: dataUrl,
					});
				}
				return input?.multiple ? results : (results[0] ?? null);
			},
			listEngineModels: () => fetchEngineModels(toTarget(node)),
			listTtsEngines: () => listTtsEngines(toTarget(node)),
			// GIF search via Core's proxy (holds the provider key). Inline the preview
			// + full clip to data URLs so the CSP-locked frame can render/insert them.
			searchGifs: async ({ query }) => {
				const resp = await searchGifs(toTarget(node), query);
				const results = await Promise.all(
					resp.results.map(async (g) => ({
						id: g.id,
						title: g.title,
						preview: await inlineToDataUrl(g.preview_url),
						url: await inlineToDataUrl(g.url),
						width: g.width,
						height: g.height,
					}))
				);
				return { configured: resp.configured, results };
			},
			// Fine-tune runs — the @ryu/finetune app drives Core's orchestration +
			// durable job store through the governed bridge (host holds the node token).
			// Unary calls forward verbatim; live progress streams over finetuneStream.
			finetuneCapability: () =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"finetune.capability",
					{}
				),
			finetuneStart: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"finetune.start",
					input
				),
			finetuneList: () =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"finetune.list",
					{}
				),
			finetuneGet: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"finetune.get",
					input
				),
			finetuneCancel: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"finetune.cancel",
					input
				),
			finetuneAdapters: () =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"finetune.adapters",
					{}
				),
			finetuneMerge: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"finetune.merge",
					input
				),
			finetuneStream: (input, emit, signal) =>
				pluginFinetuneStream(toTarget(node), companion.pluginId, input.id, {
					onFrame: emit,
					signal,
				}),
			// Website monitors — the @ryu/monitors companion drives Core's
			// `/api/monitors/*` orchestration. Called DIRECTLY (the media pattern), not
			// via the PluginHookBridge: `/api/monitors/*` already exists and is gated on
			// the same @ryu/monitors enabled bit, so no Core bridge verb is needed.
			monitorsList: () => listMonitors(toTarget(node)),
			monitorsGet: ({ id }) => getMonitor(toTarget(node), id),
			monitorsCreate: (input) => createMonitor(toTarget(node), input),
			monitorsUpdate: ({ id, input }) =>
				updateMonitor(toTarget(node), id, input),
			monitorsDelete: async ({ id }) => {
				await deleteMonitor(toTarget(node), id);
			},
			monitorsRun: ({ id }) => runMonitor(toTarget(node), id),
			monitorsSnapshots: ({ id, limit }) =>
				listSnapshots(toTarget(node), id, limit),
			monitorsAlerts: ({ id, limit }) =>
				listMonitorAlerts(toTarget(node), id, limit),
			// Workflows — the @ryu/workflows companion drives Core's DAG workflow
			// engine + templates + node-config catalogs + ghost record→replay. Host-
			// direct (the monitors pattern): the host holds the node token and calls
			// the existing `/workflows*` + `/api/workflows/catalog*` + `/api/recipes/*`
			// + node-config API, already gated on the @ryu/workflows enabled bit.
			// definition CRUD (workflows:crud)
			workflowsList: () => fetchWorkflows(toTarget(node)),
			workflowsGet: ({ id }) => fetchWorkflow(toTarget(node), id),
			workflowsSave: (def) => createWorkflow(toTarget(node), def),
			workflowsDelete: async ({ id }) => {
				await deleteWorkflow(toTarget(node), id);
			},
			workflowsVersionsList: ({ id }) =>
				listWorkflowVersions(toTarget(node), id),
			workflowsVersionGet: ({ id, versionId }) =>
				getWorkflowVersionDefinition(toTarget(node), id, versionId),
			workflowsVersionCreate: async ({ id, label }) => {
				await createWorkflowVersion(toTarget(node), id, label);
			},
			workflowsVersionRestore: ({ id, versionId }) =>
				restoreWorkflowVersion(toTarget(node), id, versionId),
			workflowsTemplatesList: () => fetchWorkflowTemplates(toTarget(node)),
			workflowsTemplateGet: ({ id }) =>
				fetchWorkflowTemplate(toTarget(node), id),
			workflowsTemplateInstall: ({ templateId }) =>
				installWorkflowTemplate(toTarget(node), templateId),
			// The inbound webhook URL is the SERVER-RESOLVED public URL from the
			// registry (`/api/webhooks`), never a fabricated `node.url` (that is
			// localhost — the anti-goal). Core resolves it via the ingress origin
			// (tunnel backends) OR the relay inbound endpoint (managed RyuRelay), so a
			// per-workflow webhook is reachable on a laptop once the relay registers.
			// Empty until a reachable URL exists, rendered as an honest "no URL yet".
			workflowsWebhook: async ({ id }) => {
				const registry = await fetchWebhooks(toTarget(node));
				const endpoint = registry.endpoints.find(
					(e) => e.kind === "workflow" && (e.workflowId === id || e.id === id)
				);
				return { url: endpoint?.publicUrl ?? "" };
			},
			// run + run-state (workflows:runstate)
			workflowsRun: ({ id, input, dryRun }) =>
				runWorkflow(toTarget(node), id, input ?? {}, { dryRun }),
			workflowsRunGet: ({ runId }) => getWorkflowRun(toTarget(node), runId),
			workflowsResume: ({ runId, payload }) =>
				resumeWorkflow(toTarget(node), runId, payload),
			// node-config catalog pickers (workflows:catalogs) — read-only projections
			workflowsAgents: () => fetchAgents(toTarget(node)),
			workflowsApps: () => fetchApps(toTarget(node)),
			workflowsMcp: async () => ({
				servers: await fetchMcpServers(toTarget(node)),
				tools: await fetchMcpTools(toTarget(node)),
			}),
			workflowsSkills: () => listSkills(toTarget(node)),
			workflowsSchedules: () => fetchJobs(toTarget(node)),
			workflowsNotifyTargets: () => listMentionTargetUsers(toTarget(node)),
			// The app-event catalog behind the `event` trigger's picker. Served from
			// the same contributions endpoint the shell already reads, narrowed to the
			// one family the canvas needs.
			workflowsHookEvents: async () =>
				(await getPluginContributions(toTarget(node))).hook_events,
			workflowsComposio: ({ kind, toolkit }) => {
				switch (kind) {
					case "status":
						return fetchComposioStatus(toTarget(node));
					case "toolkits":
						return fetchComposioToolkits(toTarget(node));
					case "triggers":
						return fetchComposioTriggers(toTarget(node), toolkit ?? "");
					default:
						return fetchComposioConnections(toTarget(node), toolkit ?? "");
				}
			},
			// ghost record→replay (ghost:record)
			ghostRecipes: () => listRecipes(toTarget(node)),
			ghostRecordStart: ({ task }) => startRecording(toTarget(node), task),
			ghostRecordStatus: () => getRecordingStatus(toTarget(node)),
			ghostRecordStop: () => stopRecording(toTarget(node)),
			// Inbound webhook registry + protected secret management — the
			// @ryu/webhooks companion uses explicit secret reads/writes while the host
			// keeps the node token out of the sandboxed frame (webhooks:crud).
			webhooksList: () => fetchWebhooks(toTarget(node)),
			webhooksIngressStatus: () => fetchWebhookIngressStatus(toTarget(node)),
			webhooksSecretGet: ({ id }) =>
				fetchWebhookSecret(toTarget(node), id).then((secret) => ({ secret })),
			webhooksSecretSet: ({ id, secret }) =>
				setWebhookSecret(toTarget(node), id, secret).then((value) => ({
					secret: value,
				})),
			// Quests — the @ryu/quests companion drives Core's `/api/quests/*`
			// auto-detecting-todo orchestration. Host-direct (the monitors pattern): the
			// host holds the node token and calls the existing `/api/quests/*` client,
			// forwarding Core's snake_case shapes verbatim over the bridge (quests:crud).
			questsList: (input) =>
				listQuests(
					toTarget(node),
					input?.kind as Parameters<typeof listQuests>[1]
				) as unknown as Promise<QuestRecord[]>,
			questsCapture: (input) =>
				captureQuest(
					toTarget(node),
					input as unknown as Parameters<typeof captureQuest>[1]
				) as unknown as Promise<QuestRecord>,
			questsUse: ({ id, complete }) =>
				useQuest(
					toTarget(node),
					id,
					complete
				) as unknown as Promise<QuestRecord>,
			questsPin: ({ id, pinned }) =>
				pinQuest(
					toTarget(node),
					id,
					pinned ?? true
				) as unknown as Promise<QuestRecord>,
			questsScratchpad: () => getScratchpad(toTarget(node)),
			questsSetScratchpad: ({ text }) => setScratchpad(toTarget(node), text),
			questsCreate: (input) =>
				createQuest(
					toTarget(node),
					input as unknown as QuestInput
				) as unknown as Promise<QuestRecord>,
			questsUpdate: ({ id, input }) =>
				updateQuest(
					toTarget(node),
					id,
					input as unknown as QuestInput
				) as unknown as Promise<QuestRecord>,
			questsDelete: async ({ id }) => {
				await deleteQuest(toTarget(node), id);
			},
			questsComplete: ({ id }) =>
				completeQuest(toTarget(node), id) as unknown as Promise<QuestRecord>,
			questsDismiss: ({ id }) =>
				dismissQuest(toTarget(node), id) as unknown as Promise<QuestRecord>,
			questsAcceptSuggestion: ({ id }) =>
				acceptQuestSuggestion(
					toTarget(node),
					id
				) as unknown as Promise<QuestRecord>,
			questsDismissSuggestion: ({ id }) =>
				dismissQuestSuggestion(
					toTarget(node),
					id
				) as unknown as Promise<QuestRecord>,
			questsJudge: ({ id }) =>
				judgeQuest(toTarget(node), id) as unknown as Promise<
					Record<string, unknown>
				>,
			// Shell navigation: open Settings at the Quests (detection) tab. Not a Core
			// call — the companion's gear reaches the shell SettingsDialog through here.
			questsOpenDetectionSettings: () => openGateway("app:@ryu/quests"),
			// Activity feed — the @ryu/activity companion renders Core's read-only
			// unified feed. Host-direct (the monitors pattern): the host holds the node
			// token and calls the existing `/api/activity` read, forwarding Core's
			// snake_case items verbatim over the bridge (activity:read).
			activityList: ({ limit }) =>
				listActivity(toTarget(node), { limit }) as unknown as Promise<
					ActivityRecord[]
				>,
			// Shell navigation: open the chat tab for an item's session. Not a Core call —
			// the extracted page opened it via `useTabsContext().openTab` (same call here).
			activityOpenSession: ({ session_id }) =>
				openTab("/chat", { conversationId: session_id, title: "Chat" }),
			// Timeline — the @ryu/timeline companion renders the activity replay
			// scrubber. Host-direct but device-LOCAL: Shadow (:3030) is machine-pinned,
			// so these call the `shadow.ts` client WITHOUT `toTarget(node)` — the
			// INVARIANT (the same host-direct-to-Shadow shape as `suggestions*` above).
			// `frame` fetches the keyframe and returns a data URL (CSP img-src data:
			// blob:). `openReview`/`openSettings` are shell-navigation verbs mirroring the
			// desktop page's `navigate("/review")`/`navigate("/settings")`.
			timelineList: async ({ rangeMinutes }) =>
				sanitizeTimelineEvents(await getTimeline(rangeMinutes)) as unknown as
					| Record<string, unknown>[]
					| null,
			timelineJournal: async ({ rangeMinutes, narrate }) =>
				enrichTimelineJournal(
					await getJournal(rangeMinutes, { narrate })
				) as unknown as Record<string, unknown> | null,
			timelineFrame: ({ tsMicros }) => fetchFrameDataUrl(tsMicros),
			timelineOpenReview: () => openTab("/review", { title: "Weekly review" }),
			timelineOpenSettings: () => openTab("/settings"),
			// Agent Inboxes — the @ryu/mail companion drives Core's `/api/mail/*`
			// orchestration (inbox CRUD, message list/send, inbound-secret rotation).
			// Host-direct (the monitors pattern): the host holds the node token and
			// calls the existing `/api/mail/*` client (served by the out-of-process
			// `ryu-mail` sidecar), forwarding Core's shapes verbatim over the bridge
			// (mail:crud). The extracted `AgentInboxesPage` used these same clients.
			mailList: () =>
				listInboxes(toTarget(node)) as unknown as Promise<MailInbox[]>,
			mailMessages: ({ inboxId }) =>
				listMessages(toTarget(node), inboxId) as unknown as Promise<
					MailMessage[]
				>,
			mailCreate: (input) =>
				createInbox(toTarget(node), {
					name: input.name,
					address: input.address,
				}) as unknown as Promise<MailInbox>,
			mailDelete: async ({ id }) => {
				await deleteInbox(toTarget(node), id);
			},
			mailRotateSecret: ({ id }) => rotateInboundSecret(toTarget(node), id),
			mailSend: ({ inboxId, to, subject, text }) =>
				sendMessage(toTarget(node), inboxId, {
					to,
					subject,
					text,
				}) as unknown as Promise<MailMessage>,
			// The inbound forwarder URL is derived from the node URL (the desktop page
			// built it client-side); the host owns node.url, the sandboxed frame does
			// not (the workflowsWebhook precedent).
			mailInboundUrl: ({ inboxId }) =>
				Promise.resolve({
					url: `${node.url.replace(/\/+$/, "")}/api/mail/inbound/${inboxId}`,
				}),
			// Calendar — the @ryu/calendar companion renders the scheduled-runs
			// calendar and schedules an agent routine. Host-direct (the monitors pattern): the
			// host holds the node token and calls the existing `/heartbeat/jobs` (jobs),
			// `/workflows` (names), and `/api/agents` (picker) reads, forwarding Core's
			// shapes verbatim over the bridge (calendar:crud). `createAutomation` reuses
			// the SAME `createScheduledAgentWorkflow` routine composite the desktop dialog ran, so
			// Core's validation error (bad cron/interval) propagates as the thrown message.
			calendarJobs: () =>
				fetchJobs(toTarget(node)) as unknown as Promise<CalendarJobRecord[]>,
			calendarWorkflows: () =>
				fetchWorkflows(toTarget(node)) as unknown as Promise<
					CalendarWorkflowRecord[]
				>,
			calendarAgents: () =>
				fetchAgents(toTarget(node)) as unknown as Promise<
					CalendarAgentRecord[]
				>,
			calendarCreateAutomation: (args) =>
				createScheduledAgentWorkflow(toTarget(node), args),
			// Warmup — the @ryu/warmup companion keeps subscription usage windows
			// open by scheduling a keep-alive ping per agent. Host-direct (the monitors
			// pattern): the host holds the node token and drives `/api/agents` (+ its
			// `/usage` and `/acp-config` reads) and `/heartbeat/jobs`, forwarding Core's
			// shapes verbatim over the bridge (warmup:crud). Both mutating verbs are
			// scoped to jobs stamped `ownerApp: @ryu/warmup`, so the grant can never
			// reach an automation another app or Core owns.
			warmupDetect: () =>
				detectWarmupAgents(toTarget(node)) as unknown as Promise<{
					agents: WarmupDetectionRecord["agents"];
					tz: WarmupDetectionRecord["tz"];
				}>,
			warmupList: () =>
				listWarmupJobs(toTarget(node)) as unknown as Promise<
					CalendarJobRecord[]
				>,
			warmupApply: (jobs) => applyWarmupJobs(toTarget(node), jobs),
			warmupRunNow: ({ jobId }) => runWarmupJobNow(toTarget(node), jobId),
			// Learning — the @ryu/learning companion renders the read-only
			// continual-learning surface. Host-direct (the monitors pattern): the host
			// holds the node token and calls the existing `/api/learn/config` (config),
			// `/api/experience/list` (buffer), and `/api/healing/status` (heal history)
			// reads, forwarding Core's shapes verbatim over the bridge (learning:crud).
			// All READ-ONLY — the skill approvals + heal inbox stay in the Inbox, the
			// opt-ins in Privacy settings.
			learningConfig: () =>
				getLearningConfig(toTarget(node)) as unknown as Promise<
					Record<string, unknown>
				>,
			learningExperience: () =>
				listExperience(toTarget(node)) as unknown as Promise<
					Record<string, unknown>
				>,
			learningHealing: () =>
				getHealingStatus(toTarget(node)) as unknown as Promise<
					Record<string, unknown>
				>,
			// Inbox / Approvals — the @ryu/approvals companion renders the unified
			// inbox. Host-direct (the monitors pattern): the host holds the node token
			// and calls the existing `/api/approvals/*` (approve/reject),
			// `/api/notifications/*` (the per-user feed, scoped by the host-resolved
			// `meId`), and Shadow's `/proactive` + `/api/feedback` reads/writes,
			// forwarding the shapes verbatim over the bridge (approvals:crud). The quest
			// task check-off reuses the `quests*` services above (the app also holds
			// quests:crud). `suggestionsOpenInChat` is a shell-navigation verb.
			approvalsList: () =>
				listApprovals(toTarget(node)) as unknown as Promise<ApprovalRecord[]>,
			approvalsApprove: ({ id, note }) =>
				approveApproval(
					toTarget(node),
					id,
					note
				) as unknown as Promise<ApprovalRecord>,
			approvalsReject: ({ id, note }) =>
				rejectApproval(
					toTarget(node),
					id,
					note
				) as unknown as Promise<ApprovalRecord>,
			notificationsList: ({ archived }: { archived?: boolean } = {}) =>
				(meId
					? listNotifications(toTarget(node), meId, undefined, archived)
					: Promise.resolve([])) as unknown as Promise<NotificationRecord[]>,
			notificationsSend: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"notifications.send",
					input
				) as Promise<{ notification_id: string; target_user_id: string }>,
			notificationsMarkRead: ({ id }) =>
				markNotificationRead(toTarget(node), id),
			notificationsAck: ({ id }) => ackNotification(toTarget(node), id),
			notificationsArchive: ({ id }) => archiveNotification(toTarget(node), id),
			notificationsUnarchive: ({ id }) =>
				unarchiveNotification(toTarget(node), id),
			notificationsAppIcons: async ({ appIds }: { appIds: string[] }) => {
				const tiles = await Promise.all(
					appIds.map(
						async (appId) =>
							[appId, await resolveAppIconTile(toTarget(node), appId)] as const
					)
				);
				return Object.fromEntries(tiles);
			},
			suggestionsList: () =>
				getProactiveInbox() as unknown as Promise<ProactiveSuggestionRecord[]>,
			suggestionsFeedback: ({ kind, suggestion_type }) =>
				postFeedback({ kind, suggestion_type }),
			suggestionsOpenInChat: ({ prompt }) =>
				openTab("/chat", {
					forceNew: true,
					initialPrompt: prompt,
					title: "Chat",
				}),
			// Meetings — the @ryu/meetings companion renders the record → live-
			// transcript → AI-notes surface. Host-direct (the monitors pattern): the host
			// holds the node token and calls the existing `/api/meetings/*` clients,
			// forwarding Core's shapes verbatim over the bridge (meetings:crud). `import`
			// is host-owned: the frame carries no file picker + cannot POST multipart under
			// the CSP, so the host opens the OS file dialog (the same `audio/wav` filter the
			// desktop page used) and performs the upload, returning the created meeting or
			// `null` on cancel. `open`/`openNotes`/`openList` are shell-navigation verbs
			// mirroring the extracted page's `useTabsContext().openTab`.
			meetingsList: () =>
				listMeetings(toTarget(node)) as unknown as Promise<MeetingRecord[]>,
			meetingsTranscript: ({ id }) =>
				getTranscript(toTarget(node), id) as unknown as Promise<
					Record<string, unknown>
				>,
			meetingsStart: (input) =>
				startMeeting(toTarget(node), {
					source: input.source as "manual" | "auto" | undefined,
					app: input.app,
					title: input.title,
				}) as unknown as Promise<MeetingRecord>,
			meetingsFinalize: ({ id }) =>
				finalizeMeeting(
					toTarget(node),
					id
				) as unknown as Promise<MeetingRecord>,
			meetingsDelete: async ({ id }) => {
				await deleteMeeting(toTarget(node), id);
			},
			meetingsRename: ({ id, title }) =>
				renameMeeting(
					toTarget(node),
					id,
					title
				) as unknown as Promise<MeetingRecord>,
			meetingsSetIcon: async ({ id, icon }) => {
				const updated = await setMeetingIcon(toTarget(node), id, icon);
				const glyph = asGlyphValue(icon) ?? null;
				updateTabsIconWhere(
					(t) =>
						t.path === `/meetings/${id}` ||
						t.path.startsWith(`/meetings/${id}?`),
					glyph
				);
				return updated as unknown as MeetingRecord;
			},
			meetingsImport: async () => {
				const file = await pickAudioFile();
				if (!file) {
					return null;
				}
				return importMeeting(toTarget(node), file, {
					title: file.name,
				}) as unknown as MeetingRecord;
			},
			meetingsOpen: ({ id, title }) =>
				openTab(`/meetings/${id}`, { title: title ?? "Meeting" }),
			meetingsOpenNotes: ({ spaceId, docId, title }) =>
				openTab(`/spaces/${spaceId}/doc/${docId}`, {
					title: title ?? "Notes",
				}),
			meetingsOpenList: () => openTab("/meetings", { title: "Meetings" }),
			// Outpost — the @ryu/social companion renders the compose → calendar → queue
			// → inbox surface. Host-direct (the monitors pattern), but through ONE
			// forwarder rather than a verb per endpoint: the companion's ~35 client calls
			// all arrive as `socialRequest`, which re-issues them against Core's
			// `/api/social` public mount with the node bearer attached (social:crud).
			//
			// SECURITY: `socialRequest` in `lib/api/social.ts` owns the check, and it is
			// the reason a generic forwarder is safe here — the frame supplies only a
			// SUB-PATH, which must start with `/`, must not be protocol-relative, must
			// carry no backslash, and must contain no `..` segment. The URL is then built
			// from the fixed `/api/social` base, so the frame can never choose a host, an
			// absolute URL, or another Core API. `rpc.ts`'s `asSocialRequestArg` applies
			// the identical rules one layer earlier; the duplication is deliberate, since
			// either layer alone would be the only thing standing between a sandboxed
			// frame and the node's credentials.
			//
			// `open`/`openList` are shell-navigation verbs. `/social` resolves through the
			// generic companion-alias route, and `/social/:id` through the pattern that
			// bakes the post id into the frame as `window.ryu.context.postId`.
			socialRequest: (input) => socialRequest(toTarget(node), input),

			// Subtitles — the @ryu/subtitles companion picks a video, queues a local
			// transcription + translation job, and reads the cue list back. Same ONE-verb
			// shape as Outpost above: every call arrives as `subtitlesRequest`, which
			// re-issues it against Core's `/api/subtitles` public mount with the node bearer
			// attached (subtitles:crud).
			//
			// SECURITY: `subtitlesRequest` in `lib/api/subtitles.ts` owns the check — it
			// resolves the frame's sub-path with the SAME URL parser `fetch` will use and
			// asserts containment under the mount, then builds the URL from the fixed base,
			// so the frame can never choose a host or climb out onto another Core API. The
			// VIDEO never crosses this boundary at all: a job names a path and the sidecar
			// opens the file itself.
			//
			// No navigation verb: the companion is the whole surface, and `/subtitles` +
			// `/subtitles/:id` resolve through the generic companion-alias routes.
			subtitlesRequest: (input) => subtitlesRequest(toTarget(node), input),
			// Automated Reasoning — the @ryu/reasoning companion authors formal policies
			// and runs the solver playground. Same one-forwarder shape as Outpost, and
			// the same security note applies: `reasoningRequest` in `lib/api/reasoning.ts`
			// owns the path check (leading slash, not protocol-relative, no backslash,
			// resolving under `/api/reasoning` per the WHATWG parser rather than a literal
			// `..` blocklist), and `rpc.ts`'s `asReasoningRequestArg` applies the identical
			// rules one layer earlier. There is no `open` verb because the companion is the
			// whole surface — it never navigates the shell.
			reasoningRequest: (input) => reasoningRequest(toTarget(node), input),
			safeActionsRequest: (input) => safeActionsRequest(toTarget(node), input),
			// Deep Read — the @ryu/rlm companion loads a corpus, browses its outline,
			// asks questions of it and reads run traces. Same one-forwarder shape as
			// Reasoning, and the same security note applies: `rlmRequest` in
			// `lib/api/rlm.ts` owns the path check (leading slash, not protocol-relative,
			// no backslash, resolving under `/api/rlm` per the WHATWG parser rather than a
			// literal `..` blocklist), and `rpc.ts`'s `asRlmRequestArg` applies the
			// identical rules one layer earlier. No `open` verb: the companion is the whole
			// surface.
			rlmRequest: (input) => rlmRequest(toTarget(node), input),
			// Tuition and Wire: the same one-forwarder shape, and the same security note
			// — each `*Request` re-validates the frame-chosen sub-path against its own
			// mount before building a URL, independently of the check `@ryu/app-host/rpc`
			// already ran. Two layers on purpose: either alone would be the only thing
			// between a sandboxed frame and the node's credentials.
			tuitionRequest: (input) => tuitionRequest(toTarget(node), input),
			newsRequest: (input) => newsRequest(toTarget(node), input),
			// Blueprint — the @ryu/blueprint companion renders a plan an agent published
			// and records the reviewer's annotations and verdict. Same one-forwarder shape
			// again, and the same security note, with one twist worth spelling out: the
			// path segments the frame concatenates are PLAN IDS an agent chose, so the
			// untrusted string reaching `resolveBlueprintPath` in `lib/api/blueprint.ts`
			// has not passed a human. That check (leading slash, not protocol-relative, no
			// backslash, resolving under `/api/blueprint` per the WHATWG parser rather than
			// a literal `..` blocklist) and `rpc.ts`'s `asBlueprintRequestArg` one layer
			// earlier are both load-bearing. No `open` verb: the review surface is the
			// companion, so it never navigates the shell.
			blueprintRequest: (input) => blueprintRequest(toTarget(node), input),
			// Generic companion → OWN sidecar forwarder. The plugin id is host-owned;
			// the frame can choose only the relative path/method/body.
			appRequest: (input) =>
				ownAppRequest(toTarget(node), companion.pluginId, input),
			// Generic application-room realtime. The node target, node bearer and
			// user JWT remain in this trusted host; only the opaque join result crosses
			// the RPC boundary into the null-origin companion.
			realtimeConnect: async ({ room_id }) => {
				const connectionId = crypto.randomUUID();
				const queue = new ApplicationRealtimeQueue();
				let connection: RealtimeConnection;
				let resolveJoin: (ack: {
					access: "read" | "write";
					memberId: string;
					presence: unknown[];
					roomId: string;
				}) => void;
				let rejectJoin: (error: Error) => void;
				const join = new Promise<{
					access: "read" | "write";
					memberId: string;
					presence: unknown[];
					roomId: string;
				}>((resolve, reject) => {
					resolveJoin = resolve;
					rejectJoin = reject;
				});
				const timeout = window.setTimeout(() => {
					rejectJoin(new Error("realtime join timed out"));
				}, 15_000);
				const jwt = await getRealtimeJwt();
				const closeOnOverflow = () => {
					connection.close();
					realtimeSessionsRef.current.delete(connectionId);
				};
				connection = new RealtimeConnection(toTarget(node), {
					appId: companion.pluginId,
					handlers: {
						onClose: (event) => {
							queue.close({
								code: event.code,
								reason: event.reason,
								type: "close",
							});
							queue.end();
							rejectJoin(
								new Error(`realtime closed: ${event.reason || event.code}`)
							);
							realtimeSessionsRef.current.delete(connectionId);
						},
						onJoinAck: (ack) => resolveJoin(ack),
						onNamedEvent: ({ name, data }) => {
							if (!queue.push({ data, name, type: "event" })) {
								closeOnOverflow();
							}
						},
						onPresence: (data) => {
							if (!queue.push({ data, type: "presence" })) {
								closeOnOverflow();
							}
						},
						onResyncRequired: ({ dropped, reason }) => {
							if (!queue.push({ dropped, reason, type: "resync_required" })) {
								closeOnOverflow();
							}
						},
					},
					jwt,
					kind: "application",
					roomId: room_id,
				});
				realtimeSessionsRef.current.set(connectionId, { connection, queue });
				connection.connect();
				try {
					const ack = await join;
					window.clearTimeout(timeout);
					return {
						access: ack.access,
						connection_id: connectionId,
						member_id: ack.memberId,
						presence: ack.presence,
						room_id: ack.roomId,
					};
				} catch (error) {
					window.clearTimeout(timeout);
					connection.close();
					queue.end();
					realtimeSessionsRef.current.delete(connectionId);
					throw error;
				}
			},
			realtimePublish: async ({ connection_id, event, data }) => {
				const session = realtimeSessionsRef.current.get(connection_id);
				if (!session) {
					throw new Error("realtime connection is not available");
				}
				session.connection.sendEvent(event, data);
			},
			realtimePresence: async ({ connection_id, data }) => {
				const session = realtimeSessionsRef.current.get(connection_id);
				if (!session) {
					throw new Error("realtime connection is not available");
				}
				session.connection.publishPresence(data);
			},
			realtimeSubscribe: async (input, emit, signal) => {
				const session = realtimeSessionsRef.current.get(input.connection_id);
				if (!session) {
					throw new Error("realtime connection is not available");
				}
				while (!signal.aborted) {
					const push = await session.queue.take(signal);
					if (push === null) {
						return;
					}
					emit(JSON.stringify(push));
				}
			},
			realtimeClose: async ({ connection_id }) => {
				const session = realtimeSessionsRef.current.get(connection_id);
				if (!session) {
					return;
				}
				session.connection.close();
				session.queue.end();
				realtimeSessionsRef.current.delete(connection_id);
			},
			socialOpen: ({ postId, title }) =>
				openTab(postId ? `/social/${postId}` : "/social", {
					title: title ?? "Outpost",
				}),
			socialOpenList: () => openTab("/social", { title: "Outpost" }),
			// Skill authoring — the @ryu/skill-editor companion authors a user-owned
			// Agent Skill (SKILL.md). Host-direct (the monitors pattern): the host holds the
			// node token and calls the existing `skills.ts` authoring client (createSkill/
			// updateSkill/getSkillSource/version history), which normalizes Core's snake_case
			// to camelCase, forwarding those shapes verbatim over the bridge (skills:crud).
			// The extracted `SkillEditorPage` used these same clients. `skillsSetTitle` is a
			// shell-navigation verb: it renames the companion's own tab (the desktop page's
			// `updateTabTitle(currentTabId, …)`).
			skillsGetSource: ({ id }) =>
				getSkillSource(toTarget(node), id) as unknown as Promise<
					Record<string, unknown>
				>,
			skillsCreate: (input) =>
				createSkill(toTarget(node), {
					name: input.name,
					body: input.body,
					description: input.description ?? null,
					allowedTools: input.allowedTools ?? [],
					alwaysOn: input.alwaysOn ?? false,
				}) as unknown as Promise<Record<string, unknown>>,
			skillsUpdate: ({ id, name, body, description, allowedTools, alwaysOn }) =>
				updateSkill(toTarget(node), id, {
					name,
					body,
					description: description ?? null,
					allowedTools: allowedTools ?? [],
					alwaysOn: alwaysOn ?? false,
				}) as unknown as Promise<Record<string, unknown>>,
			skillsListVersions: ({ id }) =>
				listSkillVersions(toTarget(node), id) as unknown as Promise<
					Record<string, unknown>[]
				>,
			skillsVersionSource: ({ id, versionId }) =>
				getSkillVersionSource(toTarget(node), id, versionId),
			skillsSnapshot: async ({ id, label }) => {
				await snapshotSkill(toTarget(node), id, label);
			},
			skillsRestore: async ({ id, versionId }) => {
				await restoreSkillVersion(toTarget(node), id, versionId);
			},
			skillsDistribute: async ({ id }) => {
				await distributeInstalledSkill(id);
			},
			skillsSetTitle: ({ title }) => {
				if (currentTabId) {
					updateTabTitle(currentTabId, title);
				}
			},
			// --- Shell primitives (grant shell:integrate). The generic shell-integration
			// lane. The host owns every seam (tabs / theme / palette / event stream), so
			// none of these reach Core — they resolve entirely in the trusted webview
			// (like the per-app nav verbs above). `shellOpenTab` re-applies the route
			// ALLOWLIST on top of the grant (a granted companion can still only open a
			// safe first-party destination). The three subscribe/register verbs are
			// streaming: each attaches its listener and releases it when `signal` aborts
			// (frame unmount / dispose), so no subscription outlives the frame. ---
			shellOpenTab: ({
				path,
				title,
				conversationId,
				forceNew,
				initialPrompt,
				icon,
			}) => {
				const ownPath = `/plugin/${encodeURIComponent(companion.pluginId)}`;
				if (!isShellSafeRoute(path, ownPath)) {
					throw new Error(
						`shell.openTab: '${path}' is not an allowed shell destination`
					);
				}
				openTab(path, {
					title,
					conversationId,
					forceNew,
					initialPrompt,
					icon: asGlyphValue(icon),
				});
				return Promise.resolve();
			},
			shellThemeSubscribe: (_input, emit, signal) =>
				new Promise<void>((resolve) => {
					const push = () => {
						try {
							emit(JSON.stringify(readHostThemeTokens()));
						} catch {
							// A serialize/post failure is non-fatal — the next change re-emits.
						}
					};
					push(); // emit the current tokens immediately on subscribe
					const observer = new MutationObserver(push);
					observer.observe(document.documentElement, {
						attributes: true,
						attributeFilter: ["class", "style", "data-theme"],
					});
					const done = () => {
						observer.disconnect();
						resolve();
					};
					if (signal.aborted) {
						done();
					} else {
						signal.addEventListener("abort", done, { once: true });
					}
				}),
			// The host's display preferences. One field today — `friendly`, the
			// app-wide "Friendly names" toggle — emitted now and on every change, so a
			// companion's own copy can follow the shell's vocabulary instead of being
			// the one panel still saying "Graph" while the app around it says
			// "Connected search". `subscribeFriendlyMode` calls back immediately, which
			// is what gives the frame the current value on subscribe (the same contract
			// `shellThemeSubscribe` above keeps with its initial `push()`).
			shellPrefsSubscribe: (_input, emit, signal) =>
				new Promise<void>((resolve) => {
					const dispose = subscribeFriendlyMode((friendly) => {
						try {
							emit(JSON.stringify({ friendly }));
						} catch {
							// A serialize/post failure is non-fatal — the next change re-emits.
						}
					});
					const done = () => {
						dispose();
						resolve();
					};
					if (signal.aborted) {
						done();
					} else {
						signal.addEventListener("abort", done, { once: true });
					}
				}),
			shellRegisterCommand: (input, emit, signal) =>
				new Promise<void>((resolve) => {
					const raw = Array.isArray((input as { commands?: unknown }).commands)
						? ((input as { commands: unknown[] }).commands as Record<
								string,
								unknown
							>[])
						: [];
					const disposers: (() => void)[] = [];
					for (const c of raw) {
						if (!c || typeof c.id !== "string" || typeof c.title !== "string") {
							continue;
						}
						const commandId = c.id;
						const entry: CommandEntry = {
							// Namespace the palette id so a companion can neither collide with
							// nor impersonate a built-in / another plugin's command.
							id: `plugin:${companion.pluginId}:${commandId}`,
							title: c.title,
							group:
								typeof c.group === "string"
									? c.group
									: companion.label || companion.name,
							keywords: typeof c.keywords === "string" ? c.keywords : undefined,
							// Invocation is pushed back to the frame (which owns the handler);
							// emit the ORIGINAL id the frame registered.
							run: () => {
								try {
									emit(JSON.stringify(commandId));
								} catch {
									// non-fatal
								}
							},
						};
						disposers.push(contributionRegistry.registerCommand(entry));
					}
					const done = () => {
						for (const dispose of disposers) {
							dispose();
						}
						resolve();
					};
					if (signal.aborted) {
						done();
					} else {
						signal.addEventListener("abort", done, { once: true });
					}
				}),
			shellRegisterTabIcon: (input, _emit, signal) =>
				new Promise<void>((resolve) => {
					const raw = Array.isArray((input as { icons?: unknown }).icons)
						? ((input as { icons: unknown[] }).icons as Record<
								string,
								unknown
							>[])
						: [];
					const disposers: (() => void)[] = [];
					for (const [i, entry] of raw.entries()) {
						if (
							!entry ||
							typeof entry.pathPrefix !== "string" ||
							entry.pathPrefix.length === 0 ||
							typeof entry.icon !== "string" ||
							entry.icon.length === 0
						) {
							continue;
						}
						disposers.push(
							registerTabIcon({
								id: `plugin:${companion.pluginId}:tab-icon:${i}:${entry.pathPrefix}`,
								pathPrefix: entry.pathPrefix,
								pathIncludes:
									typeof entry.pathIncludes === "string"
										? entry.pathIncludes
										: undefined,
								icon: entry.icon,
								priority:
									typeof entry.priority === "number" ? entry.priority : 30,
							})
						);
					}
					const done = () => {
						for (const dispose of disposers) {
							dispose();
						}
						resolve();
					};
					if (signal.aborted) {
						done();
					} else {
						signal.addEventListener("abort", done, { once: true });
					}
				}),
			shellEventsSubscribe: (input, emit, signal) =>
				new Promise<void>((resolve) => {
					const requested = Array.isArray(
						(input as { channels?: unknown }).channels
					)
						? ((input as { channels: unknown[] }).channels as unknown[])
						: [];
					const allowed = SHELL_EVENT_CHANNELS.filter((ch) =>
						requested.includes(ch)
					);
					const disposers = allowed.map((ch) =>
						subscribeChannel(toTarget(node), ch, (data) => {
							try {
								emit(JSON.stringify({ channel: ch, data }));
							} catch {
								// non-fatal
							}
						})
					);
					const done = () => {
						for (const dispose of disposers) {
							dispose();
						}
						resolve();
					};
					if (signal.aborted) {
						done();
					} else {
						signal.addEventListener("abort", done, { once: true });
					}
				}),
		}),
		[
			node,
			distributeInstalledSkill,
			companion.id,
			companion.name,
			companion.pluginId,
			assistantOwner,
			openGateway,
			openTab,
			updateTabTitle,
			updateTabsIconWhere,
			currentTabId,
			meId,
			getActiveNode,
			i18n,
			toastHost,
		]
	);

	const srcdoc = useMemo(() => {
		if (!code) {
			return null;
		}
		// Path B (ui_format:"html"): a full self-contained HTML bundle (a heavy app
		// like the whiteboard, built via vite-plugin-singlefile) is mounted directly
		// as srcdoc with the window.ryu bridge injected inline — no new Function eval.
		// Content-sniff the fetched bundle so the panel needs no extra plumbing: a
		// `ui_format:"html"` companion's ui_code always starts with a doctype/<html>,
		// while a Path A ESM module never does.
		if (/^\s*<(?:!doctype|html)\b/i.test(code)) {
			return htmlCompanionSrcdoc(
				nonce,
				code,
				companion.id,
				mountContext,
				companion.csp,
				initialThemeTokens
			);
		}
		return thirdPartyPluginSrcdoc(
			nonce,
			toBase64Utf8(code),
			companion.id,
			mountContext
		);
	}, [code, nonce, companion.id, mountContext, initialThemeTokens]);

	const panelTitle = companion.label || companion.name;

	// The bundle fetch failed (`retry: false`, so this is terminal). Distinct from
	// "no bundle": saying "does not provide a runnable UI" for a failed fetch is a
	// lie about the app, and it hides the one thing that would fix it — retrying.
	if (isError) {
		return (
			<PanelPlaceholder
				description="The app's interface could not be fetched from this node. It may still be starting up."
				onRetry={retry}
				retryDisabledFor={cooldownSeconds}
				title={`Couldn't load ${panelTitle}`}
			/>
		);
	}

	if (isPending) {
		return (
			<PanelPlaceholder
				busy
				description="Fetching the app's interface from this node."
				title={`Loading ${panelTitle}…`}
			/>
		);
	}

	if (!srcdoc) {
		return (
			<PanelPlaceholder
				description="This app has no interface of its own — it works through the rest of Ryu."
				title={`${panelTitle} has nothing to show here`}
			/>
		);
	}

	return (
		// `data-plugin-*` rather than a header strip. The strip that used to sit here
		// spent a whole row of every app's height restating what the tab already
		// says (which plugin this is) plus a status that is only ever "connected" by
		// the time you can read it — the not-connected case is the opaque
		// PanelPlaceholder below, which covers the frame entirely. Attribution now
		// rides the tab; these attributes are what a tab-strip status dot reads.
		<div
			className="relative flex h-full flex-col overflow-hidden"
			data-plugin-id={companion.pluginId}
			data-plugin-state={connected ? "connected" : "starting"}
			data-plugin-title={panelTitle}
		>
			<div className="min-h-0 flex-1">
				<ExtensionHost
					granted={granted}
					nonce={nonce}
					onConnected={() => setConnected(true)}
					services={services}
					srcdoc={srcdoc}
					themeTokens={themeTokens}
					title={`Plugin: ${companion.name}`}
				/>
			</div>
			{/* The startup state, centered over the frame rather than a word in a
			    header: until the sandbox bridge connects the frame is blank anyway (a
			    Path-A bundle does not even evaluate before the port lands), so this IS
			    the panel's content, not a decoration on it. Opaque so the blank frame
			    behind it never flashes through. */}
			{connected ? null : (
				<div className="absolute inset-0 z-10 bg-background">
					<PanelPlaceholder
						busy={!stalled}
						description={
							stalled
								? "The sandboxed interface hasn't connected yet. Retry to reload it."
								: "Runs sandboxed, with only the permissions you approved."
						}
						onRetry={stalled ? retry : undefined}
						retryDisabledFor={cooldownSeconds}
						title={
							stalled
								? `${panelTitle} is taking a while`
								: `Starting ${panelTitle}…`
						}
					/>
				</div>
			)}
		</div>
	);
}

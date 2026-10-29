import {
	ryuCatalogModelsSchema,
	ryuCatalogSnapshotSchema,
	ryuProviderUsageReadingSchema,
	ryuSubscriptionsSchema,
} from "@ryu/app-host/app-bridge";
import {
	activityAuditResponseSchema,
	activityEvalResponseSchema,
	activityPruneResponseSchema,
	activityRecordSchema,
	activityRedteamResponseSchema,
	activityScoreResponseSchema,
	activityTraceImportRecordSchema,
	activityTraceResponseSchema,
	appBackupMethodSchema,
	appBackupResponseSchema,
	approvalRecordSchema,
	backgroundProcessSchema,
	calendarAgentRecordSchema,
	calendarJobRecordSchema,
	calendarWorkflowRecordSchema,
	chatConversationSummarySchema,
	chatSendResultSchema,
	cryptoStatusSchema,
	learningConfigSchema,
	learningExperienceListSchema,
	learningHealingStatusSchema,
	mailInboxSchema,
	mailMessageSchema,
	meetingRecordSchema,
	meetingTranscriptSchema,
	notificationRecordSchema,
	proactiveSuggestionRecordSchema,
	questJudgeResultSchema,
	questRecordSchema,
	rpcJsonResponseSchema,
	skillSourceRecordSchema,
	skillVersionRecordsSchema,
	skillWriteRecordSchema,
	spaceDatabaseQueryResultSchema,
	spaceDocumentWriteResultSchema,
	timelineEventRecordSchema,
	timelineJournalRecordSchema,
	warmupDetectionSchema,
	workflowAgentsRecordsSchema,
	workflowAppsRecordsSchema,
	workflowComposioResponseSchema,
	workflowConnectBindingRecordSchema,
	workflowConnectBindingRecordsSchema,
	workflowHookEventsRecordsSchema,
	workflowMcpRecordSchema,
	workflowNotifyTargetsRecordsSchema,
	workflowSchedulesRecordsSchema,
	workflowSkillsRecordsSchema,
	workflowWebhookRecordSchema,
} from "@ryu/app-host/rpc";
import { z } from "zod";
import { createCompanionTranscribeAudio } from "./companion-voice-engine.ts";
import { sendCompanionMail } from "./mail-send-service.ts";
import { createCompanionMediaServices } from "./media-host-services.ts";
import {
	activityScoreInputSchema,
	backgroundStopResponseSchema,
	mailProviderInputSchema,
	meetingSourceInputSchema,
	notificationSendResponseSchema,
	parseCompanionCommands,
	parseCompanionEventChannels,
	parseCompanionTabIcons,
	questCaptureInputSchema,
	questKindInputSchema,
	questWriteInputSchema,
	spaceDatabaseResponseSchema,
	spaceDocumentResponseSchema,
	spaceDocumentSummarySchema,
} from "./node-response-contracts.ts";
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
import { checkAppBundle } from "@ryu/app-host/app-bundle";
import { appRequestService } from "@ryu/app-host/app-request-target";
import {
	COMPANION_THEME_MUTATION_ATTRIBUTES,
	readCompanionThemeTokens,
} from "@ryu/app-host/companion-theme";
import {
	APP_DOWNLOAD_GRANT,
	type ExtensionFrameMessage,
	ExtensionHost,
	shouldEnableCompanionFormEvents,
} from "@ryu/app-host/ExtensionHost";
import {
	finetuneServicesViaAppRequest,
	finetuneStreamPath,
} from "@ryu/app-host/finetune-compat";
import { useModelContextStore } from "@ryu/app-host/model-context";
import {
	assertOpenedFileUri,
	type OpenedFileAccess,
} from "@ryu/app-host/opened-file";
import { ghostRecipesViaAppMount } from "@ryu/app-host/recipes-compat";
import {
	type ActivityScoreInput,
	type Capability,
	capabilitiesFromGrants,
	createI18nHostServices,
	type HostPush,
	type HostServices,
	isShellSafeRoute,
	type UploadFileResult,
	validatePluginRoute,
} from "@ryu/app-host/rpc";
import {
	htmlCompanionSrcdoc,
	thirdPartyPluginSrcdoc,
} from "@ryu/app-host/third-party-plugin";
import {
	createScopedToastHost,
	createSileoToastRenderer,
} from "@ryu/app-host/toast-host";
import { voiceAudioDataUrl } from "@ryu/app-host/voice-services";
import { browserRecordingHost } from "@ryu/blocks/companion/browser-recording.ts";
import { useI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import { iconToUrl } from "@ryu/ui/components/icon.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { RealtimeConnection } from "@ryuhq/core-client/realtime.ts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getActiveUserId, useSession } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import {
	useCurrentTabId,
	useIsActiveTab,
	useTabSelector,
} from "@/src/contexts/TabsContext.tsx";
import { waitForApplicationRealtime } from "@/src/contributions/host/application-realtime-lifetime.ts";
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
import { useUserAvailability } from "@/src/hooks/useUserAvailability.ts";
import { listActivity } from "@/src/lib/api/activity.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import { ownAppRequest } from "@/src/lib/api/app-request.ts";
import {
	approveApproval,
	listApprovals,
	rejectApproval,
} from "@/src/lib/api/approvals.ts";
import { searchGifs, searchImages } from "@/src/lib/api/assets.ts";
import { blueprintRequest } from "@/src/lib/api/blueprint.ts";
import {
	listChatBroadcastConversations,
	sendChatBroadcastTurn,
} from "@/src/lib/api/chat-broadcast.ts";
import {
	type ApiTarget,
	realtimeJwtForTarget,
	toTarget,
} from "@/src/lib/api/client.ts";
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
import {
	fetchGatewayAudit,
	pruneGatewayAudit,
	runGatewayEvals,
	runGatewayRedTeam,
	scoreGatewayOutput,
} from "@/src/lib/api/gateway.ts";
import { getHealingStatus } from "@/src/lib/api/healing.ts";
import { getLearningConfig, listExperience } from "@/src/lib/api/learn.ts";
import {
	createInbox,
	deleteInbox,
	listInboxes,
	listMessages,
	mailRequest,
	rotateInboundSecret,
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
	redactConnectSuggestionNotifications,
	unarchiveNotification,
} from "@/src/lib/api/notifications.ts";
import {
	fetchApps,
	fetchPluginUiBundle,
	getPluginContributions,
	installCompanionAppBundle,
	ownAppEventStream,
	type PluginCompanion,
	pluginHostInvoke,
	pluginHostInvokeStream,
} from "@/src/lib/api/plugins.ts";
import { getVoiceInputPrefs } from "@/src/lib/api/preferences.ts";
import {
	createPromptSuite,
	importPromptTrace,
	listPromptSuites,
} from "@/src/lib/api/prompt-suites.ts";
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
	setScratchpad,
	updateQuest,
	useQuest,
} from "@/src/lib/api/quests.ts";
import { reasoningRequest } from "@/src/lib/api/reasoning.ts";
import {
	getRecordingStatus,
	startRecording,
	stopRecording,
} from "@/src/lib/api/recipes.ts";
import { rlmRequest } from "@/src/lib/api/rlm.ts";
import { fetchRunTrace } from "@/src/lib/api/runs.ts";
import { safeActionsRequest } from "@/src/lib/api/safe-actions.ts";
import { fetchJobs } from "@/src/lib/api/schedules.ts";
import {
	getJournal,
	getProactiveInbox,
	getShadowFrame,
	getSpeechHistory,
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
import {
	speakText as apiSpeakText,
	transcribeAudio as apiTranscribeAudio,
	transcribeAudioDetailed as apiTranscribeAudioDetailed,
	installTtsEngine as installTtsEngineApi,
	listTtsEngines,
} from "@/src/lib/api/voice.ts";
import {
	applyWarmupJobs,
	detectWarmupAgents,
	listWarmupJobs,
	runWarmupJobNow,
} from "@/src/lib/api/warmup.ts";
import {
	fetchWebhooks,
	readWebhookSecret,
	toWebhookIngressStatus,
	toWebhookRegistry,
	webhookIngressStatusWireSchema,
	webhookRegistryWireSchema,
	writeWebhookSecret,
} from "@/src/lib/api/webhooks.ts";
import {
	bindWorkflowConnectTrigger,
	fetchWorkflowConnectBindings,
	removeWorkflowConnectBinding,
} from "@/src/lib/api/workflow-connect.ts";
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
import {
	enrichTimelineJournal,
	sanitizeTimelineEvents,
} from "@/src/lib/timeline-app-icons.ts";
import { getUserAvailabilitySnapshot } from "@/src/lib/user-availability.ts";
import {
	type AssistantBuilderSession,
	type PageContextItem,
	useAssistantStore,
} from "@/src/store/useAssistantStore.ts";
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
 *  through the LOCAL Core's `/api/shadow` proxy (`getShadowFrame` — Shadow's own HTTP
 *  surface is bearer-gated and 403s browser requests; the `shadow.ts` INVARIANT
 *  still holds: never the per-tab node).
 *  Resolves to `null` when no keyframe exists near that moment (Shadow 404s), so the
 *  companion renders its "No frame recorded" placeholder — parity with the desktop
 *  page's `<img onError>` fallback. */
async function fetchFrameDataUrl(tsMicros: number): Promise<string | null> {
	try {
		const frame = await getShadowFrame(tsMicros);
		if (!frame) {
			return null;
		}
		return await blobToDataUrl(frame);
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
function readHostThemeTokens(): ReturnType<typeof readCompanionThemeTokens> {
	return readCompanionThemeTokens(undefined, {
		includeStoredPreferences: true,
	});
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
	onMessage,
	onRequestClose,
	fileAccess,
}: {
	companion: PluginCompanion;
	/** Optional host-supplied context baked into the frame as `window.ryu.context`
	 *  (e.g. `{ spaceId, docId }` when the app is opened as a Space document). */
	mountContext?: unknown;
	/** Optional messages emitted by this companion's sandboxed frame. */
	onMessage?: (data: ExtensionFrameMessage) => void;
	/** Supplied only by the host-owned dialog that contains this frame. */
	onRequestClose?: () => void;
	fileAccess?: OpenedFileAccess;
}) {
	const closeOnEscape = onRequestClose !== undefined;
	const node = useActiveNode();
	const getActiveNode = useActiveNodeGetter();
	useEffect(
		() => () => browserRecordingHost.release(companion.pluginId),
		[companion.pluginId]
	);
	const i18n = useI18n();
	const { distributeInstalledSkill } = useSkillDistributionFlow();
	const [connectedNonce, setConnectedNonce] = useState<string | null>(null);
	const realtimeLifetimeRef = useRef<AbortController | null>(null);
	const realtimeSessionsRef = useRef(
		new Map<string, ApplicationRealtimeSession>()
	);

	// The theme-token bridge (W7): seed the companion's first paint from the
	// desktop's resolved theme, then push subsequent changes into the already
	// mounted null-origin frame. Keeping the initial snapshot separate avoids
	// remounting a running app when the user changes appearance.
	const [initialThemeTokens] = useState(readHostThemeTokens);
	const [themeTokens, setThemeTokens] = useState(initialThemeTokens);
	useEffect(() => {
		if (globalThis.MutationObserver === undefined) {
			return;
		}
		const observer = new MutationObserver(() => {
			setThemeTokens(readHostThemeTokens());
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: [...COMPANION_THEME_MUTATION_ATTRIBUTES],
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
	const openTab = useTabSelector((state) => state.openTab);
	const updateTabTitle = useTabSelector((state) => state.updateTabTitle);
	const updateTabsIconWhere = useTabSelector(
		(state) => state.updateTabsIconWhere
	);
	// The current tab id — the `@ryu/skill-editor` companion's `skills.setTitle` verb
	// renames its own owning tab (the desktop page's `updateTabTitle(currentTabId, …)`).
	const currentTabId = useCurrentTabId();
	// The signed-in user id, resolved HOST-SIDE for the `@ryu/approvals` companion's
	// Notifications section: the per-user feed is scoped by user id, but the sandboxed
	// frame has no Better Auth session, so the host reads it (the session query, falling
	// back to the local account vault) exactly as the deleted `useNotifications` hook did.
	const { streamingPrivacyActive } = useUserAvailability();
	const { data: session } = useSession();
	const meId = session?.user?.id ?? getActiveUserId() ?? null;
	const target = useMemo(
		() => toTarget(node),
		[node.url, node.token, node.userJwt]
	);

	// Fetch the plugin's bundled code over the trusted API. `null` (no bundle /
	// not enabled) or an error means we render the benign fallback, never code.
	const bundleQueryOptions = useMemo(
		() => ({
			queryKey: [
				"plugin-ui-bundle",
				target.url,
				target.token,
				target.userJwt,
				companion.pluginId,
			],
			// Fetch by the OWNING plugin id (the store key), not the companion id.
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				fetchPluginUiBundle(target, companion.pluginId, signal),
			retry: false,
			staleTime: 60_000,
		}),
		[companion.pluginId, target]
	);
	const {
		data: code,
		isPending,
		isError,
		refetch,
	} = useQuery(bundleQueryOptions);

	// Retry generation. Bumping it mints a fresh nonce → a fresh `srcdoc` → the
	// iframe genuinely reloads (a re-render alone would not: React leaves an
	// unchanged `srcDoc` attribute alone, so the dead document would just sit
	// there). The nonce is also the ExtensionHost effect's key, so the bridge
	// listener is rebuilt in step with the document it is waiting on.
	const [attempt, setAttempt] = useState(0);
	const grantsKey = [...new Set(companion.approvedGrants)].sort().join(" ");
	// The approved grants as a content-stable list (same set ⇒ same array), for
	// host services that check a specific grant (the cross-app `app.request`).
	const approvedGrantList = useMemo(
		() => (grantsKey ? grantsKey.split(" ") : []),
		[grantsKey]
	);
	const documentScope = JSON.stringify([
		node.url,
		node.token,
		node.userJwt,
		companion.id,
		mountContext ?? null,
		companion.csp ?? null,
		companion.defaultCspEnforced,
	]);
	// One nonce per document and authorization scope. Cosmetic renders keep it stable.
	// code and serialized scope deliberately reset the document handshake.
	const nonce = useMemo(
		() =>
			globalThis.crypto?.randomUUID === undefined
				? `nonce-${attempt}-${Date.now()}-${Math.round(Math.random() * 1e9)}`
				: crypto.randomUUID(),
		[attempt, grantsKey, code, documentScope]
	);
	const connected = connectedNonce === nonce;
	// document replacement owns realtime connection cleanup.
	useEffect(() => {
		const lifetime = new AbortController();
		realtimeLifetimeRef.current = lifetime;
		return () => {
			lifetime.abort();
			for (const session of realtimeSessionsRef.current.values()) {
				session.connection.close();
				session.queue.end();
			}
			realtimeSessionsRef.current.clear();
		};
	}, [nonce]);

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
	}, [connected, nonce]);

	// Retry cooldown, ticked only while it runs (an idle panel must not re-render
	// once a second forever). Armed on press, not on success: the press is what
	// costs a reload, whether or not the reload then works.
	const [cooldownUntil, setCooldownUntil] = useState(0);
	const [now, setNow] = useState(() => Date.now());
	const cooldownLeftMs = Math.max(0, cooldownUntil - now);
	const cooldownSeconds = Math.ceil(cooldownLeftMs / 1000);
	const mediaPermission =
		companion.pluginId === "@ryu/voice"
			? "voice.studio.generate"
			: companion.pluginId === "@ryu/canvas" ||
					companion.pluginId === "@ryu/slides"
				? `${companion.pluginId.slice("@ryu/".length)}.generate`
				: undefined;
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
		setConnectedNonce(null);
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
	// grantsKey is the content hash of approvedGrants.
	const granted = useMemo<ReadonlySet<Capability>>(() => {
		const capabilities = new Set(
			capabilitiesFromGrants(companion.approvedGrants)
		);
		if (fileAccess) {
			capabilities.add("file.access");
		}
		return capabilities;
	}, [grantsKey, fileAccess]);
	const filePushRef = useRef<((message: HostPush) => void) | null>(null);
	useEffect(() => {
		if (!fileAccess || connectedNonce !== nonce) {
			return;
		}
		let stopped = false;
		let revision: string | undefined;
		let inFlight = false;
		const refresh = async () => {
			if (stopped || inFlight) {
				return;
			}
			inFlight = true;
			try {
				const snapshot = await fileAccess.read();
				if (!stopped && snapshot.revision !== revision) {
					revision = snapshot.revision;
					filePushRef.current?.({
						kind: "ryu-widget-set-globals",
						globals: {
							openedFile: {
								uri: fileAccess.uri,
								name: fileAccess.name,
								editable: fileAccess.editable,
								revision,
							},
						},
					});
				}
			} catch {
				// The reader surfaces errors on its next scoped read; polling never fabricates content.
			} finally {
				inFlight = false;
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 1000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [fileAccess, connectedNonce, nonce]);

	// This app's assistant-context slice + takeover token. Scoped to the plugin id
	// so two companions of the same app share one slice (they are one app to the
	// user) while different apps stay isolated.
	const assistantOwner = `plugin:${companion.pluginId}:${companion.id}:${nonce}`;
	const modelContext = useModelContextStore(
		(store) => store.entries[assistantOwner]?.state ?? null
	);
	useEffect(() => {
		filePushRef.current?.({
			kind: "ryu-widget-set-globals",
			globals: { modelContext },
		});
	}, [modelContext]);
	const toastHost = useMemo(
		() =>
			createScopedToastHost({
				renderer: PLUGIN_TOAST_RENDERER,
				sourceId: `${companion.pluginId}:${companion.id}`,
			}),
		[companion.id, companion.pluginId]
	);

	useEffect(() => () => toastHost.dispose(), [toastHost]);

	// What this app last asked the assistant to hold. The store only carries it
	// while this panel's tab is focused: inactive tabs stay mounted (hidden), and
	// a background app must not keep its context or takeover on whatever page the
	// user is now looking at. Focus returning re-applies the app's last state.
	const isActiveTab = useIsActiveTab();
	const isActiveTabRef = useRef(isActiveTab);
	isActiveTabRef.current = isActiveTab;
	const assistantContextRef = useRef<PageContextItem[]>([]);
	const assistantSurfaceRef = useRef<AssistantBuilderSession | null>(null);
	// A new frame document (retry/reload changes the nonce, and so the owner) has
	// published nothing yet: forget the previous document's context and surface
	// so they are never replayed under the new owner. Declared before the focus
	// effect below so it runs first.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset at the owner boundary
	useEffect(() => {
		assistantContextRef.current = [];
		assistantSurfaceRef.current = null;
	}, [assistantOwner]);
	useEffect(() => {
		const assistant = useAssistantStore.getState();
		if (!isActiveTab) {
			assistant.clearContextOwner(assistantOwner);
			assistant.clearBuilder(assistantOwner);
			return;
		}
		if (assistantContextRef.current.length > 0) {
			assistant.publishContext(assistantOwner, assistantContextRef.current);
		}
		if (assistantSurfaceRef.current) {
			assistant.registerBuilder(assistantSurfaceRef.current);
		}
	}, [isActiveTab, assistantOwner]);

	// A closed page is not "what the user is looking at". Drop this app's slice and
	// its takeover when the panel unmounts — an app that crashed or was navigated
	// away from must not keep steering the assistant.
	useEffect(() => {
		return () => {
			const assistant = useAssistantStore.getState();
			useModelContextStore.getState().clear(assistantOwner);
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
			requestClose: onRequestClose ? async () => onRequestClose() : undefined,
			getGlobals: async () => ({
				modelContext: useModelContextStore
					.getState()
					.get("assistant", assistantOwner),
				locale: i18n.locale,
			}),
			getModelContext: () =>
				useModelContextStore.getState().get("assistant", assistantOwner),
			updateModelContext: async (input) => {
				const state = useModelContextStore
					.getState()
					.update("assistant", assistantOwner, input);
				return state;
			},
			readOpenedFile: fileAccess
				? async ({ uri }) => await assertOpenedFileUri(fileAccess, uri).read()
				: undefined,
			writeOpenedFile: fileAccess?.editable
				? async (input) => {
						const access = assertOpenedFileUri(fileAccess, input.uri);
						if (input.text !== undefined && access.write) {
							return await access.write(input.text, input.expectedRevision);
						}
						if (input.blob !== undefined && access.writeBlob) {
							return await access.writeBlob(input.blob, input.expectedRevision);
						}
						throw new Error("This file representation is read-only");
					}
				: undefined,
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
				// `source` is stamped HERE, by the shell, from the companion's real
				// name — never taken from the app's own payload, which could claim
				// to be anything.
				// Ids are namespaced by this app's owner key, so an app cannot collide
				// with (or remove) another publisher's chip, or mimic the shell's own
				// `tab:` chip, by choosing its ids.
				assistantContextRef.current = items.map((i) => ({
					...i,
					id: `${assistantOwner}:${i.id}`,
					source: companion.name,
				}));
				if (isActiveTabRef.current) {
					useAssistantStore
						.getState()
						.publishContext(assistantOwner, assistantContextRef.current);
				}
			},
			assistantClearContext: async () => {
				assistantContextRef.current = [];
				useAssistantStore.getState().clearContextOwner(assistantOwner);
			},
			assistantRegisterSurface: async (surface) => {
				assistantSurfaceRef.current = {
					conversationId: assistantOwner,
					// An app-defined kind, so `buildBuilderPreamble` uses the surface's
					// own `preamble` instead of a built-in builder's instructions.
					kind: `plugin:${companion.pluginId}`,
					label: surface.label,
					description: surface.description,
					preamble: surface.preamble,
					prompts: surface.prompts,
					thread: surface.thread,
					tools: surface.tools,
					// Registering must not pop the panel open — see the store's `dock` doc.
					dock: false,
					snapshot: "",
					targetId: companion.id,
					targetName: surface.label,
					resolveId: () => Promise.resolve(companion.id),
					onChanged: () => undefined,
				};
				if (isActiveTabRef.current) {
					useAssistantStore
						.getState()
						.registerBuilder(assistantSurfaceRef.current);
				}
			},
			assistantClearSurface: async () => {
				assistantSurfaceRef.current = null;
				useAssistantStore.getState().clearBuilder(assistantOwner);
			},
			assistantOpen: async ({ mode, prompt }) => {
				// Only the focused app may open (or ask) the assistant; a background
				// tab's late call would otherwise pop it over another page and spend a
				// turn under that page's context.
				if (!isActiveTabRef.current) {
					throw new Error(
						"assistant.open is only available while the app is focused"
					);
				}
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
			catalogSnapshot: () =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"catalog.snapshot",
					{}
				).then(ryuCatalogSnapshotSchema.parse),
			catalogModels: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"catalog.models",
					input
				).then(ryuCatalogModelsSchema.parse),
			// Subscription accounts (subscriptions:read) — Core-bridge verbs; Core
			// also requires a verified node owner/admin caller.
			subscriptionsList: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"subscriptions.list",
					input
				).then(ryuSubscriptionsSchema.parse),
			subscriptionsUsage: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"subscriptions.usage",
					input
				).then(ryuProviderUsageReadingSchema.parse),
			chatListConversations: () =>
				listChatBroadcastConversations(toTarget(node)).then(
					z.array(chatConversationSummarySchema).parse
				),
			chatSend: (input) =>
				sendChatBroadcastTurn(toTarget(node), input).then(
					chatSendResultSchema.parse
				),
			runAgent: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"agent.run",
					input
				).then(z.string().parse),
			backgroundList: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"background.list",
					input
				).then(z.array(backgroundProcessSchema).parse),
			backgroundStop: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"background.stop",
					input
				).then(backgroundStopResponseSchema.parse),
			backupsRequest: (method, input) => {
				const backupMethod = appBackupMethodSchema.parse(method);
				return pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					backupMethod,
					input
				).then(appBackupResponseSchema(backupMethod).parse);
			},
			storageGet: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"storage.get",
					input
				).then(z.string().nullable().parse),
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
				).then(z.array(z.string()).parse),
			// Sealing: the app hands over plaintext and gets back an opaque envelope.
			// The key is derived per app inside Core and never crosses to the frame,
			// so these are host round-trips rather than a local crypto helper.
			cryptoSeal: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"crypto.seal",
					input
				).then(z.string().parse),
			cryptoOpen: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"crypto.open",
					input
				).then(z.string().parse),
			cryptoStatus: () =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"crypto.status",
					{}
				).then(cryptoStatusSchema.parse),
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
				).then(z.string().parse),
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
				).then(z.string().parse),
			spacesGetDoc: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.getDoc",
					input
				).then(spaceDocumentResponseSchema.parse),
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
				).then(z.array(spaceDocumentSummarySchema).parse),
			spacesDeleteDoc: async (input) => {
				await pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.deleteDoc",
					input
				);
			},
			spacesCreateDatabase: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.createDatabase",
					input
				).then(z.string().parse),
			spacesListDatabases: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.listDatabases",
					input
				).then(z.array(spaceDocumentSummarySchema).parse),
			spacesGetDatabase: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.getDatabase",
					input
				).then(spaceDatabaseResponseSchema.parse),
			spacesUpdateDatabase: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.updateDatabase",
					input
				).then(spaceDocumentWriteResultSchema.parse),
			spacesQueryDatabase: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.queryDatabase",
					input
				).then(spaceDatabaseQueryResultSchema.parse),
			spacesDeleteDatabase: async (input) => {
				await pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"spaces.deleteDatabase",
					input
				);
			},
			// Media services — host-direct governed fetches (same pattern as
			// listAgents: the host holds the node token and calls the Gateway-governed
			// Core media endpoints). Every result is normalized to a `data:` URL so the
			// CSP-locked frame (img/media-src data: blob: only) can render it.
			// Image, video and audio generation plus `model.complete` (with vision
			// images) forward every validated field to Core unchanged; see
			// media-host-services.ts.
			...createCompanionMediaServices({
				appId: mediaPermission ? companion.pluginId : undefined,
				appPermission: mediaPermission,
				inline: inlineToDataUrl,
				pluginId: companion.pluginId,
				target: toTarget(node),
			}),
			ttsSpeak: async (input) => {
				const blob = await apiSpeakText(toTarget(node), input.text, {
					appId: mediaPermission ? companion.pluginId : undefined,
					appPermission: mediaPermission,
					engine: input.engine,
					voice: input.voice,
					speed: input.speed,
					language: input.language,
					requestId: input.request_id,
					referenceAudioDataUrl: input.reference_audio_data_url,
					seed: input.seed,
					instruct: input.instruct,
					referenceText: input.reference_text,
					effects: input.effects,
					normalize: input.normalize,
					format: input.format,
				});
				// The shared encoder keeps the served MIME and the bridge byte cap.
				return await voiceAudioDataUrl(blob);
			},
			// Same engine as first-party voice input: the user's Voice Recognition
			// choice (its default when unset), or Core's default only when the
			// preference cannot be read. Only `data:` URLs are accepted. A
			// companion-supplied `language` hint is forwarded to Core unchanged.
			transcribeAudio: (input) => {
				const target = toTarget(node);
				return createCompanionTranscribeAudio({
					readPrefs: () => getVoiceInputPrefs(target),
					transcribe: (blob, filename, engine) =>
						apiTranscribeAudio(target, blob, filename, engine, input.language),
					transcribeDetailed: (blob, filename, engine) =>
						apiTranscribeAudioDetailed(
							target,
							blob,
							filename,
							engine,
							input.language
						),
				})(input);
			},
			mediaRecording: (input) =>
				browserRecordingHost.call(companion.pluginId, input),
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
			installTtsEngine: (input) =>
				installTtsEngineApi(toTarget(node), input.engine, {
					appId: companion.pluginId,
					appPermission: "voice.models.manage",
				}),
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
			// Image catalogs use the same host-owned egress boundary as GIFs. The
			// Core response carries provider attribution and rights metadata; only
			// the media bytes are transformed into CSP-safe data URLs here.
			searchImages: async ({ provider, query }) => {
				const resp = await searchImages(toTarget(node), provider, query);
				const results = await Promise.all(
					resp.results.map(async (image) => ({
						id: image.id,
						title: image.title,
						preview: await inlineToDataUrl(image.preview_url),
						url: await inlineToDataUrl(image.url),
						width: image.width,
						height: image.height,
						attribution: image.attribution,
						sourceUrl: image.source_url,
						licenseUrl: image.license_url,
						rights: image.rights,
					}))
				);
				return {
					configured: resp.configured,
					provider: resp.provider,
					error: resp.error,
					results,
				};
			},
			// Fine-tune runs — the legacy `finetune.*` host-API verbs. Core no longer
			// bridges them: each is the same request onto the companion's OWN sidecar
			// through the generic ext-proxy (the host derives the plugin id), and the
			// progress stream reads that sidecar's SSE route the same way.
			...finetuneServicesViaAppRequest((input) =>
				ownAppRequest(toTarget(node), companion.pluginId, input).then(
					rpcJsonResponseSchema.parse
				)
			),
			finetuneStream: (input, emit, signal) =>
				ownAppEventStream(
					toTarget(node),
					companion.pluginId,
					finetuneStreamPath(input.id),
					{ onFrame: emit, signal }
				),
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
			workflowsVersionCreate: async ({ id, label, expectedRevision }) => {
				await createWorkflowVersion(
					toTarget(node),
					id,
					label,
					expectedRevision
				);
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
				return workflowWebhookRecordSchema.parse({
					url: endpoint?.publicUrl ?? "",
				});
			},
			// run + run-state (workflows:runstate)
			workflowsRun: ({ id, input, dryRun }) =>
				runWorkflow(toTarget(node), id, input ?? {}, { dryRun }),
			workflowsRunGet: ({ runId }) => getWorkflowRun(toTarget(node), runId),
			workflowsResume: ({ runId, payload }) =>
				resumeWorkflow(toTarget(node), runId, payload),
			// node-config catalog pickers (workflows:catalogs) — read-only projections
			workflowsAgents: () =>
				fetchAgents(toTarget(node)).then(workflowAgentsRecordsSchema.parse),
			workflowsApps: () =>
				fetchApps(toTarget(node)).then(workflowAppsRecordsSchema.parse),
			workflowsMcp: async () =>
				workflowMcpRecordSchema.parse({
					servers: await fetchMcpServers(toTarget(node)),
					tools: await fetchMcpTools(toTarget(node)),
				}),
			workflowsSkills: () =>
				listSkills(toTarget(node)).then(workflowSkillsRecordsSchema.parse),
			workflowsSchedules: () =>
				fetchJobs(toTarget(node)).then(workflowSchedulesRecordsSchema.parse),
			workflowsNotifyTargets: () =>
				listMentionTargetUsers(toTarget(node)).then(
					workflowNotifyTargetsRecordsSchema.parse
				),
			// The app-event catalog behind the `event` trigger's picker. Served from
			// the same contributions endpoint the shell already reads, narrowed to the
			// one family the canvas needs.
			workflowsHookEvents: async () =>
				workflowHookEventsRecordsSchema.parse(
					(await getPluginContributions(toTarget(node))).hook_events
				),
			workflowsConnectBindings: ({ id }) =>
				fetchWorkflowConnectBindings(toTarget(node), id).then(
					workflowConnectBindingRecordsSchema.parse
				),
			workflowsBindConnectTrigger: ({ id, connectTriggerId }) =>
				bindWorkflowConnectTrigger(toTarget(node), id, connectTriggerId).then(
					workflowConnectBindingRecordSchema.parse
				),
			workflowsRemoveConnectBinding: ({ id, bindingId }) =>
				removeWorkflowConnectBinding(toTarget(node), id, bindingId),
			workflowsComposio: ({ kind, toolkit }) => {
				switch (kind) {
					case "status":
						return fetchComposioStatus(toTarget(node)).then(
							workflowComposioResponseSchema("status").parse
						);
					case "toolkits":
						return fetchComposioToolkits(toTarget(node)).then(
							workflowComposioResponseSchema("toolkits").parse
						);
					case "triggers":
						return fetchComposioTriggers(toTarget(node), toolkit ?? "").then(
							workflowComposioResponseSchema("triggers").parse
						);
					default:
						return fetchComposioConnections(toTarget(node), toolkit ?? "").then(
							workflowComposioResponseSchema("connections").parse
						);
				}
			},
			// ghost record→replay (ghost:record). The legacy `ghost.recipes` list verb
			// is served from the Recipes app's list route through the generic
			// ext-proxy forwarder; current Workflows bundles call
			// `app.request({ app: "@ryu/recipes" })` (grant `app:http:@ryu/recipes`).
			...ghostRecipesViaAppMount((pluginId, input, signal) =>
				ownAppRequest(toTarget(node), pluginId, { ...input, signal }).then(
					rpcJsonResponseSchema.parse
				)
			),
			ghostRecordStart: ({ task }) => startRecording(toTarget(node), task),
			ghostRecordStatus: () => getRecordingStatus(toTarget(node)),
			ghostRecordStop: () => stopRecording(toTarget(node)),
			// Inbound webhook registry + protected secret management — the
			// @ryu/webhooks companion uses explicit secret reads/writes while the host
			// keeps the node token out of the sandboxed frame (webhooks:crud).
			// All four go through Core's app host bridge. The registry reads are the
			// `webhooks.list` / `webhooks.ingressStatus` kernel operations, so Core
			// checks the app's approved grant. The secret verbs are bridge-only
			// user-aware methods: Core checks the app's approved grant AND the
			// signed-in user's own workflow-edit / Gateway-configure permission. Only
			// an older Core that lacks the methods gets the host-direct fallback.
			webhooksList: () =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"webhooks.list",
					{}
				).then((value) =>
					toWebhookRegistry(webhookRegistryWireSchema.parse(value))
				),
			webhooksIngressStatus: () =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"webhooks.ingressStatus",
					{}
				).then((value) =>
					toWebhookIngressStatus(webhookIngressStatusWireSchema.parse(value))
				),
			webhooksSecretGet: ({ id }) =>
				readWebhookSecret(toTarget(node), companion.pluginId, id),
			webhooksSecretSet: ({ id, secret }) =>
				writeWebhookSecret(toTarget(node), companion.pluginId, id, secret),
			// Quests — the @ryu/quests companion drives Core's `/api/quests/*`
			// auto-detecting-todo orchestration. Host-direct (the monitors pattern): the
			// host holds the node token and calls the existing `/api/quests/*` client,
			// forwarding Core's snake_case shapes verbatim over the bridge (quests:crud).
			questsList: (input) =>
				listQuests(
					toTarget(node),
					questKindInputSchema.optional().parse(input?.kind)
				).then(z.array(questRecordSchema).parse),
			questsCapture: (input) =>
				captureQuest(toTarget(node), questCaptureInputSchema.parse(input)).then(
					questRecordSchema.parse
				),
			questsUse: ({ id, complete }) =>
				useQuest(toTarget(node), id, complete).then(questRecordSchema.parse),
			questsPin: ({ id, pinned }) =>
				pinQuest(toTarget(node), id, pinned ?? true).then(
					questRecordSchema.parse
				),
			questsScratchpad: () => getScratchpad(toTarget(node)),
			questsSetScratchpad: ({ text }) => setScratchpad(toTarget(node), text),
			questsCreate: (input) =>
				createQuest(toTarget(node), questWriteInputSchema.parse(input)).then(
					questRecordSchema.parse
				),
			questsUpdate: ({ id, input }) =>
				updateQuest(
					toTarget(node),
					id,
					questWriteInputSchema.parse(input)
				).then(questRecordSchema.parse),
			questsDelete: async ({ id }) => {
				await deleteQuest(toTarget(node), id);
			},
			questsComplete: ({ id }) =>
				completeQuest(toTarget(node), id).then(questRecordSchema.parse),
			questsDismiss: ({ id }) =>
				dismissQuest(toTarget(node), id).then(questRecordSchema.parse),
			questsAcceptSuggestion: ({ id }) =>
				acceptQuestSuggestion(toTarget(node), id).then(questRecordSchema.parse),
			questsDismissSuggestion: ({ id }) =>
				dismissQuestSuggestion(toTarget(node), id).then(
					questRecordSchema.parse
				),
			questsJudge: ({ id }) =>
				judgeQuest(toTarget(node), id).then(questJudgeResultSchema.parse),
			// Shell navigation: open Settings at the Quests (detection) tab. Not a Core
			// call — the companion's gear reaches the shell SettingsDialog through here.
			questsOpenDetectionSettings: () => openGateway("app:@ryu/quests"),
			// Activity feed — the @ryu/activity companion renders Core's read-only
			// unified feed. Host-direct (the monitors pattern): the host holds the node
			// token and calls the existing `/api/activity` read, forwarding Core's
			// snake_case items verbatim over the bridge (activity:read).
			activityList: ({ limit }) =>
				listActivity(toTarget(node), { limit }).then(
					z.array(activityRecordSchema).parse
				),
			activityAudit: async ({
				agent_id,
				event_type,
				errors_only,
				from,
				limit,
				model,
				provider,
				until,
				widget_instance_id,
			}) =>
				activityAuditResponseSchema.parse(
					await fetchGatewayAudit(toTarget(node), {
						agentId: agent_id,
						eventType: event_type,
						errorsOnly: errors_only,
						from,
						limit,
						model,
						provider,
						until,
						widgetInstanceId: widget_instance_id,
					})
				),
			activityPrune: async () =>
				activityPruneResponseSchema.parse(
					await pruneGatewayAudit(toTarget(node))
				),
			activityScore: async (input: ActivityScoreInput) =>
				activityScoreResponseSchema.parse(
					await scoreGatewayOutput(
						toTarget(node),
						activityScoreInputSchema.parse(input)
					)
				),
			activityTrace: async ({ run_id }) =>
				activityTraceResponseSchema.parse({
					spans: await fetchRunTrace(toTarget(node), run_id),
				}),
			activityRedteam: async ({ agent_id, model }) =>
				activityRedteamResponseSchema.parse(
					await runGatewayRedTeam(toTarget(node), {
						agent_id,
						model,
					})
				),
			activityEval: async ({ agent_id, model }) =>
				activityEvalResponseSchema.parse(
					await runGatewayEvals(toTarget(node), {
						agent_id,
						model,
					})
				),
			activityImportTrace: async ({ agent_id, run_id, suite_id }) => {
				const target = toTarget(node);
				const suite = suite_id
					? { id: suite_id }
					: agent_id
						? (await listPromptSuites(target, agent_id))[0]
						: undefined;
				if (!suite) {
					throw new Error(
						"activity.importTrace requires an agent_id or suite_id"
					);
				}
				const resolvedSuite =
					"name" in suite
						? suite
						: (
								await createPromptSuite(target, {
									agentId: agent_id ?? "",
									config: { prompts: [], providers: [], tests: [] },
									label: "Trace baseline",
									name: "Agent regression suite",
								})
							).suite;
				return activityTraceImportRecordSchema.parse(
					await importPromptTrace(target, resolvedSuite.id, run_id)
				);
			},
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
				z
					.array(timelineEventRecordSchema)
					.nullable()
					.parse(sanitizeTimelineEvents(await getTimeline(rangeMinutes))),
			timelineTranscripts: getSpeechHistory,
			timelineJournal: async ({ rangeMinutes, narrate }) =>
				timelineJournalRecordSchema
					.nullable()
					.parse(
						await enrichTimelineJournal(
							await getJournal(rangeMinutes, { narrate })
						)
					),
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
				listInboxes(toTarget(node)).then(z.array(mailInboxSchema).parse),
			mailMessages: ({ inboxId }) =>
				listMessages(toTarget(node), inboxId).then(
					z.array(mailMessageSchema).parse
				),
			mailCreate: (input) =>
				createInbox(toTarget(node), {
					name: input.name,
					address: input.address,
					client_id: input.clientId,
					metadata: input.metadata,
					pod_id: input.podId,
					provider: mailProviderInputSchema.parse(input.provider),
				}).then(mailInboxSchema.parse),
			mailDelete: async ({ id }) => {
				await deleteInbox(toTarget(node), id);
			},
			mailRotateSecret: ({ id }) => rotateInboundSecret(toTarget(node), id),
			mailSend: (input) => sendCompanionMail(toTarget(node), input),
			mailRequest: (input) =>
				mailRequest(toTarget(node), input).then(rpcJsonResponseSchema.parse),
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
				fetchJobs(toTarget(node)).then(z.array(calendarJobRecordSchema).parse),
			calendarWorkflows: () =>
				fetchWorkflows(toTarget(node)).then(
					z.array(calendarWorkflowRecordSchema).parse
				),
			calendarAgents: () =>
				fetchAgents(toTarget(node)).then(
					z.array(calendarAgentRecordSchema).parse
				),
			calendarCreateAutomation: (args) =>
				createScheduledAgentWorkflow(toTarget(node), args),
			// Warmup — the @ryu/warmup companion keeps subscription usage windows
			// open by scheduling a keep-alive ping per agent. Each verb goes through
			// Core's app host bridge to the `warmup.*` kernel operation of the same
			// name, so Core checks the app's approved grant (warmup:crud) and the
			// signed-in user's agent permissions, and scopes every job to the calling
			// app: the grant can never reach an automation another app or Core owns.
			warmupDetect: () =>
				detectWarmupAgents(toTarget(node), companion.pluginId).then(
					warmupDetectionSchema.parse
				),
			warmupList: () =>
				listWarmupJobs(toTarget(node), companion.pluginId).then(
					z.array(calendarJobRecordSchema).parse
				),
			warmupApply: (jobs) =>
				applyWarmupJobs(toTarget(node), companion.pluginId, jobs),
			warmupRunNow: (ping) =>
				runWarmupJobNow(toTarget(node), companion.pluginId, ping),
			// Learning — the @ryu/learning companion renders the read-only
			// continual-learning surface. Host-direct (the monitors pattern): the host
			// holds the node token and calls the existing `/api/learn/config` (config),
			// `/api/experience/list` (buffer), and `/api/healing/status` (heal history)
			// reads, forwarding Core's shapes verbatim over the bridge (learning:crud).
			// All READ-ONLY — the skill approvals + heal inbox stay in the Inbox, the
			// opt-ins in Privacy settings.
			learningConfig: () =>
				getLearningConfig(toTarget(node)).then(learningConfigSchema.parse),
			learningExperience: () =>
				listExperience(toTarget(node)).then(learningExperienceListSchema.parse),
			learningHealing: () =>
				getHealingStatus(toTarget(node)).then(
					learningHealingStatusSchema.parse
				),
			// Inbox / Approvals — the @ryu/approvals companion renders the unified
			// inbox. Host-direct (the monitors pattern): the host holds the node token
			// and calls the existing `/api/approvals/*` (approve/reject),
			// `/api/notifications/*` (the per-user feed, scoped by the host-resolved
			// `meId`), and Shadow's `/proactive` + `/api/feedback` reads/writes,
			// forwarding the shapes verbatim over the bridge (approvals:crud). The quest
			// task check-off reuses the `quests*` services above (the app also holds
			// quests:crud). `suggestionsOpenInChat` is a shell-navigation verb.
			approvalsList: () =>
				listApprovals(toTarget(node)).then(z.array(approvalRecordSchema).parse),
			approvalsApprove: ({ id, note }) =>
				approveApproval(toTarget(node), id, note).then(
					approvalRecordSchema.parse
				),
			approvalsReject: ({ id, note }) =>
				rejectApproval(toTarget(node), id, note).then(
					approvalRecordSchema.parse
				),
			notificationsList: async ({ archived }: { archived?: boolean } = {}) => {
				const notifications = meId
					? await listNotifications(toTarget(node), meId, undefined, archived)
					: [];
				return z
					.array(notificationRecordSchema)
					.parse(
						redactConnectSuggestionNotifications(
							notifications,
							getUserAvailabilitySnapshot().streamingPrivacyActive
						)
					);
			},
			notificationsSend: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"notifications.send",
					input
				).then(notificationSendResponseSchema.parse),
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
				getProactiveInbox().then(
					z.array(proactiveSuggestionRecordSchema).parse
				),
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
				listMeetings(toTarget(node)).then(z.array(meetingRecordSchema).parse),
			meetingsTranscript: ({ id }) =>
				getTranscript(toTarget(node), id).then(meetingTranscriptSchema.parse),
			meetingsStart: (input) =>
				startMeeting(toTarget(node), {
					source: meetingSourceInputSchema.parse(input.source),
					app: input.app,
					title: input.title,
				}).then(meetingRecordSchema.parse),
			meetingsFinalize: ({ id }) =>
				finalizeMeeting(toTarget(node), id).then(meetingRecordSchema.parse),
			meetingsDelete: async ({ id }) => {
				await deleteMeeting(toTarget(node), id);
			},
			meetingsRename: ({ id, title }) =>
				renameMeeting(toTarget(node), id, title).then(
					meetingRecordSchema.parse
				),
			meetingsSetIcon: async ({ id, icon }) => {
				const updated = await setMeetingIcon(toTarget(node), id, icon);
				const glyph = asGlyphValue(icon) ?? null;
				updateTabsIconWhere(
					(t) =>
						t.path === `/meetings/${id}` ||
						t.path.startsWith(`/meetings/${id}?`),
					glyph
				);
				return meetingRecordSchema.parse(updated);
			},
			meetingsImport: async () => {
				const file = await pickAudioFile();
				if (!file) {
					return null;
				}
				return meetingRecordSchema.parse(
					await importMeeting(toTarget(node), file, {
						title: file.name,
					})
				);
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
			socialRequest: (input) =>
				socialRequest(toTarget(node), input).then(rpcJsonResponseSchema.parse),

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
			subtitlesRequest: (input) =>
				subtitlesRequest(toTarget(node), input).then(
					rpcJsonResponseSchema.parse
				),
			// Automated Reasoning — the @ryu/reasoning companion authors formal policies
			// and runs the solver playground. Same one-forwarder shape as Outpost, and
			// the same security note applies: `reasoningRequest` in `lib/api/reasoning.ts`
			// owns the path check (leading slash, not protocol-relative, no backslash,
			// resolving under `/api/reasoning` per the WHATWG parser rather than a literal
			// `..` blocklist), and `rpc.ts`'s `asReasoningRequestArg` applies the identical
			// rules one layer earlier. There is no `open` verb because the companion is the
			// whole surface — it never navigates the shell.
			reasoningRequest: (input) =>
				reasoningRequest(toTarget(node), input).then(
					rpcJsonResponseSchema.parse
				),
			// Safe Actions — the @ryu/safe-actions companion reviews tool plans. The
			// call goes through Core's app host bridge (`safeActions.request`): Core
			// checks the app's approved grant (safe-actions:manage) AND the signed-in
			// user's Safe Actions role, and records that user as the reviewer of an
			// approval or denial. `safeActionsRequest` keeps the mount check as a
			// first layer and falls back host-direct only on an older Core that
			// lacks the method.
			safeActionsRequest: (input) =>
				safeActionsRequest(toTarget(node), companion.pluginId, input).then(
					rpcJsonResponseSchema.parse
				),
			// Deep Read — the @ryu/rlm companion loads a corpus, browses its outline,
			// asks questions of it and reads run traces. Same one-forwarder shape as
			// Reasoning, and the same security note applies: `rlmRequest` in
			// `lib/api/rlm.ts` owns the path check (leading slash, not protocol-relative,
			// no backslash, resolving under `/api/rlm` per the WHATWG parser rather than a
			// literal `..` blocklist), and `rpc.ts`'s `asRlmRequestArg` applies the
			// identical rules one layer earlier. No `open` verb: the companion is the whole
			// surface.
			rlmRequest: (input) =>
				rlmRequest(toTarget(node), input).then(rpcJsonResponseSchema.parse),
			// Tuition and Wire: the same one-forwarder shape, and the same security note
			// — each `*Request` re-validates the frame-chosen sub-path against its own
			// mount before building a URL, independently of the check `@ryu/app-host/rpc`
			// already ran. Two layers on purpose: either alone would be the only thing
			// between a sandboxed frame and the node's credentials.
			tuitionRequest: (input) =>
				tuitionRequest(toTarget(node), input).then(rpcJsonResponseSchema.parse),
			newsRequest: (input) =>
				newsRequest(toTarget(node), input).then(rpcJsonResponseSchema.parse),
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
			blueprintRequest: (input) =>
				blueprintRequest(toTarget(node), input).then(
					rpcJsonResponseSchema.parse
				),
			// Generic companion → sidecar forwarder. Own sidecar by default (grant
			// `app:http`); another app's only with the reviewed per-target grant
			// `app:http:<app>`, checked against the APPROVED grants. Plugin ids are
			// host-owned; the frame chooses only the relative path/method/body, which
			// stays confined to the target's `/api/ext/<id>` mount.
			appRequest: appRequestService({
				approvedGrants: approvedGrantList,
				callerId: companion.pluginId,
				forward: (pluginId, input, signal) =>
					ownAppRequest(toTarget(node), pluginId, {
						...input,
						signal,
					}).then(rpcJsonResponseSchema.parse),
			}),
			// Generic application-room realtime. The node target, node bearer and
			// user JWT remain in this trusted host; only the opaque join result crosses
			// the RPC boundary into the null-origin companion.
			realtimeConnect: async ({ room_id }) => {
				const signal = realtimeLifetimeRef.current?.signal;
				if (!signal || signal.aborted) {
					throw new Error("companion document is closed");
				}
				const jwt = await waitForApplicationRealtime(
					realtimeJwtForTarget(toTarget(node)),
					signal
				);
				if (signal.aborted) {
					throw new Error("companion document is closed");
				}
				const connectionId = crypto.randomUUID();
				const queue = new ApplicationRealtimeQueue();
				let connection: RealtimeConnection | undefined;
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
				// A transport can fail before the join await is reached.
				void join.catch(() => undefined);
				const timeout = window.setTimeout(() => {
					rejectJoin(new Error("realtime join timed out"));
				}, 15_000);
				const closeOnOverflow = () => {
					connection?.close();
					realtimeSessionsRef.current.delete(connectionId);
				};
				try {
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
					const ack = await waitForApplicationRealtime(join, signal);
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
					connection?.close();
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
			// App installation — a builder app (the @ryu/app-studio companion) installs
			// the companion-only app it made. The bundle is checked against THIS
			// companion's own id (`com.local.<segment>.*`, companion runnable only,
			// reviewed grants) before Core's generic install-bundle sink sees it; Core
			// leaves a new install disabled until the user enables it (plugins:install).
			appsInstallBundle: async (value) => {
				const check = checkAppBundle(companion.pluginId, value);
				if (!check.ok) {
					throw new Error(check.error);
				}
				await installCompanionAppBundle(toTarget(node), check.bundle);
				return {
					id: check.bundle.id,
					installed: true,
					updated: check.bundle.update === true,
					version: check.bundle.version,
				};
			},
			// Skill authoring — the @ryu/skill-editor companion authors a user-owned
			// Agent Skill (SKILL.md). Host-direct (the monitors pattern): the host holds the
			// node token and calls the existing `skills.ts` authoring client (createSkill/
			// updateSkill/getSkillSource/version history), which normalizes Core's snake_case
			// to camelCase, forwarding those shapes verbatim over the bridge (skills:crud).
			// The extracted `SkillEditorPage` used these same clients. `skillsSetTitle` is a
			// shell-navigation verb: it renames the companion's own tab (the desktop page's
			// `updateTabTitle(currentTabId, …)`).
			skillsGetSource: ({ id }) =>
				getSkillSource(toTarget(node), id).then(skillSourceRecordSchema.parse),
			skillsCreate: (input) =>
				createSkill(toTarget(node), {
					name: input.name,
					body: input.body,
					description: input.description ?? null,
					allowedTools: input.allowedTools ?? [],
					alwaysOn: input.alwaysOn ?? false,
				}).then(skillWriteRecordSchema.parse),
			skillsUpdate: ({ id, name, body, description, allowedTools, alwaysOn }) =>
				updateSkill(toTarget(node), id, {
					name,
					body,
					description: description ?? null,
					allowedTools: allowedTools ?? [],
					alwaysOn: alwaysOn ?? false,
				}).then(skillWriteRecordSchema.parse),
			skillsListVersions: ({ id }) =>
				listSkillVersions(toTarget(node), id).then(
					skillVersionRecordsSchema.parse
				),
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
						attributeFilter: [...COMPANION_THEME_MUTATION_ATTRIBUTES],
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
					const raw = parseCompanionCommands(input);
					const disposers: (() => void)[] = [];
					for (const c of raw) {
						const commandId = c.id;
						const entry: CommandEntry = {
							// Namespace the palette id so a companion can neither collide with
							// nor impersonate a built-in / another plugin's command.
							id: `plugin:${companion.pluginId}:${commandId}`,
							title: c.title,
							group:
								c.group === undefined
									? companion.label || companion.name
									: c.group,
							keywords: c.keywords === undefined ? undefined : c.keywords,
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
					const raw = parseCompanionTabIcons(input);
					const disposers: (() => void)[] = [];
					for (const entry of raw) {
						disposers.push(
							registerTabIcon({
								id: `plugin:${companion.pluginId}:tab-icon:${entry.index}:${entry.pathPrefix}`,
								pathPrefix: entry.pathPrefix,
								pathIncludes:
									entry.pathIncludes === undefined
										? undefined
										: entry.pathIncludes,
								icon: entry.icon,
								priority: entry.priority === undefined ? 30 : entry.priority,
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
					const requested = parseCompanionEventChannels(input);
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
			approvedGrantList,
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
			onRequestClose,
			fileAccess,
		]
	);

	const isHtmlBundle = Boolean(code && /^\s*<(?:!doctype|html)\b/i.test(code));
	const allowForms = shouldEnableCompanionFormEvents(
		companion.firstParty === true,
		isHtmlBundle
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
		if (isHtmlBundle) {
			return htmlCompanionSrcdoc(
				nonce,
				code,
				companion.id,
				mountContext,
				companion.csp,
				initialThemeTokens,
				true,
				{ enforceDefaultCsp: companion.defaultCspEnforced, closeOnEscape }
			);
		}
		return thirdPartyPluginSrcdoc(
			nonce,
			toBase64Utf8(code),
			companion.id,
			mountContext,
			initialThemeTokens,
			true,
			{ enforceDefaultCsp: companion.defaultCspEnforced, closeOnEscape }
		);
	}, [
		code,
		isHtmlBundle,
		nonce,
		companion.id,
		companion.csp,
		companion.defaultCspEnforced,
		closeOnEscape,
		mountContext,
		initialThemeTokens,
	]);

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
					allowDownloads={companion.approvedGrants.includes(APP_DOWNLOAD_GRANT)}
					allowForms={allowForms}
					granted={granted}
					nonce={nonce}
					onConnected={() => setConnectedNonce(nonce)}
					onMessage={onMessage}
					pushRef={filePushRef}
					services={services}
					srcdoc={srcdoc}
					streamingPrivacyActive={streamingPrivacyActive}
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

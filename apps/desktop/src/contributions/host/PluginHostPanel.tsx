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
// It renders NOTHING until the flag-gated caller (PluginCompanionPage) decides the
// plugin actually carries a UI bundle and the experimental flag is on.

import { PuzzleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	type Capability,
	capabilitiesFromGrants,
	type HostServices,
	isShellSafeRoute,
	type MailInbox,
	type MailMessage,
	type MonitorRecord,
	type QuestRecord,
	validatePluginRoute,
} from "@ryu/app-host/rpc";
import {
	htmlCompanionSrcdoc,
	thirdPartyPluginSrcdoc,
} from "@ryu/app-host/third-party-plugin";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { getActiveUserId, useSession } from "@/lib/auth-client.ts";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import {
	useCurrentTabId,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import {
	type CommandEntry,
	contributionRegistry,
} from "@/src/contributions/registry.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { listActivity } from "@/src/lib/api/activity.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import {
	approveApproval,
	listApprovals,
	rejectApproval,
} from "@/src/lib/api/approvals.ts";
import { searchGifs } from "@/src/lib/api/assets.ts";
import { toTarget } from "@/src/lib/api/client.ts";
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
	startMeeting,
} from "@/src/lib/api/meetings.ts";
import {
	createMonitor,
	deleteMonitor,
	getMonitor,
	listMonitorAlerts,
	listMonitors,
	listSnapshots,
	type MonitorInput,
	runMonitor,
	updateMonitor,
} from "@/src/lib/api/monitors.ts";
import {
	ackNotification,
	listNotifications,
	markNotificationRead,
} from "@/src/lib/api/notifications.ts";
import {
	fetchApps,
	fetchPluginUiBundle,
	type PluginCompanion,
	pluginFinetuneStream,
	pluginHostInvoke,
	pluginHostInvokeStream,
} from "@/src/lib/api/plugins.ts";
import {
	acceptSuggestion as acceptQuestSuggestion,
	completeQuest,
	createQuest,
	deleteQuest,
	dismissQuest,
	dismissSuggestion as dismissQuestSuggestion,
	judgeQuest,
	listQuests,
	type QuestInput,
	updateQuest,
} from "@/src/lib/api/quests.ts";
import {
	getRecordingStatus,
	listRecipes,
	startRecording,
	stopRecording,
} from "@/src/lib/api/recipes.ts";
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
import { generateVideo as apiGenerateVideo } from "@/src/lib/api/video.ts";
import {
	speakText as apiSpeakText,
	transcribeAudio as apiTranscribeAudio,
	listTtsEngines,
} from "@/src/lib/api/voice.ts";
import {
	fetchWebhookIngressStatus,
	fetchWebhooks,
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
import { PlanCapError } from "@/src/lib/gating/planCapBridge.ts";
import { useEntityCap } from "@/src/lib/gating/useEntityCap.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";

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
] as const;

/** The node event-stream channels a `shell.eventsSubscribe` call may request (grant
 *  `shell:integrate`). A companion's requested set is intersected with this — an
 *  unknown channel is silently dropped. Mirrors the `EventChannel` union. */
const SHELL_EVENT_CHANNELS: readonly EventChannel[] = [
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
	const [connected, setConnected] = useState(false);
	// The theme-token bridge (W7): read the host's live resolved theme tokens ONCE
	// at mount and inject them into the sandboxed companion so it renders in the
	// desktop's active light/dark/custom theme. Lazy-init (mount-time snapshot) — a
	// companion's own hardcoded token block is the fallback for anything unread.
	const [themeTokens] = useState(readHostThemeTokens);
	// The managed-path numeric cap on monitors (free-tier gating). Read from the
	// React entitlement context so the guard is always fresh — the `com.ryu.monitors`
	// companion re-applies it in `monitorsCreate` below (the old `useMonitors` hook
	// that carried this gate is deleted with `MonitorsPage`). Caps live ONLY in the
	// closed desktop layer (open-core rule, `planCapBridge.ts`), so this stays here,
	// not in Core. A no-op off the managed path (self-host is uncapped).
	const { guard, limitFor } = useEntityCap();
	// Band-2 boolean gate for always-on workflow triggers (schedule / webhook /
	// Composio). The `com.ryu.workflows` companion re-applies it in `workflowsSave`
	// below — the shell `TriggerConfig` that carried `canUse("local-background-runs")`
	// was deleted with the shell canvas, and the sandboxed companion's own
	// entitlement is stubbed (it cannot import `@ryu/auth`). Same open-core reasoning
	// as the monitors cap: enforcement lives in the closed desktop layer, never Core
	// (Core's scheduler fires triggers headlessly and carries no paywall). A no-op
	// off the managed path (self-host is unrestricted).
	const { canUse, requestUpgrade } = useEntitlementContext();
	// The shell Settings dialog opener — the `com.ryu.quests` companion's detection-
	// settings gear opens Settings → Quests through the `questsOpenDetectionSettings`
	// bridge verb (the QuestsSettings tab stays a shell surface; the extracted page's
	// gear reaches it via this host-side navigation, preserving the old behavior).
	// Quests is an app: its settings render under the Apps header in the node-scoped
	// Gateway dialog, addressed by its `app:<id>` entity value.
	const openGateway = useGatewayDialog((s) => s.openGateway);
	// The shell tab opener — the `com.ryu.activity` companion's clickable rows open the
	// chat tab for an item's session through the `activityOpenSession` bridge verb (the
	// extracted page used `useTabsContext().openTab` directly; the sandboxed frame reaches
	// it here). PluginHostPanel renders as tab content, so it sits under TabsProvider.
	const { openTab, updateTabTitle } = useTabsContext();
	// The current tab id — the `com.ryu.skill-editor` companion's `skills.setTitle` verb
	// renames its own owning tab (the desktop page's `updateTabTitle(currentTabId, …)`).
	const currentTabId = useCurrentTabId();
	// The signed-in user id, resolved HOST-SIDE for the `com.ryu.approvals` companion's
	// Notifications section: the per-user feed is scoped by user id, but the sandboxed
	// frame has no Better Auth session, so the host reads it (the session query, falling
	// back to the local account vault) exactly as the deleted `useNotifications` hook did.
	const { data: session } = useSession();
	const meId = session?.user?.id ?? getActiveUserId() ?? null;

	// Fetch the plugin's bundled code over the trusted API. `null` (no bundle /
	// not enabled) or an error means we render the benign fallback, never code.
	const { data: code, isPending } = useQuery({
		queryKey: ["plugin-ui-bundle", node.url, node.token, companion.pluginId],
		// Fetch by the OWNING plugin id (the store key), not the companion id.
		queryFn: () => fetchPluginUiBundle(toTarget(node), companion.pluginId),
		retry: false,
		staleTime: 60_000,
	});

	// One nonce per mount. Host-generated, never plugin/user input.
	const nonce = useMemo(
		() =>
			typeof crypto?.randomUUID === "function"
				? crypto.randomUUID()
				: `nonce-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
		[]
	);

	// The granted set comes from the plugin's GATEWAY-APPROVED grants, mapped to
	// capabilities (unmapped grants dropped). DENY-SAFE: an empty approved list
	// yields an empty set, so a plugin with no validated grants can call nothing.
	const granted = useMemo<ReadonlySet<Capability>>(
		() => capabilitiesFromGrants(companion.approvedGrants),
		[companion.approvedGrants]
	);

	// The privileged services. `listAgents` holds the token and returns a minimal
	// projection; `registerRoute` accepts ONLY this plugin's own `/plugin/<id>`
	// path (anti-phishing), rejecting system/other-plugin paths.
	const services = useMemo<HostServices>(
		() => ({
			listAgents: async () => {
				const agents = await fetchAgents(toTarget(node));
				return agents.map((a) => ({ id: a.id, name: a.name }));
			},
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
			runAgent: (input) =>
				pluginHostInvoke(
					toTarget(node),
					companion.pluginId,
					"agent.run",
					input
				) as Promise<string>,
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
			// Streaming agent.run: reply text arrives token-by-token via `emit`; the
			// SSE fetch is aborted when `signal` fires (frame cancel).
			runAgentStream: (input, emit, signal) =>
				pluginHostInvokeStream(toTarget(node), companion.pluginId, input, {
					onChunk: emit,
					signal,
				}),
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
			// Fine-tune runs — the com.ryu.finetune app drives Core's orchestration +
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
			// Website monitors — the com.ryu.monitors companion drives Core's
			// `/api/monitors/*` orchestration. Called DIRECTLY (the media pattern), not
			// via the PluginHookBridge: `/api/monitors/*` already exists and is gated on
			// the same com.ryu.monitors enabled bit, so no Core bridge verb is needed.
			monitorsList: () =>
				listMonitors(toTarget(node)) as unknown as Promise<MonitorRecord[]>,
			monitorsGet: ({ id }) =>
				getMonitor(toTarget(node), id) as unknown as Promise<MonitorRecord>,
			// The paywall gate: re-applied here because deleting `useMonitors` dropped
			// it. Fetch the live count, then the fresh React `guard` (opens the upgrade
			// modal in the shell + throws) — the throw crosses the bridge as a denial.
			monitorsCreate: async (input) => {
				const existing = await listMonitors(toTarget(node));
				if (!guard("maxMonitors", existing.length)) {
					throw new PlanCapError("maxMonitors", limitFor("maxMonitors"));
				}
				return (await createMonitor(
					toTarget(node),
					input as unknown as MonitorInput
				)) as unknown as MonitorRecord;
			},
			monitorsUpdate: ({ id, input }) =>
				updateMonitor(
					toTarget(node),
					id,
					input as unknown as MonitorInput
				) as unknown as Promise<MonitorRecord>,
			monitorsDelete: async ({ id }) => {
				await deleteMonitor(toTarget(node), id);
			},
			monitorsRun: ({ id }) => runMonitor(toTarget(node), id),
			monitorsSnapshots: ({ id, limit }) =>
				listSnapshots(toTarget(node), id, limit) as unknown as Promise<
					Record<string, unknown>[]
				>,
			monitorsAlerts: ({ id, limit }) =>
				listMonitorAlerts(toTarget(node), id, limit) as unknown as Promise<
					Record<string, unknown>[]
				>,
			// Workflows — the com.ryu.workflows companion drives Core's DAG workflow
			// engine + templates + node-config catalogs + ghost record→replay. Host-
			// direct (the monitors pattern): the host holds the node token and calls
			// the existing `/workflows*` + `/api/workflows/catalog*` + `/api/recipes/*`
			// + node-config API, already gated on the com.ryu.workflows enabled bit.
			// definition CRUD (workflows:crud)
			workflowsList: () => fetchWorkflows(toTarget(node)),
			workflowsGet: ({ id }) => fetchWorkflow(toTarget(node), id),
			workflowsSave: (def) => {
				// Gate always-on triggers: a free (Band-1) workflow runs manually only;
				// any schedule / webhook / Composio trigger is a Band-2 "background runs"
				// feature. Deny at save (opens the shell upgrade modal + throws, crossing
				// the bridge as a denial) so a stubbed in-frame entitlement can't smuggle
				// a background trigger past the paywall.
				const wantsBackground = (
					(def as { triggers?: { type?: string }[] }).triggers ?? []
				).some((t) => t?.type && t.type !== "manual");
				if (wantsBackground && !canUse("local-background-runs")) {
					requestUpgrade();
					throw new Error(
						"Background workflow runs (schedule / webhook / Composio triggers) require a Lifetime license or a subscription."
					);
				}
				return createWorkflow(toTarget(node), def);
			},
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
			workflowsRun: ({ id, input }) =>
				runWorkflow(toTarget(node), id, input ?? {}),
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
			// Inbound webhook registry — the com.ryu.webhooks companion renders Core's
			// read-only `/api/webhooks` + `/api/webhook-ingress/status`. Host-direct (the
			// monitors pattern): the host holds the node token and calls the existing
			// ungated reads; both return the camelCase-normalized shape the desktop page
			// used, forwarded verbatim over the bridge (webhooks:crud).
			webhooksList: () => fetchWebhooks(toTarget(node)),
			webhooksIngressStatus: () => fetchWebhookIngressStatus(toTarget(node)),
			// Quests — the com.ryu.quests companion drives Core's `/api/quests/*`
			// auto-detecting-todo orchestration. Host-direct (the monitors pattern): the
			// host holds the node token and calls the existing `/api/quests/*` client,
			// forwarding Core's snake_case shapes verbatim over the bridge (quests:crud).
			questsList: () =>
				listQuests(toTarget(node)) as unknown as Promise<QuestRecord[]>,
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
			questsOpenDetectionSettings: () => openGateway("app:com.ryu.quests"),
			// Activity feed — the com.ryu.activity companion renders Core's read-only
			// unified feed. Host-direct (the monitors pattern): the host holds the node
			// token and calls the existing `/api/activity` read, forwarding Core's
			// snake_case items verbatim over the bridge (activity:read).
			activityList: ({ limit }) =>
				listActivity(toTarget(node), { limit }) as unknown as Promise<
					Record<string, unknown>[]
				>,
			// Shell navigation: open the chat tab for an item's session. Not a Core call —
			// the extracted page opened it via `useTabsContext().openTab` (same call here).
			activityOpenSession: ({ session_id }) =>
				openTab("/chat", { conversationId: session_id, title: "Chat" }),
			// Timeline — the com.ryu.timeline companion renders the activity replay
			// scrubber. Host-direct but device-LOCAL: Shadow (:3030) is machine-pinned,
			// so these call the `shadow.ts` client WITHOUT `toTarget(node)` — the
			// INVARIANT (the same host-direct-to-Shadow shape as `suggestions*` above).
			// `frame` fetches the keyframe and returns a data URL (CSP img-src data:
			// blob:). `openReview`/`openSettings` are shell-navigation verbs mirroring the
			// desktop page's `navigate("/review")`/`navigate("/settings")`.
			timelineList: ({ rangeMinutes }) =>
				getTimeline(rangeMinutes) as unknown as Promise<
					Record<string, unknown>[] | null
				>,
			timelineJournal: ({ rangeMinutes, narrate }) =>
				getJournal(rangeMinutes, { narrate }) as unknown as Promise<Record<
					string,
					unknown
				> | null>,
			timelineFrame: ({ tsMicros }) => fetchFrameDataUrl(tsMicros),
			timelineOpenReview: () => openTab("/review", { title: "Weekly review" }),
			timelineOpenSettings: () => openTab("/settings"),
			// Agent Inboxes — the com.ryu.mail companion drives Core's `/api/mail/*`
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
			// Calendar — the com.ryu.calendar companion renders the scheduled-runs
			// calendar and schedules an agent. Host-direct (the monitors pattern): the
			// host holds the node token and calls the existing `/heartbeat/jobs` (jobs),
			// `/workflows` (names), and `/api/agents` (picker) reads, forwarding Core's
			// shapes verbatim over the bridge (calendar:crud). `createAutomation` reuses
			// the SAME `createScheduledAgentWorkflow` composite the desktop dialog ran, so
			// Core's validation error (bad cron/interval) propagates as the thrown message.
			calendarJobs: () =>
				fetchJobs(toTarget(node)) as unknown as Promise<
					Record<string, unknown>[]
				>,
			calendarWorkflows: () =>
				fetchWorkflows(toTarget(node)) as unknown as Promise<
					Record<string, unknown>[]
				>,
			calendarAgents: () =>
				fetchAgents(toTarget(node)) as unknown as Promise<
					Record<string, unknown>[]
				>,
			calendarCreateAutomation: (args) =>
				createScheduledAgentWorkflow(toTarget(node), args),
			// Learning — the com.ryu.learning companion renders the read-only
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
			// Inbox / Approvals — the com.ryu.approvals companion renders the unified
			// inbox. Host-direct (the monitors pattern): the host holds the node token
			// and calls the existing `/api/approvals/*` (approve/reject),
			// `/api/notifications/*` (the per-user feed, scoped by the host-resolved
			// `meId`), and Shadow's `/proactive` + `/api/feedback` reads/writes,
			// forwarding the shapes verbatim over the bridge (approvals:crud). The quest
			// task check-off reuses the `quests*` services above (the app also holds
			// quests:crud). `suggestionsOpenInChat` is a shell-navigation verb.
			approvalsList: () =>
				listApprovals(toTarget(node)) as unknown as Promise<
					Record<string, unknown>[]
				>,
			approvalsApprove: ({ id, note }) =>
				approveApproval(toTarget(node), id, note) as unknown as Promise<
					Record<string, unknown>
				>,
			approvalsReject: ({ id, note }) =>
				rejectApproval(toTarget(node), id, note) as unknown as Promise<
					Record<string, unknown>
				>,
			notificationsList: () =>
				(meId
					? listNotifications(toTarget(node), meId)
					: Promise.resolve([])) as unknown as Promise<
					Record<string, unknown>[]
				>,
			notificationsMarkRead: ({ id }) =>
				markNotificationRead(toTarget(node), id),
			notificationsAck: ({ id }) => ackNotification(toTarget(node), id),
			suggestionsList: () =>
				getProactiveInbox() as unknown as Promise<Record<string, unknown>[]>,
			suggestionsFeedback: ({ kind, suggestion_type }) =>
				postFeedback({ kind, suggestion_type }),
			suggestionsOpenInChat: ({ prompt }) =>
				openTab("/chat", {
					forceNew: true,
					initialPrompt: prompt,
					title: "Chat",
				}),
			// Meetings — the com.ryu.meetings companion renders the record → live-
			// transcript → AI-notes surface. Host-direct (the monitors pattern): the host
			// holds the node token and calls the existing `/api/meetings/*` clients,
			// forwarding Core's shapes verbatim over the bridge (meetings:crud). `import`
			// is host-owned: the frame carries no file picker + cannot POST multipart under
			// the CSP, so the host opens the OS file dialog (the same `audio/wav` filter the
			// desktop page used) and performs the upload, returning the created meeting or
			// `null` on cancel. `open`/`openNotes`/`openList` are shell-navigation verbs
			// mirroring the extracted page's `useTabsContext().openTab`.
			meetingsList: () =>
				listMeetings(toTarget(node)) as unknown as Promise<
					Record<string, unknown>[]
				>,
			meetingsTranscript: ({ id }) =>
				getTranscript(toTarget(node), id) as unknown as Promise<
					Record<string, unknown>
				>,
			meetingsStart: (input) =>
				startMeeting(toTarget(node), {
					source: input.source as "manual" | "auto" | undefined,
					app: input.app,
					title: input.title,
				}) as unknown as Promise<Record<string, unknown>>,
			meetingsFinalize: ({ id }) =>
				finalizeMeeting(toTarget(node), id) as unknown as Promise<
					Record<string, unknown>
				>,
			meetingsDelete: async ({ id }) => {
				await deleteMeeting(toTarget(node), id);
			},
			meetingsRename: ({ id, title }) =>
				renameMeeting(toTarget(node), id, title) as unknown as Promise<
					Record<string, unknown>
				>,
			meetingsImport: async () => {
				const file = await pickAudioFile();
				if (!file) {
					return null;
				}
				return importMeeting(toTarget(node), file, {
					title: file.name,
				}) as unknown as Record<string, unknown>;
			},
			meetingsOpen: ({ id, title }) =>
				openTab(`/meetings/${id}`, { title: title ?? "Meeting" }),
			meetingsOpenNotes: ({ spaceId, docId, title }) =>
				openTab(`/spaces/${spaceId}/doc/${docId}`, {
					title: title ?? "Notes",
				}),
			meetingsOpenList: () => openTab("/meetings", { title: "Meetings" }),
			// Skill authoring — the com.ryu.skill-editor companion authors a user-owned
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
			}) => {
				const ownPath = `/plugin/${encodeURIComponent(companion.pluginId)}`;
				if (!isShellSafeRoute(path, ownPath)) {
					throw new Error(
						`shell.openTab: '${path}' is not an allowed shell destination`
					);
				}
				openTab(path, { title, conversationId, forceNew, initialPrompt });
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
			companion.id,
			companion.pluginId,
			guard,
			limitFor,
			canUse,
			requestUpgrade,
			openGateway,
			openTab,
			updateTabTitle,
			currentTabId,
			meId,
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
				themeTokens
			);
		}
		return thirdPartyPluginSrcdoc(
			nonce,
			toBase64Utf8(code),
			companion.id,
			mountContext
		);
	}, [code, nonce, companion.id, mountContext, themeTokens]);

	if (isPending) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-muted-foreground text-sm">
				Loading plugin…
			</div>
		);
	}

	if (!srcdoc) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-muted-foreground text-sm">
				This plugin does not provide a runnable UI.
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* Visible attribution: this is plugin content, namespaced, never system
			    chrome. */}
			<div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={PuzzleIcon}
				/>
				<span className="font-medium text-sm">
					Plugin · {companion.label || companion.name}
				</span>
				<span className="ml-auto text-muted-foreground text-xs">
					{connected ? "sandboxed · connected" : "sandboxed · starting…"}
				</span>
			</div>
			<div className="min-h-0 flex-1">
				<ExtensionHost
					granted={granted}
					nonce={nonce}
					onConnected={() => setConnected(true)}
					services={services}
					srcdoc={srcdoc}
					title={`Plugin: ${companion.name}`}
				/>
			</div>
		</div>
	);
}

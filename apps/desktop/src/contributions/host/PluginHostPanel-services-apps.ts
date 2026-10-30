import {
	type ActivityScoreInput,
	activityAuditResponseSchema,
	activityEvalResponseSchema,
	activityPruneResponseSchema,
	activityRecordSchema,
	activityRedteamResponseSchema,
	activityScoreResponseSchema,
	activityTraceImportRecordSchema,
	activityTraceResponseSchema,
	approvalRecordSchema,
	calendarAgentRecordSchema,
	calendarJobRecordSchema,
	calendarWorkflowRecordSchema,
	type HostServices,
	learningConfigSchema,
	learningExperienceListSchema,
	learningHealingStatusSchema,
	mailInboxSchema,
	mailMessageSchema,
	notificationRecordSchema,
	proactiveSuggestionRecordSchema,
	questJudgeResultSchema,
	questRecordSchema,
	rpcJsonResponseSchema,
	timelineEventRecordSchema,
	timelineJournalRecordSchema,
	warmupDetectionSchema,
} from "@ryu/app-host/rpc";
import { z } from "zod";
import { listActivity } from "@/src/lib/api/activity.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import {
	approveApproval,
	listApprovals,
	rejectApproval,
} from "@/src/lib/api/approvals.ts";
import { toTarget } from "@/src/lib/api/client.ts";
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
import {
	ackNotification,
	archiveNotification,
	listNotifications,
	markNotificationRead,
	redactConnectSuggestionNotifications,
	unarchiveNotification,
} from "@/src/lib/api/notifications.ts";
import { pluginHostInvoke } from "@/src/lib/api/plugins.ts";
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
import { fetchRunTrace } from "@/src/lib/api/runs.ts";
import { fetchJobs } from "@/src/lib/api/schedules.ts";
import {
	getJournal,
	getProactiveInbox,
	getSpeechHistory,
	getTimeline,
	postFeedback,
} from "@/src/lib/api/shadow.ts";
import {
	applyWarmupJobs,
	detectWarmupAgents,
	listWarmupJobs,
	runWarmupJobNow,
} from "@/src/lib/api/warmup.ts";
import { fetchWorkflows } from "@/src/lib/api/workflows.ts";
import { createScheduledAgentWorkflow } from "@/src/lib/automations.ts";
import {
	enrichTimelineJournal,
	sanitizeTimelineEvents,
} from "@/src/lib/timeline-app-icons.ts";
import { getUserAvailabilitySnapshot } from "@/src/lib/user-availability.ts";
import { sendCompanionMail } from "./mail-send-service.ts";
import {
	activityScoreInputSchema,
	mailProviderInputSchema,
	notificationSendResponseSchema,
	questCaptureInputSchema,
	questKindInputSchema,
	questWriteInputSchema,
} from "./node-response-contracts.ts";
import { resolveAppIconTile } from "./PluginHostPanel-app-icon-tile.ts";
import { fetchFrameDataUrl } from "./PluginHostPanel-host-media.ts";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";

export function buildPluginHostAppServices({
	companion,
	meId,
	node,
	openGateway,
	openTab,
}: PluginHostServicesContext): Partial<HostServices> {
	return {
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
			updateQuest(toTarget(node), id, questWriteInputSchema.parse(input)).then(
				questRecordSchema.parse
			),
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
			dismissQuestSuggestion(toTarget(node), id).then(questRecordSchema.parse),
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
			getHealingStatus(toTarget(node)).then(learningHealingStatusSchema.parse),
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
			rejectApproval(toTarget(node), id, note).then(approvalRecordSchema.parse),
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
		notificationsMarkRead: ({ id }) => markNotificationRead(toTarget(node), id),
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
			getProactiveInbox().then(z.array(proactiveSuggestionRecordSchema).parse),
		suggestionsFeedback: ({ kind, suggestion_type }) =>
			postFeedback({ kind, suggestion_type }),
		suggestionsOpenInChat: ({ prompt }) =>
			openTab("/chat", {
				forceNew: true,
				initialPrompt: prompt,
				title: "Chat",
			}),
	};
}

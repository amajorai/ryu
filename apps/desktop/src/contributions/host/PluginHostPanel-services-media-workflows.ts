import {
	finetuneServicesViaAppRequest,
	finetuneStreamPath,
} from "@ryu/app-host/finetune-compat";
import { ghostRecipesViaAppMount } from "@ryu/app-host/recipes-compat";
import {
	type HostServices,
	rpcJsonResponseSchema,
	type UploadFileResult,
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
import { voiceAudioDataUrl } from "@ryu/app-host/voice-services";
import { browserRecordingHost } from "@ryu/blocks/companion/browser-recording.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import { ownAppRequest } from "@/src/lib/api/app-request.ts";
import { searchGifs, searchImages } from "@/src/lib/api/assets.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	fetchComposioConnections,
	fetchComposioStatus,
	fetchComposioToolkits,
	fetchComposioTriggers,
} from "@/src/lib/api/composio.ts";
import { fetchEngineModels } from "@/src/lib/api/engines.ts";
import { fetchMcpServers, fetchMcpTools } from "@/src/lib/api/mcp.ts";
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
import { listMentionTargetUsers } from "@/src/lib/api/notifications.ts";
import {
	fetchApps,
	getPluginContributions,
	ownAppEventStream,
	pluginHostInvoke,
} from "@/src/lib/api/plugins.ts";
import { getVoiceInputPrefs } from "@/src/lib/api/preferences.ts";
import {
	getRecordingStatus,
	startRecording,
	stopRecording,
} from "@/src/lib/api/recipes.ts";
import { fetchJobs } from "@/src/lib/api/schedules.ts";
import { listSkills } from "@/src/lib/api/skills.ts";
import { fileToDataUrl, uploadUserFile } from "@/src/lib/api/uploads.ts";
import {
	speakText as apiSpeakText,
	transcribeAudio as apiTranscribeAudio,
	transcribeAudioDetailed as apiTranscribeAudioDetailed,
	installTtsEngine as installTtsEngineApi,
	listTtsEngines,
} from "@/src/lib/api/voice.ts";
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
import { createCompanionTranscribeAudio } from "./companion-voice-engine.ts";
import { createCompanionMediaServices } from "./media-host-services.ts";
import { inlineToDataUrl, pickFiles } from "./PluginHostPanel-host-media.ts";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";

export function buildPluginHostMediaWorkflowServices({
	companion,
	mediaPermission,
	node,
}: PluginHostServicesContext): Partial<HostServices> {
	return {
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
		monitorsUpdate: ({ id, input }) => updateMonitor(toTarget(node), id, input),
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
		workflowsVersionsList: ({ id }) => listWorkflowVersions(toTarget(node), id),
		workflowsVersionGet: ({ id, versionId }) =>
			getWorkflowVersionDefinition(toTarget(node), id, versionId),
		workflowsVersionCreate: async ({ id, label, expectedRevision }) => {
			await createWorkflowVersion(toTarget(node), id, label, expectedRevision);
		},
		workflowsVersionRestore: ({ id, versionId }) =>
			restoreWorkflowVersion(toTarget(node), id, versionId),
		workflowsTemplatesList: () => fetchWorkflowTemplates(toTarget(node)),
		workflowsTemplateGet: ({ id }) => fetchWorkflowTemplate(toTarget(node), id),
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
	};
}

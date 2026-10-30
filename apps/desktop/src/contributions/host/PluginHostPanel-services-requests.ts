import { checkAppBundle } from "@ryu/app-host/app-bundle";
import { appRequestService } from "@ryu/app-host/app-request-target";
import {
	type HostServices,
	meetingRecordSchema,
	meetingTranscriptSchema,
	rpcJsonResponseSchema,
	skillSourceRecordSchema,
	skillVersionRecordsSchema,
	skillWriteRecordSchema,
} from "@ryu/app-host/rpc";
import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import { RealtimeConnection } from "@ryuhq/core-client/realtime.ts";
import { z } from "zod";
import { waitForApplicationRealtime } from "@/src/contributions/host/application-realtime-lifetime.ts";
import { ApplicationRealtimeQueue } from "@/src/contributions/host/application-realtime-queue.ts";
import { ownAppRequest } from "@/src/lib/api/app-request.ts";
import { blueprintRequest } from "@/src/lib/api/blueprint.ts";
import { realtimeJwtForTarget, toTarget } from "@/src/lib/api/client.ts";
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
import { newsRequest } from "@/src/lib/api/news.ts";
import { installCompanionAppBundle } from "@/src/lib/api/plugins.ts";
import { reasoningRequest } from "@/src/lib/api/reasoning.ts";
import { rlmRequest } from "@/src/lib/api/rlm.ts";
import { safeActionsRequest } from "@/src/lib/api/safe-actions.ts";
import {
	createSkill,
	getSkillSource,
	getSkillVersionSource,
	listSkillVersions,
	restoreSkillVersion,
	snapshotSkill,
	updateSkill,
} from "@/src/lib/api/skills.ts";
import { socialRequest } from "@/src/lib/api/social.ts";
import { subtitlesRequest } from "@/src/lib/api/subtitles.ts";
import { tuitionRequest } from "@/src/lib/api/tuition.ts";
import { meetingSourceInputSchema } from "./node-response-contracts.ts";
import { pickAudioFile } from "./PluginHostPanel-host-media.ts";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";

export function buildPluginHostRequestServices({
	approvedGrantList,
	companion,
	currentTabId,
	distributeInstalledSkill,
	node,
	openTab,
	realtimeLifetimeRef,
	realtimeSessionsRef,
	updateTabTitle,
	updateTabsIconWhere,
}: PluginHostServicesContext): Partial<HostServices> {
	return {
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
			renameMeeting(toTarget(node), id, title).then(meetingRecordSchema.parse),
		meetingsSetIcon: async ({ id, icon }) => {
			const updated = await setMeetingIcon(toTarget(node), id, icon);
			const glyph = asGlyphValue(icon) ?? null;
			updateTabsIconWhere(
				(t) =>
					t.path === `/meetings/${id}` || t.path.startsWith(`/meetings/${id}?`),
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
			subtitlesRequest(toTarget(node), input).then(rpcJsonResponseSchema.parse),
		// Automated Reasoning — the @ryu/reasoning companion authors formal policies
		// and runs the solver playground. Same one-forwarder shape as Outpost, and
		// the same security note applies: `reasoningRequest` in `lib/api/reasoning.ts`
		// owns the path check (leading slash, not protocol-relative, no backslash,
		// resolving under `/api/reasoning` per the WHATWG parser rather than a literal
		// `..` blocklist), and `rpc.ts`'s `asReasoningRequestArg` applies the identical
		// rules one layer earlier. There is no `open` verb because the companion is the
		// whole surface — it never navigates the shell.
		reasoningRequest: (input) =>
			reasoningRequest(toTarget(node), input).then(rpcJsonResponseSchema.parse),
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
			blueprintRequest(toTarget(node), input).then(rpcJsonResponseSchema.parse),
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
	};
}

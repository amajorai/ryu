// Chat composer mentions and autocomplete: workflow directory, @-mention
// candidates (agents, people, apps, files) and human mention notifications.

import { fetchAgents } from "@ryuhq/core-client/agents";
import type { MentionTargetUser } from "@ryuhq/core-client/notifications";
import { type AppInfo, fetchApps } from "@ryuhq/core-client/plugins";
import { fetchWorkflows, type Workflow } from "@ryuhq/core-client/workflows";
import { useCallback, useEffect, useRef } from "react";
import {
	type AutocompleteSuggestion,
	agentSuggestions,
	appPluginSuggestions,
	commandSuggestions,
	getAutocompleteContext,
	humanSuggestions,
	slashArgumentSuggestions,
	workflowSuggestions,
} from "../../core/autocomplete.ts";
import { isLocal } from "../../core/bootstrap.ts";
import { searchFiles } from "../../core/fileMentions.ts";
import {
	type ActiveAccountIdentity,
	fetchActiveAccountIdentity,
	inboxEnabled,
	listMentionTargetUsers,
	notifyMentionedUsers,
	type SelectedHumanMention,
	selectHumanNotificationTargets,
} from "../../core/humanMentions.ts";
import {
	EMPTY_APPS,
	EMPTY_MENTION_USERS,
	EMPTY_WORKFLOWS,
	FILE_SEARCH_DEBOUNCE_MS,
} from "./index-constants.ts";
import type { ChatSurfaceContext } from "./index-context.ts";

type UseChatMentionsDeps = Pick<
	ChatSurfaceContext,
	| "activeAcpCommands"
	| "composer"
	| "composerRef"
	| "contributedSlashCommands"
	| "dismissedSlashArgumentValue"
	| "notify"
	| "setAutocomplete"
	| "setWorkflowDirectory"
	| "simpleInterface"
	| "slashCommandState"
	| "target"
	| "workflowDirectory"
>;

export function useChatMentions(deps: UseChatMentionsDeps) {
	const {
		activeAcpCommands,
		composer,
		composerRef,
		contributedSlashCommands,
		dismissedSlashArgumentValue,
		notify,
		setAutocomplete,
		setWorkflowDirectory,
		simpleInterface,
		slashCommandState,
		target,
		workflowDirectory,
	} = deps;
	const workflowsRef = useRef<Workflow[]>([]);
	const availableWorkflows =
		!simpleInterface &&
		workflowDirectory?.target.url === target.url &&
		workflowDirectory.target.token === (target.token ?? null) &&
		workflowDirectory.target.userJwt === (target.userJwt ?? null)
			? workflowDirectory.workflows
			: EMPTY_WORKFLOWS;
	workflowsRef.current = availableWorkflows;
	const mentionRequestIdRef = useRef(0);
	const mentionAppsCacheRef = useRef<{
		apps: AppInfo[];
		targetKey: string;
	} | null>(null);
	const mentionAppsRequestRef = useRef<{
		promise: Promise<AppInfo[]>;
		targetKey: string;
	} | null>(null);
	const mentionPeopleCacheRef = useRef<{
		directory: {
			identity: ActiveAccountIdentity | null;
			users: MentionTargetUser[];
		};
		targetKey: string;
	} | null>(null);
	const mentionPeopleRequestRef = useRef<{
		promise: Promise<{
			identity: ActiveAccountIdentity | null;
			users: MentionTargetUser[];
		}>;
		targetKey: string;
	} | null>(null);
	const selectedHumanMentionsRef = useRef<SelectedHumanMention[]>([]);
	const mentionTargetKey = JSON.stringify([
		target.url,
		target.token ?? null,
		target.userJwt ?? null,
	]);
	const loadMentionApps = useCallback(() => {
		if (mentionAppsCacheRef.current?.targetKey === mentionTargetKey) {
			return Promise.resolve(mentionAppsCacheRef.current.apps);
		}
		if (mentionAppsRequestRef.current?.targetKey === mentionTargetKey) {
			return mentionAppsRequestRef.current.promise;
		}

		const promise = fetchApps(target).then((apps) => {
			if (mentionAppsRequestRef.current?.promise === promise) {
				mentionAppsCacheRef.current = { apps, targetKey: mentionTargetKey };
			}
			return apps;
		});
		mentionAppsRequestRef.current = { promise, targetKey: mentionTargetKey };
		const clearPending = () => {
			if (mentionAppsRequestRef.current?.promise === promise) {
				mentionAppsRequestRef.current = null;
			}
		};
		void promise.then(clearPending, clearPending);
		return promise;
	}, [mentionTargetKey, target]);
	const loadHumanMentionDirectory = useCallback(() => {
		if (mentionPeopleCacheRef.current?.targetKey === mentionTargetKey) {
			return Promise.resolve(mentionPeopleCacheRef.current.directory);
		}
		if (mentionPeopleRequestRef.current?.targetKey === mentionTargetKey) {
			return mentionPeopleRequestRef.current.promise;
		}

		const promise = Promise.all([
			listMentionTargetUsers(target),
			fetchActiveAccountIdentity(target),
		]).then(([users, identity]) => {
			const directory = { identity, users };
			if (mentionPeopleRequestRef.current?.promise === promise) {
				mentionPeopleCacheRef.current = {
					directory,
					targetKey: mentionTargetKey,
				};
			}
			return directory;
		});
		mentionPeopleRequestRef.current = { promise, targetKey: mentionTargetKey };
		const clearPending = () => {
			if (mentionPeopleRequestRef.current?.promise === promise) {
				mentionPeopleRequestRef.current = null;
			}
		};
		void promise.then(clearPending, clearPending);
		return promise;
	}, [mentionTargetKey, target]);

	useEffect(() => {
		if (simpleInterface) {
			setWorkflowDirectory(null);
			return;
		}
		const controller = new AbortController();
		const source = {
			token: target.token ?? null,
			url: target.url,
			userJwt: target.userJwt ?? null,
		};
		fetchWorkflows(target, controller.signal)
			.then((workflows) => setWorkflowDirectory({ target: source, workflows }))
			.catch(() => {
				if (!controller.signal.aborted) {
					setWorkflowDirectory({ target: source, workflows: [] });
				}
			});
		return () => controller.abort();
	}, [simpleInterface, target]);

	// Slash commands are local and immediate. Mention candidates come from the
	// same Core agent catalog as Ctrl+A, but stale responses never replace newer
	// input.
	useEffect(() => {
		const requestId = mentionRequestIdRef.current + 1;
		mentionRequestIdRef.current = requestId;
		const context = getAutocompleteContext(composer, contributedSlashCommands);
		if (!context) {
			setAutocomplete(null);
			return;
		}
		if (context.kind === "slash-argument") {
			if (dismissedSlashArgumentValue === composer) {
				setAutocomplete(null);
				return;
			}
			const suggestions: AutocompleteSuggestion[] =
				slashArgumentSuggestions(context);
			if (slashCommandState === "error") {
				suggestions.push({ kind: "retry-slash-commands" });
			}
			setAutocomplete({ context, suggestions, index: 0 });
			return;
		}
		if (context.kind === "slash") {
			const suggestions: AutocompleteSuggestion[] = commandSuggestions(
				context.query,
				contributedSlashCommands,
				activeAcpCommands
			).filter(
				(suggestion) =>
					!simpleInterface ||
					suggestion.kind !== "command" ||
					(suggestion.name !== "model" &&
						suggestion.name !== "reasoning" &&
						suggestion.name !== "agent" &&
						suggestion.name !== "group")
			);
			if (slashCommandState === "error") {
				suggestions.push({ kind: "retry-slash-commands" });
			}
			setAutocomplete({ context, suggestions, index: 0 });
			return;
		}
		if (simpleInterface) {
			setAutocomplete(null);
			return;
		}
		if (context.kind === "file") {
			// File paths come from this machine, so they only describe the node's
			// workspace when Core runs locally.
			if (!isLocal(target.url)) {
				setAutocomplete({
					context,
					index: 0,
					notice: "File mentions need a local node",
					suggestions: [],
				});
				return;
			}
			setAutocomplete({ context, index: 0, loading: true, suggestions: [] });
			let cancelled = false;
			const timer = setTimeout(() => {
				void searchFiles(process.cwd(), context.query).then((paths) => {
					if (cancelled || mentionRequestIdRef.current !== requestId) {
						return;
					}
					setAutocomplete({
						context,
						index: 0,
						suggestions: paths.map((path) => ({ kind: "file", path })),
					});
				});
			}, FILE_SEARCH_DEBOUNCE_MS);
			return () => {
				cancelled = true;
				clearTimeout(timer);
			};
		}
		setAutocomplete({ context, index: 0, loading: true, suggestions: [] });
		void Promise.all([
			fetchAgents(target).catch(() => []),
			loadMentionApps().catch(() => EMPTY_APPS),
		]).then(async ([agents, mentionApps]) => {
			const inboxIsEnabled = mentionApps.some(
				(app) => app.id === "@ryu/approvals" && app.enabled
			);
			const people = inboxIsEnabled
				? await loadHumanMentionDirectory().catch(() => ({
						identity: null,
						users: EMPTY_MENTION_USERS,
					}))
				: { identity: null, users: EMPTY_MENTION_USERS };
			if (
				composerRef.current !== composer ||
				mentionRequestIdRef.current !== requestId
			) {
				return;
			}
			const latest = getAutocompleteContext(composer);
			if (latest?.kind !== "mention") {
				return;
			}
			const workflows = workflowSuggestions(workflowsRef.current, latest.query);
			const appsAndPlugins = appPluginSuggestions(mentionApps, latest.query);
			const humans = humanSuggestions(
				people.users,
				latest.query,
				people.identity?.userId ?? null
			);
			setAutocomplete({
				context: latest,
				suggestions: [
					...agentSuggestions(agents, latest.query),
					...humans,
					...appsAndPlugins,
					...workflows,
				],
				index: 0,
			});
		});
	}, [
		activeAcpCommands,
		availableWorkflows,
		composer,
		contributedSlashCommands,
		dismissedSlashArgumentValue,
		loadHumanMentionDirectory,
		loadMentionApps,
		slashCommandState,
		simpleInterface,
		target,
	]);

	const notifySelectedHumanMentions = useCallback(
		(content: string) => {
			const directory =
				mentionPeopleCacheRef.current?.targetKey === mentionTargetKey
					? mentionPeopleCacheRef.current.directory
					: null;
			const mentions = selectHumanNotificationTargets({
				content,
				currentUserId: directory?.identity?.userId ?? null,
				selected: selectedHumanMentionsRef.current,
			});
			selectedHumanMentionsRef.current = [];
			if (simpleInterface || mentions.length === 0) {
				return;
			}
			const senderName =
				directory?.identity?.name?.trim() ||
				directory?.identity?.email?.trim() ||
				"Someone";
			void inboxEnabled(target)
				.then((enabled) =>
					enabled
						? notifyMentionedUsers({
								content,
								mentions,
								senderName,
								target,
							})
						: { failedNames: [] }
				)
				.then(({ failedNames }) => {
					if (failedNames.length > 0) {
						notify(
							`Couldn't notify ${failedNames.join(", ")}`.slice(0, 180),
							"error"
						);
					}
				})
				.catch(() => {
					notify(
						`Couldn't notify ${mentions.map((mention) => mention.label).join(", ")}`.slice(
							0,
							180
						),
						"error"
					);
				});
		},
		[mentionTargetKey, notify, simpleInterface, target]
	);
	return {
		notifySelectedHumanMentions,
		selectedHumanMentionsRef,
		workflowsRef,
	};
}

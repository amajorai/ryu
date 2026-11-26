import {
	type FeedbackActions,
	FeedbackHostContext,
} from "@ryu/blocks/desktop/agent-elements/feedback-host-context.tsx";
import { activeLocale } from "@ryu/i18n/core";
import { getVersion } from "@tauri-apps/api/app";
import { type ReactNode, useMemo, useRef } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { getVersionInfo, type VersionInfo } from "@/src/lib/api/update.ts";
import {
	type FeedbackEnvironment,
	feedbackAttachments,
} from "@/src/lib/feedback-environment.ts";
import { openFeedbackWidget } from "@/src/lib/userjot.ts";

/**
 * Desktop side of the in-chat feedback card (`feedback.draft`).
 *
 * The card shows the agent's draft; this host adds what only the app knows
 * (versions, system, the conversation's agent and model, recent errors) and
 * owns the destination. In this first version sending copies the report and
 * opens the existing feedback board, where the user posts it. Nothing is
 * uploaded from here.
 */

/** What the host reads from the chat the card renders in, at click time. */
export interface ChatFeedbackSources {
	agentId: string | null;
	model: string | null;
	/** The conversation's newest messages, for the recent errors of a bug. */
	readMessages: () => readonly unknown[];
	target: ApiTarget;
}

/** The device and network calls, injectable so tests need no shell. */
export interface ChatFeedbackDeps {
	appVersion: () => Promise<string>;
	locale: () => string;
	openBoard: () => Promise<void>;
	versionInfo: (target: ApiTarget) => Promise<VersionInfo>;
	writeClipboard: (text: string) => Promise<void>;
}

const GATEWAY_COMPONENT = /gateway/i;

const defaultDeps: ChatFeedbackDeps = {
	appVersion: () => getVersion(),
	locale: () => activeLocale(),
	openBoard: () => openFeedbackWidget("light"),
	versionInfo: (target) => getVersionInfo(target),
	writeClipboard: (text) => navigator.clipboard.writeText(text),
};

/** Read the versions, failing soft: an unreachable Core leaves lines out. */
async function readEnvironment(
	sources: ChatFeedbackSources,
	deps: ChatFeedbackDeps
): Promise<FeedbackEnvironment> {
	const [appVersion, info] = await Promise.all([
		deps.appVersion().catch(() => null),
		deps.versionInfo(sources.target).catch(() => null),
	]);
	const gateway = info?.components.find((component) =>
		GATEWAY_COMPONENT.test(component.name)
	);
	return {
		agentId: sources.agentId,
		appVersion,
		coreVersion: info?.ryu_version ?? null,
		gatewayVersion: gateway?.version ?? null,
		locale: deps.locale(),
		model: sources.model,
		system: info?.platform ?? null,
	};
}

/**
 * The actions for one chat. `read` is called on every action, so the card
 * always acts on the chat's current agent, model, node and messages.
 */
export function createChatFeedbackActions(
	read: () => ChatFeedbackSources,
	deps: ChatFeedbackDeps = defaultDeps
): FeedbackActions {
	return {
		async collectAttachments(kind) {
			const sources = read();
			const environment = await readEnvironment(sources, deps);
			return feedbackAttachments(kind, environment, sources.readMessages());
		},

		openDestination: () => deps.openBoard(),

		async submitFeedback(submission) {
			// The copy is the send in this version: if it fails, nothing left the
			// device and the card says so. A board that will not open is not a
			// failed send; the card offers to open it again.
			await deps.writeClipboard(submission.report);
			const destinationOpened = await deps.openBoard().then(
				() => true,
				() => false
			);
			return { destinationOpened, status: "copied" };
		},
	};
}

/** Provides the feedback host to the cards of one chat transcript. */
export function ChatFeedbackHost({
	agentId,
	children,
	model,
	readMessages,
	target,
}: {
	agentId?: string | null;
	children: ReactNode;
	model?: string | null;
	readMessages: () => readonly unknown[];
	target: ApiTarget;
}) {
	// Read through a ref so the actions stay one object for the chat's lifetime
	// (the card collects once per mount) while still seeing the latest values.
	const sources = useRef<ChatFeedbackSources>({
		agentId: agentId ?? null,
		model: model ?? null,
		readMessages,
		target,
	});
	sources.current = {
		agentId: agentId ?? null,
		model: model ?? null,
		readMessages,
		target,
	};
	const actions = useMemo(
		() => createChatFeedbackActions(() => sources.current),
		[]
	);
	return (
		<FeedbackHostContext.Provider value={actions}>
			{children}
		</FeedbackHostContext.Provider>
	);
}

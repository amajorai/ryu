import { openTabWindow } from "@/lib/tauri-bridge.ts";
import {
	invokeWhenReady,
	listenWhenReady,
	TauriUnavailableError,
} from "@/src/lib/tauri-ready.ts";

export const ENTITY_ACTIVATION_EVENT = "ryu:activate-entity";

export type EntityRouteAction = "createCurrent" | "current" | "focused";

export interface EntityRouteResult {
	action: EntityRouteAction;
	windowLabel?: string | null;
}

export interface EntityActivation {
	key: string;
	messageId?: string;
}

export interface TabEntitySource {
	conversationId?: string;
}

export interface WindowTabRegistration {
	active: boolean;
	key: string;
}

/** Only the main shell consumes app/agent navigation events. Tear-off and
 * companion windows render the same Layout, but a broadcast request must not
 * open or replace a tab in every window at once. */
export function isMainWindow(): boolean {
	try {
		const tauriWindow: Window & {
			__TAURI_INTERNALS__?: {
				metadata?: { currentWindow?: { label?: unknown } };
			};
		} = window;
		const label =
			tauriWindow.__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
		return typeof label !== "string" || label === "main";
	} catch {
		return true;
	}
}

/** Conversation ids are Core-owned identifiers, so they are the stable key
 * shared by renderers. Encoding keeps the protocol unambiguous even if a
 * future importer uses punctuation that looks like a key separator. */
export function conversationEntityKey(conversationId: string): string {
	return `conversation:${encodeURIComponent(conversationId)}`;
}

export function tabEntityKey(tab: TabEntitySource): string | null {
	return tab.conversationId ? conversationEntityKey(tab.conversationId) : null;
}

/** Register the current renderer's tab snapshot with the native process. Plain
 * browser/story renders intentionally degrade to a no-op. */
export async function registerWindowTabs(
	rendererId: string,
	revision: number,
	entries: WindowTabRegistration[]
): Promise<void> {
	try {
		await invokeWhenReady<void>("register_window_tabs", {
			rendererId,
			revision,
			tabs: entries,
		});
	} catch (error) {
		if (!(error instanceof TauriUnavailableError)) {
			// Registration is advisory. A renderer can still route locally if the
			// native registry is unavailable, so do not turn a transient window
			// lifecycle race into an unhandled effect rejection.
			return;
		}
	}
}

/** Ask the native process to focus the window that owns an entity. The caller
 * opens locally only for `current`/`createCurrent`; `focused` means the native
 * process already emitted activation to another renderer. */
export async function routeEntityOpen(
	key: string,
	activation?: { messageId?: string }
): Promise<EntityRouteAction> {
	if (!key) {
		return "createCurrent";
	}
	try {
		const result = await invokeWhenReady<EntityRouteResult>(
			"route_entity_open",
			{ key, messageId: activation?.messageId }
		);
		return result.action;
	} catch {
		// Webapp/story mode and a native window that is closing both need the
		// same safe fallback: let the current renderer's existing openTab logic
		// decide whether to reuse or create a local tab.
		return "createCurrent";
	}
}

export async function openEntityInNewWindow(opts: {
	conversationId?: string;
	node?: string;
	path?: string;
	title?: string;
}): Promise<void> {
	try {
		await openTabWindow({
			...opts,
			entityKey: opts.conversationId
				? conversationEntityKey(opts.conversationId)
				: undefined,
		});
	} catch {
		// A sidebar action is best-effort in browser/story mode and while the native
		// app is closing; neither case should surface an unhandled rejection.
	}
}

export async function listenForEntityActivation(
	onActivate: (activation: EntityActivation) => void
): Promise<() => void> {
	return listenWhenReady<{ key?: unknown; messageId?: unknown }>(
		ENTITY_ACTIVATION_EVENT,
		({ payload }) => {
			if (typeof payload.key === "string" && payload.key.length > 0) {
				onActivate({
					key: payload.key,
					messageId:
						typeof payload.messageId === "string" &&
						payload.messageId.length > 0
							? payload.messageId
							: undefined,
				});
			}
		}
	);
}

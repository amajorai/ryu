// Route elements shared by the built-in route table (see `../builtins.ts`): the
// generic companion-alias mount and the chat surface's crash boundary.

import { createElement, type ReactNode } from "react";
import { CrashBoundary } from "@/src/components/CrashBoundary.tsx";
import PluginCompanionPage, {
	CompanionUnavailable,
} from "@/src/pages/PluginCompanionPage.tsx";
import type { RouteTab } from "../registry.ts";
import { useCompanionAlias } from "../use-companion-alias.ts";

/**
 * Mount whatever enabled app answers to `alias`, or nothing.
 *
 * The generic replacement for a hardcoded `companionId`. `mountContext` is forwarded
 * untouched so the context-carrying deep links (`/timeline/:ts` → `focusTs`,
 * `/meetings/:id` → `meetingId`, `/workflows/:id` → `workflowId`,
 * `/skills/:id/edit` → `skillId`) keep baking their parameter into the sandboxed
 * frame as `window.ryu.context.*` — losing that would be a silent regression, since
 * the sandbox cannot receive the window events the old desktop pages used.
 */
export function CompanionAliasRoute({
	alias,
	mountContext,
}: {
	alias: string;
	mountContext?: unknown;
}) {
	const companionId = useCompanionAlias(alias);
	if (!companionId) {
		// NOT `null`. A blank tab is the one outcome worse than a hardcoded route:
		// most apps ship not pre-installed, so on a fresh install the palette's "Inbox"
		// row, an OS notification click, the Timeline hotkey and the tray's
		// "Open Timeline" all reach this branch, and blank gives the user nothing to
		// read and nothing to do. Shares one definition with the by-id mount below so
		// the two cannot drift.
		return createElement(CompanionUnavailable);
	}
	return createElement(PluginCompanionPage, { companionId, mountContext });
}

/** Element factory for a route that mounts an app by short path rather than by id. */
export const companionAlias = <TMountContext>(
	alias: string,
	mountContext?: TMountContext
) => createElement(CompanionAliasRoute, { alias, mountContext });

// SKILL_EDITOR_ALIAS + APPROVALS_ALIAS — the two legacy paths no app can derive from
// its own id — moved to `companion-alias.ts`, because the surfaces that decide whether
// to OFFER these paths (the sidebar footer's Inbox tray, an OS notification's click
// target) need the same strings and must resolve them against the same feed. Both
// still name a PATH, never a companion id, so they blank out when their app is
// disabled — and both disappear the moment the owning manifest claims the path itself
// (a `sidebar_buttons[].target`-style route claim; see the manifest follow-up).

/**
 * The chat surface's OWN crash boundary (#97).
 *
 * `CrashBoundary` used to exist only at the app root (`App.tsx`), so a render
 * error anywhere in a chat took the whole renderer down with it and recovery
 * remounted EVERY tab — a crash in one conversation cost the user the sidebar,
 * the tab strip, the titlebar and every other open tab, all of which were
 * perfectly healthy. Wrapping here narrows the blast radius to one tab's body:
 * `RouteOutlet` is mounted *inside* `Layout`, so the shell chrome sits above
 * this boundary and survives untouched.
 *
 * WRAPPED AT THE ROUTE RATHER THAN INSIDE `ChatPage` for three reasons: it
 * catches crashes in ChatPage's own hooks and in `WorkspacePanels`, not just in
 * the transcript below them; `tab.conversationId` — the reset key — is already
 * in scope here and nowhere near the transcript; and the dock-hosted path
 * (`WorkspacePanels` renders the same `RouteOutlet`) gets the boundary for free.
 *
 * KNOWN LIMIT, stated rather than papered over: the composer does NOT survive a
 * transcript crash. `AgentChat` (@ryu/blocks) owns the message list and the
 * composer together and `ChatSlots` exposes no `MessageList` seam, so the
 * narrowest boundary reachable from this side still contains both. Fixing that
 * properly means adding a `MessageList` slot to `ChatSlots` and wrapping only
 * the list — an edit inside `packages/blocks`, whoever owns it.
 *
 * `resetKeys` is the conversation id: opening a different chat in the same tab
 * is a different bug, so it clears the crash and hands the new conversation a
 * fresh retry budget instead of inheriting a spent one. `undefined` (a brand-new
 * chat that has not bound an id yet) is a legitimate key — `resetKeysChanged`
 * compares by `Object.is`, so `undefined → "<id>"` reads as a change exactly
 * once, when `ChatPage` binds the tab to its conversation.
 */
export const chatBoundary = (tab: RouteTab, children: ReactNode) =>
	createElement(CrashBoundary, { children, resetKeys: [tab.conversationId] });

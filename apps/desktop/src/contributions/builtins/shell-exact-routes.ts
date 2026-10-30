// The shell-page slice of the built-in exact routes (see `../builtins.ts`): chat,
// settings, vault, review and the other long-tail pages.

import { createElement } from "react";
import { queryClient } from "@/src/lib/query-client.ts";
import {
	downloadsHistoryQuery,
	prefetchRouteQueries,
	REVIEW_DEFAULT_DAYS,
	vaultSecretsQuery,
	weeklyReviewQuery,
} from "@/src/lib/route-queries.ts";
import { PANE_CHOOSER_PATH } from "@/src/lib/splitPresets.ts";
import ChatPage from "@/src/pages/ChatPage.tsx";
import { APPROVALS_ALIAS, SKILL_EDITOR_ALIAS } from "../companion-alias.ts";
import { chatBoundary, companionAlias } from "./companion-routes.ts";
import {
	ComputePage,
	DownloadsPage,
	IdentitiesPage,
	KnowledgeGraphPage,
	PaneChooserPage,
	ReviewPage,
	SettingsPage,
	SharePage,
	VaultPage,
	WorkflowsPage,
} from "./lazy-pages.ts";
import type { ExactRouteRegistrar } from "./registrars.ts";

/** Exact routes for the chat surface and the shell's own pages. */
// one flat registration list, mirroring the old tab router branch-for-branch.
export function registerShellExactRoutes(exact: ExactRouteRegistrar): void {
	exact("/chat", (tab) =>
		chatBoundary(
			tab,
			createElement(ChatPage, {
				initialAgent: tab.initialAgent,
				initialTeamId: tab.initialTeamId,
				initialGhost: tab.initialGhost,
				initialPluginFlags: tab.initialPluginFlags,
				initialImages: tab.initialImages,
				initialProject: tab.initialProject,
				initialPrompt: tab.initialPrompt,
				initialQuote: tab.initialQuote,
				initialModel: tab.initialModel,
				initialProactiveOpening: tab.initialProactiveOpening,
				initialSubmit: tab.initialSubmit,
				tabConversationId: tab.conversationId,
				tabWorktreeMode: tab.worktreeMode,
			})
		)
	);
	exact("/compute", () => createElement(ComputePage), ComputePage.preload);
	exact("/share", () => createElement(SharePage), SharePage.preload);
	exact(
		"/identities/new",
		() => createElement(IdentitiesPage, { initialNew: true }),
		IdentitiesPage.preload
	);
	// Pages whose first read is a shared query also warm that data on hover, so
	// the click renders from cache instead of a skeleton.
	exact(
		"/vault",
		() => createElement(VaultPage),
		() =>
			Promise.all([
				VaultPage.preload(),
				prefetchRouteQueries((target) => [
					queryClient.prefetchQuery(vaultSecretsQuery(target)),
				]),
			]).then<void>(() => undefined)
	);
	// The SKILL.md authoring editor (fresh draft). Both `/skills/new` and the
	// `/skills/:id/edit` pattern route below mount whichever app answers to
	// SKILL_EDITOR_ALIAS; new-draft mode carries no mount context (the companion
	// detects the absent `window.ryu.context.skillId`).
	exact("/skills/new", () => companionAlias(SKILL_EDITOR_ALIAS));
	exact(
		"/graph",
		() => createElement(KnowledgeGraphPage),
		KnowledgeGraphPage.preload
	);
	exact(
		"/review",
		() => createElement(ReviewPage),
		() =>
			Promise.all([
				ReviewPage.preload(),
				queryClient.prefetchQuery(weeklyReviewQuery(REVIEW_DEFAULT_DAYS)),
			]).then<void>(() => undefined)
	);
	// The NL workflow builder (fresh draft). The visual canvas is the
	// @ryu/workflows companion (see the /workflows/:id pattern route below); the
	// builder is architecturally shell-only, so it keeps its own shell page.
	exact(
		"/workflows/build",
		() => createElement(WorkflowsPage, { initialWorkflowId: null }),
		WorkflowsPage.preload
	);
	// `/approvals` itself needs no entry — the catch-all derives it from the app's
	// companion id — but `/inbox` is the historic alias of the same surface, and no
	// convention can get there from "approvals".
	exact("/inbox", () => companionAlias(APPROVALS_ALIAS));
	exact(
		"/downloads",
		() => createElement(DownloadsPage),
		() =>
			Promise.all([
				DownloadsPage.preload(),
				prefetchRouteQueries((target) => [
					queryClient.prefetchQuery(downloadsHistoryQuery(target)),
				]),
			]).then<void>(() => undefined)
	);
	// An empty split pane: the picker that replaces itself with whatever the
	// user chooses. Reached only by applying a layout preset (and by a session
	// restore that revives one), never from the sidebar or the palette.
	exact(
		PANE_CHOOSER_PATH,
		() => createElement(PaneChooserPage),
		PaneChooserPage.preload
	);
	exact("/settings", () => createElement(SettingsPage), SettingsPage.preload);
}

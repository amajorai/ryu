// apps/desktop/src/components/layout/PullRequestAutomationWatcher.tsx
//
// Mounts the Settings › Git pull request automations exactly once per main
// window. It used to live in the sidebar panel, which is mounted twice while
// the desktop sidebar is collapsed (docked panel plus hover float), so two
// watchers could address the same feedback.

import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useApps } from "@/src/hooks/useApps.ts";
import { usePullRequestAutomation } from "@/src/hooks/usePullRequestAutomation.ts";
import { PULL_REQUESTS_APP_ID } from "@/src/lib/api/pull-requests.ts";

export function PullRequestAutomationWatcher() {
	const { conversations } = useChatHistoryContext();
	const { apps } = useApps();
	const pullRequestsEnabled = apps.some(
		(app) => app.id === PULL_REQUESTS_APP_ID && app.enabled
	);
	usePullRequestAutomation({ conversations, pullRequestsEnabled });
	return null;
}

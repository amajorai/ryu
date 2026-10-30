// apps/desktop/src/components/chat/WorkspacePicker-environment-action.ts
//
// Runs a project environment action in the terminal dock panel for
// WorkspacePicker's environment action buttons.

import type { LiteralMessage } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback } from "react";
import { useTerminalPanelLocation } from "@/src/hooks/useTerminalPanelLocation.ts";
import { useDockPanelRequestStore } from "@/src/store/useDockPanelRequestStore.ts";
import type {
	ProjectEnvironment,
	ProjectEnvironmentScripts,
} from "@/src/store/useWorkspaceStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

function scriptForCurrentPlatform(scripts: ProjectEnvironmentScripts): string {
	const platform = navigator.platform.toLowerCase();
	const override = platform.includes("mac")
		? scripts.macos
		: platform.includes("win")
			? scripts.windows
			: platform.includes("linux")
				? scripts.linux
				: "";
	return override.trim() || scripts.default.trim();
}

export function useRunEnvironmentAction(
	closeMenus: () => void,
	folder: string | null,
	worktreePath: string | null | undefined,
	tl: LiteralMessage
) {
	const terminalShell = useWorkspaceStore((s) => s.terminalShell);
	const [terminalPanelLocation] = useTerminalPanelLocation();
	return useCallback(
		(environment: ProjectEnvironment, actionId: string) => {
			const action = environment.actions.find((item) => item.id === actionId);
			const actionCwd = worktreePath ?? folder;
			if (!(action && actionCwd)) {
				return;
			}
			const command = scriptForCurrentPlatform(action.scripts);
			if (!command) {
				toast.error(
					tl("{name} has no command for this platform", { name: action.name })
				);
				return;
			}
			const env = Object.fromEntries(
				environment.variables
					.filter((variable) => variable.key.trim())
					.map((variable) => [variable.key.trim(), variable.value])
			);
			env.RYU_PROJECT_PATH = folder ?? actionCwd;
			env.RYU_WORKTREE_PATH = actionCwd;
			useDockPanelRequestStore
				.getState()
				.open("terminal", "Terminal", terminalPanelLocation, {
					command,
					cwd: actionCwd,
					env,
					shell: terminalShell === "auto" ? null : terminalShell,
				});
			closeMenus();
		},
		[closeMenus, folder, terminalPanelLocation, terminalShell, tl, worktreePath]
	);
}

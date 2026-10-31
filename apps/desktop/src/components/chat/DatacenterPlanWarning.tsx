// apps/desktop/src/components/chat/DatacenterPlanWarning.tsx
//
// The inline warning shown wherever a personal Claude or ChatGPT plan could be used
// from a datacenter IP: Claude Code or Codex inside a Ryu Box, or a plan run on a node
// Ryu hosts (see planFromDatacenter in src/lib/cloud-agent-mode.ts). It follows the
// warning-tinted row of BoxCreditBanner and links the public "Where your agent runs"
// page.

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** The public page that explains the two kinds of cloud agent. */
export const WHERE_AGENTS_RUN_DOCS_PATH =
	"/docs/surfaces/desktop/user-guide/where-agents-run";

const trimSlash = (url: string) => url.replace(/\/$/, "");

/** True when the node at `url` is one Ryu hosts (a managed cloud node). */
export function useNodeManaged(url: string): boolean {
	return useNodeStore((state) =>
		state.nodes.some(
			(node) => node.managed === true && trimSlash(node.url) === trimSlash(url)
		)
	);
}

export function DatacenterPlanWarning({ className }: { className?: string }) {
	const openDocs = () => {
		void Promise.resolve(
			openExternal(`${FRONTEND_URL}${WHERE_AGENTS_RUN_DOCS_PATH}`)
		).catch(() => undefined);
	};
	return (
		<div
			className={cn(
				"flex min-w-0 items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-2 py-1.5 text-status-warning text-xs",
				className
			)}
			data-testid="datacenter-plan-warning"
			role="status"
		>
			<HugeiconsIcon className="mt-0.5 shrink-0" icon={Alert02Icon} size={13} />
			<span className="min-w-0 flex-1">
				If your Claude or ChatGPT plan is used here, it runs from a cloud
				server's IP address, not your own. Providers such as Anthropic can
				restrict or ban plan accounts used from datacenter or sandbox IPs. Use
				an API key here, or choose Agent on your computer: the agent stays on
				your machine and only the files and commands run in the cloud.
			</span>
			<Button
				className="shrink-0"
				onClick={openDocs}
				size="sm"
				type="button"
				variant="ghost"
			>
				Learn more
			</Button>
		</div>
	);
}

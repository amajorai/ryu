import { ArrowDown01Icon, FolderOpenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArtifactHostContext,
	type ArtifactHostValue,
	type HostArtifact,
} from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ButtonGroup,
	ButtonGroupSeparator,
} from "@ryu/ui/components/button-group.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { ThemeProvider } from "next-themes";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { InlineArtifact } from "../../src/components/chat/InlineArtifact.tsx";
import "../../src/index.css";

const ARTIFACT: HostArtifact = {
	content:
		"<div style='padding:16px;font:14px system-ui'>Artifact preview</div>",
	kind: "html",
	title: "ButtonGroup preview",
};

function WorkspaceFilesButtonGroup() {
	return (
		<ButtonGroup aria-label="Open project folder">
			<Button aria-label="Open in Files" size="icon-sm" variant="ghost">
				<HugeiconsIcon icon={FolderOpenIcon} />
			</Button>
			<ButtonGroupSeparator />
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button aria-label="Choose editor" size="icon-sm" variant="ghost">
							<HugeiconsIcon icon={ArrowDown01Icon} />
						</Button>
					}
				/>
				<DropdownMenuContent align="end">
					<DropdownMenuItem>Files</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</ButtonGroup>
	);
}

function Proof() {
	const [lastAction, setLastAction] = useState("No action yet");
	const host = useMemo<ArtifactHostValue>(
		() => ({
			Renderer: () => null,
			fetchContent: async () => null,
			openInPanel: () => setLastAction("Chat: opened in panel"),
			openInTab: () => setLastAction("Chat: opened in tab"),
			submitFollowUp: () => undefined,
		}),
		[]
	);

	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto flex max-w-5xl flex-col gap-6">
				<header className="flex flex-col gap-2">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Desktop UI proof
					</p>
					<h1 className="font-semibold text-2xl tracking-tight">
						Open-in actions use ghost ButtonGroups
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm">
						The chat card mounts the production artifact; the workspace card
						previews the production group composition. Both expose their actions
						as one accessible control.
					</p>
				</header>

				<div className="grid gap-4 md:grid-cols-2">
					<section className="flex min-h-56 flex-col gap-3 rounded-2xl border border-border/60 bg-card p-4">
						<div>
							<h2 className="font-medium text-sm">Chat artifact</h2>
							<p className="text-muted-foreground text-xs">
								Open and Open in tab are grouped together.
							</p>
						</div>
						<div className="mt-auto">
							<ArtifactHostContext.Provider value={host}>
								<InlineArtifact artifact={ARTIFACT} id="button-group-proof" />
							</ArtifactHostContext.Provider>
						</div>
					</section>

					<section className="flex min-h-56 flex-col gap-3 rounded-2xl border border-border/60 bg-card p-4">
						<div>
							<h2 className="font-medium text-sm">Workspace files</h2>
							<p className="text-muted-foreground text-xs">
								The active opener and editor menu share one split group.
							</p>
						</div>
						<div className="mt-auto flex items-center justify-between rounded-xl bg-sidebar px-3 py-2">
							<span className="text-muted-foreground text-xs">
								Project folder
							</span>
							<TooltipProvider>
								<WorkspaceFilesButtonGroup />
							</TooltipProvider>
						</div>
					</section>
				</div>

				<output
					aria-live="polite"
					className="rounded-xl border border-border/60 bg-muted/40 px-4 py-3 text-muted-foreground text-sm"
					data-testid="proof-status"
				>
					{lastAction}
				</output>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
			<Proof />
		</ThemeProvider>
	);
}

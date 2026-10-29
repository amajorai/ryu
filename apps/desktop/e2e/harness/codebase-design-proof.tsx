import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { SidecarRow } from "@ryu/blocks/extension/services.tsx";
import { SettingsPanelView } from "@ryu/blocks/island/settings-panel.tsx";
import {
	ToolApproval,
	type ToolApprovalStatus,
} from "@ryu/ui/components/agents/tool-approval.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useConfirmDialog } from "@ryu/ui/hooks/use-confirm-dialog.tsx";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import EmailVerifiedPage from "../../../web/src/app/email-verified/page.tsx";
import { MergedThreadPicker } from "../../src/components/chat/MergedThreadPicker.tsx";
import { ViewBar } from "../../src/components/spaces/views/ViewBar.tsx";
import { SubscriptionUsageDashboard } from "../../src/components/usage/SubscriptionUsageDashboard.tsx";
import type { DbView } from "../../src/lib/realtime/yjs-database.ts";
import "../../src/index.css";

const INITIAL_VIEW: DbView = {
	id: "audit-table",
	name: "All records",
	kind: "table",
};

function DesignProof() {
	const params = new URLSearchParams(window.location.search);
	const [surface, setSurface] = useState(params.get("surface") ?? "shared");
	const [theme, setTheme] = useState(params.get("theme") ?? "light");
	const { confirm, confirmationDialog } = useConfirmDialog();
	const [confirmationResult, setConfirmationResult] = useState(
		"No action confirmed"
	);
	const [approval, setApproval] = useState<ToolApprovalStatus>("pending");
	const [view, setView] = useState(INITIAL_VIEW);
	const [running, setRunning] = useState(true);
	const [consent, setConsent] = useState({
		chat: true,
		contextRead: false,
		proactive: false,
	});
	useEffect(() => {
		document.documentElement.classList.toggle("dark", theme === "dark");
	}, [theme]);

	return (
		<main className="min-h-screen bg-background text-foreground">
			{confirmationDialog}
			<header className="flex flex-wrap items-center justify-between gap-3 border-border border-b p-4">
				<div>
					<h1 className="font-heading font-medium">
						Ryu interface verification
					</h1>
					<p className="text-muted-foreground text-xs">
						Production components · isolated sample data
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					{["shared", "desktop", "extension", "web", "island"].map((name) => (
						<Button
							key={name}
							onClick={() => setSurface(name)}
							size="sm"
							variant={surface === name ? "secondary" : "ghost"}
						>
							{name}
						</Button>
					))}
					<Button
						onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
						size="sm"
						variant="outline"
					>
						Switch to {theme === "dark" ? "light" : "dark"}
					</Button>
				</div>
			</header>
			<div
				className="mx-auto flex max-w-4xl flex-col gap-6 p-4 sm:p-8"
				data-testid="production-surface"
			>
				{surface === "shared" && (
					<>
						<h2 className="font-heading font-medium text-xl">
							Agent permissions
						</h2>
						<Button
							onClick={async () => {
								const accepted = await confirm("Run the sample action?", {
									confirmLabel: "Run action",
									description:
										"This changes only the isolated verification state.",
								});
								setConfirmationResult(
									accepted ? "Action confirmed" : "Action cancelled"
								);
							}}
							variant="outline"
						>
							Confirm sample action
						</Button>
						<p role="status">{confirmationResult}</p>
						<ToolApproval
							choices={[
								{
									id: "allow",
									label: "Allow once",
									tone: "primary",
									onSelect: () => setApproval("approved"),
								},
								{
									id: "deny",
									label: "Deny",
									tone: "secondary",
									onSelect: () => setApproval("denied"),
								},
							]}
							description="The agent needs permission to inspect this workspace."
							status={approval}
							title="Read workspace files"
							tool="Read files"
						/>
						<ToolApproval
							status="complete"
							title="Completed request"
							tool="Read files"
						/>
						<ToolApproval
							description="The provider could not be reached. Reconnect and try again."
							status="error"
							title="Unavailable provider"
							tool="Model request"
						/>
						<Button
							onClick={() => setApproval("pending")}
							size="sm"
							variant="outline"
						>
							Reset permission example
						</Button>
					</>
				)}
				{surface === "desktop" && (
					<>
						<h2 className="font-heading font-medium text-xl">
							Workspace controls
						</h2>
						<MergedThreadPicker
							activeConversationId={null}
							onNewThread={() => setApproval("pending")}
							onSelectThread={() => undefined}
							threads={[]}
						/>
						<ViewBar
							activeViewId={view.id}
							columns={[]}
							onAddView={(kind) => setView({ ...view, kind })}
							onRemoveView={() => setView(INITIAL_VIEW)}
							onSelect={() => undefined}
							onUpdateView={(_, patch) => setView({ ...view, ...patch })}
							readOnly={false}
							views={[view]}
						/>
						<SubscriptionUsageDashboard
							accounts={[]}
							catalogError="No host is connected to this verification page."
							catalogLoading={false}
						/>
					</>
				)}
				{surface === "extension" && (
					<>
						<h2 className="font-heading font-medium text-xl">Services</h2>
						<SidecarRow
							entry={{
								name: "sample-service",
								displayName: "Sample service",
								description:
									"An isolated service row for interface verification.",
								installState: "installed",
								running,
							}}
							onAction={(action) => setRunning(action !== "stop")}
						/>
						<SidecarRow
							entry={{
								name: "unavailable",
								displayName: "Unavailable service",
								installState: "failed",
								running: false,
							}}
							pending="install"
						/>
					</>
				)}
				{surface === "web" && <EmailVerifiedPage />}
				{surface === "island" && (
					<div className="mx-auto w-full max-w-md">
						<SettingsPanelView
							consent={consent}
							onSetConsent={(key, value) =>
								setConsent({ ...consent, [key]: value })
							}
						/>
					</div>
				)}
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing design verification root");
}
createRoot(root).render(<DesignProof />);

import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	capabilitiesFromGrants,
	type HostServices,
	type NotificationRecord,
} from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import inboxDocument from "../../../../apps-store/approvals/ui/dist/index.html?raw";
import "./inbox-privacy-proof.css";

// Synthetic records; the real shipped Inbox bundle and host bridge render them.
const notifications: NotificationRecord[] = [
	{
		id: "ntf_connect_fixture",
		title: "Connect fixture: private meeting",
		body: "Synthetic customer details for cached-row verification",
		workflow_run_id: "fixture-private-run",
		node_id: "fixture-private-node",
		user_id: "fixture-user",
		level: "info",
		ack_required: false,
		acked: false,
		created_at: new Date().toISOString(),
		read_at: null,
		source_app_id: null,
	},
	{
		id: "ntf_workflow_fixture",
		title: "Workflow completed",
		body: "Your ordinary workflow result remains visible during Streaming.",
		user_id: "fixture-user",
		level: "info",
		ack_required: false,
		acked: false,
		created_at: new Date().toISOString(),
		read_at: null,
	},
];
const nonce = "inbox-proof-host-nonce";
const granted = capabilitiesFromGrants([
	"approvals:crud",
	"quests:crud",
	"shell:integrate",
]);
const srcdoc = htmlCompanionSrcdoc(nonce, inboxDocument, "@ryu/approvals");

function Proof() {
	const [streaming, setStreaming] = useState(false);
	const [connected, setConnected] = useState(false);
	const [reads, setReads] = useState(0);
	const services: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim) => ({ path: claim.path }),
		approvalsList: async () => [],
		questsList: async () => [],
		suggestionsList: async () => [],
		notificationsAppIcons: async () => ({}),
		notificationsList: async () => {
			setReads((count) => count + 1);
			return notifications;
		},
		shellThemeSubscribe: async () => undefined,
	};
	return (
		<main>
			<header>
				<div>
					<span data-proof-eyebrow>Ryu · Privacy verification</span>
					<h1>Inbox</h1>
					<p>The shipped Inbox app stays open while Streaming changes.</p>
				</div>
				<button
					aria-pressed={streaming}
					onClick={() => setStreaming((active) => !active)}
					type="button"
				>
					{streaming ? "Streaming on" : "Enable Streaming"}
				</button>
			</header>
			<div data-proof-status role="status">
				{streaming
					? "Connected-app details hidden"
					: "Available · Connected-app details visible"}{" "}
				· {connected ? "Inbox connected" : "Connecting"} · Notification reads:{" "}
				{reads}
			</div>
			<section aria-label="Actual Inbox app" data-proof-inbox-frame>
				<ExtensionHost
					granted={granted}
					nonce={nonce}
					onConnected={() => setConnected(true)}
					services={services}
					srcdoc={srcdoc}
					streamingPrivacyActive={streaming}
					title="Inbox privacy proof"
				/>
			</section>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}

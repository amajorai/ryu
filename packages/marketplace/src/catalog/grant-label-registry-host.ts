// packages/marketplace/src/catalog/grant-label-registry-host.ts
//
// Plain-language copy for the HOST permission grants: the capabilities Ryu itself
// owns (the window.ryu bridge, chat, models, storage, network, process and code
// execution) plus the coarse OS-style grants older manifests still declare. The
// app-domain grants live in `grant-label-registry-apps.ts`; open-ended grant
// families (`tool:command:<bin>`, `mcp:<server>`, …) in `grant-label-families.ts`.
//
// Every description says exactly what the grant allows, including the ones that
// run code or reach the network; the consent dialog is where a user decides, so
// the copy never softens a grant. The `label`/`description` literals are catalog
// copy (the i18n extractor reads these object properties) and are translated at
// lookup time by `grant-label-registry.ts`. Keys MUST be lower-case: lookups
// lowercase the grant first (`chat.sendFollowUp` → `chat.sendfollowup`).

import type { GrantCopy } from "./grant-label-families.ts";

export const HOST_GRANT_COPY = new Map<string, GrantCopy>(
	Object.entries({
		"usage:read": {
			label: "Read usage summaries",
			description:
				"Read permitted usage summaries and aggregate budget information.",
		},
		"usage:audit": {
			label: "Read administrative audit records",
			description:
				"Read node-wide Gateway records, including commands, errors, and activity from other users. Requires node administrator approval.",
		},
		"subscriptions:read": {
			label: "See your subscription accounts",
			description:
				"See which subscription logins are saved for each provider (names may be email addresses) and how much of each one's limit is left. Never sees passwords or tokens.",
		},
		"spaces:docs": {
			label: "Manage its Space documents",
			description:
				"Create, read, and update the documents this app owns inside your Spaces.",
		},
		"spaces:database": {
			label: "Manage Space databases",
			description:
				"Create, read, change, and delete databases in your Spaces, and run read-only queries on them.",
		},
		"hook:side-model": {
			label: "Use AI models",
			description:
				"Send prompts to a model to generate content on your behalf.",
		},
		"hook:run-self": {
			label: "Run its own automations on demand",
			description:
				"Let you trigger this app's turn hooks yourself — for example a menu row that re-runs it on one chat. It gains no permission it does not already have; this only adds a way to start it.",
		},
		"hook:run-agent": {
			label: "Run AI agents",
			description:
				"Start a read-only tool-using agent that can look at your connected tools and data.",
		},
		"hook:run-agent:write": {
			label: "Run AI agents that make changes",
			description:
				"Start an agent that can edit files, apply patches, and run commands on your behalf.",
		},
		"storage:kv": {
			label: "Store app data on this device",
			description:
				"Save its own settings and state locally, isolated to this app.",
		},
		"ui:toast": {
			label: "Show temporary messages",
			description:
				"Show short status or result messages in Ryu while you are using the app.",
		},
		"ui:declarative-http": {
			label: "Load app data in Ryu views",
			description:
				"Let Ryu load and change this app's declared records through the selected node.",
		},
		"crypto:seal": {
			label: "Encrypt its own data",
			description:
				"Protect the data it stores so it cannot be read off this device's disk. It cannot read other apps' data or reach the encryption key.",
		},
		"backups:app": {
			label: "Back up its own data",
			description:
				"Save and restore this app's encrypted snapshots using a backup destination you approve. It cannot access other apps' backups or storage credentials.",
		},
		"native:haptics": {
			label: "Use haptic feedback",
			description: "Give you bounded tactile feedback on supported devices.",
		},
		"native:notifications": {
			label: "Send native notifications",
			description:
				"Show a bounded notification on a supported phone, browser, or desktop host.",
		},
		"native:live_activities": {
			label: "Update live status",
			description:
				"Update a bounded Live Activity or ongoing run status on supported devices.",
		},
		"notifications:send": {
			label: "Send Ryu notifications",
			description:
				"Add a notification to your Ryu inbox when a subscribed event occurs.",
		},
		"notifications:send-to-user": {
			label: "Notify organization members",
			description:
				"Deliver Inbox notifications to people in your organization or team.",
		},
		// The reviewed tool-plane scope: it gates tool calls, managed providers and
		// MCP tool calls, so the copy covers connected tools AND managed providers.
		"tools.invoke": {
			label: "Use your connected tools",
			description:
				"Run tools connected to Ryu and request work from Ryu-managed providers. Paid provider requests can use your Ryu credits.",
		},
		// Ships code: inline JavaScript tools and capability adapters run only
		// while the plugin holds this grant.
		"tool:execute": {
			label: "Run its own code",
			description:
				"Run JavaScript code it ships, such as its tools and adapters, inside Ryu's sandbox. That code receives whatever an agent passes to those tools.",
		},
		"tool:http-egress:127.0.0.1": {
			label: "Connect to services on this device",
			description:
				"Send requests from its tools to programs listening on this device (127.0.0.1), such as its own local server.",
		},
		"egress:http": {
			label: "Make web requests",
			description:
				"Send requests to internet addresses it chooses through Ryu's shared connection, which screens each address before connecting.",
		},
		"files:download": {
			label: "Download files it creates",
			description:
				"Save files it exports, such as rendered documents, to your downloads when you ask. It cannot read or change your other files.",
		},
		"mcp:server": {
			label: "Start its own MCP servers",
			description:
				"Start the local programs listed in its MCP server settings and give agents their tools. Those programs run on this device with your user's access.",
		},
		"pi:extension": {
			label: "Add code to the Ryu agent",
			description:
				"Load its own code into the Ryu agent, where it runs with the agent's full access to your files, commands, and network.",
		},
		"sidecar:process": {
			label: "Run its own background program",
			description:
				"Start and keep running its own program on this device, outside the app sandbox, with your user's access.",
		},
		"runtime:external": {
			label: "Install an external runtime",
			description:
				"Download and install the language runtime, packages, and files it needs, and run them on this device.",
		},
		"plugins:install": {
			label: "Install apps",
			description:
				"Install app bundles it builds. A new app stays turned off until you review its permissions and enable it.",
		},
		"shell:integrate": {
			label: "Integrate with the Ryu window",
			description:
				"Open Ryu tabs, add commands to the command palette and icons to tabs, follow your theme and display settings, and receive this node's live event stream.",
		},
		"widget:render": {
			label: "Show interactive cards in chat",
			description:
				"Render its own interactive interface inline in your conversation, instead of returning plain text.",
		},
		"assistant:context": {
			label: "Talk to your assistant about its page",
			description:
				"Tell the Ask Ryu assistant what this app is showing, guide how it answers while the app is open, and ask it a question on your behalf.",
		},
		"preferences:read": {
			label: "Read your Ryu settings",
			description:
				"Read your saved settings by name, such as the options you set for plugins.",
		},
		"identity:read": {
			label: "Know who is signed in",
			description:
				"Read who the current signed-in user is. It cannot look up other people or read credentials.",
		},
		"identity.read": {
			label: "Read your saved credentials",
			description:
				"Read a credential sealed in your Ryu vault for a connection it uses. Each read is recorded in the audit log.",
		},
		"authorization:defer": {
			label: "Recheck permissions for recurring work",
			description:
				"Record your permission for work that runs later and check it again before each run, so the work stops if your access changes.",
		},
		"security:check": {
			label: "Scan text for threats",
			description:
				"Check text it provides with Ryu's firewall and read the result. It does not change anything.",
		},
		// Common coarse OS-style grants.
		fs: {
			label: "Access your files",
			description: "Read and change your files.",
		},
		"fs.read": { label: "Read your files", description: "Read your files." },
		"fs.write": {
			label: "Change your files",
			description: "Modify your files.",
		},
		net: {
			label: "Access the internet",
			description: "Make network requests.",
		},
		"net.fetch": {
			label: "Access the internet",
			description: "Make network requests.",
		},
		http: {
			label: "Access the internet",
			description: "Make network requests.",
		},
		clipboard: {
			label: "Use the clipboard",
			description: "Read from and write to your clipboard.",
		},
		notifications: {
			label: "Show notifications",
			description: "Send you desktop notifications.",
		},
		shell: {
			label: "Run commands on your device",
			description: "Execute shell commands on this device.",
		},
		chat: {
			label: "Read and write chats",
			description: "Read and post messages in your chats.",
		},
		"chat.sendfollowup": {
			label: "Send follow-up messages",
			description:
				"List your chats and post messages into them on your behalf.",
		},
		calendar: {
			label: "Access your calendar",
			description: "Read and edit your calendar.",
		},
		contacts: {
			label: "Access your contacts",
			description: "Read your contacts.",
		},
	})
);

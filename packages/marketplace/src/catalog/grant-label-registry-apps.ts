// packages/marketplace/src/catalog/grant-label-registry-apps.ts
//
// Plain-language copy for the APP-DOMAIN permission grants: capabilities over
// data that Ryu or one of its apps owns (workflows, quests, mail, meetings, the
// virtual desktop, the browser, …). Host primitives are in
// `grant-label-registry-host.ts`. Each description says exactly what the grant
// allows, including access to data from runs or apps the holder did not start.
// The `label`/`description` literals are catalog copy, translated at lookup time
// by `grant-label-registry.ts`. Keys MUST be lower-case.

import type { GrantCopy } from "./grant-label-families.ts";

export const APP_GRANT_COPY = new Map<string, GrantCopy>(
	Object.entries({
		"activity:read": {
			label: "See your activity",
			description:
				"Read your recent agent runs and sessions, including their audit records and traces, and open them.",
		},
		"activity:run": {
			label: "Run checks on your activity",
			description:
				"Prune old activity, score runs, import traces, and start evaluation and red-team runs.",
		},
		"app:http": {
			label: "Talk to its own server",
			description:
				"Send requests from its interface to this app's own server on the node.",
		},
		"app:realtime": {
			label: "Use live updates",
			description:
				"Open live connections to this app's own server to send and receive real-time updates and see who else is present.",
		},
		"app:http:@ryu/recipes": {
			label: "Read your recipes",
			description:
				"Read the recipes recorded by the Recipes app so this app can offer them.",
		},
		"approvals:crud": {
			label: "Manage your approvals inbox",
			description:
				"List, approve, and reject pending approvals, and read and manage your notifications and suggestions.",
		},
		"approvals:request": {
			label: "Ask for your approval",
			description:
				"Queue a request in your approvals inbox. It cannot approve or reject anything itself.",
		},
		"blueprint:review": {
			label: "Use Blueprint plans",
			description:
				"Read and update plans in the Blueprint app through the routes it declares.",
		},
		"browser:control": {
			label: "Control a web browser",
			description:
				"Open, navigate, and screenshot tabs in Ryu's browser, read their titles, and run JavaScript inside those pages.",
		},
		"calendar:crud": {
			label: "Access your calendar",
			description: "Read and edit your scheduled runs and automations.",
		},
		"chat:project-guidance": {
			label: "Set project instructions",
			description:
				"Change a project's standing goal and instructions, which Ryu adds to every chat turn in that project, including the ones you start.",
		},
		"conversation:reactions": {
			label: "React to messages",
			description:
				"Add reactions to messages in the conversation it is working in.",
		},
		"conversation:set-title": {
			label: "Rename chats",
			description: "Change the title of a conversation it is part of.",
		},
		"core:list_agents": {
			label: "See your agents and models",
			description:
				"List the agents, models, and engines set up in Ryu, and search for GIFs and images.",
		},
		"core:readings": {
			label: "Read activity and usage levels",
			description:
				"Read counts of activity on this node and how much of each subscription limit is used. No run titles, ids, or folder paths.",
		},
		"crm:crud": {
			label: "Manage your CRM records",
			description:
				"Create, read, change, and delete the companies, people, deals, notes, tasks, and custom records in the CRM.",
		},
		"desktop:view": {
			label: "View virtual desktops",
			description:
				"See the screens of the virtual Linux desktops on this node.",
		},
		"desktop:control": {
			label: "Control virtual desktops",
			description:
				"Send mouse and keyboard input to the virtual Linux desktops on this node.",
		},
		"drafts:crud": {
			label: "Manage your drafts",
			description:
				"Save, edit, schedule, and delete the unsent message drafts from all your chats.",
		},
		"execution:control": {
			label: "Stop all running work",
			description:
				"Pause and resume every agent, tool, and workflow run on this node, and see whether they are paused.",
		},
		"finetune:runs": {
			label: "Train models",
			description:
				"Start, follow, cancel, and merge model fine-tuning runs, and list the trained adapters.",
		},
		"ghost:record": {
			label: "Record desktop actions",
			description:
				"Record the actions you take on this computer while recording is on, and save them as replayable recipes.",
		},
		"learning:crud": {
			label: "Manage learning",
			description:
				"Record your ratings of replies, turn chats into skills, and read and change learning and self-healing settings.",
		},
		"mail:crud": {
			label: "Use your mail inboxes",
			description:
				"List, create, and delete inboxes, read their messages, rotate their secrets, and send email from them.",
		},
		"media:generate": {
			label: "Generate images, video, and audio",
			description:
				"Create images, video, audio, and speech with the AI models and engines available in Ryu.",
		},
		"media:record": {
			label: "Record from your microphone",
			description:
				"Record from your device's microphone for short windows when you start a capture.",
		},
		"media:transcribe": {
			label: "Transcribe audio",
			description: "Turn audio into text with the speech models in Ryu.",
		},
		"meetings:crud": {
			label: "Manage your meetings",
			description:
				"Start, import, rename, and delete meeting recordings, and read their transcripts and notes.",
		},
		"monitors:crud": {
			label: "Manage monitors",
			description:
				"Create, change, run, and delete monitors, and read their snapshots and alerts.",
		},
		"news:crud": {
			label: "Use your news feeds",
			description:
				"Read and change the News app's feeds and stories through the routes it declares.",
		},
		"quests:capture": {
			label: "Keep text you select",
			description:
				"Save text you select in other apps as a quest, including its full content.",
		},
		"quests:crud": {
			label: "Manage your quests",
			description:
				"Create, change, complete, and dismiss quests and suggestions, and read and edit the quest scratchpad.",
		},
		"reasoning:check": {
			label: "Check reasoning",
			description:
				"Send text to the Reasoning app to have its reasoning checked, through the routes it declares.",
		},
		"rlm:query": {
			label: "Ask the RLM app",
			description:
				"Send long-context questions to the RLM app and read its answers, through the routes it declares.",
		},
		"runs:failures": {
			label: "See failed runs",
			description:
				"Receive the instruction and error text of agent, scheduled, and workflow runs that fail, including runs it did not start.",
		},
		"runs:rerun-agent": {
			label: "Retry failed agent runs",
			description:
				"Run a failed agent task again with the same agent, using its instruction or a corrected one.",
		},
		"safe-actions:manage": {
			label: "Review safe actions",
			description:
				"List, approve, and reject planned tool actions as you. Your Safe Actions role still applies, and you are recorded as the reviewer.",
		},
		"security-key:relay": {
			label: "Use your security key",
			description:
				"Ask your hardware security key to answer sign-in requests from websites open in Ryu's browser.",
		},
		"simulator:control": {
			label: "Control device simulators",
			description:
				"List, boot, and control iOS Simulators and Android Emulators: install and open apps, open links, take screenshots, and tap, swipe, and type.",
		},
		"skills:crud": {
			label: "Manage your skills",
			description:
				"Read, create, edit, restore, and share your skills and their version history.",
		},
		"social:crud": {
			label: "Use the Social app",
			description:
				"Send requests to the Social app, such as drafting and scheduling posts, through the routes it declares.",
		},
		"subtitles:crud": {
			label: "Manage subtitles",
			description:
				"Create and edit subtitles through the Subtitles app's declared routes.",
		},
		"timeline:read": {
			label: "See your screen timeline",
			description:
				"Read your timeline of captured screen frames and journal entries, and open its review and settings.",
		},
		"timeline:speech": {
			label: "Read your recorded speech",
			description:
				"Read transcripts of the speech recorded on this device over time.",
		},
		"tuition:crud": {
			label: "Manage your lessons",
			description:
				"Read and change lessons and progress through the Tuition app's declared routes.",
		},
		"vault:fill": {
			label: "Fill in agent logins",
			description:
				"Receive an agent's saved website password or one-time code in plain text so it can type it into the page.",
		},
		"voice:models:manage": {
			label: "Install voice engines",
			description: "Download and install text-to-speech engines on this node.",
		},
		"warmup:crud": {
			label: "Schedule keep-alive pings",
			description:
				"See which agents you have and what their usage limits say, and schedule its own short messages to them.",
		},
		"webhooks:crud": {
			label: "Manage webhooks",
			description:
				"List webhooks, check whether incoming webhooks can reach this node, and read and set their signing secrets.",
		},
		"workflows:catalogs": {
			label: "See what workflows can use",
			description:
				"List your agents, apps, MCP servers, skills, schedules, notification targets, and connected accounts for use in workflows.",
		},
		"workflows:crud": {
			label: "Manage your workflows",
			description:
				"Create, change, delete, and version workflows, install templates, and set up their webhooks.",
		},
		"workflows:runstate": {
			label: "Run workflows",
			description:
				"Start and resume workflow runs, read their state, and connect or remove the triggers that start them.",
		},
	})
);

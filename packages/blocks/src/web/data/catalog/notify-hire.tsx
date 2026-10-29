import {
	Bell,
	Globe,
	HeartHandshake,
	Mail as MailIcon,
	MessageSquare,
	Zap,
} from "lucide-react";
import { RetryTimelineVisual } from "../../product-row-visuals.tsx";
import {
	HireVisual,
	MailVisual,
	MarketplaceVisual,
	MessagingVisual,
	NotifyVisual,
	SitesVisual,
} from "../../visuals.tsx";
import type { Product } from "../product-types.ts";
import {
	AgentBriefVisual,
	AgentHostVisual,
	BOOK_DEMO,
	EARLY_ACCESS,
	MailVerifyVisual,
	readTheDocs,
	SitesDeployVisual,
	START_HERE_DOCS,
} from "./shared.tsx";

/** Notify, Mail, Messaging, Sites, Agents as a Service and Hire, in catalogue order (see `../products.tsx`). */
export const NOTIFY_TO_HIRE: Product[] = [
	{
		slug: "notify",
		name: "Ryu Notify",
		navLabel: "Notify",
		category: "Agent APIs",
		standalone: true,
		status: "early-access",
		tagline:
			"Durable events, live activities, and delivery for products and agents.",
		Icon: Bell,
		hero: {
			eyebrow: "Ryu Notify · Early access",
			title: "Durable events for agents",
			subtitle:
				"Publish events, stream live progress, and collect approvals through one API.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/standalone/notify"),
			visual: <NotifyVisual />,
		},
		splits: [
			{
				title: "Failed deliveries retry",
				description:
					"A failed delivery is tried again, up to five attempts in all, with backoff that grows to 30 minutes.",
				visual: <RetryTimelineVisual />,
			},
		],
		bento: {
			title: "Every event in one format",
			items: [
				{
					title: "Survives restarts",
					description:
						"Stored events and pending deliveries survive a restart.",
				},
				{
					// services.md N3: 64 streams per tenant (service.ts:141-146).
					title: "Live activities",
					description: "Up to 64 live progress streams per account.",
				},
				{
					// services.md N4.
					title: "Mute and silence",
					description: "Mute noisy recipients and silence repeat alerts.",
				},
				{
					title: "Structured events",
					description: "Keep source, type, recipient, and JSON data together.",
				},
				{
					title: "Webhook delivery",
					description: "Deliver to signed webhooks and other HTTP channels.",
				},
				{
					title: "Action links",
					description:
						"Attach up to three links to the run or dashboard a person needs.",
				},
			],
		},
		faq: [
			{
				q: "Is Ryu Notify the same as Core notifications?",
				a: "No. Core owns the local user inbox, workflow acknowledgements, desktop stream, and node fan-out. Notify is a separate event API for products and agents.",
			},
			{
				q: "Does it send push, email, or SMS?",
				a: "Notify delivers to signed webhooks and ntfy-compatible endpoints. It does not send push, email, or SMS itself. Email stays with Ryu Mail, SMS, WhatsApp, and voice messages with Ryu Messaging, and native push with Core.",
			},
			{
				q: "Can I call it from Box or Ryu Mail?",
				a: "Yes, over its HTTP API. Example scripts show Box and Mail publishing metadata such as the sender and subject, not message bodies.",
			},
		],
		cta: {
			title: "Ready to publish your first event?",
			subtitle: "",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/standalone/notify"),
			note: "Standalone · REST and live streams",
		},
	},

	{
		slug: "mail",
		name: "Ryu Mail",
		navLabel: "Mail",
		category: "Agent APIs",
		standalone: true,
		tagline: "API-first email inboxes for agents.",
		Icon: MailIcon,
		hero: {
			eyebrow: "Ryu Mail",
			title: "Email inboxes for agents",
			subtitle:
				"Give each agent an inbox it can send from and receive into over an API. Run it with Ryu or standalone.",
			primaryCta: readTheDocs("/docs/standalone/mail"),
			secondaryCta: BOOK_DEMO,
			visual: <MailVisual />,
		},
		splits: [
			{
				title: "Only verified mail gets in",
				description:
					"Each inbox has its own signing secret. Mail without a valid, recent signature is rejected.",
				visual: <MailVerifyVisual />,
			},
		],
		bento: {
			title: "What an inbox can do",
			items: [
				{
					title: "Inbox API",
					description:
						"List, create, rename, and remove inboxes through one API.",
				},
				{
					title: "Stored messages",
					description:
						"Message metadata, bodies, and attachment records stay in Ryu Mail.",
				},
				{
					title: "Rotate secrets",
					description:
						"Rotate an inbox's signing secret without recreating it.",
				},
			],
		},
		faq: [
			{
				q: "Does Mail receive email directly?",
				a: "No. Mail arrives from your mail provider as a signed request, and sending uses a configured mail transport.",
			},
			{
				q: "Does a Mail event include the email body?",
				a: "The Notify example and app hooks carry metadata only, such as the sender and subject. Mail's own webhooks can include the body.",
			},
		],
		cta: {
			title: "Ready to give agents an inbox?",
			subtitle: "",
			primaryCta: readTheDocs("/docs/standalone/mail"),
			secondaryCta: BOOK_DEMO,
		},
	},

	{
		slug: "messaging",
		name: "Ryu Messaging",
		navLabel: "Messaging",
		category: "Agent APIs",
		standalone: true,
		status: "early-access",
		tagline: "SMS, WhatsApp, voice messages, and phone numbers for agents.",
		Icon: MessageSquare,
		hero: {
			eyebrow: "Ryu Messaging · Early access",
			title: "Message from your own numbers",
			subtitle:
				"Lease phone numbers and send SMS, MMS, WhatsApp, and voice messages through one API. Billed at the AWS price, no markup.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/standalone/messaging"),
			visual: <MessagingVisual />,
		},
		bento: {
			title: "Every send has a ceiling",
			subtitle:
				"Hold the worst-case price, send, then settle at the real price.",
			items: [
				{
					title: "Your own numbers",
					description:
						"Lease local and toll-free numbers by country, renewed every 30 days from credits.",
				},
				{
					title: "Four channels",
					description:
						"SMS, MMS, WhatsApp templates and replies, and outbound text-to-speech voice messages.",
				},
				{
					title: "Quote before you send",
					description:
						"See the hold for any destination and channel, with credits still available.",
				},
				{
					title: "Safe retries",
					description:
						"Every send and number purchase takes an idempotency key, so a retry never charges twice.",
				},
				{
					title: "Opt-outs and limits",
					description:
						"Recipients who reply STOP are refused, and send caps bound what a key spends.",
				},
				{
					title: "Signed webhooks",
					description:
						"Receive replies, delivery results, and number changes as signed events.",
				},
			],
		},
		faq: [
			{
				q: "What does a message cost?",
				a: "What AWS End User Messaging charges for it, with no Ryu markup. Prices depend on the destination country, carrier, number type, and WhatsApp category; see the AWS End User Messaging pricing page. Credit top-ups keep their usual deposit fee.",
			},
			{
				q: "Can it place live phone calls?",
				a: "No. Voice messages are outbound text-to-speech only. Live and inbound calls use the Gateway phone assistant.",
			},
			{
				q: "How do I get WhatsApp?",
				a: "During early access Ryu links a WhatsApp Business Account and assigns its number to your organization as a sender. Business-initiated messages use approved templates; free-form text is allowed within 24 hours of the contact's last message.",
			},
		],
		cta: {
			title: "Ready to give agents a number?",
			subtitle: "Ryu enables it for each organization, which then turns it on.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/standalone/messaging"),
			note: "SMS, WhatsApp, voice · AWS price, no markup",
		},
	},

	{
		slug: "sites",
		name: "Ryu Sites",
		navLabel: "Sites",
		category: "Agent APIs",
		standalone: true,
		status: "early-access",
		tagline: "Save, review, and deploy websites.",
		Icon: Globe,
		hero: {
			eyebrow: "Ryu Sites · Early access",
			title: "Deploy the version you reviewed",
			subtitle: "Save each build and publish only the version you approve.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/standalone/sites"),
			visual: <SitesVisual />,
		},
		splits: [
			{
				title: "A leaked key blocks the deploy",
				description:
					"Each deploy rescans the exact saved version. A detected credential, or a missing scanner, stops it.",
				visual: <SitesDeployVisual />,
			},
		],
		bento: {
			title: "From build to visitors",
			items: [
				{
					title: "Immutable versions",
					description:
						"Saving a new version never changes the build already deployed.",
				},
				{
					title: "Isolated public pages",
					description:
						"Visitor pages run on their own address and can't load scripts from other sites.",
				},
				{
					title: "Run it yourself",
					description:
						"Run it in Ryu Desktop or on your own infrastructure. No Ryu-hosted service yet.",
				},
			],
		},
		faq: [
			{
				q: "Does Sites generate pages with AI on its own?",
				a: "No. AI page generation and the Sites management UI are in Ryu Desktop. A self‑hosted install accepts finished HTML through its API.",
			},
			{
				q: "Can one Sites setup serve several customers?",
				a: "No. Each self‑hosted setup serves one customer. Run a separate one for each customer you need to keep apart.",
			},
			{
				q: "Can I use a custom domain?",
				a: "Not yet. You can add a domain and verify you own it, but it can't serve traffic until HTTPS support ships. Use a subdomain of your Sites address for now.",
			},
		],
		cta: {
			title: "Ready to ship the approved build?",
			subtitle: "",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/standalone/sites"),
			note: "No published price",
		},
	},

	{
		slug: "agents-as-a-service",
		name: "Agents as a Service",
		navLabel: "Agents as a Service",
		category: "Platform",
		tagline: "We help you scope and set up your first agent.",
		Icon: HeartHandshake,
		hero: {
			eyebrow: "Agents as a Service",
			title: "Get help building your agents",
			subtitle:
				"Tell us the task and the tools it uses. We'll help scope and set up your first agent.",
			primaryCta: BOOK_DEMO,
			secondaryCta: readTheDocs(START_HERE_DOCS),
			visual: <AgentBriefVisual />,
		},
		// services.md A5; Core is open source (services.md C7).
		splits: [
			{
				title: "Runs where you choose",
				description: "Runs on a Ryu cloud node or on your own machines.",
				cta: { label: "See Ryu Cloud", href: "/products/cloud" },
				visual: <AgentHostVisual />,
			},
		],
		// services.md A4, A6 rewrites.
		bento: {
			title: "What we set up",
			items: [
				{
					title: "Approval points",
					description: "We agree which steps wait for your approval.",
				},
				{
					title: "Built on Ryu",
					description:
						"Uses Ryu's memory, model routing, and Gateway security.",
				},
				{
					title: "Yours to keep",
					description: "Standard Ryu underneath, so you can take it in-house.",
				},
			],
		},
		cta: {
			title: "Ready to build your first agent?",
			subtitle: "",
			primaryCta: BOOK_DEMO,
			secondaryCta: readTheDocs(START_HERE_DOCS),
		},
	},

	{
		slug: "hire",
		name: "Ryu Hire",
		navLabel: "Hire",
		category: "Agent APIs",
		standalone: true,
		status: "early-access",
		tagline: "Bring in a specialist agent for one task.",
		Icon: Zap,
		hero: {
			eyebrow: "Ryu Hire · Early access",
			title: "Hire specialist agents",
			subtitle:
				"Bring in a specialist agent for one task, with nothing to install.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			visual: <HireVisual />,
		},
		splits: [
			{
				title: "Use Marketplace apps today",
				description:
					"Install apps and plugins from the Marketplace and run them in Ryu Desktop.",
				cta: { label: "Browse the Marketplace", href: "/marketplace" },
				visual: <MarketplaceVisual />,
			},
		],
		bento: {
			title: "The planned flow",
			items: [
				{
					title: "Choose a specialist",
					description:
						"Find an agent by the outcome you need, not the runtime it uses.",
				},
				{
					title: "Review the request",
					description:
						"See the connections and context the run asks for before you approve.",
				},
				{
					title: "Run once",
					description:
						"The agent runs with only the access you approved, then returns the result.",
				},
				{
					title: "Keep the record",
					description:
						"The run's inputs, output, and final status stay together.",
				},
			],
		},
		cta: {
			title: "Ready to hire a specialist?",
			subtitle: "",
			primaryCta: EARLY_ACCESS,
			secondaryCta: BOOK_DEMO,
			note: "No published price",
		},
	},
];

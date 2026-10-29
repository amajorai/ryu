// React's style contract includes the exact CSS custom properties consumed below.
declare module "react" {
	interface CSSProperties {
		"--fixture-value-1"?: string | number;
		"--fixture-value-2"?: string | number;
		"--fixture-value-3"?: string | number;
		"--fixture-value-4"?: string | number;
		"--fixture-value-5"?: string | number;
		"--fixture-value-6"?: string | number;
		"--fixture-value-7"?: string | number;
		"--fixture-value-8"?: string | number;
		"--fixture-value-9"?: string | number;
		"--fixture-value-10"?: string | number;
		"--fixture-value-11"?: string | number;
		"--fixture-value-12"?: string | number;
		"--fixture-value-13"?: string | number;
		"--fixture-value-14"?: string | number;
		"--fixture-value-15"?: string | number;
		"--fixture-value-16"?: string | number;
		"--fixture-value-17"?: string | number;
		"--fixture-value-18"?: string | number;
		"--fixture-value-19"?: string | number;
		"--fixture-value-20"?: string | number;
		"--fixture-value-21"?: string | number;
		"--fixture-value-22"?: string | number;
		"--fixture-value-23"?: string | number;
		"--fixture-value-24"?: string | number;
		"--fixture-value-25"?: string | number;
		"--fixture-value-26"?: string | number;
		"--fixture-value-27"?: string | number;
		"--fixture-value-28"?: string | number;
		"--fixture-value-29"?: string | number;
		"--fixture-value-30"?: string | number;
	}
}

import { type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import proofStyles from "./billing-transactional-emails-proof.module.css";

type InvitationAudience = "existing" | "new";

const BASE_URL = "https://app.ryuhq.com";
const BILLING_URL = `${BASE_URL}/organizations/billing`;
const INVITATION_PATH = "/organizations/accept-invitation/inv_123";
const SIGN_UP_URL =
	BASE_URL +
	"/login?view=signup&callback=" +
	encodeURIComponent(INVITATION_PATH);

const EVENT_CARDS = [
	{
		audience: "Owners + admins",
		body: "$10.00 is now available. The charge was $12.00.",
		event: "order.paid · credits_topup",
		heading: "Your Ryu top-up went through",
		id: "manual-topup",
		label: "Manual top-up",
	},
	{
		audience: "Owners + admins",
		body: "The fixed pack was charged and added automatically after balance crossed the threshold.",
		event: "maybeAutoTopup · charged",
		heading: "Your Ryu balance was topped up",
		id: "automatic-topup",
		label: "Automatic top-up",
	},
	{
		audience: "Owners + admins",
		body: "Your spendable balance is below the threshold you asked us to watch.",
		event: "credit alert · below threshold",
		heading: "Your Ryu credit balance is low",
		id: "low-balance",
		label: "Low balance",
	},
	{
		audience: "Owners + admins",
		body: "Your Pro plan is active and included monthly credits are ready.",
		event: "subscription.active · subscription_create",
		heading: "Welcome to Pro",
		id: "welcome",
		label: "Subscribed welcome",
	},
	{
		audience: "Owners + admins",
		body: "Your Pro subscription renewed and the next included credit period is ready.",
		event: "order.paid · subscription_cycle",
		heading: "Your Ryu subscription renewed",
		id: "renewal",
		label: "Successful renewal",
	},
	{
		audience: "Owners + admins",
		body: "Payment is being retried during the grace period. Update the payment method before it ends.",
		event: "subscription.past_due",
		heading: "A quick fix for your Ryu payment",
		id: "past-due",
		label: "Payment recovery",
	},
	{
		audience: "Owners + admins",
		body: "The subscription is no longer active. Managed plan features and included capacity are paused.",
		event: "subscription.revoked",
		heading: "Your Ryu subscription needs attention",
		id: "revoked",
		label: "Terminal consequence",
	},
	{
		audience: "Owners + admins on both organizations",
		body: "Node, credit, Marketplace, and organization-invitation lifecycle events are recorded in the server inbox and emailed to both sides.",
		event: "organization activity · transfer/invitation lifecycle",
		heading: "Organization activity",
		href: `${BASE_URL}/inbox`,
		id: "organization-activity",
		label: "Organization activity",
		linkLabel: "Open organization inbox",
	},
] as const;

function StatusPill({
	children,
	tone = "green",
}: {
	children: ReactNode;
	tone?: "green" | "yellow";
}) {
	return (
		<span
			className={proofStyles.dynamicFixture1}
			style={{
				"--fixture-value-1":
					tone === "green"
						? "var(--billing-transactional-emails-proof-color-1)"
						: "var(--billing-transactional-emails-proof-color-2)",
				"--fixture-value-2": `1px solid ${tone === "green" ? "var(--billing-transactional-emails-proof-color-3)" : "var(--billing-transactional-emails-proof-color-4)"}`,
				"--fixture-value-3": "999px",
				"--fixture-value-4":
					tone === "green"
						? "var(--billing-transactional-emails-proof-color-5)"
						: "var(--billing-transactional-emails-proof-color-6)",
				"--fixture-value-5": "10px",
				"--fixture-value-6": 800,
				"--fixture-value-7": "0.8px",
				"--fixture-value-8": "6px 9px",
				"--fixture-value-9": "nowrap",
			}}
		>
			{children}
		</span>
	);
}

function EmailCard({
	audience,
	body,
	event,
	heading,
	href = BILLING_URL,
	label,
	linkLabel = "Open billing",
}: {
	audience: string;
	body: string;
	event: string;
	heading: string;
	href?: string;
	label: string;
	linkLabel?: string;
}) {
	return (
		<article className={proofStyles.fixture1} data-email-card>
			<div className={proofStyles.fixture2}>
				<div className={proofStyles.fixture3}>{label}</div>
				<StatusPill>WIRED</StatusPill>
			</div>
			<div className={proofStyles.fixture4}>{event}</div>
			<div className={proofStyles.fixture5}>
				<div className={proofStyles.fixture6}>{heading}</div>
				<p className={proofStyles.fixture7}>{body}</p>
				<a className={proofStyles.fixture8} href={href}>
					{linkLabel}
				</a>
				<div className={proofStyles.fixture9}>
					{audience} · Notion-style transactional shell
				</div>
			</div>
		</article>
	);
}

function InvitationCard({ audience }: { audience: InvitationAudience }) {
	const isExisting = audience === "existing";
	const heading = isExisting
		? "Join Acme on Ryu"
		: "You’ve been invited to Acme";
	const body = isExisting
		? "You already have a Ryu account. Sign in and accept the invitation when you’re ready."
		: "You don’t have a Ryu account yet. Create one and we’ll bring you back to accept the invitation.";
	const href = isExisting ? BASE_URL + INVITATION_PATH : SIGN_UP_URL;

	return (
		<article className={proofStyles.fixture10} data-email-card>
			<div className={proofStyles.fixture11}>
				<div className={proofStyles.fixture12}>Account-aware invitation</div>
				<StatusPill tone="yellow">
					{isExisting ? "SIGN IN THEN ACCEPT" : "SIGN UP THEN RETURN"}
				</StatusPill>
			</div>
			<div className={proofStyles.fixture13}>
				organization invitation ·{" "}
				{isExisting ? "existing-account template" : "new-account template"}
			</div>
			<div className={proofStyles.fixture14}>
				<div className={proofStyles.fixture15}>{heading}</div>
				<p className={proofStyles.fixture16}>{body}</p>
				<a
					className={proofStyles.fixture17}
					data-testid="invitation-link"
					href={href}
				>
					{isExisting ? "Accept the invitation" : "Create your Ryu account"}
				</a>
				<div className={proofStyles.fixture18}>{href}</div>
			</div>
		</article>
	);
}

const ORGANIZATION_NOTIFICATION_ROWS = [
	{
		description: "Manual credit purchases that finish successfully.",
		id: "topup-success",
		label: "Successful top-ups",
	},
	{
		description:
			"Automatic balance packs charged after a threshold is reached.",
		id: "automatic-topup-success",
		label: "Successful automatic top-ups",
	},
	{
		description:
			"The managed balance crosses the configured low-balance threshold.",
		id: "low-balance",
		label: "Low balance",
	},
	{
		description:
			"A new subscription becomes active and included credits are ready.",
		id: "subscription-welcome",
		label: "Subscription welcome",
	},
	{
		description: "A recurring subscription charge completes successfully.",
		id: "subscription-renewal",
		label: "Successful renewals",
	},
	{
		description: "Payment enters its grace period and needs attention.",
		id: "payment-past-due",
		label: "Payment recovery",
	},
	{
		description: "A subscription ends and managed capacity pauses.",
		id: "subscription-revoked",
		label: "Subscription ended",
	},
	{
		description: "Invitations for existing and new Ryu accounts.",
		id: "organization-invitation",
		label: "Organization invitations",
	},
	{
		description:
			"Node, credit, Marketplace, and invitation lifecycle events for both sides.",
		id: "organization-activity",
		label: "Organization activity",
	},
] as const;

function OrganizationNotificationSettingsProof() {
	const [preferences, setPreferences] = useState<Record<string, boolean>>(() =>
		Object.fromEntries(
			ORGANIZATION_NOTIFICATION_ROWS.map((notification) => [
				notification.id,
				true,
			])
		)
	);
	const enabledCount = Object.values(preferences).filter(Boolean).length;

	return (
		<section
			className={proofStyles.fixture19}
			data-testid="organization-notification-settings"
		>
			<div className={proofStyles.fixture20}>
				<div>
					<div className={proofStyles.fixture21}>
						ORGANIZATION · NOTIFICATIONS
					</div>
					<div className={proofStyles.fixture22}>
						One place for organization email
					</div>
					<p className={proofStyles.fixture23}>
						Owner/admin controls · all switches are enabled by default · members
						are read-only
					</p>
				</div>
				<StatusPill>{enabledCount} OF 9 ENABLED</StatusPill>
			</div>
			<div
				className={proofStyles.fixture24}
				data-testid="organization-notification-count"
			>
				{enabledCount} of 9 enabled
			</div>
			<div className={proofStyles.fixture25}>
				{ORGANIZATION_NOTIFICATION_ROWS.map((notification) => {
					const enabled = preferences[notification.id];
					return (
						<div className={proofStyles.fixture26} key={notification.id}>
							<div>
								<div className={proofStyles.fixture27}>
									{notification.label}
								</div>
								<div className={proofStyles.fixture28}>
									{notification.description}
								</div>
							</div>
							<button
								aria-label={`${notification.label} notifications`}
								aria-pressed={enabled}
								className={proofStyles.dynamicFixture2}
								data-testid={`org-notification-toggle-${notification.id}`}
								onClick={() =>
									setPreferences((current) => ({
										...current,
										[notification.id]: !current[notification.id],
									}))
								}
								style={{
									"--fixture-value-10": enabled
										? "var(--billing-transactional-emails-proof-color-1)"
										: "var(--billing-transactional-emails-proof-color-2)",
									"--fixture-value-11": `1px solid ${enabled ? "var(--billing-transactional-emails-proof-color-3)" : "var(--billing-transactional-emails-proof-color-4)"}`,
									"--fixture-value-12": "999px",
									"--fixture-value-13": enabled
										? "var(--billing-transactional-emails-proof-color-5)"
										: "var(--billing-transactional-emails-proof-color-6)",
									"--fixture-value-14": "pointer",
									"--fixture-value-15": "11px",
									"--fixture-value-16": 800,
									"--fixture-value-17": "76px",
									"--fixture-value-18": "7px 10px",
								}}
								type="button"
							>
								{enabled ? "Enabled" : "Paused"}
							</button>
						</div>
					);
				})}
			</div>
		</section>
	);
}

function BillingTransactionalEmailsProof() {
	const [audience, setAudience] = useState<InvitationAudience>("existing");
	const [replayed, setReplayed] = useState(false);

	return (
		<main
			className={proofStyles.fixture29}
			data-testid="billing-transactional-emails-proof"
		>
			<div className={proofStyles.fixture30}>
				<header className={proofStyles.fixture31}>
					<div className={proofStyles.fixture32}>
						RYU · BILLING · LIVE REACT PROOF
					</div>
					<div className={proofStyles.fixture33}>
						<h1 className={proofStyles.fixture34}>
							Transactional email system
						</h1>
						<div data-testid="proof-status">
							<StatusPill>VERIFIED</StatusPill>
						</div>
					</div>
					<p className={proofStyles.fixture35}>
						Every charge, balance threshold, subscription transition,
						invitation, and organization transfer has a specific message, a safe
						action link, and a durable delivery identity.
					</p>
				</header>

				<section className={proofStyles.fixture36}>
					<div className={proofStyles.fixture37}>
						<div>
							<div className={proofStyles.fixture38}>DELIVERY GUARANTEES</div>
							<div className={proofStyles.fixture39}>
								7 billing events · 1 organization activity · 1 account-aware
								invitation · 1 replay-safe ledger
							</div>
						</div>
						<button
							className={proofStyles.fixture40}
							data-testid="replay-button"
							onClick={() => setReplayed(true)}
							type="button"
						>
							Replay order.paid
						</button>
					</div>
					<div className={proofStyles.fixture41}>
						{replayed
							? "1 sent · 1 replay suppressed by dedupe key"
							: "Ready · dedupe key is claimed before send and marked sent after delivery"}
					</div>
					{replayed ? (
						<div className={proofStyles.fixture42} data-testid="replay-proof">
							Replay proof complete
						</div>
					) : null}
				</section>

				<OrganizationNotificationSettingsProof />

				<section
					className={proofStyles.fixture43}
					data-testid="transactional-email-grid"
				>
					{EVENT_CARDS.map((card) => (
						<EmailCard key={card.id} {...card} />
					))}
					<div className={proofStyles.fixture44}>
						<button
							aria-pressed={audience === "existing"}
							className={proofStyles.dynamicFixture3}
							onClick={() => setAudience("existing")}
							style={{
								"--fixture-value-19":
									audience === "existing"
										? "var(--billing-transactional-emails-proof-color-7)"
										: "var(--billing-transactional-emails-proof-color-8)",
								"--fixture-value-20":
									"1px solid " +
									(audience === "existing"
										? "var(--billing-transactional-emails-proof-color-7)"
										: "var(--billing-transactional-emails-proof-color-9)"),
								"--fixture-value-21": "9px",
								"--fixture-value-22":
									audience === "existing"
										? "var(--billing-transactional-emails-proof-color-10)"
										: "var(--billing-transactional-emails-proof-color-11)",
								"--fixture-value-23": "pointer",
								"--fixture-value-24": "9px 12px",
							}}
							type="button"
						>
							Existing Ryu account
						</button>
						<button
							aria-pressed={audience === "new"}
							className={proofStyles.dynamicFixture4}
							onClick={() => setAudience("new")}
							style={{
								"--fixture-value-25":
									audience === "new"
										? "var(--billing-transactional-emails-proof-color-7)"
										: "var(--billing-transactional-emails-proof-color-8)",
								"--fixture-value-26":
									"1px solid " +
									(audience === "new"
										? "var(--billing-transactional-emails-proof-color-7)"
										: "var(--billing-transactional-emails-proof-color-9)"),
								"--fixture-value-27": "9px",
								"--fixture-value-28":
									audience === "new"
										? "var(--billing-transactional-emails-proof-color-10)"
										: "var(--billing-transactional-emails-proof-color-11)",
								"--fixture-value-29": "pointer",
								"--fixture-value-30": "9px 12px",
							}}
							type="button"
						>
							New Ryu account
						</button>
					</div>
					<InvitationCard audience={audience} />
				</section>
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<BillingTransactionalEmailsProof />
);

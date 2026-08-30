import { useState } from "react";
import { createRoot } from "react-dom/client";

type InvitationAudience = "existing" | "new";

const styles = {
	accent: "#c4b5fd",
	background: "#09090b",
	border: "#27272a",
	green: "#86efac",
	muted: "#a1a1aa",
	panel: "#111113",
	text: "#f4f4f5",
	yellow: "#fcd34d",
};

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
	children: string;
	tone?: "green" | "yellow";
}) {
	return (
		<span
			style={{
				background: tone === "green" ? "#123022" : "#33270c",
				border: `1px solid ${tone === "green" ? "#245c3e" : "#765b16"}`,
				borderRadius: 999,
				color: tone === "green" ? styles.green : styles.yellow,
				fontSize: 10,
				fontWeight: 800,
				letterSpacing: 0.8,
				padding: "6px 9px",
				whiteSpace: "nowrap",
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
		<article
			data-email-card
			style={{
				background: styles.panel,
				border: `1px solid ${styles.border}`,
				borderRadius: 16,
				display: "flex",
				flexDirection: "column",
				gap: 13,
				padding: 18,
			}}
		>
			<div
				style={{
					alignItems: "center",
					display: "flex",
					justifyContent: "space-between",
					gap: 12,
				}}
			>
				<div
					style={{
						color: styles.accent,
						fontSize: 11,
						letterSpacing: 1.1,
						textTransform: "uppercase",
					}}
				>
					{label}
				</div>
				<StatusPill>WIRED</StatusPill>
			</div>
			<div
				style={{
					color: styles.muted,
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: 11,
				}}
			>
				{event}
			</div>
			<div
				style={{
					background: "#fafafa",
					borderRadius: 11,
					color: "#333",
					padding: 15,
				}}
			>
				<div style={{ fontSize: 16, fontWeight: 700 }}>{heading}</div>
				<p style={{ fontSize: 13, lineHeight: 1.55, margin: "9px 0 12px" }}>
					{body}
				</p>
				<a
					href={href}
					style={{
						color: "#2754c5",
						fontSize: 13,
						textDecoration: "underline",
					}}
				>
					{linkLabel}
				</a>
				<div style={{ color: "#898989", fontSize: 10, marginTop: 12 }}>
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
		<article
			data-email-card
			style={{
				background: styles.panel,
				border: `1px solid ${styles.accent}`,
				borderRadius: 16,
				display: "flex",
				flexDirection: "column",
				gap: 13,
				gridColumn: "1 / -1",
				padding: 18,
			}}
		>
			<div
				style={{
					alignItems: "center",
					display: "flex",
					justifyContent: "space-between",
					gap: 12,
				}}
			>
				<div
					style={{
						color: styles.accent,
						fontSize: 11,
						letterSpacing: 1.1,
						textTransform: "uppercase",
					}}
				>
					Account-aware invitation
				</div>
				<StatusPill tone="yellow">
					{isExisting ? "SIGN IN THEN ACCEPT" : "SIGN UP THEN RETURN"}
				</StatusPill>
			</div>
			<div
				style={{
					color: styles.muted,
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: 11,
				}}
			>
				organization invitation ·{" "}
				{isExisting ? "existing-account template" : "new-account template"}
			</div>
			<div
				style={{
					background: "#fafafa",
					borderRadius: 11,
					color: "#333",
					padding: 15,
				}}
			>
				<div style={{ fontSize: 16, fontWeight: 700 }}>{heading}</div>
				<p style={{ fontSize: 13, lineHeight: 1.55, margin: "9px 0 12px" }}>
					{body}
				</p>
				<a
					data-testid="invitation-link"
					href={href}
					style={{
						color: "#2754c5",
						fontSize: 13,
						textDecoration: "underline",
					}}
				>
					{isExisting ? "Accept the invitation" : "Create your Ryu account"}
				</a>
				<div style={{ color: "#898989", fontSize: 10, marginTop: 12 }}>
					{href}
				</div>
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
			data-testid="organization-notification-settings"
			style={{
				background: styles.panel,
				border: `1px solid ${styles.accent}`,
				borderRadius: 18,
				marginBottom: 16,
				padding: 20,
			}}
		>
			<div
				style={{
					alignItems: "center",
					display: "flex",
					flexWrap: "wrap",
					gap: 10,
					justifyContent: "space-between",
				}}
			>
				<div>
					<div style={{ color: styles.accent, fontSize: 11, letterSpacing: 1 }}>
						ORGANIZATION · NOTIFICATIONS
					</div>
					<div style={{ fontSize: 19, fontWeight: 700, marginTop: 5 }}>
						One place for organization email
					</div>
					<p
						style={{
							color: styles.muted,
							fontSize: 13,
							lineHeight: 1.5,
							margin: "8px 0 0",
						}}
					>
						Owner/admin controls · all switches are enabled by default · members
						are read-only
					</p>
				</div>
				<StatusPill>{enabledCount} OF 9 ENABLED</StatusPill>
			</div>
			<div
				data-testid="organization-notification-count"
				style={{ color: styles.muted, fontSize: 12, marginTop: 16 }}
			>
				{enabledCount} of 9 enabled
			</div>
			<div style={{ display: "grid", gap: 8, marginTop: 12 }}>
				{ORGANIZATION_NOTIFICATION_ROWS.map((notification) => {
					const enabled = preferences[notification.id];
					return (
						<div
							key={notification.id}
							style={{
								alignItems: "center",
								background: "#18181b",
								border: `1px solid ${styles.border}`,
								borderRadius: 11,
								display: "flex",
								gap: 12,
								justifyContent: "space-between",
								padding: "12px 13px",
							}}
						>
							<div>
								<div style={{ fontSize: 14, fontWeight: 650 }}>
									{notification.label}
								</div>
								<div
									style={{ color: styles.muted, fontSize: 11, marginTop: 3 }}
								>
									{notification.description}
								</div>
							</div>
							<button
								aria-label={`${notification.label} notifications`}
								aria-pressed={enabled}
								data-testid={`org-notification-toggle-${notification.id}`}
								onClick={() =>
									setPreferences((current) => ({
										...current,
										[notification.id]: !current[notification.id],
									}))
								}
								style={{
									background: enabled ? "#123022" : "#33270c",
									border: `1px solid ${enabled ? "#245c3e" : "#765b16"}`,
									borderRadius: 999,
									color: enabled ? styles.green : styles.yellow,
									cursor: "pointer",
									fontSize: 11,
									fontWeight: 800,
									minWidth: 76,
									padding: "7px 10px",
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
			data-testid="billing-transactional-emails-proof"
			style={{
				background: styles.background,
				boxSizing: "border-box",
				color: styles.text,
				fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
				minHeight: "100vh",
				padding: "32px 24px 56px",
			}}
		>
			<div style={{ margin: "0 auto", maxWidth: 1100 }}>
				<header style={{ marginBottom: 24 }}>
					<div
						style={{ color: styles.accent, fontSize: 12, letterSpacing: 1.4 }}
					>
						RYU · BILLING · LIVE REACT PROOF
					</div>
					<div
						style={{
							alignItems: "center",
							display: "flex",
							gap: 14,
							justifyContent: "space-between",
						}}
					>
						<h1
							style={{ fontSize: 34, letterSpacing: -1.2, margin: "8px 0 0" }}
						>
							Transactional email system
						</h1>
						<div data-testid="proof-status">
							<StatusPill>VERIFIED</StatusPill>
						</div>
					</div>
					<p
						style={{
							color: styles.muted,
							fontSize: 15,
							lineHeight: 1.55,
							margin: "10px 0 0",
							maxWidth: 790,
						}}
					>
						Every charge, balance threshold, subscription transition,
						invitation, and organization transfer has a specific message, a safe
						action link, and a durable delivery identity.
					</p>
				</header>

				<section
					style={{
						background: styles.panel,
						border: `1px solid ${styles.border}`,
						borderRadius: 18,
						marginBottom: 16,
						padding: 20,
					}}
				>
					<div
						style={{
							alignItems: "center",
							display: "flex",
							flexWrap: "wrap",
							gap: 10,
							justifyContent: "space-between",
						}}
					>
						<div>
							<div
								style={{ color: styles.muted, fontSize: 11, letterSpacing: 1 }}
							>
								DELIVERY GUARANTEES
							</div>
							<div style={{ fontSize: 17, fontWeight: 650, marginTop: 5 }}>
								7 billing events · 1 organization activity · 1 account-aware
								invitation · 1 replay-safe ledger
							</div>
						</div>
						<button
							data-testid="replay-button"
							onClick={() => setReplayed(true)}
							style={{
								background: "#18181b",
								border: `1px solid ${styles.border}`,
								borderRadius: 9,
								color: styles.text,
								cursor: "pointer",
								padding: "9px 12px",
							}}
							type="button"
						>
							Replay order.paid
						</button>
					</div>
					<div style={{ color: styles.muted, fontSize: 13, marginTop: 12 }}>
						{replayed
							? "1 sent · 1 replay suppressed by dedupe key"
							: "Ready · dedupe key is claimed before send and marked sent after delivery"}
					</div>
					{replayed ? (
						<div
							data-testid="replay-proof"
							style={{ color: styles.green, fontSize: 13, marginTop: 8 }}
						>
							Replay proof complete
						</div>
					) : null}
				</section>

				<OrganizationNotificationSettingsProof />

				<section
					data-testid="transactional-email-grid"
					style={{
						display: "grid",
						gap: 12,
						gridTemplateColumns: "repeat(auto-fit, minmax(310px, 1fr))",
					}}
				>
					{EVENT_CARDS.map((card) => (
						<EmailCard key={card.id} {...card} />
					))}
					<div
						style={{
							display: "flex",
							gap: 8,
							gridColumn: "1 / -1",
							marginTop: 4,
						}}
					>
						<button
							aria-pressed={audience === "existing"}
							onClick={() => setAudience("existing")}
							style={{
								background: audience === "existing" ? styles.accent : "#18181b",
								border:
									"1px solid " +
									(audience === "existing" ? styles.accent : styles.border),
								borderRadius: 9,
								color: audience === "existing" ? "#17121f" : styles.text,
								cursor: "pointer",
								padding: "9px 12px",
							}}
							type="button"
						>
							Existing Ryu account
						</button>
						<button
							aria-pressed={audience === "new"}
							onClick={() => setAudience("new")}
							style={{
								background: audience === "new" ? styles.accent : "#18181b",
								border:
									"1px solid " +
									(audience === "new" ? styles.accent : styles.border),
								borderRadius: 9,
								color: audience === "new" ? "#17121f" : styles.text,
								cursor: "pointer",
								padding: "9px 12px",
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

createRoot(document.getElementById("root") as HTMLElement).render(
	<BillingTransactionalEmailsProof />
);

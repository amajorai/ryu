// apps/desktop/src/components/settings/EmailAlertsSettings.tsx
//
// Self-host email + policy-alert delivery settings. Two cards:
//   1. SMTP transport   the node's BYO outbound relay (host/port/user/pass/from/
//                        STARTTLS) plus a Test-send button.
//   2. Alert delivery   the node-level recipients (emails + webhook URLs) that
//                        policy alerts fan out to.
//
// Both write to Core routes on the ACTIVE node, gated self-host-only: a managed
// (Ryu Cloud) node has its transport and recipients configured by the control
// plane, so the editable cards are hidden and a short note takes their place.
//
// AlertTier note: which tier fires (Silent/Warn/Fanout/Email) is decided by the
// gateway config (PUT /v1/config on the budget + firewall rules); this card owns
// only the DELIVERY targets and routes whatever tier the gateway sets.

import { HelpCircleIcon, Mail01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { toast } from "@ryu/ui/components/sileo";
import { Switch } from "@ryu/ui/components/switch";
import { useCallback, useEffect, useState } from "react";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	type AlertNotifyTarget,
	getAlertDelivery,
	getEmailTransport,
	putAlertDelivery,
	putEmailTransport,
	testEmail,
} from "@/src/lib/api/email-transport.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const DEFAULT_PORT = 587;

interface TransportForm {
	from: string;
	host: string;
	port: string;
	starttls: boolean;
	username: string;
}

const EMPTY_TRANSPORT: TransportForm = {
	from: "",
	host: "",
	port: String(DEFAULT_PORT),
	starttls: true,
	username: "",
};

function activeTarget(): ApiTarget {
	return toTarget(useNodeStore.getState().getActiveNode());
}

/** Parse the port field, falling back to the last-known saved port on NaN. */
function parsePort(value: string, fallback: number): number {
	const n = Number.parseInt(value.trim(), 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function SmtpTransportCard() {
	const [form, setForm] = useState<TransportForm>(EMPTY_TRANSPORT);
	const [password, setPassword] = useState("");
	const [passwordSet, setPasswordSet] = useState(false);
	// The port last returned by the server; used as the NaN fallback so we never
	// hardcode a default over a value the node already stored.
	const [savedPort, setSavedPort] = useState(DEFAULT_PORT);
	const [loading, setLoading] = useState(true);
	const [loadFailed, setLoadFailed] = useState(false);
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testTo, setTestTo] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		setLoadFailed(false);
		try {
			const t = await getEmailTransport(activeTarget());
			setForm({
				from: t.from,
				host: t.host,
				port: String(t.port),
				starttls: t.starttls,
				username: t.username,
			});
			setSavedPort(t.port);
			setPasswordSet(t.passwordSet);
			// Never prefill the secret: an empty field on save keeps the stored value.
			setPassword("");
		} catch {
			setLoadFailed(true);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load().catch(() => undefined);
	}, [load]);

	// Persist the current form. Returns true on success so Test can chain off it.
	const save = useCallback(async (): Promise<boolean> => {
		setSaving(true);
		try {
			const port = parsePort(form.port, savedPort);
			await putEmailTransport(activeTarget(), {
				from: form.from.trim(),
				host: form.host.trim(),
				port,
				starttls: form.starttls,
				username: form.username.trim(),
				// Only send the password when the user typed one; blank keeps the
				// stored secret intact (Core has no clear-password path).
				...(password.trim() ? { password } : {}),
			});
			setSavedPort(port);
			setForm((p) => ({ ...p, port: String(port) }));
			if (password.trim()) {
				setPasswordSet(true);
				setPassword("");
			}
			return true;
		} catch {
			toast.error("Couldn't save SMTP settings", {
				description: "Ryu couldn't reach this node. Check that it's running.",
			});
			return false;
		} finally {
			setSaving(false);
		}
	}, [form, password, savedPort]);

	const handleSave = useCallback(() => {
		save()
			.then((ok) => {
				if (ok) {
					toast.success("SMTP settings saved");
				}
			})
			.catch(() => undefined);
	}, [save]);

	// Test uses the node's SAVED transport, so persist the form first (the
	// unsaved fields and any freshly-typed password would otherwise be ignored).
	const handleTest = useCallback(() => {
		const to = testTo.trim();
		if (!to) {
			toast.error("Enter a recipient for the test email");
			return;
		}
		setTesting(true);
		save()
			.then(async (ok) => {
				if (!ok) {
					return;
				}
				try {
					await testEmail(activeTarget(), to);
					toast.success("Test email sent", {
						description: `Delivered to ${to}. Check the inbox.`,
					});
				} catch (e) {
					toast.error("Test email failed", {
						description:
							e instanceof Error
								? e.message
								: "The SMTP relay rejected the send.",
					});
				}
			})
			.catch(() => undefined)
			.finally(() => setTesting(false));
	}, [save, testTo]);

	if (loadFailed) {
		return (
			<SettingsCard className="space-y-3">
				<p className="font-medium text-sm">Couldn't load email settings</p>
				<p className="text-muted-foreground text-xs">
					Ryu couldn't reach this node. Check that it's running, then try again.
				</p>
				<Button
					disabled={loading}
					onClick={() => {
						load().catch(() => undefined);
					}}
					size="sm"
					variant="outline"
				>
					{loading ? "Retrying…" : "Retry"}
				</Button>
			</SettingsCard>
		);
	}

	return (
		<SettingsCard className="space-y-4">
			<div className="grid grid-cols-2 gap-4">
				<div className="col-span-2 space-y-1.5">
					<Label htmlFor="smtp-host">SMTP host</Label>
					<Input
						disabled={loading}
						id="smtp-host"
						onChange={(e) => setForm((p) => ({ ...p, host: e.target.value }))}
						placeholder="smtp.example.com"
						value={form.host}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="smtp-port">Port</Label>
					<Input
						disabled={loading}
						id="smtp-port"
						inputMode="numeric"
						onChange={(e) => setForm((p) => ({ ...p, port: e.target.value }))}
						placeholder={String(DEFAULT_PORT)}
						value={form.port}
					/>
				</div>
				<div className="flex items-end gap-3 pb-1">
					<Switch
						aria-label="Use STARTTLS"
						checked={form.starttls}
						disabled={loading}
						id="smtp-starttls"
						onCheckedChange={(v) =>
							setForm((p) => ({ ...p, starttls: Boolean(v) }))
						}
					/>
					<Label className="cursor-pointer" htmlFor="smtp-starttls">
						STARTTLS
					</Label>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="smtp-username">Username</Label>
					<Input
						autoComplete="off"
						disabled={loading}
						id="smtp-username"
						onChange={(e) =>
							setForm((p) => ({ ...p, username: e.target.value }))
						}
						placeholder="apikey / user@example.com"
						value={form.username}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="smtp-password">Password</Label>
					<Input
						autoComplete="new-password"
						disabled={loading}
						id="smtp-password"
						onChange={(e) => setPassword(e.target.value)}
						placeholder={passwordSet ? "•••••••• (unchanged)" : "SMTP password"}
						type="password"
						value={password}
					/>
					{passwordSet ? (
						<p className="text-muted-foreground text-xs">
							A password is stored. Leave blank to keep it.
						</p>
					) : null}
				</div>
				<div className="col-span-2 space-y-1.5">
					<Label htmlFor="smtp-from">From address</Label>
					<Input
						disabled={loading}
						id="smtp-from"
						onChange={(e) => setForm((p) => ({ ...p, from: e.target.value }))}
						placeholder="Ryu <alerts@example.com>"
						value={form.from}
					/>
				</div>
			</div>

			<div className="flex items-center gap-2">
				<Button disabled={loading || saving} onClick={handleSave} size="sm">
					{saving ? "Saving…" : "Save"}
				</Button>
			</div>

			<div className="space-y-1.5 border-border/60 border-t pt-4">
				<Label htmlFor="smtp-test">Send a test email</Label>
				<div className="flex items-center gap-2">
					<Input
						disabled={loading}
						id="smtp-test"
						onChange={(e) => setTestTo(e.target.value)}
						placeholder="you@example.com"
						value={testTo}
					/>
					<Button
						disabled={loading || testing || saving}
						onClick={handleTest}
						size="sm"
						variant="outline"
					>
						{testing ? "Sending…" : "Send test"}
					</Button>
				</div>
				<p className="text-muted-foreground text-xs">
					Saves the settings above, then sends a test message over this relay.
				</p>
			</div>
		</SettingsCard>
	);
}

function AlertDeliveryCard() {
	const [emails, setEmails] = useState<string[]>([]);
	const [webhooks, setWebhooks] = useState<string[]>([]);
	// Non-webhook targets (Telegram / Expo push) the card does not edit; preserved
	// verbatim so a save never drops targets configured elsewhere.
	const [otherTargets, setOtherTargets] = useState<AlertNotifyTarget[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadFailed, setLoadFailed] = useState(false);
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setLoadFailed(false);
		try {
			const cfg = await getAlertDelivery(activeTarget());
			setEmails(cfg.emails ?? []);
			const targets = cfg.targets ?? [];
			setWebhooks(
				targets
					.filter(
						(t): t is { kind: "webhook"; url: string } => t.kind === "webhook"
					)
					.map((t) => t.url)
			);
			setOtherTargets(targets.filter((t) => t.kind !== "webhook"));
		} catch {
			setLoadFailed(true);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load().catch(() => undefined);
	}, [load]);

	const save = useCallback(
		(nextEmails: string[], nextWebhooks: string[]) => {
			setSaving(true);
			const webhookTargets: AlertNotifyTarget[] = nextWebhooks
				.map((url) => url.trim())
				.filter((url) => url.length > 0)
				.map((url) => ({ kind: "webhook", url }));
			putAlertDelivery(activeTarget(), {
				emails: nextEmails.map((e) => e.trim()).filter((e) => e.length > 0),
				targets: [...webhookTargets, ...otherTargets],
			})
				.catch(() => {
					toast.error("Couldn't save alert recipients", {
						description: "Ryu couldn't reach this node.",
					});
				})
				.finally(() => setSaving(false));
		},
		[otherTargets]
	);

	const updateEmail = (i: number, value: string) => {
		setEmails((prev) => prev.map((e, idx) => (idx === i ? value : e)));
	};
	const addEmail = () => setEmails((prev) => [...prev, ""]);
	const removeEmail = (i: number) => {
		const next = emails.filter((_, idx) => idx !== i);
		setEmails(next);
		save(next, webhooks);
	};

	const updateWebhook = (i: number, value: string) => {
		setWebhooks((prev) => prev.map((w, idx) => (idx === i ? value : w)));
	};
	const addWebhook = () => setWebhooks((prev) => [...prev, ""]);
	const removeWebhook = (i: number) => {
		const next = webhooks.filter((_, idx) => idx !== i);
		setWebhooks(next);
		save(emails, next);
	};

	if (loadFailed) {
		return (
			<SettingsCard className="space-y-3">
				<p className="font-medium text-sm">Couldn't load alert recipients</p>
				<p className="text-muted-foreground text-xs">
					The node's monitor engine may still be starting. Try again shortly.
				</p>
				<Button
					disabled={loading}
					onClick={() => {
						load().catch(() => undefined);
					}}
					size="sm"
					variant="outline"
				>
					{loading ? "Retrying…" : "Retry"}
				</Button>
			</SettingsCard>
		);
	}

	return (
		<SettingsCard className="space-y-5">
			<div className="space-y-2">
				<Label>Email recipients</Label>
				<p className="text-muted-foreground text-xs">
					Addresses that receive Email-tier policy alerts over the SMTP relay
					above.
				</p>
				<div className="space-y-2">
					{emails.map((email, i) => (
						<div className="flex items-center gap-2" key={`email-${i}`}>
							<Input
								disabled={loading}
								onBlur={() => save(emails, webhooks)}
								onChange={(e) => updateEmail(i, e.target.value)}
								placeholder="alerts@example.com"
								value={email}
							/>
							<Button onClick={() => removeEmail(i)} size="sm" variant="ghost">
								Remove
							</Button>
						</div>
					))}
				</div>
				<Button
					disabled={loading || saving}
					onClick={addEmail}
					size="sm"
					variant="outline"
				>
					Add email
				</Button>
			</div>

			<div className="space-y-2 border-border/60 border-t pt-4">
				<Label>Webhook URLs</Label>
				<p className="text-muted-foreground text-xs">
					Endpoints that receive Fanout-tier alerts (Slack / Discord incoming
					webhooks or any JSON POST endpoint).
				</p>
				<div className="space-y-2">
					{webhooks.map((url, i) => (
						<div className="flex items-center gap-2" key={`webhook-${i}`}>
							<Input
								disabled={loading}
								onBlur={() => save(emails, webhooks)}
								onChange={(e) => updateWebhook(i, e.target.value)}
								placeholder="https://hooks.example.com/…"
								value={url}
							/>
							<Button
								onClick={() => removeWebhook(i)}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
						</div>
					))}
				</div>
				<Button
					disabled={loading || saving}
					onClick={addWebhook}
					size="sm"
					variant="outline"
				>
					Add webhook
				</Button>
			</div>
		</SettingsCard>
	);
}

export function EmailAlertsSettings() {
	// Subscribe reactively so switching to a managed node hides the cards live.
	const isManaged = useNodeStore((s) => Boolean(s.getActiveNode().managed));

	if (isManaged) {
		return (
			<SettingsSection
				caption="This is a Ryu Cloud node. Its outbound email relay and alert recipients are managed for you in the cloud dashboard."
				title="Email & alerts"
			>
				<SettingsCard className="flex items-center gap-3">
					<HugeiconsIcon
						className="size-5 text-muted-foreground"
						icon={HelpCircleIcon}
					/>
					<p className="text-muted-foreground text-sm">
						Email transport and alert delivery are configured by Ryu Cloud for
						managed nodes.
					</p>
				</SettingsCard>
			</SettingsSection>
		);
	}

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Your node's outbound email relay (BYO SMTP). Used to send policy-alert emails and test messages. Nothing is sent until you configure a relay here."
				title="SMTP transport"
			>
				<div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs">
					<HugeiconsIcon className="size-4" icon={Mail01Icon} />
					<span>
						Credentials stay on this node and are never sent to Ryu Cloud.
					</span>
				</div>
				<SmtpTransportCard />
			</SettingsSection>

			<SettingsSection
				caption="Where policy alerts (budget caps, firewall blocks, wallet-empty) are delivered on this node. The alert tier that fires is set in the Gateway config; this only chooses the recipients."
				title="Alert delivery"
			>
				<AlertDeliveryCard />
			</SettingsSection>
		</div>
	);
}

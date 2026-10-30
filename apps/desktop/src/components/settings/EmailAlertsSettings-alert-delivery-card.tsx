// apps/desktop/src/components/settings/EmailAlertsSettings-alert-delivery-card.tsx
//
// Alert delivery card for EmailAlertsSettings: the node-level recipients
// (emails + webhook URLs) that policy alerts fan out to.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AlertNotifyTarget,
	getAlertDelivery,
	putAlertDelivery,
} from "@/src/lib/api/email-transport.ts";
import { SettingsCard } from "./shared/settings-items.tsx";

/**
 * One webhook row. A saved webhook arrives redacted (`url` is the placeholder)
 * with the `secretRef` Core needs to keep the stored URL and a host `preview`;
 * editing the field drops both, so the typed URL replaces the stored one.
 */
interface WebhookEntry {
	preview?: string;
	secretRef?: string;
	url: string;
}

function webhookTarget(entry: WebhookEntry): AlertNotifyTarget {
	const url = entry.url.trim();
	return entry.secretRef
		? { kind: "webhook", url, secret_ref: entry.secretRef }
		: { kind: "webhook", url };
}

export function AlertDeliveryCard({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const [emails, setEmails] = useState<string[]>([]);
	const [webhooks, setWebhooks] = useState<WebhookEntry[]>([]);
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
			const cfg = await getAlertDelivery(target);
			setEmails(cfg.emails ?? []);
			const targets = cfg.targets ?? [];
			setWebhooks(
				targets
					.filter(
						(t): t is Extract<AlertNotifyTarget, { kind: "webhook" }> =>
							t.kind === "webhook"
					)
					.map((t) => ({
						url: t.url,
						secretRef: t.secret_ref,
						preview: t.preview,
					}))
			);
			setOtherTargets(targets.filter((t) => t.kind !== "webhook"));
		} catch {
			setLoadFailed(true);
		} finally {
			setLoading(false);
		}
	}, [target]);

	useEffect(() => {
		load().catch(() => undefined);
	}, [load]);

	const save = useCallback(
		(nextEmails: string[], nextWebhooks: WebhookEntry[]) => {
			setSaving(true);
			const webhookTargets: AlertNotifyTarget[] = nextWebhooks
				.filter((entry) => entry.url.trim().length > 0)
				.map(webhookTarget);
			putAlertDelivery(target, {
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
		[otherTargets, target]
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
		setWebhooks((prev) =>
			prev.map((w, idx) => (idx === i ? { url: value } : w))
		);
	};
	const addWebhook = () => setWebhooks((prev) => [...prev, { url: "" }]);
	const removeWebhook = (i: number) => {
		const next = webhooks.filter((_, idx) => idx !== i);
		setWebhooks(next);
		save(emails, next);
	};

	if (loadFailed) {
		return (
			<SettingsCard className="space-y-3 py-3">
				<p className="font-medium text-sm">Couldn't load alert recipients</p>
				<p className="text-detail text-muted-foreground">
					The node's monitor engine may still be starting. Try again shortly.
				</p>
				<Button
					disabled={loading}
					onClick={() => {
						load().catch(() => undefined);
					}}
					size="sm"
					variant="ghost"
				>
					{loading ? "Retrying…" : "Retry"}
				</Button>
			</SettingsCard>
		);
	}

	return (
		<SettingsCard className="space-y-6 py-3">
			<div className="space-y-2">
				<Label>Email recipients</Label>
				<p className="text-detail text-muted-foreground">
					Addresses that receive Email-tier policy alerts over the SMTP relay
					above.
				</p>
				<div className="space-y-2">
					{emails.map((email, i) => (
						<div className="flex items-center gap-2" key={`email-${i}`}>
							<Input
								aria-label={tl("Email recipient {number}", { number: i + 1 })}
								disabled={loading}
								onBlur={() => save(emails, webhooks)}
								onChange={(e) => updateEmail(i, e.target.value)}
								placeholder="alerts@example.com"
								value={email}
							/>
							<Button
								aria-label={tl("Remove email recipient {number}", {
									number: i + 1,
								})}
								onClick={() => removeEmail(i)}
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
					onClick={addEmail}
					size="sm"
					variant="ghost"
				>
					Add email
				</Button>
			</div>

			<div className="space-y-2 border-border border-t pt-4">
				<Label>Webhook URLs</Label>
				<p className="text-detail text-muted-foreground">
					Endpoints that receive Fanout-tier alerts (Slack / Discord incoming
					webhooks or any JSON POST endpoint).
				</p>
				<div className="space-y-2">
					{webhooks.map((entry, i) => (
						<div className="flex items-center gap-2" key={`webhook-${i}`}>
							<Input
								aria-label={tl("Webhook URL {number}", { number: i + 1 })}
								disabled={loading}
								onBlur={() => save(emails, webhooks)}
								onChange={(e) => updateWebhook(i, e.target.value)}
								placeholder="https://hooks.example.com/…"
								type={entry.secretRef ? "password" : undefined}
								value={entry.url}
							/>
							{entry.secretRef ? (
								<span className="shrink-0 text-detail text-muted-foreground">
									{entry.preview
										? tl("Saved · {preview}", { preview: entry.preview })
										: tl("Saved")}
								</span>
							) : null}
							<Button
								aria-label={tl("Remove webhook URL {number}", {
									number: i + 1,
								})}
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
					variant="ghost"
				>
					Add webhook
				</Button>
			</div>
		</SettingsCard>
	);
}

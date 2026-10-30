// apps/desktop/src/components/settings/EmailAlertsSettings-smtp-card.tsx
//
// SMTP transport card for EmailAlertsSettings: the node's BYO outbound relay
// (host/port/user/pass/from/STARTTLS) plus a Test-send button.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useState } from "react";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import {
	getEmailTransport,
	putEmailTransport,
	testEmail,
} from "@/src/lib/api/email-transport.ts";
import { SettingsCard } from "./shared/settings-items.tsx";

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

function emailErrorMessage<TError>(error: TError): string {
	if (error instanceof ApiError && error.serverMessage) {
		return error.serverMessage;
	}
	return error instanceof Error
		? error.message
		: "The SMTP relay rejected the send.";
}

/** Parse the port field, falling back to the last-known saved port on NaN. */
function parsePort(value: string, fallback: number): number {
	const n = Number.parseInt(value.trim(), 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function SmtpTransportCard({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
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
			const t = await getEmailTransport(target);
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
	}, [target]);

	useEffect(() => {
		load().catch(() => undefined);
	}, [load]);

	// Persist the current form. Returns true on success so Test can chain off it.
	const save = useCallback(async (): Promise<boolean> => {
		setSaving(true);
		try {
			const port = parsePort(form.port, savedPort);
			await putEmailTransport(target, {
				from: form.from.trim(),
				host: form.host.trim(),
				port,
				starttls: form.starttls,
				username: form.username.trim(),
				// Only send the password when the user typed one; blank keeps the
				// stored secret intact (Core has no clear-password path).
				...(password.trim() ? { password } : undefined),
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
	}, [form, password, savedPort, target]);

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
					await testEmail(target, to);
					toast.success("Test email sent", {
						description: tl("Delivered to {to}. Check the inbox.", { to }),
					});
				} catch (e) {
					toast.error("Test email failed", {
						description: emailErrorMessage(e),
					});
				}
			})
			.catch(() => undefined)
			.finally(() => setTesting(false));
	}, [save, testTo, target, tl]);

	if (loadFailed) {
		return (
			<SettingsCard className="space-y-3 py-3">
				<p className="font-medium text-sm">Couldn't load email settings</p>
				<p className="text-detail text-muted-foreground">
					Ryu couldn't reach this node. Check that it's running, then try again.
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
		<SettingsCard className="space-y-4 py-3">
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
				<p className="col-span-2 -mt-2 text-detail text-muted-foreground">
					With STARTTLS off, Ryu uses implicit TLS (SMTPS). Only a relay on this
					machine (localhost) on a port other than 465 is reached without
					encryption.
				</p>
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
						<p className="text-detail text-muted-foreground">
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

			<div className="space-y-1.5 border-border border-t pt-4">
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
						variant="ghost"
					>
						{testing ? "Sending…" : "Send test"}
					</Button>
				</div>
				<p className="text-detail text-muted-foreground">
					Saves the settings above, then sends a test message over this relay.
				</p>
			</div>
		</SettingsCard>
	);
}

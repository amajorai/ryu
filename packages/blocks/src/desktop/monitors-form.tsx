"use client";

import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import { Switch } from "@ryu/ui/components/switch";
import type {
	MonitorInput,
	NotifyTarget,
	ProviderUsageSnapshot,
	PublicNotifyTarget,
	UsageProviderOption,
} from "@ryuhq/core-client/monitors";
import { monitorNotifyTargetsInputSchema } from "@ryuhq/core-client/monitors";
import { useEffect, useState } from "react";
import { CheckTypeFields } from "./monitors-check-fields.tsx";
import {
	backendSelection,
	buildInput,
	CHECK_LABELS,
	checkSelection,
	type FormState,
	patch,
} from "./monitors-form-state.ts";
import type {
	UsageAccountsByProvider,
	UsageSelectionChange,
} from "./monitors-usage-accounts.ts";

interface NotifyFieldsPatch {
	bot_token?: Extract<NotifyTarget, { kind: "telegram" }>["bot_token"];
	chat_id?: Extract<NotifyTarget, { kind: "telegram" }>["chat_id"];
	to?: Extract<NotifyTarget, { kind: "email" }>["to"];
	url?: Extract<NotifyTarget, { kind: "webhook" }>["url"];
}

function NotifyEditor({
	notify,
	setForm,
}: {
	notify: PublicNotifyTarget[];
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
}) {
	const update = (next: PublicNotifyTarget[]) =>
		setForm((prev) => ({ ...prev, notify: next }));
	const addWebhook = () => update([...notify, { kind: "webhook", url: "" }]);
	const addTelegram = () =>
		update([...notify, { kind: "telegram", bot_token: "", chat_id: "" }]);
	const addEmail = () => update([...notify, { kind: "email", to: "" }]);
	const removeAt = (i: number) => update(notify.filter((_, idx) => idx !== i));
	const patchAt = (i: number, p: NotifyFieldsPatch) =>
		update(notify.map((t, idx) => (idx === i ? { ...t, ...p } : t)));

	return (
		<div className="space-y-2">
			<Label>Notify (in-app + mobile push are automatic)</Label>
			{notify.map((t, i) => (
				<div className="flex items-center gap-2" key={`${t.kind}-${i}`}>
					{t.kind === "webhook" ? (
						<Input
							aria-label="Webhook URL"
							className="flex-1"
							onChange={(e) => patchAt(i, { url: e.target.value })}
							placeholder="Slack/Discord webhook URL"
							value={t.url}
						/>
					) : null}
					{t.kind === "telegram" ? (
						<>
							<Input
								aria-invalid={t.bot_token === undefined}
								aria-label="Telegram bot token"
								className="flex-1"
								onChange={(e) => patchAt(i, { bot_token: e.target.value })}
								placeholder={
									t.bot_token === undefined
										? "Enter bot token to save"
										: "Bot token"
								}
								value={t.bot_token}
							/>
							<Input
								aria-label="Telegram chat ID"
								className="w-32"
								onChange={(e) => patchAt(i, { chat_id: e.target.value })}
								placeholder="Chat ID"
								value={t.chat_id}
							/>
						</>
					) : null}
					{t.kind === "email" ? (
						<Input
							aria-label="Email recipient"
							className="flex-1"
							onChange={(e) => patchAt(i, { to: e.target.value })}
							placeholder="Email recipient"
							value={t.to}
						/>
					) : null}
					<Button
						aria-label="Remove notification target"
						onClick={() => removeAt(i)}
						size="sm"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Delete02Icon} />
					</Button>
				</div>
			))}
			<div className="flex gap-2">
				<Button onClick={addWebhook} size="sm" type="button" variant="outline">
					+ Webhook
				</Button>
				<Button onClick={addTelegram} size="sm" type="button" variant="outline">
					+ Telegram
				</Button>
				<Button onClick={addEmail} size="sm" type="button" variant="outline">
					+ Email
				</Button>
			</div>
		</div>
	);
}

export function MonitorForm({
	initial,
	saving,
	onSave,
	onCancel,
	providerOptions,
	usageAccounts,
	usageSnapshot,
	usageLoading,
	providerCatalogLoading,
	usageError,
	onUsageProviderChange,
}: {
	initial: FormState;
	saving: boolean;
	onSave: (input: MonitorInput) => void;
	onCancel: () => void;
	providerOptions: UsageProviderOption[];
	usageAccounts: UsageAccountsByProvider;
	usageSnapshot?: ProviderUsageSnapshot;
	usageLoading: boolean;
	providerCatalogLoading: boolean;
	usageError?: string | null;
	onUsageProviderChange: UsageSelectionChange;
}) {
	const [form, setForm] = useState<FormState>(initial);
	useEffect(() => setForm(initial), [initial]);
	useEffect(() => {
		if (form.checkType === "provider_usage_reset") {
			onUsageProviderChange(
				form.providerId || null,
				form.accountId || undefined
			);
		}
	}, [form.checkType, form.providerId, form.accountId, onUsageProviderChange]);
	const accountOptions = usageAccounts[form.providerId] ?? [];
	// A pin is kept when this host cannot list accounts; it must name a saved
	// account only when the list is known.
	const validAccount =
		form.accountId === "" ||
		accountOptions.length === 0 ||
		accountOptions.some((account) => account.accountId === form.accountId);

	const validMinimumDrop =
		Number.isFinite(Number(form.minimumDropPercent)) &&
		Number(form.minimumDropPercent) > 0 &&
		Number(form.minimumDropPercent) <= 100;
	const notifyInput = monitorNotifyTargetsInputSchema.safeParse(form.notify);
	const canSave =
		notifyInput.success &&
		form.name.trim() !== "" &&
		(form.checkType === "provider_usage_reset"
			? form.providerId !== "" &&
				form.targetIds.length > 0 &&
				validMinimumDrop &&
				validAccount
			: form.url.trim() !== "");
	const isProviderUsage = form.checkType === "provider_usage_reset";

	return (
		<div className="mx-auto max-w-2xl space-y-4">
			<div className="space-y-1.5">
				<Label htmlFor="m-name">Name</Label>
				<Input
					id="m-name"
					onChange={(e) => patch(setForm, "name")(e.target.value)}
					value={form.name}
				/>
			</div>
			{isProviderUsage ? null : (
				<div className="space-y-1.5">
					<Label htmlFor="m-url">URL</Label>
					<Input
						id="m-url"
						onChange={(e) => patch(setForm, "url")(e.target.value)}
						placeholder="https://example.com/product"
						value={form.url}
					/>
				</div>
			)}
			<div className="flex gap-3">
				<div className="flex-1 space-y-1.5">
					<Label htmlFor="m-type">What to monitor</Label>
					<NativeSelect
						className="w-full"
						id="m-type"
						onChange={(e) => {
							const checkType = checkSelection.parse(e.target.value);
							setForm((previous) => ({
								...previous,
								checkType,
								interval:
									checkType === "provider_usage_reset" &&
									previous.interval === "10m"
										? "5m"
										: previous.interval,
							}));
						}}
						value={form.checkType}
					>
						{Object.entries(CHECK_LABELS).map(([k, label]) => (
							<NativeSelectOption key={k} value={k}>
								{label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				{isProviderUsage ? null : (
					<div className="w-40 space-y-1.5">
						<Label htmlFor="m-backend">Fetch via</Label>
						<NativeSelect
							className="w-full"
							id="m-backend"
							onChange={(e) =>
								patch(
									setForm,
									"backend"
								)(backendSelection.parse(e.target.value))
							}
							value={form.backend}
						>
							<NativeSelectOption value="http">HTTP (fast)</NativeSelectOption>
							<NativeSelectOption value="spider">
								Spider crawler
							</NativeSelectOption>
							<NativeSelectOption value="agentbrowser">
								AI browser
							</NativeSelectOption>
						</NativeSelect>
					</div>
				)}
				<div className="w-32 space-y-1.5">
					<Label htmlFor="m-interval">Check every</Label>
					<Input
						id="m-interval"
						onChange={(e) => patch(setForm, "interval")(e.target.value)}
						placeholder="10m"
						value={form.interval}
					/>
				</div>
			</div>

			<CheckTypeFields
				accountOptions={accountOptions}
				form={form}
				onUsageProviderChange={onUsageProviderChange}
				providerCatalogLoading={providerCatalogLoading}
				providerOptions={providerOptions}
				setForm={setForm}
				usageError={usageError}
				usageLoading={usageLoading}
				usageSnapshot={usageSnapshot}
			/>
			<NotifyEditor notify={form.notify} setForm={setForm} />
			{notifyInput.success ? null : (
				<p className="text-muted-foreground text-sm" role="status">
					Enter the Telegram bot token before saving this monitor.
				</p>
			)}

			<label className="flex items-center gap-2 text-sm">
				<Switch
					checked={form.enabled}
					onCheckedChange={(v) => patch(setForm, "enabled")(Boolean(v))}
				/>
				Enabled
			</label>

			<div className="flex gap-2 pt-2">
				<Button
					disabled={!canSave || saving}
					onClick={() => {
						if (notifyInput.success) {
							onSave(buildInput(form, notifyInput.data));
						}
					}}
				>
					{saving ? "Saving…" : "Save monitor"}
				</Button>
				<Button onClick={onCancel} type="button" variant="ghost">
					Cancel
				</Button>
			</div>
		</div>
	);
}

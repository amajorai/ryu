"use client";
import { Alert, AlertDescription, AlertTitle } from "@ryu/ui/components/alert";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import type { Dispatch, SetStateAction } from "react";
import type { PlatformOptionField } from "./channels-constants.ts";
import type { FormState } from "./channels-model.ts";
import { type ChannelSetup, SECRET_LABELS } from "./channels-setup.ts";

interface ChannelCredentialsSectionProps {
	form: FormState;
	managedBotReady: boolean;
	optionalKeys: string[];
	platformOptionFields: PlatformOptionField[];
	requiredKeys: string[];
	setForm: Dispatch<SetStateAction<FormState>>;
	setup: ChannelSetup;
}

export function ChannelCredentialsSection({
	form,
	setForm,
	managedBotReady,
	optionalKeys,
	platformOptionFields,
	requiredKeys,
	setup,
}: ChannelCredentialsSectionProps) {
	return (
		<>
			{/* Credentials — the fields are exactly what the platform's
						    gateway adapter refuses to start without. */}
			<div className="space-y-3 rounded-lg border bg-card p-4">
				<p className="font-medium text-sm">Credentials</p>
				<p className="text-muted-foreground text-xs">
					{managedBotReady
						? "Ryu has already connected this dedicated bot to your managed node. Leave the field blank to keep it, or paste your own token below to switch credentials."
						: setup.note}
				</p>
				{requiredKeys.map((key) => {
					const isSet = form.existingSecretKeys.includes(key);
					const help = setup.secretHelp[key];
					const isManagedBotToken = managedBotReady && key === "bot_token";
					return (
						<div className="space-y-1.5" key={key}>
							<Label htmlFor={`secret-${key}`}>
								{isManagedBotToken
									? "Replace with your own bot token (optional)"
									: (SECRET_LABELS[key] ?? key)}
							</Label>
							<Input
								aria-describedby={help ? `secret-${key}-help` : undefined}
								autoComplete="off"
								id={`secret-${key}`}
								name={`secret-${key}`}
								onChange={(e) =>
									setForm((f) => ({
										...f,
										secrets: { ...f.secrets, [key]: e.target.value },
									}))
								}
								placeholder={
									isManagedBotToken
										? "Leave blank to keep the Ryu-managed bot"
										: isSet
											? "•••••••• (unchanged)"
											: "Paste value…"
								}
								type={
									key === "openwa_url" || key === "webhook_url"
										? "url"
										: "password"
								}
								value={form.secrets[key] ?? ""}
							/>
							{isManagedBotToken ? (
								<p
									className="text-muted-foreground text-xs"
									id={`secret-${key}-help`}
								>
									Saving a token here changes this channel to customer-managed
									credentials. Provider ownership transfer is not automatic.
								</p>
							) : help ? (
								<p
									className="text-muted-foreground text-xs"
									id={`secret-${key}-help`}
								>
									{help}
								</p>
							) : null}
						</div>
					);
				})}
				{optionalKeys.length > 0 || platformOptionFields.length > 0 ? (
					<div className="space-y-3 border-t pt-3">
						<div>
							<p className="font-medium text-sm">Advanced delivery</p>
							<p className="text-muted-foreground text-xs">
								Optional settings stay with this channel, so another bot can use
								different delivery, mention, and thread behavior.
							</p>
						</div>
						{optionalKeys.map((key) => {
							const isSet = form.existingSecretKeys.includes(key);
							const help = setup.secretHelp[key];
							const isBoolean = key === "self_chat_only";
							return (
								<div className="space-y-1.5" key={key}>
									<Label htmlFor={`secret-${key}`}>
										{SECRET_LABELS[key] ?? key}
									</Label>
									<Input
										aria-describedby={help ? `secret-${key}-help` : undefined}
										autoComplete="off"
										id={`secret-${key}`}
										name={`secret-${key}`}
										onChange={(e) =>
											setForm((f) => ({
												...f,
												secrets: { ...f.secrets, [key]: e.target.value },
											}))
										}
										placeholder={
											isSet
												? "•••••••• (unchanged)"
												: isBoolean
													? "true or false"
													: "Leave blank for default…"
										}
										type={
											isBoolean ||
											[
												"webhook_bind",
												"webhook_path",
												"graph_version",
												"channel_ids",
											].includes(key)
												? "text"
												: "password"
										}
										value={form.secrets[key] ?? ""}
									/>
									{help ? (
										<p
											className="text-muted-foreground text-xs"
											id={`secret-${key}-help`}
										>
											{help}
										</p>
									) : null}
								</div>
							);
						})}
						{platformOptionFields.map((field) => (
							<div className="space-y-1.5" key={field.key}>
								<Label htmlFor={`platform-option-${field.key}`}>
									{field.label}
								</Label>
								<Input
									aria-describedby={`platform-option-${field.key}-help`}
									id={`platform-option-${field.key}`}
									inputMode={field.kind === "number" ? "numeric" : undefined}
									onChange={(e) =>
										setForm((f) => ({
											...f,
											platformOptionInputs: {
												...f.platformOptionInputs,
												[field.key]: e.target.value,
											},
										}))
									}
									placeholder={
										field.kind === "boolean"
											? "true or false"
											: field.kind === "list"
												? "id1, id2"
												: "Leave blank for default…"
									}
									type={field.kind === "url" ? "url" : "text"}
									value={form.platformOptionInputs[field.key] ?? ""}
								/>
								<p
									className="text-muted-foreground text-xs"
									id={`platform-option-${field.key}-help`}
								>
									{field.help}
								</p>
							</div>
						))}
					</div>
				) : null}
				<p className="text-muted-foreground text-xs">
					Values are stored encrypted and never shown again. On edit, leave a
					field blank to keep the stored value.
				</p>
			</div>

			{/* Hard external prerequisite (today: WhatsApp's public webhook). */}
			{setup.warning ? (
				<Alert>
					<AlertTitle>Before you connect</AlertTitle>
					<AlertDescription>{setup.warning}</AlertDescription>
				</Alert>
			) : null}
		</>
	);
}

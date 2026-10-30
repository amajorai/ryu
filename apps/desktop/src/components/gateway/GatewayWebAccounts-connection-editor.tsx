import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SvglIcon } from "@ryu/blocks/web/svgl-icon.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@ryu/ui/components/field.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useEffect, useId, useRef, useState } from "react";
import { SettingsItem } from "@/src/components/settings/shared/settings-items.tsx";
import {
	type GATEWAY_WEB_PROVIDERS,
	type GatewayWebAccountEdit,
	GatewayWebAccountSavedError,
	type GatewayWebConnection,
	type GatewayWebContext,
} from "@/src/lib/api/web-service-accounts.ts";
import {
	ProviderBrandLogo,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";
import { gatewayAccountErrorMessage } from "./GatewayProviderKeyRow.tsx";
import { AccountPolicy } from "./GatewayWebAccounts-account-policy.tsx";
import {
	ContextFields,
	defaultContext,
	validContext,
} from "./GatewayWebAccounts-context-fields.tsx";

export function ConnectionEditor({
	definition,
	connection,
	disabled,
	writing,
	revision,
	mutate,
	applySaved,
}: {
	definition: (typeof GATEWAY_WEB_PROVIDERS)[number];
	connection: GatewayWebConnection;
	disabled: boolean;
	writing: boolean;
	revision: string;
	mutate: (edit: GatewayWebAccountEdit) => Promise<void>;
	applySaved: (revision: string) => Promise<void>;
}) {
	const keyFieldId = useId();
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const [key, setKey] = useState("");
	const [context, setContext] = useState<GatewayWebContext>(() =>
		defaultContext(definition.id)
	);
	const [replacement, setReplacement] = useState<string | null>(null);
	const [keyForm, setKeyForm] = useState(!connection.anonymous);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pendingRevision, setPendingRevision] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (disabled) {
			setKey("");
			setReplacement(null);
		}
	}, [disabled]);
	useEffect(() => {
		if (!connection.anonymous) {
			setKeyForm(true);
		}
	}, [connection.anonymous]);
	const locked = disabled || busy || writing || pendingRevision !== null;
	const resetCredential = () => {
		setKey("");
		setReplacement(null);
		setContext(defaultContext(definition.id));
	};
	const run = async (edit: GatewayWebAccountEdit): Promise<boolean> => {
		if (disabled || busy || writing || pendingRevision) {
			return false;
		}
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await mutate(edit);
			if (!mounted.current) {
				return false;
			}
			if (
				edit.action === "add" ||
				edit.action === "replace" ||
				edit.action === "context"
			) {
				resetCredential();
			}
			if (edit.action === "anonymous") {
				setKeyForm(false);
				resetCredential();
			}
			if (edit.action === "clear") {
				setKeyForm(true);
				resetCredential();
			}
			setNotice("Saved and applied to new requests.");
			return true;
		} catch (cause) {
			if (!mounted.current) {
				return false;
			}
			if (cause instanceof GatewayWebAccountSavedError) {
				setPendingRevision(cause.savedRevision);
			}
			setError(gatewayAccountErrorMessage(cause, "Web account update failed."));
			return false;
		} finally {
			if (mounted.current) {
				setBusy(false);
			}
		}
	};
	const apply = async () => {
		if (!pendingRevision || disabled || busy) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await applySaved(pendingRevision);
			if (mounted.current) {
				setPendingRevision(null);
				resetCredential();
				setNotice("Saved and applied to new requests.");
			}
		} catch (cause) {
			if (mounted.current) {
				setError(
					gatewayAccountErrorMessage(
						cause,
						"Saved web accounts could not be applied."
					)
				);
			}
		} finally {
			if (mounted.current) {
				setBusy(false);
			}
		}
	};
	const label = definition.label;
	const selectedAccount = connection.accounts.find(
		(account) => account.accountId === replacement
	);
	const contextChanged =
		selectedAccount !== undefined &&
		JSON.stringify(context) !== JSON.stringify(selectedAccount.context);
	const canSubmitEdit =
		Boolean(key) || (replacement !== null && contextChanged);
	const editKey = () => {
		if (!replacement) {
			return run({
				action: "add",
				provider: definition.id,
				apiKey: key,
				context,
			});
		}
		if (!key) {
			return run({
				action: "context",
				provider: definition.id,
				accountId: replacement,
				context,
			});
		}
		return run({
			action: "replace",
			provider: definition.id,
			accountId: replacement,
			apiKey: key,
			context,
		});
	};
	let submitLabel = "Add account";
	if (replacement) {
		submitLabel = key ? "Replace account" : "Save account context";
	}
	let status = "No accounts";
	if (connection.anonymous) {
		status = "Anonymous";
	} else if (connection.accounts.length > 0) {
		status = `${connection.accounts.length} saved ${connection.accounts.length === 1 ? "account" : "accounts"}`;
	}
	let logo = (
		<HugeiconsIcon
			className="size-4 text-muted-foreground"
			icon={Search01Icon}
		/>
	);
	if (definition.id === "google-pse") {
		logo = <SvglIcon size={16} spec="google" />;
	} else if (svglForProvider(definition.brand)) {
		logo = <ProviderBrandLogo providerKey={definition.brand} size={16} />;
	}
	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-2">
					<span className="text-muted-foreground text-sm">{status}</span>
					<Button
						aria-label={tl("Manage {label} accounts", { label })}
						onClick={() => setOpen(!open)}
						size="sm"
						variant="ghost"
					>
						{open ? "Close" : "Manage"}
					</Button>
				</div>
			}
			title={
				<span className="flex items-center gap-2">
					{logo}
					{label}
				</span>
			}
		>
			<p className="text-muted-foreground text-xs">
				{definition.operations
					.map((operation) =>
						operation === "search" ? "Web search" : "Page fetch"
					)
					.join(" · ")}
			</p>
			{open ? (
				<div className="flex flex-col gap-4">
					{connection.accounts.map((account, index) => (
						<AccountPolicy
							account={account}
							disabled={locked}
							index={index}
							key={account.accountId}
							label={label}
							onRemove={() =>
								run({
									action: "remove",
									provider: definition.id,
									accountId: account.accountId,
								})
							}
							onReplace={() => {
								setReplacement(account.accountId);
								setContext(account.context);
								setKey("");
								setKeyForm(true);
								setError(null);
							}}
							onSave={(accountPolicy) =>
								run({
									action: "configure",
									provider: definition.id,
									accountId: account.accountId,
									accountPolicy,
								})
							}
						/>
					))}
					{connection.anonymous ? (
						<p className="text-muted-foreground text-xs">
							Jina Reader is explicitly configured for anonymous access. No
							provider key or credential account is used.
						</p>
					) : null}
					{!disabled && connection.anonymous && !keyForm ? (
						<Button
							disabled={locked}
							onClick={() => setKeyForm(true)}
							size="sm"
							variant="secondary"
						>
							Use API-key accounts
						</Button>
					) : null}
					{!disabled && keyForm ? (
						<FieldGroup
							data-testid={`gateway-web-${definition.id}-credential-form`}
						>
							<Field>
								<FieldLabel htmlFor={keyFieldId}>
									{replacement ? "Replacement API key (optional)" : "API key"}
								</FieldLabel>
								<Input
									aria-label={`${label} ${replacement ? "replacement API key" : "API key"}`}
									autoComplete="off"
									disabled={locked}
									id={keyFieldId}
									maxLength={4096}
									onChange={(event) => setKey(event.target.value)}
									type="password"
									value={key}
								/>
							</Field>
							<ContextFields
								context={context}
								disabled={locked}
								label={label}
								onChange={setContext}
							/>
							{connection.anonymous ? (
								<FieldDescription>
									Saving a key switches this connection to API-key accounts.
								</FieldDescription>
							) : null}
							<div className="flex flex-wrap gap-2">
								<Button
									disabled={
										locked ||
										!canSubmitEdit ||
										!validContext(context) ||
										(replacement !== null &&
											!connection.accounts.some(
												(account) => account.accountId === replacement
											))
									}
									loading={busy}
									onClick={editKey}
									size="sm"
									variant="outline"
								>
									{submitLabel}
								</Button>
								{replacement ? (
									<Button
										disabled={locked}
										onClick={resetCredential}
										size="sm"
										variant="ghost"
									>
										Cancel replacement
									</Button>
								) : null}
								{definition.id === "jina-reader" &&
								connection.accounts.length === 0 &&
								!connection.anonymous ? (
									<Button
										disabled={locked}
										onClick={() =>
											run({ action: "anonymous", provider: definition.id })
										}
										size="sm"
										variant="secondary"
									>
										Use anonymous access
									</Button>
								) : null}
							</div>
						</FieldGroup>
					) : null}
					{connection.anonymous && !disabled ? (
						<Button
							disabled={locked}
							onClick={() => run({ action: "clear", provider: definition.id })}
							size="sm"
							variant="ghost"
						>
							Disable anonymous connection
						</Button>
					) : null}
					{error ? (
						<p className="text-status-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}
					{pendingRevision ? (
						<Button
							disabled={disabled || busy || revision !== pendingRevision}
							loading={busy}
							onClick={apply}
							size="sm"
							variant="outline"
						>
							Apply saved accounts
						</Button>
					) : null}
					{pendingRevision && revision !== pendingRevision ? (
						<p className="text-muted-foreground text-xs">
							A newer saved revision is available. Refresh the node before
							applying it.
						</p>
					) : null}
					{notice ? (
						<p className="text-muted-foreground text-xs" role="status">
							{notice}
						</p>
					) : null}
				</div>
			) : null}
		</SettingsItem>
	);
}

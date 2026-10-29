import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SvglIcon } from "@ryu/blocks/web/svgl-icon.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@ryu/ui/components/field.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	applyGatewayWebAccounts,
	editGatewayWebAccount,
	GATEWAY_WEB_PROVIDERS,
	type GatewayWebAccount,
	type GatewayWebAccountEdit,
	GatewayWebAccountSavedError,
	type GatewayWebAccountsView,
	type GatewayWebConnection,
	type GatewayWebContext,
	type GatewayWebPolicy,
	type GatewayWebProvider,
	getGatewayWebAccounts,
	sameGatewayWebTarget,
} from "@/src/lib/api/web-service-accounts.ts";
import {
	ProviderBrandLogo,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";
import { gatewayAccountErrorMessage } from "./GatewayProviderKeyRow.tsx";
import { SettingsNotice } from "./SettingsNotice.tsx";

function defaultContext(provider: GatewayWebProvider): GatewayWebContext {
	if (provider === "google-pse") {
		return {
			kind: "google_pse",
			engine_id: "",
			existing_customer_acknowledged: false,
		};
	}
	if (provider === "searchapi") {
		return { kind: "search_api", engine: "google" };
	}
	return { kind: "default" };
}
function validContext(context: GatewayWebContext): boolean {
	return (
		context.kind !== "google_pse" ||
		(context.engine_id.trim().length > 0 && context.engine_id.length <= 256)
	);
}
function emptyConnection(provider: GatewayWebProvider): GatewayWebConnection {
	return { provider, anonymous: false, accounts: [] };
}

function ContextFields({
	context,
	label,
	disabled,
	onChange,
}: {
	context: GatewayWebContext;
	label: string;
	disabled: boolean;
	onChange: (context: GatewayWebContext) => void;
}) {
	const fieldId = useId();
	if (context.kind === "default") {
		return null;
	}
	if (context.kind === "search_api") {
		return (
			<Field>
				<FieldLabel htmlFor={fieldId}>Search engine</FieldLabel>
				<Input
					aria-label={`${label} search engine`}
					id={fieldId}
					readOnly
					value="Google"
				/>
				<FieldDescription>
					This connection uses the Google engine.
				</FieldDescription>
			</Field>
		);
	}
	return (
		<FieldGroup>
			<Field data-invalid={!validContext(context)}>
				<FieldLabel htmlFor={`${fieldId}-engine`}>Search engine ID</FieldLabel>
				<Input
					aria-invalid={!validContext(context)}
					aria-label={`${label} search engine ID`}
					autoComplete="off"
					disabled={disabled}
					id={`${fieldId}-engine`}
					maxLength={256}
					onChange={(event) =>
						onChange({ ...context, engine_id: event.target.value })
					}
					value={context.engine_id}
				/>
				<FieldDescription>
					Each key and engine combination has its own account identity.
				</FieldDescription>
			</Field>
			<Field data-disabled={disabled} orientation="horizontal">
				<Checkbox
					aria-label={`${label} existing customer confirmation`}
					checked={context.existing_customer_acknowledged}
					disabled={disabled}
					id={`${fieldId}-customer`}
					onCheckedChange={(checked) =>
						onChange({ ...context, existing_customer_acknowledged: checked })
					}
				/>
				<FieldLabel htmlFor={`${fieldId}-customer`}>
					<span className="sr-only">
						{label} existing customer confirmation
					</span>
					<span aria-hidden="true">
						Existing Custom Search JSON API customer
					</span>
				</FieldLabel>
			</Field>
			<FieldDescription>
				New customers cannot use this API. Unconfirmed accounts stay inactive.
				Existing access ends January 1, 2027.
			</FieldDescription>
		</FieldGroup>
	);
}

function AccountPolicy({
	account,
	index,
	label,
	disabled,
	onSave,
	onReplace,
	onRemove,
}: {
	account: GatewayWebAccount;
	index: number;
	label: string;
	disabled: boolean;
	onSave: (policy: GatewayWebPolicy) => Promise<boolean>;
	onReplace: () => void;
	onRemove: () => Promise<boolean>;
}) {
	const fieldId = useId();
	const incoming = {
		...account.policy,
		name: account.policy.name || `Account ${index + 1}`,
	};
	const [draft, setDraft] = useState(incoming);
	const previous = useRef(incoming);
	useEffect(() => {
		const next = {
			...account.policy,
			name: account.policy.name || `Account ${index + 1}`,
		};
		const old = previous.current;
		setDraft((current) => ({
			name: current.name === old.name ? next.name : current.name,
			enabled: current.enabled === old.enabled ? next.enabled : current.enabled,
			priority:
				current.priority === old.priority ? next.priority : current.priority,
		}));
		previous.current = next;
	}, [account.policy, index]);
	const changed =
		draft.name !== incoming.name ||
		draft.enabled !== incoming.enabled ||
		draft.priority !== incoming.priority;
	const valid =
		draft.name.trim().length > 0 &&
		draft.name.length <= 80 &&
		Number.isInteger(draft.priority) &&
		draft.priority >= 0 &&
		draft.priority <= 65_535;
	return (
		<div className="flex flex-col gap-3 border-border/60 border-t pt-3">
			<FieldGroup className="flex flex-row flex-wrap items-end">
				<Field className="min-w-40 flex-1">
					<FieldLabel htmlFor={`${fieldId}-name`}>Account name</FieldLabel>
					<Input
						aria-label={`${label} ${incoming.name} name`}
						disabled={disabled}
						id={`${fieldId}-name`}
						maxLength={80}
						onChange={(event) =>
							setDraft({ ...draft, name: event.target.value })
						}
						value={draft.name}
					/>
				</Field>
				<Field className="w-24">
					<FieldLabel htmlFor={`${fieldId}-priority`}>Priority</FieldLabel>
					<Input
						aria-label={`${label} ${incoming.name} priority`}
						disabled={disabled}
						id={`${fieldId}-priority`}
						max={65_535}
						min={0}
						onChange={(event) =>
							setDraft({ ...draft, priority: Number(event.target.value) })
						}
						step={1}
						type="number"
						value={draft.priority}
					/>
				</Field>
				<Field className="w-auto" orientation="horizontal">
					<Switch
						aria-label={`Enable ${label} ${incoming.name}`}
						checked={draft.enabled}
						disabled={disabled}
						id={`${fieldId}-enabled`}
						onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
					/>
					<FieldLabel htmlFor={`${fieldId}-enabled`}>
						<span className="sr-only">
							Enable {label} {incoming.name}
						</span>
						<span aria-hidden="true">Enabled</span>
					</FieldLabel>
				</Field>
			</FieldGroup>
			{account.context.kind === "google_pse" ? (
				<p className="text-muted-foreground text-xs">
					Engine: {account.context.engine_id} ·{" "}
					{account.context.existing_customer_acknowledged
						? "Existing customer confirmed"
						: "Existing customer not confirmed"}
				</p>
			) : null}
			{account.context.kind === "search_api" ? (
				<p className="text-muted-foreground text-xs">Engine: Google</p>
			) : null}
			<p className="text-muted-foreground text-xs">
				Key hidden · Lower priority numbers are tried first.
			</p>
			{account.diagnostic ? (
				<p className="text-status-warning text-xs">
					{account.diagnostic === "google_pse_discontinued"
						? "Google Custom Search access has ended. Choose another search provider."
						: "This account is inactive until existing-customer eligibility is confirmed."}
				</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button
					disabled={disabled || !changed || !valid}
					onClick={() => onSave({ ...draft, name: draft.name.trim() })}
					size="sm"
				>
					Save account
				</Button>
				<Button
					aria-label={`Replace ${label} ${incoming.name}`}
					disabled={disabled}
					onClick={onReplace}
					size="sm"
					variant="secondary"
				>
					Replace key or context
				</Button>
				<Button
					aria-label={`Remove ${label} ${incoming.name}`}
					disabled={disabled}
					onClick={onRemove}
					size="sm"
					variant="ghost"
				>
					Remove
				</Button>
			</div>
		</div>
	);
}

function ConnectionEditor({
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
					<Badge variant="secondary">{status}</Badge>
					<Button
						aria-label={`Manage ${label} accounts`}
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

function AccountsTarget({
	target,
	canConfigure,
	managed,
	onRefresh,
}: {
	target: ApiTarget;
	canConfigure: boolean;
	managed: boolean;
	onRefresh?: () => Promise<void>;
}) {
	const [view, setView] = useState<GatewayWebAccountsView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [writing, setWriting] = useState(false);
	const scope = useRef(0);
	const currentTarget = useRef(target);
	const fetchController = useRef<AbortController | null>(null);
	const writeController = useRef<AbortController | null>(null);
	const inFlight = useRef(false);
	const refreshCallback = useRef(onRefresh);
	useEffect(() => {
		refreshCallback.current = onRefresh;
	}, [onRefresh]);
	const load = useCallback(
		async (snapshot: ApiTarget, generation: number, signal?: AbortSignal) => {
			const next = await getGatewayWebAccounts(snapshot, signal);
			if (
				scope.current !== generation ||
				!sameGatewayWebTarget(snapshot, currentTarget.current)
			) {
				return;
			}
			setView(next);
			setLoading(false);
			setError(null);
		},
		[]
	);
	useLayoutEffect(() => {
		scope.current += 1;
		const generation = scope.current;
		const snapshot = {
			url: target.url,
			token: target.token,
			userJwt: target.userJwt,
		};
		currentTarget.current = snapshot;
		fetchController.current?.abort();
		writeController.current?.abort();
		inFlight.current = false;
		const controller = new AbortController();
		fetchController.current = controller;
		setView(null);
		setError(null);
		setLoading(true);
		setWriting(false);
		load(snapshot, generation, controller.signal).catch((cause) => {
			if (controller.signal.aborted || scope.current !== generation) {
				return;
			}
			setError(
				gatewayAccountErrorMessage(cause, "Web accounts could not be loaded.")
			);
			setLoading(false);
		});
		return () => {
			scope.current += 1;
			controller.abort();
			writeController.current?.abort();
		};
	}, [target.url, target.token, target.userJwt, load]);
	const refresh = async () => {
		const generation = scope.current;
		const snapshot = currentTarget.current;
		fetchController.current?.abort();
		const controller = new AbortController();
		fetchController.current = controller;
		setLoading(true);
		try {
			await load(snapshot, generation, controller.signal);
		} catch (cause) {
			if (!controller.signal.aborted && scope.current === generation) {
				setError(
					gatewayAccountErrorMessage(cause, "Refresh web accounts failed.")
				);
				setLoading(false);
			}
		}
	};
	const execute = async <TResult,>(
		operation: (
			snapshot: ApiTarget,
			revision: string,
			signal: AbortSignal
		) => Promise<TResult>,
		requestedRevision: string
	) => {
		if (!canConfigure || managed || inFlight.current || !view) {
			throw new Error("Web account editing is currently unavailable.");
		}
		inFlight.current = true;
		setWriting(true);
		const generation = scope.current;
		const snapshot = currentTarget.current;
		const controller = new AbortController();
		writeController.current = controller;
		try {
			await operation(snapshot, requestedRevision, controller.signal);
			if (
				generation !== scope.current ||
				!sameGatewayWebTarget(snapshot, currentTarget.current)
			) {
				throw new Error(
					"The selected node changed. Refresh its accounts before editing."
				);
			}
			await load(snapshot, generation);
			if (
				generation === scope.current &&
				sameGatewayWebTarget(snapshot, currentTarget.current)
			) {
				await refreshCallback.current?.();
			}
		} catch (cause) {
			if (
				cause instanceof GatewayWebAccountSavedError &&
				generation === scope.current
			) {
				try {
					await load(snapshot, generation);
				} catch {
					/* Keep the saved-only receipt and draft if refresh is unavailable. */
				}
			}
			throw cause;
		} finally {
			if (generation === scope.current) {
				inFlight.current = false;
				setWriting(false);
			}
		}
	};
	const changedTarget = !sameGatewayWebTarget(target, currentTarget.current);
	if (changedTarget || (loading && !view)) {
		return (
			<SettingsCard>
				<div aria-label="Loading web accounts" className="flex flex-col gap-3">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			</SettingsCard>
		);
	}
	if (!view) {
		return (
			<SettingsNotice
				action={
					<Button onClick={refresh} size="sm" variant="ghost">
						Retry
					</Button>
				}
				detail={error ?? undefined}
				role="alert"
			>
				Couldn't load web accounts.
			</SettingsNotice>
		);
	}
	return (
		<div className="flex flex-col gap-4">
			<SettingsNotice
				action={
					<Button
						disabled={loading || writing}
						onClick={refresh}
						size="sm"
						variant="ghost"
					>
						Refresh web accounts
					</Button>
				}
				role="status"
			>
				Saved account settings · Upstream access is not verified by saving a
				key.
			</SettingsNotice>
			{managed || !canConfigure ? (
				<SettingsNotice role="status">
					{managed
						? "Connections supplied by the administrator are read-only."
						: "You can view accounts. Editing requires gateway.configure permission."}
				</SettingsNotice>
			) : null}
			{error ? <SettingsNotice role="alert">{error}</SettingsNotice> : null}
			{[
				{
					title: "Search and page fetch",
					rows: GATEWAY_WEB_PROVIDERS.filter(
						(row) => row.operations.length === 2
					),
				},
				{
					title: "Web search",
					rows: GATEWAY_WEB_PROVIDERS.filter(
						(row) =>
							row.operations.length === 1 && row.operations[0] === "search"
					),
				},
				{
					title: "Page fetch",
					rows: GATEWAY_WEB_PROVIDERS.filter(
						(row) =>
							row.operations.length === 1 && row.operations[0] === "fetch"
					),
				},
			].map((group) => (
				<SettingsSection key={group.title} title={group.title}>
					<SettingsGroup>
						{group.rows.map((definition) => (
							<ConnectionEditor
								applySaved={(saved) =>
									execute(
										(snapshot, revision, signal) =>
											applyGatewayWebAccounts(snapshot, revision, signal),
										saved
									)
								}
								connection={
									view.providers.find(
										(row) => row.provider === definition.id
									) ?? emptyConnection(definition.id)
								}
								definition={definition}
								disabled={managed || !canConfigure}
								key={definition.id}
								mutate={(edit) =>
									execute(
										(snapshot, revision, signal) =>
											editGatewayWebAccount(snapshot, revision, edit, signal),
										view.configRevision
									)
								}
								revision={view.configRevision}
								writing={writing}
							/>
						))}
					</SettingsGroup>
				</SettingsSection>
			))}
		</div>
	);
}

export function GatewayWebAccounts({
	target,
	canView,
	canConfigure,
	webServiceSchema,
	managed = false,
	onRefresh,
}: {
	target: ApiTarget;
	canView: boolean;
	canConfigure: boolean;
	webServiceSchema?: number;
	managed?: boolean;
	onRefresh?: () => Promise<void>;
}) {
	return (
		<SettingsSection
			caption="Provider accounts for direct Gateway search and page extraction. Clients also need the corresponding web operation grants."
			title="Web service connections"
		>
			{canView ? (
				webServiceSchema === 1 ? (
					<AccountsTarget
						canConfigure={canConfigure}
						key={target.url}
						managed={managed}
						onRefresh={onRefresh}
						target={target}
					/>
				) : (
					<SettingsNotice role="status">
						This Gateway does not advertise the current web service account
						schema. Update it before configuring connections.
					</SettingsNotice>
				)
			) : (
				<SettingsNotice role="status">
					Viewing web accounts requires gateway.view permission.
				</SettingsNotice>
			)}
		</SettingsSection>
	);
}

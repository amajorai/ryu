import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	applyGatewayWebAccounts,
	editGatewayWebAccount,
	GATEWAY_WEB_PROVIDERS,
	GatewayWebAccountSavedError,
	type GatewayWebAccountsView,
	getGatewayWebAccounts,
	sameGatewayWebTarget,
} from "@/src/lib/api/web-service-accounts.ts";
import { gatewayAccountErrorMessage } from "./GatewayProviderKeyRow.tsx";
import { ConnectionEditor } from "./GatewayWebAccounts-connection-editor.tsx";
import { emptyConnection } from "./GatewayWebAccounts-context-fields.tsx";
import { SettingsNotice } from "./SettingsNotice.tsx";

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
			caption={
				<CaptionInfo
					detail={"Clients also need the corresponding web operation grants."}
				>
					{"Accounts for Gateway search and page extraction."}
				</CaptionInfo>
			}
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

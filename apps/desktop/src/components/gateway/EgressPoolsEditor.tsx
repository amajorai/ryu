import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useEffect, useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayConfig,
	type GatewayEgressConfig,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { restartGateway } from "@/src/lib/api/system.ts";
import { EgressPoolEndpoints } from "./egress-pools/pool-endpoints.tsx";
import {
	EgressPoolList,
	EgressPoolSettings,
} from "./egress-pools/pool-list.tsx";
import { EgressProviderAssignments } from "./egress-pools/provider-assignments.tsx";
import {
	type DraftPool,
	EMPTY_EGRESS,
	type Endpoint,
	SUPPORTED,
	savedCredentialEnvNames,
	validatePool,
} from "./egress-pools/shared.ts";

export function EgressPoolsEditor({
	target,
	reachable,
	canConfigure,
	providers,
}: {
	target: ApiTarget;
	reachable: boolean;
	canConfigure: boolean;
	providers: string[];
}) {
	const tl = useLiteralMessages();
	const [egress, setEgress] = useState<GatewayEgressConfig | null>(null);
	const [unsupported, setUnsupported] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [pool, setPool] = useState<DraftPool>({
		include_direct: false,
		direct_fallback_only: false,
		endpoints: [],
	});
	const [provider, setProvider] = useState("");
	const [assignment, setAssignment] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		if (!reachable) {
			return;
		}
		let active = true;
		fetchGatewayConfig(target)
			.then((config) => {
				if (active) {
					setUnsupported(config.egress === undefined);
					setEgress(config.egress ?? EMPTY_EGRESS);
				}
			})
			.catch((cause) => {
				if (active) {
					setError(
						cause instanceof Error
							? cause.message
							: "Could not load proxy pools."
					);
				}
			});
		return () => {
			active = false;
		};
	}, [reachable, target]);

	const persist = async (
		change: (current: GatewayEgressConfig) => GatewayEgressConfig
	): Promise<boolean> => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const config = await fetchGatewayConfig(target);
			if (config.egress === undefined) {
				throw new Error("This Gateway does not support proxy pool editing.");
			}
			const next = change(config.egress);
			await updateGatewayConfig(target, { egress: next });
			const restarted = await restartGateway(target).catch(() => false);
			setEgress(next);
			setNotice(
				restarted
					? "Saved and restarted Gateway."
					: "Saved. Restart Gateway to apply the proxy pools."
			);
			return true;
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not save proxy pools."
			);
			return false;
		} finally {
			setBusy(false);
		}
	};

	const begin = (poolName?: string) => {
		setEditing(poolName ?? "");
		setName(poolName ?? "");
		const saved = poolName ? egress?.pools[poolName] : undefined;
		setPool({
			include_direct: saved?.include_direct ?? false,
			direct_fallback_only: saved?.direct_fallback_only ?? false,
			endpoints:
				saved?.endpoints.map((endpoint) => ({
					...endpoint,
					draftId: crypto.randomUUID(),
				})) ?? [],
		});
		setError(null);
		setNotice(null);
	};

	const savePool = async () => {
		const normalized = name.trim();
		const problem = validatePool(
			normalized,
			pool,
			savedCredentialEnvNames(egress)
		);
		if (problem) {
			setError(problem);
			return;
		}
		if (editing === "" && egress?.pools[normalized]) {
			setError("A pool with that name already exists.");
			return;
		}
		const saved = await persist((current) => {
			if (editing === "" && current.pools[normalized]) {
				throw new Error("A pool with that name already exists.");
			}
			const endpoints = pool.endpoints.map(
				({ draftId: _draftId, ...endpoint }) => endpoint
			);
			const pools = { ...current.pools, [normalized]: { ...pool, endpoints } };
			const assignments = { ...current.assignments };
			if (editing && editing !== normalized) {
				delete pools[editing];
				for (const [key, value] of Object.entries(assignments)) {
					if (value === editing) {
						assignments[key] = normalized;
					}
				}
			}
			return { pools, assignments };
		});
		if (saved) {
			setEditing(null);
		}
	};

	const updateEndpoint = (index: number, patch: Partial<Endpoint>) => {
		setPool((current) => ({
			...current,
			endpoints: current.endpoints.map((item, at) =>
				at === index ? { ...item, ...patch } : item
			),
		}));
	};

	const connected = providers.filter((id) => SUPPORTED.has(id));
	const disabled = !(reachable && canConfigure) || busy || unsupported;

	/** One labelled text field of a draft proxy endpoint, as a settings row. */
	const endpointField = ({
		id,
		index,
		label,
		patch,
		placeholder,
		value,
	}: {
		id: string;
		index: number;
		label: string;
		patch: (value: string) => Partial<Endpoint>;
		placeholder?: string;
		value: string;
	}) => (
		<SettingsItem
			actions={
				<div>
					<Input
						className="h-8 w-56"
						disabled={disabled}
						id={id}
						onChange={(event) =>
							updateEndpoint(index, patch(event.target.value))
						}
						placeholder={placeholder}
						value={value}
					/>
				</div>
			}
			key={id}
			title={<label htmlFor={id}>{label}</label>}
		/>
	);

	const selectClass =
		"h-8 rounded-lg border-0 bg-muted/50 px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

	return (
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			<SettingsSection
				caption={
					<CaptionInfo
						detail={
							"Assigned chat sessions stay on one proxy; other calls rotate per request. Failed proxy connections can use another endpoint; uncertain delivery returns an error. Proxy credentials come from Gateway environment variables."
						}
					>
						{"Choose how direct provider requests leave this node."}
					</CaptionInfo>
				}
				headerAction={
					egress && !unsupported ? (
						<Button
							disabled={disabled || Object.keys(egress.pools).length >= 128}
							onClick={() => begin()}
							size="sm"
							variant="ghost"
						>
							Create pool
						</Button>
					) : null
				}
				title="Outbound proxy pools"
			>
				{unsupported ? (
					<SettingsCard>
						<p className="text-muted-foreground text-sm">
							This Gateway version does not expose proxy pools for editing.
						</p>
					</SettingsCard>
				) : null}
				<EgressPoolList
					begin={begin}
					disabled={disabled}
					egress={egress}
					persist={persist}
					unsupported={unsupported}
				/>
			</SettingsSection>

			{egress && !unsupported && editing !== null ? (
				<SettingsSection
					headerAction={
						<div className="flex flex-wrap gap-1">
							<Button
								disabled={
									disabled ||
									pool.endpoints.length + Number(pool.include_direct) >= 32
								}
								onClick={() =>
									setPool((current) => ({
										...current,
										endpoints: [
											...current.endpoints,
											{
												draftId: crypto.randomUUID(),
												id: `proxy-${current.endpoints.length + 1}`,
												url: "",
												enabled: true,
												username_env: null,
												password_env: null,
											},
										],
									}))
								}
								size="sm"
								variant="ghost"
							>
								Add proxy
							</Button>
							<Button
								disabled={busy}
								onClick={() => setEditing(null)}
								size="sm"
								variant="ghost"
							>
								Cancel
							</Button>
							<Button
								disabled={disabled}
								onClick={() => {
									void savePool();
								}}
								size="sm"
								variant="outline"
							>
								Save pool
							</Button>
						</div>
					}
					title={editing ? tl("Edit {editing}", { editing }) : "New pool"}
				>
					<EgressPoolSettings
						disabled={disabled}
						name={name}
						pool={pool}
						setName={setName}
						setPool={setPool}
					/>
					<EgressPoolEndpoints
						disabled={disabled}
						endpointField={endpointField}
						pool={pool}
						setPool={setPool}
						updateEndpoint={updateEndpoint}
					/>
				</SettingsSection>
			) : null}

			<EgressProviderAssignments
				assignment={assignment}
				connected={connected}
				disabled={disabled}
				egress={egress}
				persist={persist}
				provider={provider}
				selectClass={selectClass}
				setAssignment={setAssignment}
				setProvider={setProvider}
				unsupported={unsupported}
			/>

			{error || notice ? (
				<div className="space-y-1 px-3">
					{error ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
					) : null}
					{notice ? (
						<p className="text-sm text-status-success" role="status">
							{notice}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}

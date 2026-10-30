import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	applyGatewayCliSetup,
	type GatewayCliSetupStatus,
	type GatewayCliTool,
	getGatewayCliSetupStatus,
	resetGatewayCliSetup,
} from "@/src/lib/api/cli-setup.ts";
import { CLI_TOOLS } from "./ApiSection-constants.ts";

/** Local CLI setup state for `GatewayClientKeys` ("Connect a local CLI"). */
export function useGatewayCliSetup({
	baseUrl,
	createdKey,
	hasInferenceCredential,
	managed,
	pastedKey,
}: {
	baseUrl: string;
	createdKey: string | null;
	hasInferenceCredential: boolean;
	managed: boolean;
	pastedKey: string;
}) {
	const [cliModel, setCliModel] = useState("");
	const [kiloContext, setKiloContext] = useState("");
	const [kiloOutput, setKiloOutput] = useState("");
	const contextTokens = Number(kiloContext);
	const outputTokens = Number(kiloOutput);
	const kiloLimitsValid =
		Number.isInteger(contextTokens) &&
		Number.isInteger(outputTokens) &&
		contextTokens > 0 &&
		contextTokens <= 16_777_216 &&
		outputTokens > 0 &&
		outputTokens <= 1_048_576 &&
		outputTokens <= contextTokens;
	const [cliBusy, setCliBusy] = useState<GatewayCliTool | null>(null);
	const [cliError, setCliError] = useState<string | null>(null);
	const [cliAvailable, setCliAvailable] = useState(true);
	const [cliStatuses, setCliStatuses] = useState<
		Partial<Record<GatewayCliTool, GatewayCliSetupStatus>>
	>({});

	useEffect(() => {
		if (managed) {
			return;
		}
		let cancelled = false;
		Promise.allSettled(
			CLI_TOOLS.map((tool) => getGatewayCliSetupStatus(tool.id))
		).then((results) => {
			if (cancelled) {
				return;
			}
			const next: Partial<Record<GatewayCliTool, GatewayCliSetupStatus>> = {};
			for (const [index, result] of results.entries()) {
				if (result.status === "fulfilled") {
					next[CLI_TOOLS[index].id] = result.value;
				}
			}
			setCliStatuses(next);
			setCliAvailable(results.some((result) => result.status === "fulfilled"));
		});
		return () => {
			cancelled = true;
		};
	}, [managed]);

	const handleApplyCli = async (tool: GatewayCliTool) => {
		const apiKey = pastedKey.trim() || createdKey;
		if (!(apiKey && cliModel.trim() && hasInferenceCredential)) {
			return;
		}
		if (tool === "kilo" && !kiloLimitsValid) {
			return;
		}
		setCliBusy(tool);
		setCliError(null);
		try {
			const status = await applyGatewayCliSetup({
				tool,
				gatewayUrl: baseUrl,
				apiKey,
				model: cliModel.trim(),
				...(tool === "kilo"
					? { modelLimits: { contextTokens, outputTokens } }
					: undefined),
			});
			setCliStatuses((current) => ({ ...current, [tool]: status }));
		} catch (error) {
			setCliError(
				error instanceof Error ? error.message : "Could not apply CLI setup"
			);
		} finally {
			setCliBusy(null);
		}
	};

	const handleResetCli = async (tool: GatewayCliTool) => {
		setCliBusy(tool);
		setCliError(null);
		try {
			const status = await resetGatewayCliSetup(tool);
			setCliStatuses((current) => ({ ...current, [tool]: status }));
		} catch (error) {
			setCliError(
				error instanceof Error ? error.message : "Could not reset CLI setup"
			);
		} finally {
			setCliBusy(null);
		}
	};

	const cliStatusLabel = (status: GatewayCliSetupStatus | undefined) => {
		if (status?.conflict) {
			return "Changed outside Ryu";
		}
		return status?.applied ? "Applied" : "Not applied";
	};

	return {
		cliAvailable,
		cliBusy,
		cliError,
		cliModel,
		cliStatuses,
		cliStatusLabel,
		handleApplyCli,
		handleResetCli,
		hasInferenceCredential,
		kiloContext,
		kiloLimitsValid,
		kiloOutput,
		setCliModel,
		setKiloContext,
		setKiloOutput,
	};
}

export type GatewayCliSetupState = ReturnType<typeof useGatewayCliSetup>;

/** The "Connect a local CLI" section of `GatewayClientKeys`. */
export function GatewayCliSetupSection({
	cli,
	createdKey,
	gatewayReady,
	pastedKey,
	setPastedKey,
}: {
	cli: GatewayCliSetupState;
	createdKey: string | null;
	gatewayReady: boolean;
	pastedKey: string;
	setPastedKey: Dispatch<SetStateAction<string>>;
}) {
	const tl = useLiteralMessages();
	const {
		cliAvailable,
		cliBusy,
		cliError,
		cliModel,
		cliStatuses,
		cliStatusLabel,
		handleApplyCli,
		handleResetCli,
		hasInferenceCredential,
		kiloContext,
		kiloLimitsValid,
		kiloOutput,
		setCliModel,
		setKiloContext,
		setKiloOutput,
	} = cli;
	return (
		<SettingsSection
			caption={
				<>
					{tl(
						"Apply writes this Gateway URL, a client key, and the selected model into the local CLI configuration. New CLI sessions use Gateway routing with that model. Reset restores the previous files if they have not changed since Apply."
					)}
					{cliAvailable ? null : (
						<span className="mt-1 block">
							CLI setup is available in the desktop app.
						</span>
					)}
					{cliError ? (
						<span className="mt-1 block text-status-destructive">
							{cliError}
						</span>
					) : null}
				</>
			}
			title="Connect a local CLI"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<div>
							<Input
								className="h-8 w-56"
								id="gateway-cli-model"
								onChange={(event) => setCliModel(event.target.value)}
								placeholder="openrouter/auto"
								value={cliModel}
							/>
						</div>
					}
					title={<label htmlFor="gateway-cli-model">Gateway model ID</label>}
				/>
				<SettingsItem
					actions={
						<div>
							<Input
								className="h-8 w-56"
								id="gateway-cli-key"
								onChange={(event) => setPastedKey(event.target.value)}
								placeholder={
									createdKey
										? "New key above will be used"
										: "Paste a key or create one above"
								}
								type="password"
								value={pastedKey}
							/>
						</div>
					}
					title={
						<label htmlFor="gateway-cli-key">
							Existing client key (optional)
						</label>
					}
				/>
			</SettingsGroup>
			<SettingsGroup>
				{CLI_TOOLS.flatMap((tool) => {
					const status = cliStatuses[tool.id];
					const row = (
						<SettingsItem
							actions={
								<div className="flex items-center gap-2">
									<span
										className={
											status?.conflict
												? "text-sm text-status-warning"
												: "text-muted-foreground text-sm"
										}
									>
										{cliStatusLabel(status)}
									</span>
									<Button
										disabled={
											!(
												gatewayReady &&
												cliAvailable &&
												cliModel.trim() &&
												hasInferenceCredential
											) ||
											cliBusy !== null ||
											(tool.id === "kilo" && !kiloLimitsValid)
										}
										onClick={() => void handleApplyCli(tool.id)}
										size="sm"
										variant="outline"
									>
										Apply
									</Button>
									<Button
										disabled={
											!(cliAvailable && status?.applied) || cliBusy !== null
										}
										onClick={() => void handleResetCli(tool.id)}
										size="sm"
										variant="outline"
									>
										Reset
									</Button>
								</div>
							}
							key={tool.id}
							title={tool.label}
						/>
					);
					if (tool.id !== "kilo") {
						return [row];
					}
					// Kilo needs the selected model's real limits, so its two
					// numeric fields sit directly under its row.
					return [
						row,
						<SettingsItem
							actions={
								<div>
									<Input
										className="h-8 w-32"
										id="gateway-kilo-context"
										max={16_777_216}
										min={1}
										onChange={(event) => setKiloContext(event.target.value)}
										step={1}
										type="number"
										value={kiloContext}
									/>
								</div>
							}
							key="kilo-context"
							title={
								<label htmlFor="gateway-kilo-context">
									Kilo model context tokens
								</label>
							}
						/>,
						<SettingsItem
							actions={
								<div>
									<Input
										className="h-8 w-32"
										id="gateway-kilo-output"
										max={1_048_576}
										min={1}
										onChange={(event) => setKiloOutput(event.target.value)}
										step={1}
										type="number"
										value={kiloOutput}
									/>
								</div>
							}
							description="Enter the selected model's actual limits so Kilo can manage context and output size."
							key="kilo-output"
							title={
								<label htmlFor="gateway-kilo-output">
									Kilo model output tokens
								</label>
							}
						/>,
					];
				})}
			</SettingsGroup>
		</SettingsSection>
	);
}

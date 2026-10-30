import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import {
	SettingsGroup,
	SettingsItem,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { DraftPool, Endpoint } from "./shared.ts";

/** The endpoints of the pool being edited, one block each. */
export function EgressPoolEndpoints({
	disabled,
	endpointField,
	pool,
	setPool,
	updateEndpoint,
}: {
	disabled: boolean;
	endpointField: ({
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
	}) => ReactElement;
	pool: DraftPool;
	setPool: Dispatch<SetStateAction<DraftPool>>;
	updateEndpoint: (index: number, patch: Partial<Endpoint>) => void;
}) {
	return pool.endpoints.map((endpoint, index) => (
		<SettingsGroup key={endpoint.draftId}>
			<SettingsItem
				actions={
					<div className="flex items-center gap-2">
						<Switch
							checked={endpoint.enabled}
							disabled={disabled}
							id={`egress-enabled-${index}`}
							onCheckedChange={(checked) =>
								updateEndpoint(index, { enabled: checked })
							}
						/>
						<Button
							disabled={disabled}
							onClick={() =>
								setPool((current) => ({
									...current,
									endpoints: current.endpoints.filter((_, at) => at !== index),
								}))
							}
							size="sm"
							variant="ghost"
						>
							Remove endpoint
						</Button>
					</div>
				}
				title={<label htmlFor={`egress-enabled-${index}`}>Enabled</label>}
			/>
			<SettingsItem
				actions={
					<div>
						<Input
							className="h-8 w-28"
							disabled={disabled}
							id={`egress-priority-${index}`}
							max={65_535}
							min={0}
							onChange={(event) =>
								updateEndpoint(index, {
									priority: Number(event.target.value),
								})
							}
							step={1}
							type="number"
							value={endpoint.priority ?? 0}
						/>
					</div>
				}
				title={
					<label htmlFor={`egress-priority-${index}`}>
						Priority (lower first)
					</label>
				}
			/>
			{endpointField({
				id: `egress-id-${index}`,
				index,
				label: "Endpoint ID",
				patch: (id) => ({ id }),
				value: endpoint.id,
			})}
			{endpointField({
				id: `egress-url-${index}`,
				index,
				label: "Proxy URL",
				patch: (url) => ({ url }),
				placeholder: "http://127.0.0.1:8080",
				value: endpoint.url,
			})}
			{endpointField({
				id: `egress-user-${index}`,
				index,
				label: "Username environment variable",
				patch: (env) => ({ username_env: env || null }),
				placeholder: "RYU_PROXY_USER",
				value: endpoint.username_env ?? "",
			})}
			{endpointField({
				id: `egress-password-${index}`,
				index,
				label: "Password environment variable",
				patch: (env) => ({ password_env: env || null }),
				placeholder: "RYU_PROXY_PASSWORD",
				value: endpoint.password_env ?? "",
			})}
		</SettingsGroup>
	));
}

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { OTPCodeDisplay } from "@ryu/ui/components/motion/otp-input.tsx";
import type { Dispatch, SetStateAction } from "react";
import {
	describePairingConstraints,
	formatPairingTimestamp,
	narrowPairingScopes,
	type PairingConstraints,
} from "./NodeAccessSettings.model.ts";
import { ScopeList } from "./NodeAccessSettings-scope-list.tsx";

export interface PairingRequest {
	client_name: string;
	created_at: number;
	requested_constraints?: PairingConstraints;
	requested_expires_at?: number | null;
	requested_scopes?: string[];
	user_code: string;
}

export function PendingRequestItem({
	busy,
	decide,
	req,
	selectedScopes,
	setSelectedScopes,
}: {
	busy: boolean;
	decide: (userCode: string, approve: boolean) => Promise<void>;
	req: PairingRequest;
	selectedScopes: Record<string, string[]>;
	setSelectedScopes: Dispatch<SetStateAction<Record<string, string[]>>>;
}) {
	const tl = useLiteralMessages();
	return (
		<li
			className="flex items-start justify-between gap-3 py-3"
			key={req.user_code}
		>
			<div className="min-w-0">
				<p className="truncate text-sm" title={req.client_name}>
					{req.client_name}
				</p>
				<div className="mt-1">
					<OTPCodeDisplay
						aria-label={tl("{client_name} pairing code", {
							client_name: req.client_name,
						})}
						code={req.user_code}
						size="compact"
					/>
				</div>
				{req.requested_scopes && req.requested_scopes.length > 0 ? (
					<fieldset className="mt-2">
						<legend className="text-muted-foreground text-xs">
							Grant access
						</legend>
						<p className="text-muted-foreground text-xs">
							Clear anything this device should not use.
						</p>
						<div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
							{req.requested_scopes.map((scope, scopeIndex) => {
								const checkboxId = `pair-${req.user_code}-scope-${scopeIndex}`;
								const selected =
									selectedScopes[req.user_code] ?? req.requested_scopes ?? [];
								return (
									<label
										className="flex cursor-pointer items-center gap-1.5 font-mono text-xs"
										htmlFor={checkboxId}
										key={scope}
									>
										<Checkbox
											checked={selected.includes(scope)}
											disabled={busy}
											id={checkboxId}
											onCheckedChange={(checked) =>
												setSelectedScopes((current) => {
													const currentSelection =
														current[req.user_code] ??
														req.requested_scopes ??
														[];
													return {
														...current,
														[req.user_code]: narrowPairingScopes({
															checked: checked === true,
															requested: req.requested_scopes ?? [],
															scope,
															selected: currentSelection,
														}),
													};
												})
											}
										/>
										{scope}
									</label>
								);
							})}
						</div>
					</fieldset>
				) : (
					<ScopeList
						emptyLabel={
							req.requested_scopes
								? "No capabilities requested"
								: "Default read-only access"
						}
						label="Requested access"
						scopes={req.requested_scopes}
					/>
				)}
				<p className="mt-2 text-muted-foreground text-xs">
					{tl("Binding: {constraints}", {
						constraints: describePairingConstraints(
							req.requested_constraints
						).join(", "),
					})}
				</p>
				{req.requested_expires_at == null ? null : (
					<p className="text-muted-foreground text-xs">
						{tl("Expires {time}", {
							time:
								formatPairingTimestamp(req.requested_expires_at) ??
								tl("at an invalid time"),
						})}
					</p>
				)}
			</div>
			<div className="flex shrink-0 gap-2">
				<Button
					aria-label={tl("Deny {client_name}", {
						client_name: req.client_name,
					})}
					disabled={busy}
					onClick={() => void decide(req.user_code, false)}
					size="sm"
					variant="ghost"
				>
					Deny
				</Button>
				<Button
					aria-label={tl("Approve {client_name} with requested access", {
						client_name: req.client_name,
					})}
					disabled={busy}
					onClick={() => void decide(req.user_code, true)}
					size="sm"
				>
					Approve
				</Button>
			</div>
		</li>
	);
}

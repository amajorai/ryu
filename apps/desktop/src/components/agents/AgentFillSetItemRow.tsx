import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import type {
	BoxFillChoice,
	FillSetItemInput,
} from "@/src/lib/api/agent-fill-sets.ts";

function itemReference(item: FillSetItemInput): string {
	const folder = item.path?.replace(/^\/+/, "") ?? "";
	return folder ? `${folder}/${item.key}` : item.key;
}

/**
 * One item to attach: where a session Box fill may submit its password (the
 * login URL), and the opt-in for a Box fill without one. Fills outside a Box
 * ignore both.
 */
export function AgentFillSetItemRow({
	choice,
	disabled,
	index,
	item,
	onChange,
}: {
	choice: BoxFillChoice;
	disabled: boolean;
	index: number;
	item: FillSetItemInput;
	onChange: (next: BoxFillChoice) => void;
}) {
	const urlId = `agent-fill-set-login-url-${index}`;
	const unboundId = `agent-fill-set-box-unbound-${index}`;
	const warningId = `${unboundId}-warning`;
	return (
		<li className="flex flex-col gap-3 rounded-lg border p-3">
			<span className="truncate font-mono text-xs">{itemReference(item)}</span>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={urlId}>Login URL</Label>
				<Input
					disabled={disabled}
					id={urlId}
					inputMode="url"
					onChange={(event) =>
						onChange({ ...choice, loginUrl: event.target.value })
					}
					placeholder="https://example.com/login"
					spellCheck={false}
					value={choice.loginUrl}
				/>
				<p className="text-muted-foreground text-xs">
					In a session Box, the password is sent only to this address.
				</p>
			</div>
			<div className="flex items-start gap-2">
				<Checkbox
					aria-describedby={warningId}
					checked={choice.unbound}
					disabled={disabled}
					id={unboundId}
					onCheckedChange={(checked) =>
						onChange({ ...choice, unbound: checked === true })
					}
				/>
				<div className="flex flex-col gap-1">
					<Label htmlFor={unboundId}>Allow Box fill without a login URL</Label>
					<p className="text-status-warning text-xs" id={warningId}>
						With this option the agent can capture this password by sending it
						to another page on the site, and the site stays intercepted for the
						rest of the Box (no WebSockets).
					</p>
				</div>
			</div>
		</li>
	);
}

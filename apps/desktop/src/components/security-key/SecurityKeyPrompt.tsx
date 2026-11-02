import { Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import type { PendingSecurityKeyRequest } from "@/src/lib/api/security-key.ts";

/** Shortest PIN a FIDO2 key accepts. */
export const SECURITY_KEY_PIN_MIN_CHARS = 4;

/**
 * Where the flow is:
 * - `confirm`: the request is shown; nothing has touched the key yet.
 * - `touch`: the ceremony is running and the key is waiting for a touch.
 * - `pin`: the key asked for its PIN.
 * - `sending`: the key answered and the answer is on its way to the page.
 * - `retry`: something the user can fix went wrong (no key, too slow).
 * - `failed`: the key cannot answer this request; closing tells the page no.
 */
export type SecurityKeyPhase =
	| "confirm"
	| "touch"
	| "pin"
	| "sending"
	| "retry"
	| "failed";

export interface SecurityKeyPromptProps {
	/** Shown when the desktop cannot reach a security key at all. */
	availabilityProblem?: string | null;
	/** Failure text for `retry` / `failed`, or the wrong-PIN line for `pin`. */
	message?: string | null;
	/** Name of the node whose browser is asking. */
	nodeName: string;
	onApprove: () => void;
	onDeny: () => void;
	onSubmitPin: (pin: string) => void;
	phase: SecurityKeyPhase;
	request: PendingSecurityKeyRequest;
}

function DetailRow({ label, value }: { label: ReactNode; value: ReactNode }) {
	return (
		<div className="flex items-start justify-between gap-4 py-1.5">
			<dt className="shrink-0 text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-all text-end font-medium">{value}</dd>
		</div>
	);
}

function PinForm({
	message,
	onCancel,
	onSubmit,
}: {
	message: string | null;
	onCancel: () => void;
	onSubmit: (pin: string) => void;
}) {
	const tl = useLiteralMessages();
	const inputId = useId();
	const [pin, setPin] = useState("");
	const ready = [...pin].length >= SECURITY_KEY_PIN_MIN_CHARS;
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (ready) {
			onSubmit(pin);
		}
	};
	return (
		<form className="space-y-3" onSubmit={submit}>
			<div className="space-y-1.5">
				<Label htmlFor={inputId}>Security key PIN</Label>
				<Input
					aria-describedby={message ? `${inputId}-message` : undefined}
					autoComplete="off"
					// biome-ignore lint/a11y/noAutofocus: the dialog opened to ask for this PIN.
					autoFocus
					id={inputId}
					onChange={(event) => setPin(event.target.value)}
					placeholder={tl("Enter the key's PIN")}
					type="password"
					value={pin}
				/>
				{message ? (
					<p
						className="text-sm text-status-destructive"
						id={`${inputId}-message`}
						role="alert"
					>
						{message}
					</p>
				) : (
					<p className="text-muted-foreground text-xs">
						The PIN goes only to the key plugged into this device.
					</p>
				)}
			</div>
			<DialogFooter className="sm:flex-row sm:justify-between">
				<Button onClick={onCancel} type="button" variant="ghost">
					Deny
				</Button>
				<Button disabled={!ready} type="submit">
					Continue
				</Button>
			</DialogFooter>
		</form>
	);
}

function PhaseStatus({
	message,
	phase,
}: {
	message: string | null;
	phase: SecurityKeyPhase;
}) {
	if (phase === "touch" || phase === "sending") {
		return (
			<div
				className="flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-3 text-sm"
				role="status"
			>
				<Spinner className="text-primary" />
				<span>
					{phase === "touch"
						? "Touch your security key."
						: "Sending the key's answer to the site…"}
				</span>
			</div>
		);
	}
	if ((phase === "retry" || phase === "failed") && message) {
		return (
			<p className="text-sm text-status-destructive" role="alert">
				{message}
			</p>
		);
	}
	return null;
}

function PromptActions({
	availabilityProblem,
	onApprove,
	onDeny,
	phase,
}: {
	availabilityProblem: string | null;
	onApprove: () => void;
	onDeny: () => void;
	phase: SecurityKeyPhase;
}) {
	if (phase === "failed") {
		return (
			<DialogFooter>
				<Button onClick={onDeny} type="button">
					Close
				</Button>
			</DialogFooter>
		);
	}
	const busy = phase === "touch" || phase === "sending";
	return (
		<DialogFooter className="sm:flex-row sm:justify-between">
			<Button
				disabled={phase === "sending"}
				onClick={onDeny}
				type="button"
				variant="ghost"
			>
				Deny
			</Button>
			<Button
				disabled={busy || Boolean(availabilityProblem)}
				onClick={onApprove}
				type="button"
			>
				{busy ? <Spinner /> : null}
				{phase === "retry" ? "Try again" : "Use security key"}
			</Button>
		</DialogFooter>
	);
}

/**
 * Asks the user whether a browser on another node may use the hardware
 * security key plugged into this device. Everything shown comes from the
 * request Core holds for the page (its origin and relying party), never from
 * a model, and nothing reaches the key until the user picks "Use security
 * key" and touches it.
 */
export function SecurityKeyPrompt({
	availabilityProblem = null,
	message = null,
	nodeName,
	onApprove,
	onDeny,
	onSubmitPin,
	phase,
	request,
}: SecurityKeyPromptProps) {
	const tl = useLiteralMessages();
	const signIn = request.kind === "get";
	const agentId = request.agent_id?.trim();
	const lane = agentId ? tl("Bot {agentId}", { agentId }) : tl("Your browser");
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!open && phase !== "sending") {
					onDeny();
				}
			}}
			open
		>
			<DialogContent
				className="sm:max-w-md"
				data-testid="security-key-prompt"
				showCloseButton={false}
			>
				<DialogHeader>
					<div className="mb-1 flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
						<HugeiconsIcon icon={Key01Icon} size={24} />
					</div>
					<DialogTitle>
						{signIn
							? "Sign in with your security key?"
							: "Register your security key?"}
					</DialogTitle>
					<DialogDescription>
						{signIn
							? tl(
									"A browser on {nodeName} wants to sign in to {origin} with the security key connected to this device. Continue only if you started this.",
									{ nodeName, origin: request.origin }
								)
							: tl(
									"A browser on {nodeName} wants to register the security key connected to this device with {origin}. Continue only if you started this.",
									{ nodeName, origin: request.origin }
								)}
					</DialogDescription>
				</DialogHeader>

				<dl className="divide-y divide-border/60 rounded-2xl border border-border/60 bg-muted/25 px-4 py-1.5 text-sm">
					<DetailRow label="Site" value={request.origin} />
					<DetailRow label="Site ID" value={request.rp_id} />
					<DetailRow
						label="Request"
						value={signIn ? tl("Sign in") : tl("Register a key")}
					/>
					<DetailRow label="Browser" value={lane} />
					<DetailRow label="Device" value={nodeName} />
				</dl>

				{availabilityProblem && phase !== "failed" ? (
					<p className="text-sm text-status-destructive" role="alert">
						{availabilityProblem}
					</p>
				) : null}

				<PhaseStatus message={message} phase={phase} />

				{phase === "pin" ? (
					<PinForm message={message} onCancel={onDeny} onSubmit={onSubmitPin} />
				) : (
					<PromptActions
						availabilityProblem={availabilityProblem}
						onApprove={onApprove}
						onDeny={onDeny}
						phase={phase}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

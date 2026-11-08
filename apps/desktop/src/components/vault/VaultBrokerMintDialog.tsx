// Mint a broker session for chosen services, then show its token and the
// proxy environment for a child process once. The reply lives only in this
// dialog's state and is dropped when the dialog closes (the body unmounts);
// it never goes through React Query, whose cache would outlive the dialog.

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
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
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { listVaultBrokerServices } from "@/src/lib/api/vault-broker.ts";
import {
	mintVaultBrokerSession,
	type VaultBrokerMintedSession,
} from "@/src/lib/api/vault-broker-console.ts";
import { vaultErrorMessage } from "./vault-errors.ts";

export const SESSION_LIFETIMES = [
	{ label: "15 minutes", value: 900 },
	{ label: "1 hour", value: 3600 },
	{ label: "8 hours", value: 28_800 },
	{ label: "24 hours", value: 86_400 },
] as const;

/** `export NAME='value'` lines for a POSIX shell, values single-quoted. */
export function shellExports(env: Record<string, string>): string {
	return Object.entries(env)
		.map(
			([name, value]) => `export ${name}='${value.replaceAll("'", `'\\''`)}'`
		)
		.join("\n");
}

async function copy(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		sileo.success({ title: "Copied" });
	} catch {
		sileo.error({ title: "Could not copy" });
	}
}

function Minted({ minted }: { minted: VaultBrokerMintedSession }) {
	const exports = minted.proxy ? shellExports(minted.proxy.env) : "";
	return (
		<>
			<DialogHeader>
				<DialogTitle>Session ready</DialogTitle>
				<DialogDescription>
					Copy the token or the environment now. It is not shown again.
				</DialogDescription>
			</DialogHeader>
			<div className="space-y-1.5">
				<Label htmlFor="broker-minted-token">Token</Label>
				<div className="flex gap-2">
					<Input
						className="font-mono"
						id="broker-minted-token"
						readOnly
						value={minted.token}
					/>
					<Button
						aria-label="Copy token"
						onClick={() => copy(minted.token)}
						size="icon"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Copy01Icon} />
					</Button>
				</div>
			</div>
			{minted.proxy ? (
				<div className="space-y-1.5">
					<Label htmlFor="broker-minted-env">Proxy environment</Label>
					<Textarea
						className="min-h-40"
						id="broker-minted-env"
						readOnly
						spellCheck={false}
						value={exports}
						variant="code-caption"
					/>
					<Button onClick={() => copy(exports)} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Copy01Icon} />
						Copy environment
					</Button>
				</div>
			) : (
				<p className="text-muted-foreground text-sm">
					The broker proxy is not listening on this node, so the session cannot
					carry traffic until it starts.
				</p>
			)}
		</>
	);
}

function MintForm({
	environment,
	onMinted,
	target,
}: {
	environment: string;
	onMinted: (minted: VaultBrokerMintedSession) => void;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [chosen, setChosen] = useState<string[]>([]);
	const [label, setLabel] = useState("");
	const [ttlSecs, setTtlSecs] = useState<number>(3600);
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const servicesQuery = useQuery({
		queryKey: ["vault", "broker", "services", target.url, environment],
		queryFn: () => listVaultBrokerServices(target, environment),
	});
	const services = (servicesQuery.data ?? []).filter((item) => item.enabled);

	const toggle = (name: string, on: boolean) =>
		setChosen((current) =>
			on ? [...current, name] : current.filter((item) => item !== name)
		);

	// Not a React Query mutation: its cache would keep the token.
	const submit = async () => {
		setProblem(null);
		setPending(true);
		try {
			const minted = await mintVaultBrokerSession(target, {
				environment,
				label,
				services: chosen,
				ttlSecs,
			});
			await queryClient.invalidateQueries({
				queryKey: ["vault", "broker", "sessions"],
			});
			onMinted(minted);
		} catch (caught) {
			setProblem(vaultErrorMessage(caught, "Could not start a session.", tl));
		} finally {
			setPending(false);
		}
	};

	return (
		<form
			className="space-y-3"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<DialogHeader>
				<DialogTitle>New broker session</DialogTitle>
				<DialogDescription>
					{tl(
						"A proxy credential for services in {environment}. The process using it never sees their credentials.",
						{ environment }
					)}
				</DialogDescription>
			</DialogHeader>
			<fieldset className="space-y-2">
				<legend className="mb-1.5 font-medium text-sm">Services</legend>
				{servicesQuery.isLoading ? null : services.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No enabled services in this environment.
					</p>
				) : (
					services.map((service) => (
						<div className="flex items-center gap-2" key={service.name}>
							<Checkbox
								checked={chosen.includes(service.name)}
								id={`broker-session-service-${service.name}`}
								onCheckedChange={(on: boolean) => toggle(service.name, on)}
							/>
							<Label
								className="flex min-w-0 items-center gap-2 font-normal"
								htmlFor={`broker-session-service-${service.name}`}
							>
								<code className="font-mono text-sm">{service.name}</code>
								<span className="truncate text-muted-foreground text-xs">
									{service.host}
								</span>
							</Label>
						</div>
					))
				)}
			</fieldset>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="broker-session-label">Label</Label>
					<Input
						autoComplete="off"
						id="broker-session-label"
						maxLength={128}
						onChange={(event) => setLabel(event.target.value)}
						placeholder="deploy script"
						value={label}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="broker-session-ttl">Lasts</Label>
					<NativeSelect
						className="w-full"
						id="broker-session-ttl"
						onChange={(event) => setTtlSecs(Number(event.target.value))}
						value={String(ttlSecs)}
					>
						{SESSION_LIFETIMES.map((item) => (
							<NativeSelectOption key={item.value} value={String(item.value)}>
								{item.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
			</div>
			{problem ? (
				<p className="text-sm text-status-destructive" role="alert">
					{problem}
				</p>
			) : null}
			<DialogFooter>
				<Button disabled={pending || chosen.length === 0} type="submit">
					Start session
				</Button>
			</DialogFooter>
		</form>
	);
}

function MintBody({
	environment,
	target,
}: {
	environment: string;
	target: ApiTarget;
}) {
	const [minted, setMinted] = useState<VaultBrokerMintedSession | null>(null);
	return minted ? (
		<Minted minted={minted} />
	) : (
		<MintForm environment={environment} onMinted={setMinted} target={target} />
	);
}

export function VaultBrokerMintDialog({
	environment,
	onOpenChange,
	open,
	target,
}: {
	environment: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	target: ApiTarget;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg">
				{open ? <MintBody environment={environment} target={target} /> : null}
			</DialogContent>
		</Dialog>
	);
}

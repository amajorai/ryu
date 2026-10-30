import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SensitiveValue } from "@ryu/ui/components/sensitive-value.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
	type A2aPrincipal,
	type A2aScope,
	issueA2aPrincipal,
	revokeA2aPrincipal,
} from "@/src/lib/api/a2a.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	ALL_SCOPES,
	errorMessage,
	SectionCard,
} from "./A2aSettings-shared.tsx";

export function AccessPanel({
	onChanged,
	principals,
	target,
}: {
	onChanged: () => Promise<void>;
	principals: A2aPrincipal[];
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [name, setName] = useState("");
	const [scopes, setScopes] = useState<A2aScope[]>(ALL_SCOPES);
	const [issuedToken, setIssuedToken] = useState<string | null>(null);
	const issue = useMutation({
		mutationFn: () => issueA2aPrincipal(target, name, scopes),
		onSuccess: async (issued) => {
			setIssuedToken(issued.token);
			setName("");
			await onChanged();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const revoke = useMutation({
		mutationFn: (id: string) => revokeA2aPrincipal(target, id),
		onSuccess: onChanged,
		onError: (error) => toast.error(errorMessage(error)),
	});
	const toggleScope = (scope: A2aScope) => {
		setScopes((current) =>
			current.includes(scope)
				? current.filter((value) => value !== scope)
				: [...current, scope]
		);
	};

	return (
		<SectionCard
			description="Issue a separate scoped token for each inbound peer. Ryu stores only its hash and shows the token once."
			title="Inbound peer access"
		>
			<div className="flex gap-2">
				<div className="min-w-0 flex-1 space-y-1.5">
					<Label htmlFor="a2a-principal-name">Peer name</Label>
					<Input
						id="a2a-principal-name"
						onChange={(event) => setName(event.target.value)}
						placeholder="Hermes production"
						value={name}
					/>
				</div>
				<Button
					className="self-end"
					disabled={!name.trim() || scopes.length === 0}
					loading={issue.isPending}
					onClick={() => issue.mutate()}
					size="sm"
				>
					Issue token
				</Button>
			</div>
			<fieldset>
				<legend className="mb-2 text-muted-foreground text-xs">
					Allowed operations
				</legend>
				<div className="flex flex-wrap gap-x-4 gap-y-2">
					{ALL_SCOPES.map((scope) => (
						<label className="flex items-center gap-1.5 text-xs" key={scope}>
							<input
								checked={scopes.includes(scope)}
								onChange={() => toggleScope(scope)}
								type="checkbox"
							/>
							{scope.replace("_", " ")}
						</label>
					))}
				</div>
			</fieldset>
			{issuedToken ? (
				<div className="rounded-md border border-warning/30 bg-warning/5 p-3">
					<p className="font-medium text-sm">Copy this token now</p>
					<p className="mb-2 text-muted-foreground text-xs">
						It cannot be retrieved after this panel is dismissed or another
						token is issued.
					</p>
					<code className="block select-all break-all rounded bg-background p-2 text-xs">
						<SensitiveValue label="A2A token" value={issuedToken} />
					</code>
					<Button
						aria-label="Copy A2A token"
						className="mt-2"
						onClick={async () => {
							try {
								await navigator.clipboard.writeText(issuedToken);
								toast.success("A2A token copied");
							} catch {
								toast.error(
									"Couldn't copy the A2A token. Reveal and copy it while this panel is open."
								);
							}
						}}
						size="sm"
						variant="ghost"
					>
						Copy token
					</Button>
				</div>
			) : null}
			<div className="divide-y rounded-md border">
				{principals.length === 0 ? (
					<p className="px-3 py-4 text-muted-foreground text-xs">
						No inbound peer tokens issued.
					</p>
				) : null}
				{principals.map((principal) => (
					<div
						className="flex items-center gap-3 px-3 py-2.5"
						key={principal.id}
					>
						<div className="min-w-0 flex-1">
							<p
								className="truncate font-medium text-sm"
								title={principal.name}
							>
								{principal.name}
							</p>
							<p
								className="truncate text-muted-foreground text-xs"
								title={principal.scopes.join(", ")}
							>
								{principal.scopes.join(", ")}
							</p>
						</div>
						{principal.revokedAt ? (
							<Badge variant="outline">revoked</Badge>
						) : null}
						<Button
							aria-label={tl("Revoke token for {name}", {
								name: principal.name,
							})}
							disabled={Boolean(principal.revokedAt) || revoke.isPending}
							onClick={() => revoke.mutate(principal.id)}
							size="sm"
							variant="ghost"
						>
							Revoke
						</Button>
					</div>
				))}
			</div>
		</SectionCard>
	);
}

import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import type {
	NativeAccount,
	NativeLoginOperation,
} from "@ryuhq/core-client/native-accounts.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	removeAgentAccount,
	switchAgentAccount,
} from "@/src/lib/api/agents.ts";
import { ApiError, type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	cancelNativeAccountLogin,
	createNativeAccount,
	disconnectNativeAccount,
	listNativeAccounts,
	logoutNativeAccount,
	nativeAccountLoginProgress,
	startNativeAccountLogin,
} from "@/src/lib/api/native-accounts.ts";

function message<TError>(error: TError) {
	return error instanceof ApiError
		? (error.serverMessage ?? error.message)
		: error instanceof Error
			? error.message
			: "Could not update the account.";
}

export function NativeProviderAccounts({ agentId }: { agentId: string }) {
	const node = useActiveNode();
	const { url, token, userJwt } = node;
	const target = useMemo(
		() => toTarget({ url, token, userJwt }),
		[url, token, userJwt]
	);
	return <NativeProviderAccountsPanel agentId={agentId} target={target} />;
}

export function NativeProviderAccountsPanel({
	agentId,
	target,
}: {
	agentId: string;
	target: ApiTarget;
}) {
	const [accounts, setAccounts] = useState<NativeAccount[] | null>(null);
	const [unsupported, setUnsupported] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [operation, setOperation] = useState<NativeLoginOperation | null>(null);
	const scope = useRef(0);
	const operationScope = useRef(0);
	const [retry, setRetry] = useState(0);
	const { url, token, userJwt } = target;

	useEffect(() => {
		const generation = ++scope.current;
		setAccounts(null);
		setUnsupported(false);
		setError(null);
		setOperation(null);
		setLabel("");
		setBusy(false);
		listNativeAccounts({ url, token, userJwt }, agentId)
			.then((result) => {
				if (scope.current === generation) {
					if (result.nativeAccounts === true) {
						setAccounts(result.accounts);
					} else {
						setUnsupported(true);
					}
				}
			})
			.catch((cause) => {
				if (scope.current !== generation) {
					return;
				}
				if (
					cause instanceof ApiError &&
					([404, 405].includes(cause.status) ||
						(cause.status === 400 &&
							(cause.serverMessage === "Not a native ACP agent" ||
								cause.serverMessage ===
									"This agent does not support native account custody")))
				) {
					setUnsupported(true);
				} else {
					setError(message(cause));
				}
			});
		return () => {
			scope.current++;
		};
	}, [agentId, url, token, userJwt, retry]);

	const operationId =
		operation?.state === "running" ? operation.operationId : null;
	useEffect(() => {
		if (!operationId || operationScope.current !== scope.current) {
			return;
		}
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				const result = await nativeAccountLoginProgress(
					{ url, token, userJwt },
					agentId,
					operationId
				);
				if (stopped) {
					return;
				}
				if (result.operation.state === "running") {
					// A good response clears a transient poll failure shown earlier.
					setError(null);
					setOperation(result.operation);
					timer = setTimeout(poll, 1000);
				} else {
					const refreshed = await listNativeAccounts(
						{ url, token, userJwt },
						agentId
					);
					if (!stopped) {
						setError(null);
						setAccounts(refreshed.accounts);
						setOperation(result.operation);
					}
				}
			} catch (cause) {
				if (!stopped) {
					setError(message(cause));
					timer = setTimeout(poll, 3000);
				}
			}
		};
		void poll();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [operationId, agentId, url, token, userJwt]);

	async function run(action: () => Promise<void>) {
		const generation = scope.current;
		setBusy(true);
		setError(null);
		try {
			await action();
			const refreshed = await listNativeAccounts(target, agentId);
			if (scope.current === generation) {
				setAccounts(refreshed.accounts);
			}
		} catch (cause) {
			if (scope.current === generation) {
				setError(message(cause));
			}
		} finally {
			if (scope.current === generation) {
				setBusy(false);
			}
		}
	}

	async function signIn(accountId: string) {
		const generation = scope.current;
		const started = await startNativeAccountLogin(target, agentId, accountId);
		if (scope.current === generation) {
			operationScope.current = generation;
			setOperation({ ...started, instructions: "", error: null });
		}
	}

	if (unsupported) {
		return null;
	}
	return (
		<section aria-label="Native provider accounts" className="space-y-4">
			<div className="space-y-1">
				<h3 className="font-medium text-sm">Native provider accounts</h3>
				<p className="text-muted-foreground text-sm">
					Sign in with this agent’s own provider. New accounts become available
					after the provider verifies your sign-in.
				</p>
			</div>
			{error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			{accounts === null ? (
				error ? (
					<Button
						onClick={() => setRetry((value) => value + 1)}
						size="sm"
						variant="outline"
					>
						Try again
					</Button>
				) : (
					<p className="text-muted-foreground text-sm" role="status">
						Checking account support…
					</p>
				)
			) : (
				<>
					{accounts.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No native accounts yet.
						</p>
					) : null}
					<ul className="divide-y rounded-lg border">
						{accounts.map((account) => (
							<li
								className="flex flex-wrap items-center justify-between gap-3 p-3"
								key={account.accountId}
							>
								<div className="min-w-0 space-y-1">
									<p className="break-words font-medium text-sm">
										{account.label}
									</p>
									<p className="text-muted-foreground text-xs">
										{account.state === "connected" && account.verified
											? account.active
												? "Connected · Active"
												: "Connected"
											: account.state === "pending"
												? "Pending sign-in"
												: "Disconnected"}
									</p>
								</div>
								<div className="flex flex-wrap gap-1">
									{account.verified && account.state === "connected" ? (
										<>
											<Button
												disabled={
													busy || Boolean(operationId) || account.active
												}
												onClick={() =>
													void run(async () => {
														await switchAgentAccount(target, agentId, {
															accountId: account.accountId,
														});
													})
												}
												size="sm"
												variant="ghost"
											>
												{account.active ? "Active" : "Use account"}
											</Button>
											<Button
												disabled={busy || Boolean(operationId)}
												onClick={() =>
													void run(async () => {
														await disconnectNativeAccount(
															target,
															agentId,
															account.accountId
														);
													})
												}
												size="sm"
												variant="ghost"
											>
												Disconnect
											</Button>
										</>
									) : (
										<Button
											disabled={busy || Boolean(operationId)}
											onClick={() => void run(() => signIn(account.accountId))}
											size="sm"
											variant="outline"
										>
											Sign in
										</Button>
									)}
									<Button
										disabled={busy || Boolean(operationId)}
										onClick={() =>
											void run(async () => {
												await logoutNativeAccount(
													target,
													agentId,
													account.accountId
												);
											})
										}
										size="sm"
										variant="ghost"
									>
										Log out
									</Button>
									<Button
										disabled={busy || Boolean(operationId)}
										onClick={() =>
											void run(() =>
												removeAgentAccount(target, agentId, account.accountId)
											)
										}
										size="sm"
										variant="ghost"
									>
										Remove
									</Button>
								</div>
							</li>
						))}
					</ul>
					<form
						className="flex flex-wrap gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							const name = label.trim();
							if (!name || busy || operationId) {
								return;
							}
							const generation = scope.current;
							void run(async () => {
								await createNativeAccount(target, agentId, name);
								if (scope.current === generation) {
									setLabel("");
								}
							});
						}}
					>
						<Input
							aria-label="Native account name"
							className="min-w-40 flex-1"
							disabled={busy || Boolean(operationId)}
							maxLength={120}
							onChange={(event) => setLabel(event.target.value)}
							placeholder="Account name, e.g. Work"
							value={label}
						/>
						<Button
							disabled={!label.trim() || busy || Boolean(operationId)}
							size="sm"
							type="submit"
							variant="outline"
						>
							Add account
						</Button>
					</form>
				</>
			)}
			{operation ? (
				<div
					aria-live="polite"
					className="space-y-3 rounded-lg border bg-muted/30 p-3"
				>
					<p className="font-medium text-sm">
						{operation.state === "running"
							? "Waiting for provider sign-in"
							: operation.state === "completed"
								? "Sign-in verified"
								: "Sign-in did not complete"}
					</p>
					{operation.state === "running" ? (
						<>
							<p className="text-muted-foreground text-sm">
								Follow the provider’s instructions below. Keep this panel open
								until verification finishes.
							</p>
							<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
								{operation.instructions || "Starting provider sign-in…"}
							</pre>
							<Button
								disabled={busy}
								onClick={() =>
									void run(async () => {
										await cancelNativeAccountLogin(
											target,
											agentId,
											operation.operationId
										);
									})
								}
								size="sm"
								variant="outline"
							>
								Cancel sign-in
							</Button>
						</>
					) : null}
					{operation.error ? (
						<p className="text-sm text-status-destructive" role="alert">
							{operation.error}
						</p>
					) : null}
				</div>
			) : null}
		</section>
	);
}

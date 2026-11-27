// Which account pools hold each account of one provider, shown inside that
// provider's Accounts section, with one menu per account to put it into a pool
// or take it out. The pools themselves (names, deletion, which agents use
// them) are managed on the Account pools page; this block answers "where does
// this account rotate" without leaving the provider.

import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { sileo } from "sileo";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type AccountPool,
	type AccountPoolMember,
	accountPoolsQueryKey,
	accountPoolsUnsupported,
	fetchAccountPools,
	updateAccountPool,
} from "@/src/lib/api/account-pools.ts";
import { ApiError, toTarget } from "@/src/lib/api/client.ts";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import { poolAccountGroups } from "../AccountPoolsSettings.tsx";
import {
	poolAccountsAfterToggle,
	poolIsFullFor,
	poolsOfAccount,
} from "./provider-pages-model.ts";

/**
 * The node's pool catalog, from the one cache entry the pools page and every
 * agent panel share. `supported` is false on a Core without pool routes.
 */
export function useAccountPoolCatalog() {
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const queryKey = accountPoolsQueryKey(target);
	const query = useQuery({
		queryKey,
		queryFn: () => fetchAccountPools(target),
		// An older Core answers 404 for good; asking again changes nothing.
		retry: false,
	});
	return {
		catalog: query.data ?? null,
		query,
		queryKey,
		supported: !accountPoolsUnsupported(query.error),
		target,
	};
}

interface ProviderAccountPoolsProps {
	/** Open the page that manages the pools themselves. */
	onManage: () => void;
	provider: PiProvider;
}

export function ProviderAccountPools({
	onManage,
	provider,
}: ProviderAccountPoolsProps) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const { catalog, queryKey, supported, target } = useAccountPoolCatalog();
	// A pool holds only the accounts its provider can route, the same rule the
	// pool editor applies.
	const accounts = useMemo(
		() => poolAccountGroups([provider])[0]?.accounts ?? [],
		[provider]
	);
	const save = useMutation({
		mutationFn: async (input: {
			member: AccountPoolMember;
			pool: AccountPool;
		}) =>
			await updateAccountPool(target, input.pool.id, {
				accounts: poolAccountsAfterToggle(input.pool, input.member),
			}),
		onError: (cause) => {
			sileo.error({
				title: tl("Could not save the account pool."),
				description:
					cause instanceof ApiError && cause.serverMessage
						? cause.serverMessage
						: undefined,
			});
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
		},
	});

	// Nothing to say on a node without pools, before the catalog arrived, or
	// for a provider whose accounts cannot be in a pool.
	if (!(supported && catalog) || accounts.length === 0) {
		return null;
	}

	return (
		<div
			className="flex flex-col gap-1.5"
			data-provider-account-pools={provider.id}
		>
			<div className="flex items-center justify-between gap-3">
				<h4 className="font-medium text-sm">Account pools</h4>
				<Button onClick={onManage} size="sm" type="button" variant="outline">
					Manage
				</Button>
			</div>
			<ul className="flex flex-col">
				{accounts.map((account) => {
					const member = {
						accountId: account.accountId,
						providerId: provider.id,
					};
					const inPools = poolsOfAccount(catalog.pools, member);
					const menuLabel = tl("Pools for {label}", { label: account.label });
					return (
						<li
							className="flex min-h-9 items-center justify-between gap-3"
							data-pool-account={account.accountId}
							key={account.accountId}
						>
							<span className="min-w-0 truncate text-sm">{account.label}</span>
							<span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
								{inPools.length === 0 ? (
									<span className="text-detail text-muted-foreground">
										None
									</span>
								) : (
									inPools.map((pool) => (
										<Badge key={pool.id} variant="outline">
											{pool.name}
										</Badge>
									))
								)}
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												aria-label={menuLabel}
												disabled={save.isPending}
												size="icon-sm"
												title={menuLabel}
												type="button"
												variant="ghost-muted"
											/>
										}
									>
										<HugeiconsIcon
											className="size-4"
											icon={MoreHorizontalIcon}
										/>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="min-w-48">
										{catalog.pools.length === 0 ? (
											<DropdownMenuItem disabled>
												No account pools yet.
											</DropdownMenuItem>
										) : (
											catalog.pools.map((pool) => (
												<DropdownMenuCheckboxItem
													checked={inPools.some(
														(entry) => entry.id === pool.id
													)}
													disabled={poolIsFullFor(
														pool,
														member,
														catalog.maxPoolAccounts
													)}
													key={pool.id}
													onCheckedChange={() => save.mutate({ member, pool })}
												>
													{pool.name}
												</DropdownMenuCheckboxItem>
											))
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

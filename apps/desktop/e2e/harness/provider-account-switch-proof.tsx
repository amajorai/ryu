import { CommandGroup } from "@ryu/ui/components/command.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type ProviderAccount,
	ProviderAccountSection,
	type ProviderAccountTarget,
} from "../../components/agent-elements/input/provider-account-section.tsx";
import { ProviderCommandDialog } from "../../components/agent-elements/input/provider-command-dialog.tsx";
import "../../src/index.css";

type ProviderName = "BYOK · admin" | "BYOK · member" | "Claude subscription";

const INITIAL_ACCOUNTS = {
	"Claude subscription": [
		{
			accountId: "claude-ada",
			active: true,
			gatewayActive: false,
			kind: "oauth",
			label: "ada@acme.example",
		},
		{
			accountId: "claude-grace",
			active: false,
			gatewayActive: false,
			kind: "oauth",
			label: "grace@acme.example",
		},
	],
	"BYOK · admin": [
		{
			accountId: "openrouter-team",
			active: true,
			gatewayActive: true,
			kind: "api_key",
			label: "Team OpenRouter",
		},
		{
			accountId: "openrouter-lab",
			active: false,
			gatewayActive: false,
			kind: "api_key",
			label: "Lab OpenRouter",
		},
	],
	"BYOK · member": [
		{
			accountId: "member-openai",
			active: true,
			gatewayActive: false,
			kind: "api_key",
			label: "Member OpenAI",
		},
	],
} satisfies Record<ProviderName, ProviderAccount[]>;

function updateAccounts(
	accounts: ProviderAccount[],
	accountId: string,
	target: ProviderAccountTarget
): ProviderAccount[] {
	return accounts.map((account) => ({
		...account,
		active:
			target === "self" ? account.accountId === accountId : account.active,
		gatewayActive:
			target === "gateway"
				? account.accountId === accountId
				: account.gatewayActive,
	}));
}

function Story() {
	const [accounts, setAccounts] =
		useState<Record<ProviderName, ProviderAccount[]>>(INITIAL_ACCOUNTS);
	const [lastAction, setLastAction] = useState("Nothing changed yet");

	const switchAccount = (
		provider: ProviderName,
		account: ProviderAccount,
		target: ProviderAccountTarget
	) => {
		setAccounts((current) => ({
			...current,
			[provider]: updateAccounts(current[provider], account.accountId, target),
		}));
		setLastAction(
			`${target === "gateway" ? "Gateway" : "You"}: ${account.label}`
		);
	};

	const renameAccount = async (
		provider: ProviderName,
		accountId: string,
		label: string
	): Promise<boolean> => {
		setAccounts((current) => ({
			...current,
			[provider]: current[provider].map((account) =>
				account.accountId === accountId ? { ...account, label } : account
			),
		}));
		setLastAction(`Renamed: ${label}`);
		return true;
	};

	return (
		<main className="min-h-screen bg-background p-8 text-foreground sm:p-12">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<header className="flex flex-col gap-3 border-b pb-5">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Provider account presentation fixture
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Render account targets and selector callbacks
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm leading-6">
						Supplied subscription and BYOK accounts exercise the shipping
						selector. Callbacks update this fixture only. Core persistence,
						authorization and retry require separate transport tests.
					</p>
				</header>

				<div className="grid gap-3 sm:grid-cols-3">
					<div className="rounded-xl border bg-card p-4">
						<p className="text-muted-foreground text-xs">
							Fixture callback result
						</p>
						<p className="mt-2 font-medium text-sm" data-testid="last-action">
							{lastAction}
						</p>
					</div>
					<div className="rounded-xl border bg-card p-4">
						<p className="text-muted-foreground text-xs">Personal scope</p>
						<p className="mt-2 font-medium text-sm">Supplied personal target</p>
					</div>
					<div className="rounded-xl border bg-card p-4">
						<p className="text-muted-foreground text-xs">Gateway scope</p>
						<p className="mt-2 font-medium text-sm">
							Supplied admin visibility flag
						</p>
					</div>
				</div>

				<ProviderCommandDialog
					renderBody={() => (
						<>
							<CommandGroup heading="Claude subscription">
								<ProviderAccountSection
									accounts={accounts["Claude subscription"]}
									onRemove={() => undefined}
									onRename={(accountId, label) =>
										renameAccount("Claude subscription", accountId, label)
									}
									onSwitch={(account, target) =>
										switchAccount("Claude subscription", account, target)
									}
								/>
							</CommandGroup>
							<CommandGroup heading="BYOK · admin">
								<ProviderAccountSection
									accounts={accounts["BYOK · admin"]}
									canSetGateway
									gatewaySupported
									onRemove={() => undefined}
									onSwitch={(account, target) =>
										switchAccount("BYOK · admin", account, target)
									}
								/>
							</CommandGroup>
							<CommandGroup heading="BYOK · member">
								<ProviderAccountSection
									accounts={accounts["BYOK · member"]}
									canSetGateway={false}
									gatewaySupported
									onRemove={() => undefined}
									onSwitch={(account, target) =>
										switchAccount("BYOK · member", account, target)
									}
								/>
							</CommandGroup>
						</>
					)}
					title="Provider accounts"
					trigger={
						<button
							className="w-fit rounded-xl border bg-card px-4 py-2.5 font-medium text-sm shadow-sm hover:bg-muted/40"
							data-testid="provider-account-trigger"
							type="button"
						>
							Open provider accounts
						</button>
					}
				/>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}

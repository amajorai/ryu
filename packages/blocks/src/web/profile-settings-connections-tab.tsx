"use client";

import { Button } from "@ryu/ui/components/button";
import { Github } from "lucide-react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../desktop/settings-items.tsx";
import {
	ACCOUNT_LINKING_PROVIDERS,
	type LinkedAccountProvider,
} from "./linked-account-providers.ts";
import styles from "./profile-settings.module.css";
import { RowHint } from "./profile-settings-row-hint.tsx";
import type { LinkedAccount } from "./profile-settings-types.ts";
import { DISCORD_SVGL, SvglIcon } from "./svgl-icon.tsx";

const GOOGLE_LOGO = (
	<svg aria-hidden="true" className="size-5" viewBox="0 0 24 24">
		<path
			className={styles.googleBlue}
			d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
		/>
		<path
			className={styles.googleGreen}
			d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
		/>
		<path
			className={styles.googleYellow}
			d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
		/>
		<path
			className={styles.googleRed}
			d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
		/>
	</svg>
);

function LinkedAccountIcon({
	providerId,
}: {
	providerId: LinkedAccountProvider;
}) {
	if (providerId === "google") {
		return GOOGLE_LOGO;
	}
	if (providerId === "github") {
		return <Github aria-hidden="true" className="size-5" />;
	}
	return <SvglIcon size={20} spec={DISCORD_SVGL} />;
}

export function ConnectionsTabPanel({
	connectAccount,
	connectingProvider,
	connections,
	unlinkAccount,
}: {
	connectAccount: (providerId: LinkedAccountProvider) => void;
	connectingProvider: LinkedAccountProvider | null;
	connections: LinkedAccount[];
	unlinkAccount: (account: LinkedAccount) => void;
}) {
	return (
		<SettingsSection
			caption="Link individual social identities to this Ryu account. These are separate from organization and agent connections. The login page keeps Google as its only social option. Telegram Login is organization/channel-level, so it does not belong in this user-account list."
			title="Connected accounts"
		>
			<SettingsGroup>
				{ACCOUNT_LINKING_PROVIDERS.map((provider) => {
					const account = connections.find(
						(candidate) => candidate.providerId === provider.id
					);
					const isConnecting = connectingProvider === provider.id;
					return (
						<div
							data-testid={`linked-account-${provider.id}`}
							key={provider.id}
						>
							<SettingsItem
								actions={
									account ? (
										<Button
											disabled={connectingProvider !== null}
											onClick={() => unlinkAccount(account)}
											size="sm"
											variant="outline"
										>
											Unlink
										</Button>
									) : (
										<Button
											disabled={connectingProvider !== null}
											loading={isConnecting}
											onClick={() => connectAccount(provider.id)}
											size="sm"
											variant="outline"
										>
											{isConnecting ? "Opening…" : "Connect"}
										</Button>
									)
								}
								title={
									<>
										<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-background">
											<LinkedAccountIcon providerId={provider.id} />
										</span>
										{provider.label}
									</>
								}
							>
								<RowHint className="truncate pl-9">
									{account ? "Connected" : provider.description}
								</RowHint>
							</SettingsItem>
						</div>
					);
				})}
			</SettingsGroup>
		</SettingsSection>
	);
}

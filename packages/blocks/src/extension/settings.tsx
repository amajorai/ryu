"use client";

import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs";
import type { ReactNode } from "react";

export type ExtensionSettingsTab =
	| "profile"
	| "account"
	| "connections"
	| "sessions"
	| "appearance"
	| "billing";

const TABS: { value: ExtensionSettingsTab; label: string }[] = [
	{ value: "profile", label: "Profile" },
	{ value: "account", label: "Account" },
	{ value: "connections", label: "Connections" },
	{ value: "sessions", label: "Sessions" },
	{ value: "appearance", label: "Appearance" },
	{ value: "billing", label: "Billing" },
];

export interface ExtensionSettingsProps {
	account?: ReactNode;
	appearance?: ReactNode;
	billing?: ReactNode;
	connections?: ReactNode;
	/** Default open tab; the live page defaults to "profile". */
	defaultTab?: ExtensionSettingsTab;
	/** Per-tab content; the live page injects its data-coupled tab components. */
	profile?: ReactNode;
	sessions?: ReactNode;
}

/**
 * The real extension settings shell (header + pill tabs + content), presentational.
 * The live page (apps/extension/pages/SettingsPage.tsx) wraps it in its
 * QueryClientProvider and injects the data-coupled ProfileTab/AccountTab/… into
 * the slots. The storyboard fills the slots with static panels and pins the open
 * tab via `defaultTab`.
 */
export default function ExtensionSettings({
	defaultTab = "profile",
	profile,
	account,
	connections,
	sessions,
	appearance,
	billing,
}: ExtensionSettingsProps) {
	const content: Record<ExtensionSettingsTab, ReactNode> = {
		profile,
		account,
		connections,
		sessions,
		appearance,
		billing,
	};

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="shrink-0 px-6 pt-5 pb-0">
				<h1 className="mb-4 font-semibold text-base">Settings</h1>
				<Tabs className="flex h-full flex-col" defaultValue={defaultTab}>
					<TabsList className="justify-start">
						{TABS.map(({ value, label }) => (
							<TabsTrigger key={value} value={value}>
								{label}
							</TabsTrigger>
						))}
					</TabsList>

					<div className="flex-1 overflow-y-auto py-6">
						<div className="max-w-lg">
							{TABS.map(({ value }) => (
								<TabsContent className="mt-0" key={value} value={value}>
									{content[value]}
								</TabsContent>
							))}
						</div>
					</div>
				</Tabs>
			</div>
		</div>
	);
}

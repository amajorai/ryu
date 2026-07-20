// apps/desktop/src/components/store/AccountSection.tsx
//
// The store's "Account" section — the Marketplace money layer that survives the
// fold-in: My licenses (purchases), Sell (seller onboarding), and Connections
// (Composio). Paid *browsing* now lives inline in each catalog section, so this
// section carries only the account-scoped surfaces, behind an internal tab bar.

import { MarketplaceHeader } from "@ryu/blocks/desktop/marketplace";
import { useState } from "react";
import ConnectionsTab from "@/src/components/marketplace/ConnectionsTab.tsx";
import LicensesTab from "@/src/components/marketplace/LicensesTab.tsx";
import SellTab from "@/src/components/marketplace/SellTab.tsx";

type AccountTab = "licenses" | "sell" | "connections";

export default function AccountSection() {
	const [tab, setTab] = useState<AccountTab>("licenses");

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<MarketplaceHeader
				activeTab={tab}
				onSelectTab={(value) => setTab(value as AccountTab)}
				tabs={[
					{ value: "licenses", label: "My licenses" },
					{ value: "sell", label: "Sell" },
					{ value: "connections", label: "Connections" },
				]}
			/>

			<div className="scroll-fade-effect-y min-h-0 flex-1 overflow-auto">
				{tab === "licenses" && <LicensesTab />}
				{tab === "sell" && <SellTab />}
				{tab === "connections" && <ConnectionsTab />}
			</div>
		</div>
	);
}

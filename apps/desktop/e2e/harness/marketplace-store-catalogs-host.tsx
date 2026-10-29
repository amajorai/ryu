import {
	type MarketplaceHost,
	MarketplaceHostProvider,
	type SellerReportRow,
} from "@ryu/marketplace/host";
import type { OwnedLicense, SellerStatus } from "@ryu/marketplace/types";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";

const OWNED_LICENSE: OwnedLicense = {
	buyerOrgId: "org-fixture",
	buyerUserId: "user-fixture",
	currency: "usd",
	entitlementUntil: null,
	id: "license-fixture",
	itemId: "fixture/paid-skill",
	itemKind: "skill",
	itemName: "Paid Fixture Skill",
	itemVersion: "1.2.0",
	platformFeeMinor: 100,
	priceMinor: 1200,
	purchasedAt: "2026-08-03T12:00:00.000Z",
	status: "active",
	stripePaymentIntentId: "pi_fixture",
	stripeSubscriptionId: null,
};

const OPEN_REPORT: SellerReportRow = {
	details: "Install fails after retrying the local fixture.",
	id: "report-fixture",
	itemId: "fixture/paid-skill",
	itemKind: "skill",
	itemName: "Paid Fixture Skill",
	reason: "broken",
	status: "open",
};

declare global {
	interface Window {
		__marketplaceStoreAccountFixture?: {
			externalUrls: string[];
			licenseRefreshes: number;
			onboardAttempts: number;
			reportActions: Array<{ id: string; status: string }>;
			reportRefreshes: number;
			sellerRefreshes: number;
		};
	}
}

export function DesktopMarketplaceHost({ children }: { children: ReactNode }) {
	const [licenses, setLicenses] = useState<OwnedLicense[]>([]);
	const [licenseRefreshes, setLicenseRefreshes] = useState(0);
	const [sellerStatus, setSellerStatus] = useState<SellerStatus>({
		onboardingStatus: "pending",
		payoutsEnabled: false,
		stripeConnectAccountId: "acct_fixture",
		stripeIdentityStatus: "pending",
	});
	const [sellerRefreshes, setSellerRefreshes] = useState(0);
	const [onboardAttempts, setOnboardAttempts] = useState(0);
	const [externalUrls, setExternalUrls] = useState<string[]>([]);
	const [reports, setReports] = useState<SellerReportRow[]>([OPEN_REPORT]);
	const [reportRefreshes, setReportRefreshes] = useState(0);
	const [reportActions, setReportActions] = useState<
		Array<{ id: string; status: string }>
	>([]);

	const refreshLicenses = useCallback(async () => {
		setLicenseRefreshes((current) => current + 1);
		setLicenses((current) => (current.length > 0 ? current : [OWNED_LICENSE]));
	}, []);
	const refreshSeller = useCallback(async () => {
		setSellerRefreshes((current) => current + 1);
		setSellerStatus({
			onboardingStatus: "active",
			payoutsEnabled: true,
			stripeConnectAccountId: "acct_fixture",
			stripeIdentityStatus: "verified",
		});
	}, []);
	const onboard = useCallback(async () => {
		const attempt = onboardAttempts + 1;
		setOnboardAttempts(attempt);
		if (attempt === 1) {
			throw new Error("Fixture seller onboarding temporarily unavailable");
		}
		return "https://checkout.example.test/connect/acct-fixture";
	}, [onboardAttempts]);
	const openExternal = useCallback((url: string) => {
		setExternalUrls((current) => [...current, url]);
	}, []);
	const refreshReports = useCallback(async () => {
		setReportRefreshes((current) => current + 1);
	}, []);
	const resolveReport = useCallback(
		async ({
			id,
			status,
		}: {
			id: string;
			status: "resolved" | "dismissed";
		}) => {
			setReportActions((current) => [...current, { id, status }]);
			setReports((current) => current.filter((report) => report.id !== id));
		},
		[]
	);
	const useLicenses = useCallback(
		() => ({
			authed: true,
			error: null,
			isLicensed: (_kind: string, id: string) =>
				licenses.some((license) => license.itemId === id),
			licenses,
			loading: false,
			refresh: refreshLicenses,
		}),
		[licenses, refreshLicenses]
	);
	const useSellerStatus = useCallback(
		() => ({
			authed: true,
			error: null,
			loading: false,
			onboard,
			onboarding: false,
			refresh: refreshSeller,
			status: sellerStatus,
		}),
		[onboard, refreshSeller, sellerStatus]
	);
	const useSellerReports = useCallback(
		() => ({
			authed: true,
			error: null,
			loading: false,
			refresh: refreshReports,
			reports,
			resolve: resolveReport,
		}),
		[refreshReports, reports, resolveReport]
	);
	const host = useMemo<MarketplaceHost>(
		() => ({
			guardPurchase: async (action) => action(),
			openExternal,
			openMarketplace: () => undefined,
			openOrganization: () => undefined,
			openSignIn: () => undefined,
			startPurchase: async () => ({
				alreadyLicensed: false,
				url: "https://checkout.example.test/session/fixture",
			}),
			useLicenses,
			useSellerReports,
			useSellerStatus,
		}),
		[openExternal, useLicenses, useSellerReports, useSellerStatus]
	);

	useEffect(() => {
		window.__marketplaceStoreAccountFixture = {
			externalUrls,
			licenseRefreshes,
			onboardAttempts,
			reportActions,
			reportRefreshes,
			sellerRefreshes,
		};
	}, [
		externalUrls,
		licenseRefreshes,
		onboardAttempts,
		reportActions,
		reportRefreshes,
		sellerRefreshes,
	]);

	return (
		<MarketplaceHostProvider host={host}>
			{children}
			<output
				aria-label="Account fixture state"
				className="sr-only"
				data-testid="account-fixture-state"
			>
				{JSON.stringify({
					externalUrls,
					licenseRefreshes,
					onboardAttempts,
					reportActions,
					reportRefreshes,
					sellerRefreshes,
				})}
			</output>
		</MarketplaceHostProvider>
	);
}

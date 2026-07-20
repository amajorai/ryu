// apps/desktop/src/components/marketplace/LicensesTab.tsx
//
// Moved to the shared @ryu/marketplace package (one money-layer UI for desktop +
// web). This re-export keeps AccountSection's default import working; the desktop
// data path is supplied by <DesktopMarketplaceHost> (host.tsx).

export { LicensesTab as default } from "@ryu/marketplace/licenses-tab";

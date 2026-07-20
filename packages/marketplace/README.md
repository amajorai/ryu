# @ryu/marketplace

One store/marketplace UI consumed by **both** the desktop app and the web app, so a
single edit updates both surfaces (the web store was behind the desktop; this closes
that gap for the money layer).

Every surface-specific dependency is injected through the **MarketplaceHost** seam
(`./host`): the license/seller data hooks, the purchase action, and how to open an
external Stripe URL. The components themselves are surface-agnostic.

- Desktop mounts `<MarketplaceHostProvider>` with a host backed by its Better-Auth
  bearer + Tauri `openExternal` (`apps/desktop/src/components/marketplace/host.tsx`).
- Web mounts it with a host backed by the session cookie + `window.location`
  (`apps/web/src/components/marketplace/host.tsx`).

## Exports

| Subpath | What |
|---|---|
| `./types` | Canonical money-layer types + `formatPrice` (were duplicated per surface) |
| `./host` | `MarketplaceHost` interface, `MarketplaceHostProvider`, `useMarketplaceHost` |
| `./star-rating` | `StarRating`, `StarRatingInput` |
| `./states` | `SignedOutState`, `NoOrgState` |
| `./licenses-tab` | `LicensesTab` — the org's owned paid items |
| `./sell-tab` | `SellTab` — Stripe Connect seller onboarding |
| `./use-marketplace-purchase` | `useMarketplacePurchase` — the shared Buy flow |

## What lives here vs. what stayed

Moved (shared): the money layer above. Catalog discovery sections (models/skills/
apps/…), the item detail dialog, publish, and Composio connections remain
surface-local for now — see the task receipt for the move-vs-stay ledger.

## Test

```
bun test src
```

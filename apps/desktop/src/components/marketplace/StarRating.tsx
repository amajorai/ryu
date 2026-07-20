// apps/desktop/src/components/marketplace/StarRating.tsx
//
// Moved to the shared @ryu/marketplace package so desktop + web render identical
// star primitives. This re-export keeps the existing desktop import paths working
// (e.g. MarketplaceDetailDialog imports `./StarRating.tsx`).

export { StarRating, StarRatingInput } from "@ryu/marketplace/star-rating";

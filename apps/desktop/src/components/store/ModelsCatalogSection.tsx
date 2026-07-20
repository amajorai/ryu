// The Models catalog section moved into @ryu/marketplace so desktop and web
// render it from one implementation. Desktop mounts the DesktopCatalogHost
// (StorePage) which injects the Core-node model catalog hook + install layer +
// the node-coupled detail extras (llmfit, active-model, fine-tuned variants);
// this re-export keeps StorePage's import path stable and behavior byte-equivalent.
export { default } from "@ryu/marketplace/catalog/models";

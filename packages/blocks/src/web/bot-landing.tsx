import { getProduct } from "./data/products.tsx";
import ProductLandingPage from "./product-landing-page.tsx";

/** Public entry point for the Ryu Bot landing surface. */
export default function BotLanding() {
	const product = getProduct("bot");
	if (!product) {
		return null;
	}
	return <ProductLandingPage product={product} />;
}

import { getProduct } from "./data/products.tsx";
import ProductLandingPage from "./product-landing-page.tsx";

/** Public entry point for the Agent landing surface. */
export default function ConsoleLanding() {
	const product = getProduct("agent");
	if (!product) {
		return null;
	}
	return <ProductLandingPage product={product} />;
}

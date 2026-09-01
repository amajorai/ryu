import { getProduct } from "./data/products.tsx";
import ProductLandingPage from "./product-landing-page.tsx";

/** Public entry point for the Ryu Console landing surface. */
export default function ConsoleLanding() {
	const product = getProduct("console");
	if (!product) {
		return null;
	}
	return <ProductLandingPage product={product} />;
}

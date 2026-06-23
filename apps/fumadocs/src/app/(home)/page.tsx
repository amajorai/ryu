import { FeaturedRail, Hero, Realms } from "@/components/home/hero";

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col pb-16">
      <Hero />
      <Realms />
      <FeaturedRail />
    </main>
  );
}

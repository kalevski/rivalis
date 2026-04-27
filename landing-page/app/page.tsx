import { Nav } from './sections/Nav'
import { HeroSection } from './sections/HeroSection'
import { FeaturesSection } from './sections/FeaturesSection'
import { UseCasesSection } from './sections/UseCasesSection'
import { QuickStartSection } from './sections/QuickStartSection'
import { ComparisonSection } from './sections/ComparisonSection'
import { CTASection } from './sections/CTASection'
import { Footer } from './sections/Footer'

export default function Page() {
    return (
        <main className="page">
            <Nav />
            <HeroSection />
            <FeaturesSection />
            <QuickStartSection />
            <UseCasesSection />
            <ComparisonSection />
            <CTASection />
            <Footer />
        </main>
    )
}

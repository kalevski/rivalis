import { Nav } from './sections/Nav'
import { HeroSection } from './sections/HeroSection'
import { QuickStartSection } from './sections/QuickStartSection'
import { FeaturesSection } from './sections/FeaturesSection'
import { UseCasesSection } from './sections/UseCasesSection'
import { ComparisonSection } from './sections/ComparisonSection'
import { CommunitySection } from './sections/CommunitySection'
import { CTASection } from './sections/CTASection'
import { Footer } from './sections/Footer'

export default function Page() {
    return (
        <main className="page">
            <Nav />
            <HeroSection />
            <QuickStartSection />
            <FeaturesSection />
            <UseCasesSection />
            <ComparisonSection />
            <CommunitySection />
            <CTASection />
            <Footer />
        </main>
    )
}

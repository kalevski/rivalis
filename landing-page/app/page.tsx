import { Nav } from './sections/Nav'
import { HeroSection } from './sections/HeroSection'
import { QuoteSection } from './sections/QuoteSection'
import { QuickStartSection } from './sections/QuickStartSection'
import { FeaturesSection } from './sections/FeaturesSection'
import { UseCasesSection } from './sections/UseCasesSection'
import { DemoSection } from './sections/DemoSection'
import { ComparisonSection } from './sections/ComparisonSection'
import { SkillSection } from './sections/SkillSection'
import { CommunitySection } from './sections/CommunitySection'
import { CTASection } from './sections/CTASection'
import { Footer } from './sections/Footer'

export default function Page() {
    return (
        <main className="page">
            <Nav />
            <HeroSection />
            <QuoteSection />
            <QuickStartSection />
            <FeaturesSection />
            <UseCasesSection />
            <DemoSection />
            <ComparisonSection />
            <SkillSection />
            <CommunitySection />
            <CTASection />
            <Footer />
        </main>
    )
}

import { Nav } from './sections/Nav'
import { HeroSection } from './sections/HeroSection'
import { QuickStartSection } from './sections/QuickStartSection'
import { FeaturesSection } from './sections/FeaturesSection'
import { UseCasesSection } from './sections/UseCasesSection'
import { FleetSection } from './sections/FleetSection'
import { P2pSection } from './sections/P2pSection'
import { SignalSection } from './sections/SignalSection'
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
            <QuickStartSection />
            <FeaturesSection />
            <UseCasesSection />
            <FleetSection />
            <P2pSection />
            <SignalSection />
            <DemoSection />
            <ComparisonSection />
            <SkillSection />
            <CommunitySection />
            <CTASection />
            <Footer />
        </main>
    )
}

---
name: landing-page-scaffold
description: "Generates high-converting, responsive landing page prototypes with five standard sections (Hero → Social Proof → Features → Pricing → CTA) in clean, semantic HTML/Tailwind CSS or React/Next.js. Trigger when users ask to build a landing page, wireframe, marketing page prototype, or SaaS product launch page."
license: MIT
---

# Landing Page Scaffold

Generates a production-ready, accessible, high-converting landing page adhering to proven SaaS and developer tool conversion architecture.

## Architecture: The 5 Standard Sections

1. **Section 1: Hero**
   - High-contrast eyebrow badge (e.g., "v0.1.1 Released · Powered by NVIDIA Nemotron")
   - Clear value proposition headline (H1: max 8 words)
   - Supporting subheadline (H2: 15-25 words explaining who it is for and the key outcome)
   - Dual Call-to-Action: Primary action button + Secondary link/terminal command
   - Interactive preview / product hero visual (dashboard, code snippet, video embed)

2. **Section 2: Social Proof / Logos**
   - Grid or ticker of trusted logos, metrics, benchmark scores, or developer endorsements
   - Quantified trust badges (e.g. "129/129 tests passing", "100% open-source MIT", "4/4 live benchmarks")

3. **Section 3: Feature Matrix / Deep Dive**
   - 3 to 4 core differentiators organized with visual cards or tabs
   - Focus on problem → solution rather than raw feature lists
   - Concrete before/after comparison code snippets or diagrams

4. **Section 4: Pricing / Tiers**
   - 2 to 3 clear tiers (e.g. Community / Pro / Enterprise)
   - Highlighted "Recommended" tier with visual badge and contrasting button
   - Feature checklist with checkmark icons and transparent limits

5. **Section 5: Final CTA & Footer**
   - High-urgency closing headline
   - Quick install snippet (`npm install -g ...` or signup form)
   - Semantic footer with docs, GitHub, license, and community links

---

## Best Practices

- **Responsive Mobile First**: Collapsing navbars, flex-col on mobile, full-width tap targets (min 44px).
- **Fast First Paint**: Zero layout shifts, system or preloaded fonts, accessible semantic tags (`<header>`, `<main>`, `<section>`, `<footer>`).
- **Dark Mode Native**: High visual polish with deep slate/charcoal backgrounds (`#0B0F17`) and crisp typography.


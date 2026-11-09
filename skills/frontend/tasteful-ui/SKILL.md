---
name: tasteful-ui
description: "Taste-driven UI/UX design & frontend engineering skill for coding agents. Guides the creation of high-polish, responsive, mobile-first web applications with interactive sorting, filtering, curated imagery, micro-interactions, and anti-generic aesthetics. Trigger when users ask to build web apps, frontend components, stores, catalogs, polish UI, or improve responsive design."
license: MIT
---

# Tasteful UI & Frontend Product Engineering

This skill equips TERMINUS with the standards required to build world-class, production-ready frontend web applications that feel human-designed, responsive across all screen sizes, and completely free of generic "AI-generated" aesthetics.

---

## 1. Multi-Device Widths & Mobile-First Responsiveness

1. **Breakpoints & Grids**:
   - Always implement responsive grid scaling:
     `grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6`.
   - Never design for desktop only. Ensure layouts look balanced on small phones (360px–480px) and large monitors (1440px+).

2. **Mobile Overflow & Touch Standards**:
   - Prevent horizontal page overflow: ensure no fixed pixel widths exceed viewport width (`w-full`, `max-w-7xl`).
   - Category and tag pills on mobile MUST use horizontal scrolling carousels (`flex gap-2 overflow-x-auto scrollbar-none pb-1`) with touch-snapping instead of wrapping into messy multi-line blocks.
   - Touch targets for interactive buttons, links, and steppers must be at least 44x44px.

3. **Mobile Navigation & Sticky Action Bars**:
   - Header must feature a mobile hamburger trigger that opens a slide-out drawer sheet with full category navigation, search, and brand guarantees.
   - On mobile e-commerce or checkout flows, provide a floating sticky bottom action bar (e.g. `[ShoppingBag] 3 items · $14.97 | Review Bag →`) when items are selected so users don't have to scroll back to top.

---

## 2. Interactive Data Management (Sorting, Filtering & Search)

1. **Multi-Criteria Sorting**:
   - Any list, store, or catalog MUST include a functional sort dropdown:
     - "Featured / Curated" (default)
     - "Price: Low to High" and "Price: High to Low"
     - "Alphabetical (A - Z)"
     - Contextual criteria (e.g. "Lowest Calories", "Highest Rated", "Newest")
   - Sorting must reorder the rendered items reactively with zero page reloads.

2. **Dietary & Attribute Filtering**:
   - Offer toggleable multi-select chips (e.g. `🌱 Organic (16)`, `🌾 Gluten-Free (7)`, `🥑 Vegan (14)`) with active checkmarks and live count badges.
   - Include optional quick price filters (e.g. `Under $3`, `Under $5`, `All Prices`).

3. **Live Search with Empty-State Recovery**:
   - Connected search bar with clear button (`✕`) when text is typed.
   - When active filters or search terms return zero results, never display an empty blank space:
     - Render an informative empty-state card with an icon, polite message, and a prominent **"Reset all filters"** button that instantly clears filters.

---

## 3. Visual Polish & Anti-Generic Aesthetics

1. **Curated Photography vs. Plain Emoji Boxes**:
   - **Never** render repetitive plain cards with raw emojis in place of real product photography.
   - Use high-resolution, context-specific imagery (e.g. Unsplash CDN URLs) with responsive aspect ratios (`aspect-4/3` or `aspect-square`, `object-cover`), smooth hover zoom (`group-hover:scale-105 transition-transform duration-500`), and a styled fallback gradient if network fails.

2. **Card Anatomy & Metadata Density**:
   - Cards should present realistic depth and rich metadata:
     - Primary dietary or status badges on top-left (`ORGANIC`, `NEW`).
     - Star rating & review counts on top-right (`★ 4.9 (184)`).
     - Title, origin/provenance, and unit weight (`Yakima Valley, WA · each`).
     - Nutritional or feature summary (`95 kcal · 2g protein`).
     - Price formatted with currency symbols and decimals (`$1.99`).

3. **Avoid AI Default Styling**:
   - Avoid purple/violet neon gradients and excessive blurry glassmorphism.
   - Use deliberate, brand-specific palettes (e.g. deep forest green, warm cream, stone neutral, and charcoal).
   - Use distinct typographic hierarchy (`font-semibold` titles with `font-normal` body at `leading-relaxed`).

---

## 4. State Synchronization Architecture

1. **Shared React Context / State Providers**:
   - Never isolate search or filter state inside disconnected local component hooks.
   - Wrap the application in a unified `ProductsProvider` (or `StoreProvider`) and `CartProvider` in `app/page.tsx` or `app/layout.tsx`.
   - Ensure changes in the top search bar, category navigation links, filter toolbar, and card steppers all immediately synchronize across the entire UI.

2. **In-Card Steppers & Micro-Interactions**:
   - When an item is added to the cart, dynamically swap the "+ Add" button for an inline stepper (`- [quantity] +`) directly on the card for effortless adjustments.
   - Include visual feedback: micro-bounce animation on add, cart quantity badge bump, and slide-in drawer transitions.

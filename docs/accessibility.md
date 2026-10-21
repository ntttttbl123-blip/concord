# Accessibility Statement & Conformance Goals

Concord is committed to providing a dashboard and interface accessible to all financial analysts, compliance officers, and operations team members, including those relying on assistive technologies.

---

## 1. Conformance Target

Our baseline target is **WCAG 2.2 Level AA** conformance across the dashboard ([`apps/web`](../apps/web)) and its reporting views.

We design and test for:
- Keyboard-only navigation without mouse dependency.
- Compatibility with modern screen readers (NVDA, JAWS, VoiceOver, and Orca).
- Perceivable information architecture, semantic markup, and sufficient contrast ratios.
- Predictable focus management across tab changes and modal interactions.

---

## 2. Implemented Accessibility Features

The dashboard incorporates core accessibility patterns directly in the source:

### Skip Navigation
- **Location:** [`apps/web/src/App.tsx:112`](../apps/web/src/App.tsx)
- A skip-to-content link (`<a href="#content" className="sr-only focus:not-sr-only ...">Skip to content</a>`) is rendered as the first element in the DOM, allowing keyboard and screen-reader users to bypass primary asset and workspace navigation directly to main data views.

### Navigation Landmarks & State
- **Semantic Navigation:** Primary asset selectors and section tabs are wrapped in semantic `<nav>` landmarks with descriptive `aria-label` attributes (`aria-label="Assets"`, `aria-label="Sections"`).
- **Active State (`aria-current`):** Navigation links state their active status programmatically using `aria-current="page"` (e.g. [`apps/web/src/App.tsx:135`](../apps/web/src/App.tsx)).
- **Descriptive Counter Badges:** Tab links with break counters provide accessible labels (e.g. `aria-label="Reconciliation, 3 open breaks"`), ensuring screen readers announce the exact count and severity without relying on color alone.

### Controls & Interactive States
- **Disclosure Controls (`aria-expanded`):** Collapsible panels, asset settings toggles, and expandable break rows indicate their open/closed state via `aria-expanded` (e.g. [`apps/web/src/breaks.tsx`](../apps/web/src/breaks.tsx), [`apps/web/src/App.tsx`](../apps/web/src/App.tsx)).
- **Role Radiogroups (`role="radiogroup"`):** Multi-option selectors (such as network switches and role pickers) use `role="radiogroup"` with `aria-checked` states on each option ([`apps/web/src/ui.tsx`](../apps/web/src/ui.tsx)).
- **Busy & Loading States (`aria-busy`):** Asynchronous actions, buttons undergoing requests, and loading skeletons signal work in progress using `aria-busy="true"` and `aria-label="Loading"` ([`apps/web/src/ui.tsx`](../apps/web/src/ui.tsx)).

### Forms & Input Labelling
- Form fields in settings, authentication, and file import workflows specify explicit `<label>` bindings or contextual `aria-label` tags (such as `aria-label="Invitation link"` in [`apps/web/src/Settings.tsx`](../apps/web/src/Settings.tsx)).
- Read-only token and invitation links automatically select text on focus to streamline keyboard copying.

---

## 3. Known Gaps & Roadmap

While current interfaces implement foundational WCAG 2.2 AA patterns, several areas are actively being enhanced:

1. **Large Data Tables:** Position and movement reconciliation tables with hundreds of lines can be difficult to navigate via screen reader. We are introducing sticky semantic column headers (`<th scope="col">`), row headers (`<th scope="row">`), and keyboard table pagination.
2. **Live Announcements (`aria-live`):** Background indexer sync passes (`CONCORD_SYNC_INTERVAL`) update ledger sequence numbers dynamically. We are adding polite live regions (`aria-live="polite"`) to announce newly flagged breaks or sync failures without interrupting analyst focus.
3. **Contrast Verification in Themes:** Certain subtle border lines (`var(--line)`) and muted badge backgrounds in dark mode are being calibrated to ensure a minimum 4.5:1 contrast ratio against background surfaces.
4. **Focus Restoration on Modal Close:** When closing sign-off modals or import dialogues, focus is being refined to consistently return to the invoking trigger button.

---

## 4. Automated Testing & Verification

We enforce accessibility quality through automated checks and continuous integration:
- **Linting:** ESLint with JSX accessibility linting rules ensures that all interactive elements carry keyboard handlers, valid ARIA attributes, and accessible labels.
- **Component Audits:** Unit and UI tests verify that ARIA attributes (`aria-expanded`, `aria-current`, `aria-busy`) toggle correctly in response to user state changes.
- **Automated Axe Audits:** Automated Lighthouse and `axe-core` sweeps evaluate rendered DOM trees for color contrast, landmark structure, form labeling, and heading hierarchy.

---

## 5. Feedback & Reporting Issues

If you encounter accessibility barriers, difficult-to-navigate tables, or incomplete screen-reader announcements when using Concord, please let us know:

- **Email:** `accessibility@useconcord.org`
- **GitHub Issues:** Open an issue on GitHub with the label `area: a11y`

Please include the page or view where the issue occurred, the assistive technology used (screen reader, browser, operating system), and a brief description of the encountered barrier. We aim to acknowledge reports within 3 business days.

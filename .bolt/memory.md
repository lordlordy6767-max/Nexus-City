# Project memory

## Product intent & audience

- **NEXUS CITY**: A GTA-style roleplay (RP) game project inspired by Grand RP.
- Primary audience: mobile and desktop players seeking browser-based GTA RP experience.
- Imported from GitHub (`lordlordy6767-max/Nexus-City`).

## Brand personality & voice

- Game-oriented, GTA RP community tone.
- Mobile experience is a priority (touch controls requested to match Grand RP).

## Visual design & UX direction

- **Touch controls (newly added, unverified):**
  - Left joystick for character movement on touch devices.
  - Right joystick for camera control on touch devices.
  - Joystick component is new; wiring is in the game screen.
  - Joysticks feed into existing `keyRef` (movement) and `yawRef` (camera yaw) refs.
  - Side-anchored positioning using computed style; made explicit for TypeScript.
  - Touch-only; desktop retains keyboard/mouse controls.
- **Potential layout issue:** Joysticks may overlap the chat panel on small screens — untested.
- Responsive behavior for mobile needs verification on actual devices.

## Decisions, constraints & rationale

- **Package manager:** Project is a pnpm workspace using `catalog:` and `workspace:` references. npm cannot install dependencies even if the preinstall guard is removed.
- **Install guard:** Root `preinstall` script explicitly blocks npm.
- **Dependencies/build not verified:** Could not run `pnpm install`, `pnpm run build`, or dev servers from the session. Shell is blocked by automatic npm install that fails on pnpm-only setup.
- **Unverified changes:** Touch joysticks added but never built or tested.
- **Two paths forward offered to user:**
  1. User runs `pnpm install` + `pnpm run build` and shares errors.
  2. User approves converting dependency setup from pnpm to npm (larger change, not yet confirmed).

## Open questions & assumptions

- Whether user will approve npm conversion or provide pnpm build results.
- Whether joysticks work correctly on real mobile devices.
- Whether joysticks overlap chat panel or other UI on small screens.
- Whether TypeScript build passes with the new joystick component.
- Whether client and server dev scripts start correctly after install.
- Full project structure, frameworks, and dev scripts not fully explored due to shell limitations.
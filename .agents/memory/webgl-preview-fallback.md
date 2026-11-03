---
name: WebGL preview fallback
description: Replit's preview capture browser cannot create a WebGL context for the Three.js game.
---

Keep a graceful Canvas 2D scene fallback alongside the Three.js renderer.

**Why:** The Replit preview capture browser failed to create a WebGL context, which caused the React error boundary to replace the game with an error screen. A fallback lets the preview show the HUD and live multiplayer state while normal browsers use the full 3D renderer.

**How to apply:** Preserve the fallback when changing game scene initialization, and use the real WebGL renderer for normal gameplay where the browser supports it.

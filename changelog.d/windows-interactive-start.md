### Fixed
- Windows remote PCs wait for Windows sign-in before starting herdr, so Codex can use its
  private-desktop sandbox. Startup options offer an explicit start without sign-in for headless
  PCs, with the sandbox and desktop-tool limitations shown before that one start. Running herdr
  servers and their panes are preserved.

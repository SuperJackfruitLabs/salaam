# Tui contributor notes

## Implementation and acceptance scope

The UI reuses the exact `@earendil-works/pi-tui@1.3.0` rendering/editor primitives, while Salaam owns its layout, themes, menus, authority and lifecycle. It does not launch Pi’s interactive app. The test harness controls real PTYs and parses their output with pinned `@xterm/headless@5.5.0`; retained screenshots render actual terminal cells rather than product mockups.

Design references were the [Crush terminal interface](https://github.com/charmbracelet/crush), [OpenCode TUI](https://github.com/anomalyco/opencode), [Pi terminal primitives](https://github.com/earendil-works/pi/tree/main/packages/tui) and [Zed external-agent integration](https://zed.dev/docs/ai/external-agents). Their service/client separation and keyboard-oriented controls informed Salaam’s own visual design.

`npm run test:acceptance` runs the complete source test suite, repeats the new operator recovery/coding proofs three times and retains the existing 20-repetition S1–S6 gate. CI stores actual terminal-cell SVG/text captures alongside its platform manifests. Source-only test discovery prevents compiled rehearsal helpers from causing duplicate test runs.

Local PTY and ACP protocol proofs are independent of the named Zed GUI rehearsal. The Zed 1.24.2 GUI check passed on an unlocked macOS desktop on 2026-10-18; its [evidence record](evidence/m10-zed-gui.json) covers actual tools, bound approvals, owned-file/diff inspection and same-session reload. The adapter fix found during that rehearsal passes all 186 local tests and the subsequent full platform acceptance CI run. M11 task controls and M12 job/schedule/inbox controls are implemented. The M12 SSH pilot is independent of the earlier Zed GUI rehearsal.

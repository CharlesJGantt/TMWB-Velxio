# TMWB Fork: Modification Notice

This repository is a modified version of **[Velxio](https://github.com/davidmonterocrespo24/velxio)**, created by **David Montero Crespo** and licensed under the **GNU Affero General Public License v3.0** (see [LICENSE](LICENSE)). It is maintained by Charles Gantt for [The Makers Workbench](https://themakersworkbench.com) and runs publicly at **https://lab.themakersworkbench.com**.

This notice is provided to satisfy AGPLv3 section 5(a) (prominent notice of modification, with dates) and section 13 (offering the corresponding source to users who interact with it over a network). The complete corresponding source of the running application is this repository. The in-app "source code" link points here.

The original copyright notices and the unmodified `LICENSE` file are retained. All original work remains copyright its respective authors. Modifications in this fork are released under the same AGPLv3 license. This fork is not affiliated with or endorsed by the upstream author.

- **Upstream base:** upstream `master` as of 2026-09-17 (commit `1456beaf4ccbf205d5e1c174dccaffbc93fe0105`)
- **Modifications dated:** 2026-09-18 through 2026-09-20 (see git history for exact commits)

## Summary of changes

| Area | Change | Main files |
| --- | --- | --- |
| Layer ordering | Right-click menu to bring components, boards, and wires to front, send to back, or move one step up/down | `SimulatorCanvas.tsx`, `BoardOnCanvas.tsx`, `WireLayer.tsx`, `DynamicComponent.tsx`, `useSimulatorStore.ts`, `vlxFile.ts` |
| Save to Media Library | File-menu action that POSTs the current project (in the `.vlx` payload format) to a Drupal site, which stores it in its media library | `lib/drupalMediaSave.ts`, `EditorMenuBar.tsx`, `EditorToolbar.tsx`, `editorCommands.ts` |
| Embed mode | Chromeless `/embed` route for embedding the simulator in a web page, with attribution bar, Reset control, and loading a project from a URL | `pages/EmbedPage.tsx`, `pages/EmbedPage.css`, `utils/loadProjectFromUrl.ts`, `App.tsx` |
| Branding | Accent color changed to the TMWB brand color; source-code link repointed to this fork | `tokens/colors.css`, `AppHeader.tsx` |
| Dev tooling | Vite dev/preview proxy for talking to a local Drupal site over HTTP | `vite.config.ts` |
| Fixes | Wire layer z-index losing to raised components; blank embed boards loading with a pre-wired LED and resistor | `WireLayer.tsx`, `EmbedPage.tsx` |

Run `git diff 1456beaf4ccbf205d5e1c174dccaffbc93fe0105 master --stat` to see the full file-level diff against the upstream base.

## Server side of Save to Media Library

Save to Media Library needs a receiving endpoint on a Drupal site. That endpoint is provided by the separate [Velxio Embed Drupal module](https://github.com/CharlesJGantt/velxio_embed) (GPL-2.0-or-later), which requires Drupal 10 or 11. The request format is also documented in `frontend/src/lib/drupalMediaSave.ts`. Without the module the feature does nothing; the rest of the fork does not depend on it.

## Deployment note

The public instance runs the stock upstream Velxio backend image with this fork's built frontend (`npm run build:docker`) layered on top.

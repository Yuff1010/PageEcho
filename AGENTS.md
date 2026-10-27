# Shared UI architecture

Before changing renderer layout, read [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md).

- Shelf geometry belongs to `ShelfHeader`, `ShelfControls`, `ShelfBookCard` and `design-tokens.css`. Audiobook and ebook routes share these components. Do not add format-specific title sizes, header heights or extra shelf banners.
- Reading chrome belongs to `ReaderToolbar`, `ReaderFooter` and `ReaderDock`. Source selection, transcription progress, following and pagination share the listening dock; do not add parallel persistent status bars or large progress cards above saved text.
- Reader layout and turning preferences come from `reader-settings.ts`. Reuse `reader-dom.ts` and `motion.ts` for page measurement, text anchors and animation. A bounded data chunk is not a viewport page or a whole-book page count.
- `ReaderPreferences` owns settings structure and density. Put optional explanations in `HelpTip`; keep actionable failures visible. Controls shown as tabs must display only the selected panel and support keyboard navigation.
- Persistent actions use accurately named icons and the shared `Tooltip`; use `ReaderAction` for reading chrome. Preserve native control semantics, refs and one-click behavior. Keep content, actual progress values and actionable errors readable. Do not add visible labels beside the same persistent icon or duplicate browser title bubbles.
- Scope styles to the component or explicit page kind. Broad `.reading` rules must not change shelf geometry. Put adjustable shared dimensions in the existing token groups instead of copying route-specific pixel values.
- Preserve audio sessions, reading anchors, manual transcripts and mapping semantics when changing presentation. Match the relevant geometry, pagination, progress/cancel or settings regressions to the change. Update the design document if component ownership or a shared parameter changes.

Build previews into a fresh cache directory with `npm.cmd run build:preview -- --version <version>`; preserve the existing root `out/` and all user/model data.

# Version delivery and repository sync

The user has requested repository updates after every completed version. This is standing authorization to commit and push completed version work; do not ask again for each version.

- Finish the relevant validation before calling a version complete. Intermediate build attempts do not need release commits or tags.
- Update `CHANGELOG.md` and a version record under `docs/releases/` with the actual delivered version, changes, validation evidence and remaining limits. Keep historical results separate from current evidence.
- Review the Git diff and intended file list, then commit the finished version and push to the configured upstream. Include the source, reproducible dependency lockfile, configuration, tests and documentation needed to reproduce the version.
- Keep user data, credentials, downloaded books/audio, model weights, caches and generated packages out of Git. Small documented synthetic test fixtures may be committed. Program directories and ZIPs remain local unless the user asks to publish release assets.
- Add and push an annotated `v<delivered-version>` tag pointing to the delivery commit. Do not move an existing version tag, force-push, overwrite remote work or invent earlier version history.
- Fetch and check the upstream before pushing; preserve other changes. Verify the remote branch and tag resolve to the intended commit, then include the version and commit link in the final handoff. If synchronization fails, report that it has not completed.

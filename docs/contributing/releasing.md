---
title: Releasing
description: How a mirrorball version becomes five binaries and a GitHub release — and the checklist that has to pass first.
sidebar_position: 3
---

# Releasing

A release is one action: pushing a `vX.Y.Z` tag. Everything after that is automated.
Everything before it is a checklist.

## What the tag sets off

```
git push origin v0.2.0
        │
        ▼
  .github/workflows/release.yml
        │
        └─ binaries    bunli build, one binary per target
        │              → mirb-0.2.0-darwin-arm64.tar.gz
        │                mirb-0.2.0-darwin-x64.tar.gz
        │                mirb-0.2.0-linux-arm64.tar.gz
        │                mirb-0.2.0-linux-x64.tar.gz
        │                mirb-0.2.0-windows-x64.zip
        │                checksums.txt
        │              → attached to the GitHub Release for the tag
        │
```

Asset names are `mirb-<version>-<os>-<arch>` with no `v` on the version — `.tar.gz` for the
unix targets, `.zip` for Windows. `checksums.txt` covers all five, and is what both
`scripts/install.sh` verifies downloads against.

The five targets are declared once, in `build.targets` in `bunli.config.ts`. That is what
gets compiled, and therefore what the packaging step finds in `dist/` and uploads. Adding a
platform is a one-line change.

> **Cross-compiling needs every platform's optional dependencies.** The OpenTUI runtime
> packages are platform-gated, so a plain `bun install` fetches only the host's and
> `bunli build --targets all` fails with *"Missing OpenTUI platform runtime packages
> required for standalone compilation"*. The release job installs with
> `bun install --frozen-lockfile --os '*' --cpu '*'`; do the same locally before building
> all targets by hand.

> **Why the workflow does its own packaging.** An earlier version delegated to
> `AryaLabsHQ/bunli-releaser@v1`. That action's README documents the `v1` ref, but the
> repository has never been tagged — only branches — so the reference cannot resolve, and
> the first real release failed with *"unable to find version v1"*. The workflow now builds,
> archives, checksums and uploads directly. It is a dozen lines, and it depends on nothing
> that can vanish.

## Why there is no npm package

There was going to be one, built the way esbuild and biome do it: five `os`/`cpu`-gated
packages carrying one binary each, and a root package listing them as optional
dependencies with a shim that dispatches to whichever one npm installed.

npm would not accept a name for the root package. Both `mirb` and `mirb-cli` were refused
with *"Package name too similar to existing packages"* — `mitt`, `mime`, `mri`, `sirv-cli`
and others. That check runs on new names only and is unrelated to availability; both names
were unclaimed.

A scoped name (`@sanil/mirb`) would have worked, since scopes skip the check. It was not
worth it: mirrorball is a CLI you install once, not a dependency you pin in a project, so
npm would only ever have been a second delivery route for the same binary the install
script already fetches and checksums.

If that changes, the packaging code is in git history at `scripts/build-npm-packages.ts`
(removed in the commit that added this section) and was working — it generated the tree,
verified the binaries against `checksums.txt`, and the shim dispatched correctly on a real
`npm install`. It needs a name, not a rewrite.

## Pre-release checklist

On `main`, before tagging:

- [ ] `main` is green and your checkout is on it, up to date, with nothing uncommitted.
- [ ] `bun test` passes.
- [ ] `bun x tsc --noEmit` is clean.
- [ ] `bun run build:all` succeeds. A target that only breaks under cross-compilation
      otherwise breaks in CI *after* the tag exists, which is the annoying way to find out.
- [ ] Smoke-test the compiled binary, not just `bun mirb.ts`: `./dist/<target>/mirb --version`
      plus one real forward and one deliberate failure.
- [ ] `bunli.config.ts` still has `compress: false`.
- [ ] `package.json` `version` is bumped to the version you are about to tag. The tag and
      this field must match exactly — the binary reports `pkg.version`, and a mismatch means
      `mirb --version` lies about which build is running.
- [ ] `CHANGELOG.md`: rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a fresh
      empty `## [Unreleased]`, and update the two link definitions at the bottom.
- [ ] `docs/` reflects every user-visible change, including the exit-code table if a code moved.
- [ ] `REPO` in `scripts/install.sh` and the repository the workflow publishes from are the
      same string. The installer downloads from that path and `chmod +x`es what it gets.
- [ ] Commit it as `chore(release): v0.2.0`.

## Tagging

```sh
git push origin main
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

Annotated tags, `v` prefix, no exceptions: the workflow triggers on `v*` and the version in
every artifact name is derived from the tag.

Push the branch **before** the tag. If the tag lands first, the release is built from a
commit that isn't yet on `main`, and tracing a shipped binary back to its source gets
needlessly hard.

## After the tag

1. Watch the workflow. The build job takes a few minutes.
2. Confirm **six** assets on the release: five archives plus `checksums.txt`.
3. Verify the shell installer against the new release:
   ```sh
   curl -fsSL https://raw.githubusercontent.com/heysanil/mirrorball-cli/main/scripts/install.sh | sh
   ```
   Then check that both names landed: `mirb --version` and `mirrorball --version`, the
   second through the symlink the installer writes next to the binary.
5. Spot-check a manual download:
   ```sh
   shasum -a 256 -c checksums.txt --ignore-missing
   ```
6. Tidy the generated release notes so they match the changelog entry.

## When something goes wrong

**Never re-tag a published version.** A moved git tag makes
the two disagree forever.

| Situation | Do this |
| --- | --- |
| Build failed, nothing published | `git push --delete origin v0.2.0`, fix, re-tag the same version |
| A published version is actively broken | Ship the fix as `X.Y.Z+1` and note it in the release body. A patch release is cheap; a broken one is confusing for as long as it stands |

Deleting a published release is a last resort — anyone who scripted against its asset URLs
breaks, and the install script pins nothing, so it will happily install whatever `latest`
resolves to next.

## Credentials

The workflow needs:

- `GITHUB_TOKEN` with `contents: write`, provided automatically, for creating the release
  and uploading its assets.

That is the whole list. There is no npm channel, so no registry token, no OIDC provenance
step, and nothing to rotate.

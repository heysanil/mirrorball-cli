# Contributing to mirrorball

Thanks for being here. mirrorball is small on purpose, which makes it a genuinely pleasant
codebase to contribute to — you can read all of it in an afternoon.

Bug reports, docs fixes and "this error message confused me" issues are as welcome
as code. If you're unsure whether an idea fits, open an issue before writing the
patch; it's cheaper for both of us.

## Quick start

```sh
git clone https://github.com/heysanil/mirrorball-cli.git
cd mirrorball-cli
bun install
bun test
bun run dev -- 127.0.0.1 3000   # run the CLI from source
```

You need [Bun](https://bun.sh) 1.3 or newer. There is no other toolchain.

## The three guides

| Guide | What's in it |
| --- | --- |
| [Development](docs/contributing/development.md) | Repo layout, running from source, typechecking, code conventions |
| [Testing](docs/contributing/testing.md) | How the suite is organised, and how the fake-ssh harness works |
| [Releasing](docs/contributing/releasing.md) | Tagging, the release pipeline, and the pre-release checklist |

## Before you open a pull request

- `bun test` passes.
- `bun x tsc --noEmit` is clean.
- New behaviour has a test. Bug fixes have a test that fails without the fix.
- User-visible changes get a bullet under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- Docs are updated in the same PR as the code that changed.

## Commit messages

**This repository requires [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).**
The changelog and the version bump are derived from them, so the prefix is not decoration.

```
feat(up): accept 8080:db.internal:5432 three-part port specs
fix(supervise): reset backoff after a connection proves stable
docs(contributing): explain the fake-ssh harness
```

Allowed types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.
Breaking changes take a `!` after the type/scope (`feat(up)!: …`) and a
`BREAKING CHANGE:` footer explaining the migration.

Keep the subject in the imperative mood, under ~72 characters, and lowercase after
the colon. Squash noisy work-in-progress commits before requesting review.

## Code of conduct

Be decent to people. Assume good faith, especially in review. Maintainers will act
on anything less.

## Licence

By contributing you agree that your contributions are licensed under the
[MIT Licence](LICENSE).

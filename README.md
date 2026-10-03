# framebudget.dev

The website of [framebudget](https://github.com/framebudget/core), the browser library that decides, per device, which visual effects a site can afford.

| Directory | What it is |
| --- | --- |
| [`docs/`](docs/README.md) | The site: landing page, API reference, privacy page, error pages and the files for AI agents (`llms.txt`, `llm.txt`, `llms-full.txt`). A static Vite build that is also a live demo of the library. |
| [`worker/`](worker/README.md) | One Cloudflare Worker that serves `docs/dist` through its static assets layer, receives the library's anonymous reports (`POST /api/report`, stored in D1) and serves the calibration patch (`GET /api/calibration`). |

Related repositories: the library is [github.com/framebudget/core](https://github.com/framebudget/core) (the npm packages `framebudget`, `@framebudget/core` and `@framebudget/react`), and the brand (fonts, logos, tokens, the release card template) is [github.com/framebudget/assets](https://github.com/framebudget/assets).

## The library as a dependency

The site and the Worker's tests use the published library, never its source: `docs/package.json` (dependency) and `worker/package.json` (devDependency) pin `"framebudget": "npm:@framebudget/framebudget@0.2.1"`, today's full package, served by GitHub Packages. `docs/.npmrc` and `worker/.npmrc` map the `@framebudget` scope to `https://npm.pkg.github.com`. The package's `README.md` becomes `llms-full.txt`, and the Worker's calibration script reads `defaultCalibration` from it.

To move to a new library release, change the version in both `package.json` files, run `npm install` in `docs/` and `worker/`, and commit both lockfiles.

## Local development

Node 22. GitHub Packages needs a token even for public packages. Keep it out of your `~/.npmrc` with a throwaway user config (the GitHub CLI token works when it has `read:packages`; add it with `gh auth refresh --scopes read:packages`):

```sh
export NPM_CONFIG_USERCONFIG=$(mktemp)
printf '//npm.pkg.github.com/:_authToken=%s\n' "$(gh auth token)" > "$NPM_CONFIG_USERCONFIG"
```

Site:

```sh
npm ci --prefix docs
npm run dev --prefix docs      # Vite dev server with hot reload
npm run build --prefix docs    # type-check, then the static site in docs/dist
npm run serve --prefix docs    # serve docs/dist like production
```

Worker:

```sh
npm ci --prefix worker
npm run typecheck --prefix worker
npm test --prefix worker
npm run migrate:local --prefix worker   # local D1 schema
npm run dev --prefix worker             # wrangler dev --local, serves docs/dist (build the site first)
```

See [`docs/README.md`](docs/README.md) and [`worker/README.md`](worker/README.md) for details.

## Pull requests

`.github/workflows/ci.yml` runs on pull requests that are ready for review (drafts skip every job; marking one ready starts the run). A change under `docs/` runs the Site job (install and build), a change under `worker/` runs the Worker job (install, typecheck, tests), and a change to `ci.yml` runs both. The `CI` job is the one required check: it fails when any job failed and passes when the others were skipped.

## Releases and deploys

The website has its own versions, independent of the library's; the first website release is `v1.0.0`. A release is cut by pushing a tag `vX.Y.Z` to a commit on `main`, and `.github/workflows/release.yml` does the rest:

1. **Validate**: refuses a tag that already has a release, then checks the tag (format, order, bump) and classifies the commits since the previous tag with the release tooling of [github.com/framebudget/core](https://github.com/framebudget/core) (`scripts/release/`, checked out at `main`), configured by `release.config.json` (sections Site for `docs/` and Worker for `worker/`).
2. **Notes**: writes the release notes, renders the release card with the template from [github.com/framebudget/assets](https://github.com/framebudget/assets) (`brand/build/release.html`), and opens the pull request `chore(release): vX.Y.Z` that prepends the release to `CHANGELOG.md`.
3. **Deploy** (environment `production`, secret `CLOUDFLARE_API_TOKEN`): installs both projects, checks registry signatures, runs the Worker tests, builds the site, applies the D1 migrations and runs `wrangler deploy`. The deployed `docs/dist` is kept as `framebudget-website-vX.Y.Z.tar.gz`.
4. **Release**: a draft release with the card, the site tarball and `SHA256SUMS`, each with a build provenance attestation, then published. Immutable releases are on, so a published release and its tag never change; the job then verifies the release attestation and every asset.

Verify a release asset:

```sh
gh release verify vX.Y.Z --repo framebudget/website
gh release verify-asset vX.Y.Z framebudget-website-vX.Y.Z.tar.gz --repo framebudget/website
gh attestation verify framebudget-website-vX.Y.Z.tar.gz --repo framebudget/website
```

The changelog lists every release, newest first, in [`CHANGELOG.md`](CHANGELOG.md).

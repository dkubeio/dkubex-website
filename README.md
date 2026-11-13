# DKubeX Demos

Public, static previews of DKubeX applications, served with GitHub Pages at
https://dkubeio.github.io/dkubex-website/. All data shown is sample data.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Home page with a card per app |
| `<app-slug>/index.html` | One app's demo (e.g. `securellm/`) |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |
| `.github/actions/push-demo/` | Shared action that app repos use to publish their demo |
| `templates/publish-demo.yml` | Workflow to copy into each app repo |

Pages is set to **Deploy from a branch → `main` / (root)**; any change to `main` republishes the site.

## Publishing an app's demo

Each app repo keeps its finished static pages in a top-level `demo/` folder (must contain
`index.html` and work without a server). A workflow in that repo copies **only** `demo/`
into `<app-slug>/` here. Each repo replaces only its own folder.

Copy [`templates/publish-demo.yml`](templates/publish-demo.yml) into the app repo as
`.github/workflows/publish-demo.yml` and set `app-slug`. It looks like this:

```yaml
name: Publish demo to dkubex-website
on:
  push:
    branches: [main]
    paths: ["demo/**"]
  workflow_dispatch:
concurrency: publish-demo
jobs:
  publish:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - uses: dkubeio/dkubex-website/.github/actions/push-demo@main
        with:
          app-slug: securellm            # change per repo
          app-id: ${{ secrets.DEMO_APP_ID }}
          app-private-key: ${{ secrets.DEMO_APP_PRIVATE_KEY }}
```

Requires a GitHub App installed on this repo with **Contents: read and write**, and its ID and
private key available to the app repo as `DEMO_APP_ID` / `DEMO_APP_PRIVATE_KEY`.

Without automation, a demo can also be updated by hand: upload the new `index.html` into the
app's folder on GitHub and commit to `main`.

**Everything here is public.** Only demo pages with sample data belong in this repo — never
source code, secrets or real customer data. When an app's demo goes live, turn its card in
`index.html` into a link.

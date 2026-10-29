# COMPO Status

A small web page that shows how COMPO is doing, read live from the COMPOMML repos:

- **Overview**: the plan's "Next up" progress, open problems, CI on `main` per repo, the last two weeks in numbers, the current sprint from the board.
- **Problems**: a checklist of open issues labelled `bug`, `blocked` or `decision`. Ticking one closes the issue (with an optional comment saying what solved it). Recently solved ones can be reopened.
- **Improvements**: ideas and planned improvements (issues labelled `enhancement`), with notes as issue comments.
- **Activity**: commits to `main`, pull requests and issues across the org, by day.
- **Plan**: `docs/plan.md`, rendered, with each issue reference ticked once it is closed.

Anything added here is an ordinary GitHub issue or comment in the private repos. New problems and ideas carry `needs-refinement`, so they go through grooming like everything else, and a new problem can be put straight on the board with its priority.

## Privacy: why this repo can be public

GitHub Pages on the Free plan only serves public repositories, and every Pages site is public. So this repo holds **code only**: no issue titles, no plan, no lab data, no client names, no tokens.

- The page reads everything at run time from `api.github.com` with the viewer's own token. Without a token it shows only the sign-in screen.
- Module names, their order and the plan are read from the private `docs` repo (`architecture/README.md`, `plan.md`), not written here.
- The token stays in the browser (session storage, or local storage with "Remember on this device") and is sent only to `api.github.com`. "Sign out" removes it.
- The page loads no third-party code. Its Content Security Policy allows scripts and styles from this site only and network requests to `api.github.com` only. Everything from GitHub is inserted as text or escaped before rendering.
- `.local/` (local preview data with real issue titles) is ignored by git and must never be committed.

## Setting up your token

Create a fine-grained token at <https://github.com/settings/personal-access-tokens/new>:

| Setting | Value |
| --- | --- |
| Resource owner | COMPOMML |
| Expiration | 90 days |
| Repository access | All repositories |
| Repository permissions | Issues: Read and write · Contents: Read · Pull requests: Read · Actions: Read · Metadata: Read |
| Organization permissions | Projects: Read and write |

If the org requires approval for fine-grained tokens, an owner approves it under the org's settings. A classic token with `repo`, `read:org` and `project` also works, but it can do much more than the page needs.

Read-only is fine for looking: leave Issues on Read and Projects on Read, and the page will say so when you try to add or close something.

## Changing what it shows

All settings are at the top of `app.js` (`CFG`): the org, the board number, which labels count as problems, the idea label, the label new items get, and the refresh interval (2 minutes while the tab is visible).

## Previewing locally

With `gh` signed in:

```bash
python dev/make_local_data.py .
python -m http.server 8765 --bind 127.0.0.1
```

Then open <http://localhost:8765/?local>. The preview uses real data fetched through `gh`, and adding or closing items there changes nothing on GitHub.

## Publishing

Settings → Pages → Deploy from a branch → `main` / root. There is no build step. `.nojekyll` makes Pages serve the files as they are.

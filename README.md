# COMPO Brain: sign-in page

The public front door of COMPO Brain: https://compomml.github.io/status/

This repo holds only a sign-in page and two open-source libraries. The site itself, its content and any notes are in a private repo, and are read with each viewer's own GitHub token. Without a token you see only the sign-in screen.

- The token stays in the browser and is sent only to `api.github.com`. "Sign out" removes it.
- `vendor/` holds three.js r128 and MathJax 3.2.2, unchanged, so the page runs no code from other sites. The Content Security Policy in `index.html` enforces that.
- Nothing about the project belongs in this repo: no results, plans, material names or tokens.

Licences: three.js (MIT), MathJax (Apache-2.0).

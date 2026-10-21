# Authoring the in-app handbook

The documentation a reader sees at `/docs` is written in `content/docs/` and reviewed like code. This
file is the contract: what a page file looks like, which Markdown the renderer understands, and what the
lint refuses. It describes the implementation in `packages/docs` — if this file and the parser disagree,
the parser is right and this file has a bug.

- Engine: `packages/docs/src/` (parser, index, search, lint)
- Roadmap and rationale: `PLAN_Phase_21_Documentation.md` §4
- Admin-facing mechanics: `docs/admin/documentation.md`

## 1. Where a page lives

```text
content/docs/
  redirects.json                    # old key → new key, the only sanctioned slug rename
  en/
    _index.md                       # the /docs landing prose
    <section>/
      _index.md                     # section descriptor + section landing content
      01-<slug>.md                  # a page
  vi/                               # same tree, may be partial
```

- **Directory = section, file = page.** The section key is the directory name; the slug is the filename
  without `.md` and without an optional `NN-` ordering prefix (`01-lists-and-views.md` → slug
  `lists-and-views`).
- Section keys and slugs match `[a-z][a-z0-9-]*` and are part of the URL. **A slug is a permalink** —
  renaming one needs an entry in `redirects.json`.
- Every section needs `_index.md`. A section without one fails the lint.
- `en` is the source of truth and defines the structure of the tree. `vi` may translate a subset; a page
  missing in `vi` is served from `en` with a visible "not translated yet" notice. A page that exists
  only in `vi` is a lint warning and a broken tree slot — add the English page first.
- Nothing from `docs/` (engineering documentation) is rendered here, and no prose is duplicated into the
  i18n catalogs. Catalogs hold UI chrome (`web.docs.*`), never page text.

## 2. Front-matter

Every page begins with a `---` block. These eight keys are the whole vocabulary:

```yaml
---
title: Main menu
summary: Enable, rename, reorder and group the entries in the sidebar.
audience: admin
order: 30
tags: [menu, navigation, sidebar]
requires: { entity: Team, action: read }
related: [admin/settings-overview, reference/glossary]
updated: 2026-10-21
---
```

| Key | Required | Accepted value |
|---|---|---|
| `title` | yes | 1–80 characters, no trailing period. Becomes the page `<h1>`. |
| `summary` | yes | 1–160 characters. Used on cards, in search results, as the page lede. |
| `audience` | yes | `user` or `admin`. An `admin` page is hidden from callers who are not administrators. |
| `order` | yes | integer ≥ 0, unique inside its section. Ordering, not a display number. |
| `tags` | no | lowercase tokens, inline array. Feeds search and "See also". |
| `requires` | no | `{ entity: X, action: read }`. Filtered through real ACL, on top of `audience`. |
| `related` | no | inline array of `section/slug` keys. Each must exist. |
| `updated` | no | ISO date `YYYY-MM-DD`, must be a real calendar day. Shown as "Last reviewed". |

Rules the reader cannot see but the build enforces:

- **An unknown key fails the build.** `audiance:` is not downgraded to `user`, it is an error.
- **Only this YAML subset parses:** one `key: value` per line, scalars, inline arrays `[a, b]`, one-level
  inline maps `{ entity: Team, action: read }`, quoted strings, `true`/`false`/`null`, and `#` comments.
  A block list (`- item` at the top level of the block) or a nested map is refused, not misread.
- `order: "30"` is a string and fails. Write `order: 30`.

## 3. The Markdown subset

The parser produces a typed block tree, never HTML. Anything outside this table is a lint failure, and
the page is rendered as escaped text so a bad build cannot put markup on screen.

| Construct | Syntax | Notes |
|---|---|---|
| Heading | `##`, `###`, `####` | `#` is reserved for `title` and is refused; `#####`+ is refused. Levels may not skip (`##` → `####`). |
| Paragraph | blank line between blocks | Consecutive lines join into one paragraph. |
| Emphasis | `**bold**`, `*italic*`, `` `code` `` | No `__`/`_` forms. One level only; markers inside emphasis are literal. |
| Link | `[text](href)` | See §4. A link *title* (`[a](b "c")`) is not supported. |
| List | `-` or `1.` | Two levels maximum; a third is pulled up and reported. An indented following line continues the item. |
| Table | pipe syntax + `---` separator row | Header row required. Alignment from colons: `:---`, `:---:`, `---:`. Escape a literal pipe as `\|`. A short row is padded and reported. |
| Code block | triple backticks + language | Read-only, never executed, Markdown inside it stays text. An unclosed fence is an error. |
| Callout | `> [!NOTE]` then `> lines` | The only blockquote form. Variants: `NOTE`, `TIP`, `WARNING`, `DANGER`. |
| Divider | `---` on its own line | Inside the body only — the front-matter delimiters are consumed first. |
| Image | `![alt](/docs-assets/x.png "caption")` | Must be on a line of its own. `alt` required. Local assets only. |
| Raw HTML | any `<tag>` | Refused. Rendered as text. |

## 4. Links and assets

- **Doc link** — `[Main menu](admin/main-menu)`, `[sibling](record-page.md)` or
  `[other section](../admin/main-menu.md)`. All normalise to one key and are checked against the corpus;
  an unknown key fails the build.
- **In-page anchor** — `[the steps](#steps)` must name a heading that exists on the page.
- **App link** — `[Open Settings → Main Menu](/admin/settings/menu)`. Validated against the route
  allowlist, so a renamed screen cannot leave a dead instruction behind. The *first* app link of a page is
  rendered as an "Open this screen" button.
- **External** — `https://` only. `http:`, `javascript:` and `data:` are refused.

Screenshots live in `apps/web/public/docs-assets/` and are referenced as `/docs-assets/<name>.png`, so
the SPA's static handler serves them and the API stays JSON-only. Capture at 1440×900 with seeded demo
data: no customer data, no personal names, no token in the frame. PNG or WebP under 400 KB. Every
referenced file must exist and every shipped file must be referenced — orphans fail the build.

## 5. Writing rules

1. Write from the screen or the service, never from a plan. If the control is not in the build, the page
   does not mention it.
2. One page = one job. "Add a user" is a page; "Users, teams and roles" is a section.
3. Answer in order: what this is → when you need it → the steps → what can go wrong → where to go next.
4. No "coming soon", no future tense, no screenshots of unbuilt screens.
5. Translate `vi` by hand. A missing translation with a fallback notice is better than a machine-
   translated page nobody reviewed.
6. Documentation is descriptive, never authoritative. Hiding a page is convenience; the screen behind it
   still enforces ACL.

## 6. Add a page in ten minutes

```bash
# 1. Create the file in the section that owns the subject.
$EDITOR content/docs/en/admin/main-menu.md

# 2. Front-matter first, then the body. Keep the summary under 160 characters:
#    it is the lede and the search snippet.

# 3. Link the screen it documents and the page that follows it.

# 4. Lint and build the engine. The corpus test lints every shipped page.
pnpm --filter @carocrm/docs build && npx vitest run packages/docs

# 5. Renamed a published slug? Add the old key to content/docs/redirects.json.
```

`npx vitest run packages/docs` is the whole loop: unit tests for the parser and the lint, plus the
contract test that lints the real corpus and asserts the page count and `vi` coverage.

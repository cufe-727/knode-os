# 21 — Feishu documents: imported once or kept in sync, pictures included

> Status: **implemented** (2026‑11‑02; batches, wiki trees and the daily check the same day). Source:
> src/ingest/feishu/ (client.ts — lark-cli; markdown.ts — links and lark-cli's Markdown; mirror.ts — one document
> as a folder; tree.ts — a wiki page with its pages, or a space, as a tree of folders; docs.ts — import, batches,
> link, the daily check, sign-in). Tall pictures: `readInBands` / `bandsFor` in src/ingest/converters/image.ts.
> Server: `/api/feishu*` in src/server/app.ts, the scheduler in src/server/serve.ts. CLI: `knode-os feishu
> status|login|import|link|list|sync|unlink`. Web: Library → Import data → Feishu documents or a wiki; Tasks →
> Feishu documents → Check now. Mac app: Tasks → Check now, and a Feishu folder's menu.

## 0. What was there

A Feishu document reached the knowledge base only by hand: export it, drop the file in, and do it again after
every edit. Feishu *chats* arrive through rookie-trade's crawler as day files (design 08), and 知识星球 posts
the same way — their pictures only as links back to rookie-trade, so a chart or a hand-drawn diagram in a post
was never read.

The case that started this: `4. 九哥星球精华` (my.feishu.cn/docx/GzLnd…), a compilation someone else owns and
shared — text, three phone screenshots of 知识星球 posts (1152 × ~27 000 px each: candlestick charts and
hand-drawn volume curves), a dozen more pictures, a PDF, two spreadsheets and an embedded base. None of it was
in the workspace; the zsxq feed held the 2020 post announcing the PDF, as a link.

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 Read through lark-cli, as the signed-in Feishu user | Every call is `lark-cli … --as user`. knode-os stores no Feishu secret: lark-cli holds the app credentials and the user's token, and refreshes it | A user token reads what that person can open, shared documents included. An app (bot) identity reads only documents whose owner added the app — which the person importing often cannot do (they do not own them). lark-cli is already the Open Platform's own client, kept current with its APIs |
| D2 One-time authorization by device flow, started from knode-os | `POST /api/feishu/auth/login` (or `knode-os feishu login`) runs `lark-cli auth login --no-wait` and returns a `accounts.feishu.cn/oauth/v1/device/verify` link; the server waits on `--device-code` while the person approves on any device. Scopes: `docx:document:readonly`, `docs:document.content:read`, `docs:document.media:download`, `drive:drive.metadata:readonly`, `wiki:node:read`, `offline_access` — plus whatever lark-cli's user had granted, so its other uses keep them | No redirect URL to register, no public callback: it works the same on this Mac and through the tunnel. `offline_access` makes Feishu hand out a refresh token |
| D3 It stays authorized while it is used | Feishu's refresh tokens are single-use and come back renewed with each access token (2 h); the renewal window reported today is 7 days (`refresh_token_expires_in`), and Feishu requires a new sign-in 365 days after the grant. The daily check (D5) uses the token every day while something is linked, so in practice the person signs in once a year, or again after revoking | Feishu's own rules (Refresh user_access_token v2/v3) |
| D4 Mirror, as a folder import does | `raw/docs/feishu/<title>__<token>/<title>.md` with frontmatter (`platform: feishu`, `source_url`, `feishu_token`, `feishu_revision`, `as_of` = last edit), pictures and boards under `assets/<token>.<ext>`, indexable attachments under `files/`, a hidden `.feishu.json` manifest. A linked mirror is read-only (`mirrorLinks` beside linked folders) | The raw path stays the key of every source, sidecars sit beside real files, a rebuild needs no Feishu. Keeping the Markdown's file name across renames keeps its knowledge where it is |
| D5 Change tracking by polling once a day, not push | While `serve` runs, once a day at `ingest.feishu.checkAt` (local "HH:MM", default 06:00; `off` leaves it to the buttons) — and shortly after startup when that time passed while it was down or asleep — one `drive/v1/metas/batch_query` call (≤ 200 documents) returns each linked document's `latest_modify_time`, and a tree's listing each page's `obj_edit_time`; only documents newer than their manifest are fetched, and only files whose bytes changed are synced. The last check is kept in `.knode/feishu-checked-at`, so a restart does not check again. **Check now** (Tasks, in the web UI and the app; `POST /api/feishu/sync`) runs the same check at once in the background, and counts as the day's. A check that fails outright (a lapsed sign-in) is tried again an hour later. Pictures are fetched once: a replaced picture gets a new token | Feishu pushes `drive.file.edit_v1` only after `drive/v1/files/:token/subscribe`, which "仅支持文档拥有者和文档管理者订阅" — owners and managers. The documents worth following are mostly shared ones, which their reader can read but not manage. Push would also need the app's event configuration and a long connection (self-built apps only) or a public webhook. Polling covers every readable document with the one sign-in, behind NAT. Every few minutes was more than the documents followed here need: they change over days, and a person who knows of an edit can ask at once |
| D6 Pictures become sources of their own | Each picture is an image under `assets/`, transcribed by the Convert stage's vision model like any image; the document links it | One mechanism for every picture in the workspace. The document's text and its pictures are searched together by path prefix |
| D7 Long screenshots are read in bands | An image taller than 2.5× its width *and* than the frame (2048 px) is cut into bands ~1.5× as tall as wide, each cut moved up to a blank row nearby (rows sampled at 160 px wide), and read three bands a call, top to bottom. Such an image's conversion key gains `bands` (the converter's `variant`), so one squeezed before is read again; every other image keeps its key | Squeezed whole into the frame, a 1152 × 27 627 screenshot arrives 85 px wide — not one character legible. A tall picture that fits (a 600 × 2000 mind map) is still read whole, so a tree is still read as one |
| D8 What stays in Feishu is named, not dropped | Attachments knode-os cannot index (xlsx…) or above the size limit, embedded bases and sheets become a line in the text — `Attachment: x.xlsx (XLSX, 16 KB) — kept in Feishu, not imported`, `Base table — kept in Feishu: [open it](…)` | A reader of the Markdown knows something is there and where |
| D9 Who may do what | Signing in, previewing and importing (and following an import, `GET /api/feishu/import/:id`) are `settings` (an administrator's: they read Feishu as the machine's Feishu user); listing, syncing — Check now included — and unlinking are `files`, as for linked folders | lark-cli's sign-in belongs to the machine, not to a knode-os account |
| D10 Several links in one batch | The import dialog takes links one per line; `POST /api/feishu/preview {urls}` looks each up, `POST /api/feishu/import {urls}` imports them in the background and answers 202 with a job the dialog follows (`GET /api/feishu/import/:id`: done so far, the link under way, each one's result or error). One link that fails is reported and the rest go on; a lapsed sign-in ends the batch. What the batch wrote is indexed in one sync. One batch runs at a time per workspace. The CLI takes several links too | Pasting a reading list should not mean a dialog per document. A batch can take minutes (pictures), longer than a request should be held open |
| D11 A wiki as a tree of folders | A wiki page with **Bring the pages under it** (`subpages`), or a whole space (`…/wiki/space/<id>`), becomes `raw/docs/feishu/<title>__<token>/`: the top page's document in it (none for a space), and each page under it a folder named for its title holding its document, its `assets/` and `files/`, and the folders of the pages under it — as deep as the wiki goes. `.feishu-tree.json` records which folder each wiki node is. Same-titled siblings get the node token's start appended; `assets` and `files` are never a page's folder. A page holding a sheet, a base or another kind stays in Feishu, its folder made only for the pages under it; a shortcut is not followed. Folders follow the wiki: a page renamed or moved in Feishu moves its own files — with their sidecars, so nothing is converted or read by a model again — and a page deleted goes. A page that cannot be fetched keeps its copy and is reported. A tree is linked or copied as one source; more than 2000 pages is refused (import a part) | The wiki's structure is how its people find things, and a path prefix is how knode-os scopes search and summaries. One listing call per page with pages under it gives every page's last edit, so a check fetches only what changed. Folder names are the titles a person sees in Feishu |

## 2. Answers to the two questions it began with

**Does a one-time import need the user to authorize once?** Yes — one device-flow approval by the Feishu
account whose documents these are (D2). After that, imports need nothing more; the authorization renews itself
while it is used and lapses only after a week of disuse or Feishu's 365-day limit (D3).

**How does ongoing change tracking work — does the user connect a bot or app and grant it the document?** No
bot is needed for documents the user can read: the same authorization lets knode-os poll their last-edit
times and fetch the changed ones (D5). A bot or app would be needed only for push events, and Feishu sends
those only to a document's owners and managers — see §4.

## 3. Flow

```
Import data → Feishu documents or a wiki → paste links (one per line), Bring the pages under each wiki page?
  └ GET /api/feishu/auth ── signed in, scopes granted? ── no → POST /api/feishu/auth/login → device link → wait
  └ POST /api/feishu/preview {urls}  each: wiki node → docx token, metas → title, last edit; or a tree's listing → pages
  └ POST /api/feishu/import {urls}   one document: +fetch → download new media → render → write → sync (answered at once)
                                     several, or a tree: 202 + job → GET /api/feishu/import/:id until done; one sync
serve, daily at checkAt (and at startup when it was missed) — or Check now:
  metas(linked documents) + listing(linked trees) → edited since the copy? → mirror → sync changed keys
```

## 4. Not done

- **Push events** for documents the user owns or manages: subscribe with `drive/v1/files/:token/subscribe`,
  receive `drive.file.edit_v1` over a long connection (needs app id and secret in knode-os, and the event
  enabled in the app's console). It would shorten the delay from minutes to seconds for those documents only;
  the poller stays for the rest.
- **Embedded bases and sheets** are links, not tables; **comments** are not imported.
- **Drive folders** as one link (`…/drive/folder/…`): a wiki space or page can be, a Drive folder cannot yet.
- **Importing from the Mac app**: it checks for edits (Tasks → Check now, a Feishu folder's menu); importing
  and linking are in the web UI and the CLI.
- **Per-account Feishu identities**: lark-cli's sign-in is the machine's. A knode-os server shared by several
  people would want each account's own OAuth token (authorization-code flow against a callback on the public
  origin), stored per account.

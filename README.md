# Crossly for Google Sheets

[![CI](https://github.com/crossly-dev/crossly-sheets/actions/workflows/ci.yml/badge.svg)](https://github.com/crossly-dev/crossly-sheets/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/crossly-dev/crossly-sheets)](https://github.com/crossly-dev/crossly-sheets/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Apps Script V8](https://img.shields.io/badge/Apps%20Script-V8-4285F4)](https://developers.google.com/apps-script)

A Google Sheets add-on for [Crossly](https://crossly.net), the multi-marketplace crossposting platform for
resellers. Pull your inventory, listings, orders and sales into a spreadsheet, bulk-edit stock and prices
in cells, and push the changes back to Crossly. Crossly then syncs them to every marketplace the item is
live on (eBay, Poshmark, Mercari, Depop and the rest).

- **Pull** inventory, listings, orders or sales into their own tab. Pull walks every page.
- **Bulk-edit**: change `quantityAvailable` on the Inventory tab or `price` on the Listings tab. The
  editable column has a yellow header.
- **Push** sends only the rows you changed. Stock goes out in one batched call per 5,000 items, and each
  price is one call per listing. Afterwards the tab is pulled again, so it shows what Crossly now holds.
- **Your token stays out of the spreadsheet.** See [Where your token is stored](#where-your-token-is-stored).
- **Rate limits are respected.** The add-on waits when the quota is spent and retries a `429` after
  `Retry-After`. See [Rate limits](#rate-limits).

## Install (clasp)

You need Node 20+ and a Google account.

1. Install clasp and log in:
   ```bash
   npm install -g @google/clasp
   clasp login
   ```
   If you have never used the Apps Script API, enable it once at <https://script.google.com/home/usersettings>.
2. Get the code:
   ```bash
   git clone https://github.com/crossly-dev/crossly-sheets.git
   cd crossly-sheets
   ```
   Or download `crossly-sheets-<version>.zip` from [Releases](https://github.com/crossly-dev/crossly-sheets/releases)
   and unzip it. Each zip carries a build-provenance attestation, so you can check it with
   `gh attestation verify crossly-sheets-v0.1.0.zip -R crossly-dev/crossly-sheets`.
3. Pick the Apps Script project to push into. You have two options:
   - **A new spreadsheet with its own bound script.** clasp writes `.clasp.json` for you:
     ```bash
     clasp create --type sheets --title "Crossly" --rootDir .
     ```
   - **An existing spreadsheet.** Open it, go to **Extensions → Apps Script**, copy the script ID from
     **Project Settings**, then:
     ```bash
     cp .clasp.json.example .clasp.json   # then put your scriptId in it
     ```
4. Push the code: `clasp push`. `.claspignore` limits the push to `appsscript.json` and `src/`.
5. Reload the spreadsheet. The menu shows up under **Extensions → Crossly**. Bound scripts are listed
   there under the project's title, so name the project "Crossly".
6. Run **Extensions → Crossly → Set API token…** and paste your token. The first run asks you to
   authorize the three scopes listed below.

### Getting a token

In Crossly, open **Settings → API & webhooks** and create a Personal Access Token
(`crossly_pat_…`). Give it the scopes your workflow needs:

| You want to… | Scopes |
| --- | --- |
| Pull inventory / push stock | `inventory:read`, `inventory:write` |
| Pull listings / push prices | `listings:read`, `listings:write` |
| Pull orders | `orders:read` |
| Pull sales | `sales:read` |

## Menu

| Command | What it does |
| --- | --- |
| Set API token… | Checks the token with `GET /v1/me`, then saves it to your UserProperties. A rejected token is not saved, and you see the API's error message. |
| Pull inventory | Writes every inventory item to **Crossly Inventory**. |
| Pull listings | Writes every listing to **Crossly Listings**. |
| Pull orders | Writes every order to **Crossly Orders**. |
| Pull sales | Writes every sale to **Crossly Sales**. |
| Push stock changes (Inventory) | Sends each edited `quantityAvailable` as the item's new available stock. |
| Push price changes (Listings) | Sends each edited `price` to the listing, which updates it everywhere it is live. |
| Clear API token | Removes the token from your Google account. |

### Columns

Every column is a field name from the API response, so a header means exactly what the
[API reference](https://crossly.net/docs) says it means.

| Tab | Columns |
| --- | --- |
| Crossly Inventory | `id`, `sku`, `defaultTitle`, `brand`, `size`, `condition`, `status`, `quantity`, **`quantityAvailable`**, `quantityReserved`, `quantitySold`, `originalPrice`, `costBasisCents`, `warehouseLocation`, `updatedAt` |
| Crossly Listings | `id`, `sku`, `title`, **`price`**, `currency`, `status`, `quantity`, `quantityAvailable`, `brand`, `size`, `condition`, `updatedAt` |
| Crossly Orders | `id`, `platform`, `platformOrderId`, `status`, `channel`, `salePrice`, `platformFee`, `sku`, `quantity`, `buyerUsername`, `trackingNumber`, `carrier`, `shippedAt`, `deliveredAt`, `createdAt` |
| Crossly Sales | `id`, `platform`, `platformOrderId`, `salePrice`, `platformFee`, `shippingCost`, `costOfGoods`, `netProfit`, `currency`, `detectedBy`, `detectedAt`, `orderId` |

### How edits are detected

Each pull also writes the editable column to a hidden tab (`_crossly_snapshot_inventory` or
`_crossly_snapshot_listings`), keyed by `id`. On push, the add-on compares the visible tab with that
snapshot and sends only rows whose value changed. You can sort, filter or reorder the columns first,
because rows are matched by `id` and columns by their header.

- Stock must be a whole number of 0 or more. It is the **available** stock; reserved units on open
  orders are kept.
- A price must be a number above 0. It is rounded to cents, and `$` and `,` are allowed.
- An invalid cell is skipped and counted in the summary, and nothing is sent for that row.
- Don't rename the `id` column or the editable column's header.

## Where your token is stored

The token goes into `PropertiesService.getUserProperties()`. That store belongs to your Google account
and this script, and nobody else who opens the spreadsheet can read it, collaborators included. The
token is never written to a cell, a note, a document property or a log. **Clear API token** deletes it.

## Rate limits

Crossly counts requests per minute for each token. Reads get 1,200 a minute. Writes depend on your plan:
Free 15, Starter 60, Pro 240, Business 1,000, Scale 2,000 (see
[Rate limits](https://crossly.net/docs/api-rate-limits)). Writes are the scarce bucket, so the add-on
handles them like this:

- It batches stock: one `POST /v1/inventory/bulk-quantity` for up to 5,000 items.
- After every response it reads `X-Quota-Remaining`. When that reaches `0`, it waits `X-Quota-Reset`
  seconds before the next call.
- It retries a `429` after `Retry-After` seconds, up to 5 attempts. A `429 retry_storm` is not
  retried, because it means the same request keeps failing for a real reason.
- It retries `502`/`503`/`504` with exponential backoff.
- Errors show the API's `error.message`, `error.code` and `correlationId`. Quote the `correlationId`
  when you contact support.

An Apps Script run stops after 6 minutes. On the Free plan that is enough for about 80 price edits in
one push, and the rows that didn't go out still differ from the snapshot. To finish, push again.

## API operations used

Every endpoint, parameter and field comes from the public OpenAPI spec
(<https://crossly.net/openapi/seller.json>). Base URL `https://crossly.net/api`, auth
`Authorization: Bearer crossly_pat_…`.

| Menu command | Method | Path | operationId | Notes |
| --- | --- | --- | --- | --- |
| Set API token… | `GET` | `/v1/me` | `getMe` | Token check |
| Pull inventory | `GET` | `/v1/inventory?page=&limit=100` | `listInventory` | `{ data, pagination }` |
| Pull listings | `GET` | `/v1/listings?page=&limit=100` | `listListings` | Response has no `total`; the add-on stops at a short page |
| Pull orders | `GET` | `/v1/orders?page=&limit=100` | `listOrders` | Response has no `total` |
| Pull sales | `GET` | `/v1/sales?page=&limit=100` | `listSales` | Response has no `total` |
| Push stock changes | `POST` | `/v1/inventory/bulk-quantity` | `createInventoryBulkQuantity` | `{ mode: "set", items: [{ id, quantity }] }`, 1–5,000 items |
| Push price changes | `PATCH` | `/v1/listings/{id}` | `updateListing` | `{ changes: { price } }`, pushed to every platform where it's live |

## Development

There is no build step. Two plain script files run unchanged in Apps Script, where every file shares one
global scope, and in Node:

- `src/core.js` holds the pure logic: URLs, pagination, row mapping, edit detection, batching,
  backoff decisions and error parsing. It never touches an Apps Script global, and it exports itself
  with `module.exports` when `module` exists.
- `src/main.js` is the Apps Script glue: menu, UrlFetchApp, PropertiesService and sheet I/O. It reads
  the Apps Script globals in exactly one function, `crosslyEnv_()`.

The tests use only Node built-ins (`node:test`, `node:assert`, `node:vm`). `test/harness.js` loads both
files into a `vm` context with in-memory fakes of `SpreadsheetApp`, `UrlFetchApp`,
`PropertiesService` and `Utilities`, then drives the real menu functions from end to end.

```bash
npm install
npm run lint
npm test
npm run bundle   # dist/crossly-sheets-<version>.zip
```

### Continuous deployment (optional)

Every release on a `v*` tag runs these steps:

1. Lint and test.
2. Zip the clasp project.
3. Attest the zip's build provenance with `actions/attest-build-provenance`.
4. Attach the zip to a GitHub Release.

To have it also `clasp push` into a real Apps Script project, set the repository variable
`CLASP_PUSH=true` and add these secrets:

- `CLASPRC_JSON`: the contents of `~/.clasprc.json` after `clasp login`, for an account that can
  edit the script.
- `SCRIPT_ID`: the target script.

## Publishing to the Google Workspace Marketplace

You can only publish through Google's consoles, and you do it once per listing:

1. **Google Cloud project.** Create a standard GCP project. In Apps Script, go to **Project Settings →
   Google Cloud Platform project** and switch the script to that project's number.
2. **OAuth consent screen.** Configure it as External, with the app name, support email, homepage,
   privacy policy and terms URLs, and the three scopes from `appsscript.json`:
   `spreadsheets.currentonly` (this spreadsheet only), `script.external_request` (calls
   `https://crossly.net/` only, enforced by `urlFetchWhitelist`) and `script.container.ui` (the menu and
   dialogs). `spreadsheets.currentonly` is a non-sensitive scope. Google may still review the app before
   it goes public, so expect brand verification and possibly a scope justification video.
3. **Versioned deployment.** In the Apps Script editor, go to **Deploy → New deployment →
   Add-on** (or `clasp deploy`) and note the version number.
4. **Marketplace SDK.** Enable the *Google Workspace Marketplace SDK* in the GCP project. Under **App
   configuration**, choose *Sheets add-on*, enter the script ID and deployment version, and list the
   same OAuth scopes. Under **Store listing**, add the name, descriptions, icons, screenshots, category,
   and the support, privacy and terms links.
5. **Test.** Before you submit, use **Test deployments** in the Apps Script editor to install the add-on
   on a test spreadsheet.
6. **Submit.** Choose *Public* or *Private* (your Workspace domain only) visibility and submit for
   review. A private listing within one Workspace domain skips the public review.

The add-on is an **editor add-on**. It uses `onOpen` / `onInstall` with `createAddonMenu()`, not
Workspace add-on cards, so `appsscript.json` has no `addOns` section on purpose. Adding one would turn
the project into a card-based Workspace add-on, which needs a homepage trigger and card UI.

## Related

- [Crossly API docs](https://crossly.net/docs)
- [`@crossly/sdk`](https://github.com/crossly-dev/crossly-sdk): the TypeScript SDK
- [crossly-recipes](https://github.com/crossly-dev/crossly-recipes): ready-to-import automations

## License

[MIT](LICENSE)

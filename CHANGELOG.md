# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-27

### Added

- Crossly menu (Extensions → Crossly): Set API token…, Pull inventory / listings / orders / sales,
  Push stock changes, Push price changes, Clear API token.
- Token validated with `GET /v1/me` and stored in the user's UserProperties only.
- Full pagination (`limit=100`, stop on a short page) for `/v1/inventory`, `/v1/listings`,
  `/v1/orders`, `/v1/sales`.
- Edit detection against a hidden per-tab snapshot; stock pushed through
  `POST /v1/inventory/bulk-quantity` (5,000 items per call), prices through `PATCH /v1/listings/{id}`.
- Rate-limit handling: `X-Quota-Remaining`/`X-Quota-Reset` throttle, `Retry-After` on `429`,
  backoff on `502`/`503`/`504`, no retry on `retry_storm`.
- Node test suite (node:test + node:vm fakes of the Apps Script services), ESLint, CI, and a tagged
  release that zips the clasp project with a build-provenance attestation.

[0.1.0]: https://github.com/crossly-dev/crossly-sheets/releases/tag/v0.1.0

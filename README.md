# italy Tracking API

Backend API for application login, role-based access, and read-only shipment monitoring from the central source database.

## Stack

- NestJS with the Fastify adapter
- MongoDB Node.js driver and one shared `MongoClient` for the replica set
- Argon2id password hashing
- Short-lived HS256 access tokens and rotating, opaque refresh tokens

## Roles

| Role | Scope |
| --- | --- |
| `admin` | Create users, list users, change roles, activate/deactivate accounts, and manage Agent AI settings |
| `pusat` | Read shipment summaries/details, Agent AI summaries, combined restock plans, and manage minimum stock thresholds for buyback cleaning |
| `cabang` | Read shipment summaries/details and Agent AI data from its assigned branch only |

Only `admin` can call `/api/v1/users` and manage Agent AI source database metadata. A `cabang` user must have a `branchId` whose value exactly matches `tujuan` in shipment documents and the branch ID in its Agent AI source configuration. Shipment monitoring continues to use only `SHIPMENT_SOURCE_DATABASE_NAME`.

## Configuration

Run commands from `backend/`. If `.env` does not exist yet, copy `.env.example` to `.env`, replace every placeholder, then install dependencies and build:

```sh
cd backend
npm install
npm run build
npm run start:dev
```

Set `MONGODB_URI` to the existing replica-set connection string in the server environment. Keep the URI and JWT secret out of source control, frontend bundles, logs, and API responses. `SYSTEM_DATABASE_NAME` is a dedicated database for users and sessions; the MongoDB service user needs `readWrite` access to it and `read` access to the shipment source database configured by `SHIPMENT_SOURCE_DATABASE_NAME` (currently `db_pntspst2`) plus any active Agent AI source databases. Shipment API reads `tt_kirim_barang` and does not write to it.

Generate the access-token key with `openssl rand -base64 48`. Configure `CORS_ORIGINS` with exact origins when the frontend is hosted separately. Keep `TRUST_PROXY` empty unless the API is behind a known reverse proxy; if so, set only that proxy's addresses/CIDRs.

## First admin

Create the first admin once from a trusted server shell, running the command from `backend/`. Read the password without echoing it so it does not appear in shell history or command-line arguments:

```sh
printf 'Admin email: '
read -r BOOTSTRAP_ADMIN_EMAIL
printf 'Admin password: '
read -s BOOTSTRAP_ADMIN_PASSWORD
printf '\n'
export BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD
npm run admin:create
unset BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD
```

The command refuses to bootstrap when an active admin already exists and never prints the password. Remove the temporary bootstrap variables from the environment afterward.

## Auth endpoints

- `POST /api/v1/auth/login` accepts `{ "email", "password" }`; returns a bearer access token and sets refresh/CSRF cookies.
- `POST /api/v1/auth/refresh` rotates the refresh token. Send the `pnt_csrf` cookie value in `x-csrf-token`.
- `POST /api/v1/auth/logout` revokes the current refresh session. Send `x-csrf-token` as above.
- `GET /api/v1/auth/me` returns the signed-in account.
- `POST /api/v1/auth/change-password` accepts `{ "currentPassword", "newPassword" }`; all refresh sessions are revoked and the user must log in again.
- `GET /health` returns process health.

Access tokens expire after 10 minutes by default. A role change, account deactivation, or password change revokes refresh sessions immediately; already-issued access tokens remain valid until their short expiry. Keep access tokens in frontend memory and send them as `Authorization: Bearer ...`.

The built-in request limiter uses in-process memory. If the API is later deployed as multiple instances, configure shared throttler storage so login limits apply across the fleet.

## Admin user endpoints

- `GET /api/v1/users?limit=25&cursor=<id>` returns a cursor-paginated list without password hashes.
- `POST /api/v1/users` creates an account with `name`, `email`, `password`, `role`, and (for `cabang`) `branchId`.
- `PATCH /api/v1/users/:id/role` changes an account role and revokes its refresh sessions.
- `PATCH /api/v1/users/:id/status` accepts `{ "active": false }` to deactivate and revoke refresh sessions.

All API request bodies are validated, unknown fields are rejected, and responses never include password hashes or token hashes.

## Shipment read endpoints

- `GET /api/v1/shipments?search=PPS-PB-&status=pending&page=1&pageSize=20` returns groups by `no_kirim`; `search` is a prefix search and `pageSize` is capped at 20. The total counts all matching groups before page slicing.
- Administrators can add `debug=1` to the shipment list query to receive cache status, MongoDB aggregation round-trip time, backend service time, matching source-row and shipment-group counts, and the applied filters. The MongoDB duration is measured around the Node.js driver's `aggregate().toArray()` call, including network transfer and result decoding; it is not MongoDB server execution time. Cache hits and requests coalesced with an in-flight query do not run or separately time an aggregation. This mode does not issue a second `explain` query.
- `GET /api/v1/shipments/:noKirim?itemLimit=100&itemCursor=<id>` returns one grouped summary plus a cursor-paginated list of its item records.

`recordCount` is the number of source rows in a `no_kirim` group; it is not presented as a unit quantity. Group status is `received` when every row is `CLOS`, `pending` when every row is `OPEN`, `partial` when both occur, and `review` if any row has a missing or unrecognized receipt status. The list response also includes counts of shipment groups by status and the five destinations with the most pending/partial groups, all from the same aggregation. Branch accounts are filtered by exact `tujuan = branchId` in MongoDB before grouping. Responses contain a small allowlist of non-financial item fields. Unit quantity and weight are omitted until their source semantics and units are confirmed; `receive_date` is returned as stored and does not override `status_terima`.

The source read does not create indexes at application startup. For high-volume collections, have the database administrator review indexes such as `{ no_kirim: 1, _id: 1 }` and `{ tujuan: 1, no_kirim: 1, _id: 1 }` on `tt_kirim_barang`; index creation is intentionally left as an explicit database operation. List summaries still aggregate the matched records, so adding indexes should be guided by the production query plan and source data size.

## Sales report endpoint

- `GET /api/v1/sales/report?from=2026-09-01&to=2026-09-30&branchId=FCL&jenisCode=CN` returns a read-only sales report for an inclusive `tgl_system` date range. `from` and `to` are required `YYYY-MM-DD` dates; the range is capped at 366 days.
- Omit `branchId` to report every active branch source available to the account. A branch account is restricted to its own branch. `jenisCode` is optional and filters the report to one Jenis across the selected branches.
- Each branch result includes weight sold in grams, sales value from `harga_total`, invoice/detail-row counts, rows without positive weight, and up to 100 Jenis sorted by weight sold. The report does not expose quantity fields or raw transaction documents.
- Sales rows are filtered to `status_kembali=OPEN` and `status_valid=DONE`; rows with `status_tukar=true` or `trs_barang_tukar=true` are excluded. `refresh=true` bypasses the in-memory cache for that report key.
- This report endpoint is limited to six requests per minute per signed-in account.

## Agent AI source metadata

- Admins can manage database name, source alias, source ID, source type (`branch` or `central`), and readiness at `/api/v1/sources`. Existing source records without a type are treated as branches; at most one source can be marked `central`.
- `GET /api/v1/agent/status` reports DeepSeek readiness and the source aliases/types visible to the current user.
- `POST /api/v1/agent/chat` accepts up to 12 `{ role, content }` messages and an optional `sessionId`. When a room is supplied, successful user/assistant exchanges are saved to that user's chat history. Configure `DEEPSEEK_API_KEY` in `backend/.env` and restart the backend to enable chat. `DEEPSEEK_MODEL` defaults to `deepseek-flash`; `DEEPSEEK_BASE_URL` defaults to `https://api.deepseek.com`.
- `GET /api/v1/agent/sessions` lists the authenticated user's chat rooms, `POST /api/v1/agent/sessions` creates a new room, and `GET /api/v1/agent/sessions/:sessionId` loads its conversation. Room and message reads are scoped to the authenticated owner.
- Agent tool `analyze_sales_period_report` supports natural-language requests for custom sales periods and runs the same deterministic report aggregation as `/api/v1/sales/report`. It resolves the date range, optionally maps a branch alias to its active `branchId`, and returns per-branch totals plus top Jenis in gram.
- Agent AI chat is limited to 10 requests per minute per signed-in account.
- `POST /api/v1/agent/network-restock` accepts `{}` or `{ "targetMonth": "YYYY-MM" }` and is restricted to `admin` and `pusat` roles. It returns a combined recommendation by Jenis, using a seven-day branch stock buffer, Pusat stock after OPEN shipments, branch surplus, prioritized recipients, proposed transfer routes, and any unfilled needs. It does not execute transfers and is limited to four requests per minute per account.
- `GET /api/v1/settings/cleaning-minimum-stocks` returns saved minimum unit/weight thresholds per Jenis and the available Jenis codes from the active Pusat source. `PATCH` accepts `{ "items": [{ "kodeDept": "CN", "minimumStock": 100, "minimumWeight": 25.5 }] }`; `minimumWeight` is optional for older clients and defaults to 0 (disabled). Both operations are restricted to `admin` and `pusat` roles; settings are shared across accounts.
- Agent tool `suggest_buyback_cleaning_priority` compares each saved unit/weight threshold with Pusat `tm_barang` stock, filtered by `status_hancur=false` and `stock_on_hand>0`, grouped by `kode_dept`. Total stock weight is calculated as `berat × stock_on_hand` per document. For each Jenis below either active threshold, it searches every active branch `tt_beli_detail` for `status_sortir=false`, `status_hancur=false`, and `status_valid != CANC`; one matching document counts as one item. It compares the last 30 days of branch sales with the preceding 30 days using `status_kembali=OPEN`, `status_valid=DONE`, and excluding `status_tukar=true` or `trs_barang_tukar=true`. It also reports branch stock from `tm_barang` filtered to `kode_gudang=TOKO`, `is_consignment_barang=false`, `status_hancur=false`, and `stock_on_hand>0`, plus estimated coverage days as context; these values do not change the center shortage. Eligible buyback weight estimates and the oldest eligible date are included when available. Allocation prioritizes higher-selling Jenis, then branches with more eligible documents, while filling unit and/or weight shortages. This is a read-only washing reminder; it does not transfer inventory or create transactions. Results use a separate in-memory cache namespace and are invalidated when minimum thresholds are saved.
- Combined plans compare branch sales in the selected month with the same month last year, use the higher quantity to calculate daily demand, and require every configured source to be readable. A missing source stops the plan so partial data cannot produce misleading routes. Results use a separate in-memory cache namespace from per-branch month-end restock projections.
- The agent can list collection names, inspect estimated document counts and field types, and run read-only aggregates. Aggregates require a date range no wider than 366 days, cap each source query at six seconds, and never return raw documents. Private-field names such as customer, phone, address, email, and member fields cannot be used for aggregate filters, metrics, or grouping.
- User prompts and aggregate results are sent to DeepSeek. Review data handling requirements before enabling the provider key in production.
- Each tool call resolves sources from active `shipment_sources` records. Branch accounts are restricted in the backend to the branch source whose `branchId` exactly matches the account's branch ID. Database names, MongoDB URI, and provider key are not returned to the frontend or model.
- Shipment reads use only `db_pntspst2.tt_kirim_barang`. Sales summaries exclude sources marked `central`; network restock uses an explicitly marked Pusat source for stock and the configured shipment source for OPEN movements.

## Current limits

- Shipment reads are grouped by `no_kirim`; source unit, weight, and date semantics are not inferred beyond the supplied guide.
- Shipment and receipt monitoring is read-only; there is no endpoint that changes source shipment records.
- Access token revocation is bounded by the access-token lifetime (10 minutes by default).
- The local auth database user needs access to `SYSTEM_DATABASE_NAME`; no connection is attempted against the private replica set during local setup.

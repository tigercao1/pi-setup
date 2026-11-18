---
name: ssms-admin
description: Do SSMS (Snow School Management System, ssms-api at api.ssnow.club) admin work from the command line with Tiger's personal admin API token. Use when asked to look up, change, export or fix instructors, documents, forms, signatures, insurance, payroll, bookings, classes, customers, pages, reference data or any other SSMS admin data. Reads SSMS_API_URL and SSMS_ADMIN_TOKEN from the environment, discovers endpoints from GET /admin/openapi.json, calls them with curl and jq, reads before writing, and asks Tiger before any destructive call.
---

# SSMS admin API

The SSMS admin API is described by an OpenAPI 3 document at `$SSMS_API_URL/admin/openapi.json`. Every admin
endpoint accepts `Authorization: Bearer $SSMS_ADMIN_TOKEN`. The token is a full admin acting as Tiger: treat
every call as if Tiger made it on the admin site. The token works only on admin routes, at most 120 requests a
minute, and seven session-only admin routes refuse it (section 3 shows how to list them).

## 1. Check the environment, never print the token

```sh
[ -n "$SSMS_API_URL" ] && echo "SSMS_API_URL=$SSMS_API_URL" || echo "SSMS_API_URL missing"
case "${SSMS_ADMIN_TOKEN-}" in ssms_pat_*) echo "token set" ;; '') echo "token missing" ;; *) echo "token set (not ssms_pat_)" ;; esac
```

If either is missing, stop and tell Tiger to set them (`export SSMS_API_URL=https://api.ssnow.club` and
`export SSMS_ADMIN_TOKEN=<token>`, token from the admin site's **API tokens** page). Do not ask him to paste the
token into the chat.

Never print, echo, log or write the token anywhere: no `echo $SSMS_ADMIN_TOKEN`, `env`, `printenv`, `set -x`,
`curl -v` or `--trace` (they show the Authorization header), and never put it in a file, a commit or a message.
If it shows up in output by accident, tell Tiger to rotate it.

## 2. Call helper

Define this in each shell command that calls the API. The header goes in through a process substitution, so the
token stays off the command line and out of `ps`. The HTTP status goes to stderr, the body to stdout.

```sh
ssms() {
  local body=()
  [ -n "${3-}" ] && body=(-H 'Content-Type: application/json' --data "$3")
  curl -sS -X "$1" "${SSMS_API_URL%/}$2" \
    -H @<(printf 'Authorization: Bearer %s\n' "$SSMS_ADMIN_TOKEN") \
    -H 'Accept: application/json' "${body[@]}" \
    -w '%{stderr}HTTP %{http_code}\n'
}
```

Usage: `ssms GET '/admin/instructors?limit=50' | jq .`, `ssms PATCH /admin/instructors/<id>/display-order '{"displayOrder":3}'`. It works in bash and zsh.

## 3. Fetch the spec and find the endpoint for the task

```sh
spec="${TMPDIR:-/tmp}/ssms-admin-openapi.json"
ssms GET /admin/openapi.json > "$spec"
jq -r '.paths | to_entries[] | .key as $p | .value | to_entries[]
  | "\(.key | ascii_upcase) \($p)  \(.value.operationId)"' "$spec" | grep -i '<keyword>'
```

Fetch it once per session. Operations with `"x-session-only": true` refuse the token with 403; list them with:

```sh
jq -r '.paths | to_entries[] | .key as $p | .value | to_entries[] | select(.value."x-session-only")
  | "\(.key | ascii_upcase) \($p)"' "$spec"
```

They are creating, listing, rotating and revoking API tokens (a token cannot mint or extend tokens), changing a
user's role (`PATCH /admin/users/{id}/role`), changing an instructor's sign-in email
(`PATCH /admin/instructors/{id}/email`) and connecting the Google calendar (`GET /admin/google/connect`). Do not
call them; tell Tiger to do it on the admin site.

Then read the operation before calling it: path and query parameters, and the request
body schema.

```sh
jq '.paths["/admin/instructors/{id}/approval"].patch' "$spec"
jq '.components.schemas.UpdateApprovalStatusDto' "$spec"
```

Bodies are validated strictly: unknown properties are rejected with 400, so send only the fields in the schema.
The spec has no response schemas; make the GET and look at the JSON.

## 4. Read before writing

- Before any write, GET the current state of what will change and show Tiger the relevant fields.
- Change the fewest fields that do the job. Prefer one targeted PATCH over a bulk endpoint.
- After the write, GET again and confirm the change took.
- To change several instructors at once (reordering with `displayOrder`, profile fields, `isActive`,
  `approvalStatus`), use `PATCH /admin/instructors` with `{ "updates": [{ "id": ..., ...fields }] }`, up to 100
  rows, of which at most 25 may set `approvalStatus` or `isActive` (more is a 400; split into batches). Send it
  with `"dryRun": true` first and show Tiger the per-row `changes`; add `"atomic": true` when it must be all or
  nothing. Each row reports `updated`, `unchanged` or `failed`; it never changes `email` or roles.
  Approvals, rejections and deactivations in it still send their emails, so section 5 applies.
- List endpoints are paged (`page`, `limit`, and an `X-Total-Count` header). Read every page before saying "all".
- Exports can contain personal data (names, emails, dates of birth). Keep them out of chat and delete local copies
  when done unless Tiger asks to keep them.

## 5. Ask Tiger before destructive calls

Stop and ask, showing the exact method, path, body and what it affects (names and counts), before any call that:

- deletes anything (`DELETE`), archives, voids or marks unpaid;
- deactivates, rejects or otherwise removes access for an instructor or user;
- sends email or reminders to more than one person, or starts any bulk job;
- publishes, unpublishes or goes live with anything public (pages, templates, forms, instructors on Shopify);
- changes roles, money (payroll, insurance, pay rates) or many records at once.

Wait for an explicit yes for that call. A yes covers that call only, not similar later ones.

## 6. Errors

| Status | What it means | What to do |
| --- | --- | --- |
| 400 | The body or query does not match the schema. | Read `message`, fix the request. |
| 401 | Token missing, unknown, revoked or expired, past its rotation grace period, or its owner is no longer an active admin. | Tell Tiger; he creates or rotates a token on the admin site. Do not retry. |
| 403 | The route is session-only (`x-session-only` in the spec: token management, role change, instructor email change, Google connect), or the route is not an admin route. | Tell Tiger it needs the admin site, signed in. Do not look for a workaround. |
| 404 | The id does not exist. | Re-check the id with a GET. |
| 429 | More than 120 requests a minute with this token. | Wait about a minute, then go on more slowly. Batch reads with `limit`. |
| 503 | The token or its owner could not be checked. | Retry once after a short wait, then tell Tiger. |

## 7. Rotating or revoking the token

On the admin site (`https://app.ssnow.club`, admin area), **API tokens**: **Rotate** gives a new secret once, and
the old one stops after the grace period chosen (default 10 minutes); **Revoke** stops it at once. Token management
is session-only, so this skill cannot rotate its own token. Tell Tiger to rotate whenever the secret may have been
exposed. API reference: `docs/ai-admin.md` in the ssms-api repo.

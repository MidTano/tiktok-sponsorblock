# Server

A Cloudflare Worker ([`src/index.ts`](src/index.ts)) with a D1 database for segments, votes and
counters and an R2 bucket for the daily snapshot. It fits the Workers free plan: phones read a
cached snapshot once a day and write rarely.

## Running your own

1. `npm install`, then `npx wrangler login`.
2. Create the database and bucket:
   ```sh
   npx wrangler d1 create <db-name>
   npx wrangler r2 bucket create <bucket-name>
   ```
3. In [`wrangler.jsonc`](wrangler.jsonc) set `name` (it becomes the `workers.dev` host),
   `account_id`, `database_name`, `database_id` and `bucket_name`. The rate-limit
   `namespace_id` values only need to be unique within your account.
4. Apply the migrations, in order:
   ```sh
   npx wrangler d1 migrations apply <db-name> --remote
   ```
5. Set the two secrets, random values nobody else knows:
   ```sh
   node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put IP_SALT
   node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put USER_SECRET
   ```
   `IP_SALT` keys the network hashes; changing it only resets the daily counters and per-network vote checks.
   `USER_SECRET` keys the account hashes; changing it makes every account new.
6. `npx wrangler deploy`.

For local development, `npx wrangler dev` with a `.dev.vars` file holding `IP_SALT=...`, and the
migrations applied with `--local`.

## Limits

| What | Limit |
| --- | --- |
| Submissions | 5 a minute per address, 20 a day per account, 60 a day per address, 300 a day across the base |
| Votes | 30 a minute per address, 300 a day per account, 600 a day per address |
| Downloads | 60 a minute per address |
| Skip reports | 2 a day per account |
| A segment | 1 to 30 s, 40 to 6,000 hashes |

Per-minute limits use Workers rate-limit bindings, which only take 10 or 60 second windows;
daily limits are counted in D1.

## Moderation

[`scripts/admin.mjs`](scripts/admin.mjs) runs SQL through Wrangler, so whoever is logged in to
the Cloudflare account that owns the Worker is the admin. There is no admin route on the
Worker to attack.

```sh
node scripts/admin.mjs list [--hidden]     # newest 50 segments
node scripts/admin.mjs show 12             # ad12 and its votes
node scripts/admin.mjs hide 12             # off every phone at the next sync
node scripts/admin.mjs unhide 12
node scripts/admin.mjs ban 12 "spam"       # ban whoever sent ad12, hide all they sent
node scripts/admin.mjs unban 12
node scripts/admin.mjs export-user 12     # everything the sender of ad12 added, as JSON
node scripts/admin.mjs delete-user 12
node scripts/admin.mjs stats
```

Edit `DATABASE` and `BUCKET` at the top of the script for your own instance.

## Free plan headroom

Workers free: 100,000 requests a day. D1 free: 5 million rows read and 100,000 written a day,
5 GB stored. R2 free: 10 GB stored, egress free. One phone makes about three requests a day,
so the public instance serves tens of thousands of daily users before it needs the paid plan.

# Save Jensen

[Website](https://savejensen.ai/) · [中文](README.zh-CN.md) · [Give back](https://savejensen.ai/#give)

An open-source supporters community for Jensen Huang and the people building AI. A public-benefit project with a source-linked timeline, a content library, repeatable cheers, moderated stories, an open letter and a Discord community.

## Run locally

Requires Python 3 and Node.js 24 or newer. No account or external database is needed for the local preview.

```sh
python3 build.py
cd server
npm ci
npm test
npm run dev
```

Open `http://localhost:8787/`. English is the default; Chinese is at `/zh/`. Legacy `/en/` and `?lang=en|zh` links redirect to their canonical home. There is no browser-language redirect. The local server binds to loopback and uses disposable in-memory SQLite; restarting clears its data. Its development-only moderation token is `local-admin` (override with `ADMIN_TOKEN`). Never use this token in production. Local preview is not a production web server.

The build emits only `server/public/`, including prerendered HTML, metadata, JSON-LD, sitemap and credited images. It requires no platform-specific image tools and never writes outside this repository.

## Deploy your own instance

1. From `server/`, copy `wrangler.example.jsonc` to `wrangler.jsonc` (git-ignored). Choose your own Worker name.
2. Sign in with `npx wrangler login`, then create your own database with `npx wrangler d1 create YOUR_DATABASE_NAME`. Put its name and ID in the `DB` binding in your private config.
3. Set distinct, strong production secrets with `npx wrangler secret put ADMIN_TOKEN` and `npx wrangler secret put RATE_SALT`. Do not put secret values in files committed to Git.
4. Run `npm run migrate:remote` to apply the migrations to your own configured database.
5. Before publishing a fork, replace the site URL in `build.py` and `src/template.html` (`SJ_CONFIG`), hostname constants in `server/src/worker.js`, and relevant SEO test expectations. Set your own contact details, community links and campaign content. The already-sent letter is a historical record of the original project, not an email sent by your fork.
6. Build with `npm run build`, run `npm test`, then `npm run deploy`. The example enables your own workers.dev endpoint; custom domains can be added following [Cloudflare's configuration documentation](https://developers.cloudflare.com/workers/wrangler/configuration/). Configure canonical host redirects for your domains.

Do not point a fork at the live Save Jensen database. No live data, credentials, account IDs, database IDs, sender contact details or deployment receipts are included.

For an existing deployment, apply migration `0004_super_boost.sql` before deploying the new Worker. It preserves prior energy, device epochs and retry keys while raising the energy batch limit. Share batches remain capped at 50.

## Giving back

We link directly to official [NumFOCUS](https://numfocus.org/donate), [scikit-learn](https://numfocus.org/donate-to-scikit-learn) and [NumPy](https://numfocus.org/donate-to-numpy) donation pages. The latter two are project-specific pages operated by NumFOCUS. Save Jensen receives no donations or commissions and does not process payments. There are no donation totals to report. These links do not imply those organizations endorse or are affiliated with this campaign. Recipient terms and processing arrangements apply on their sites.

Save Jensen is a community project, not a registered charity. Its public-benefit purpose does not restrict the MIT software license.

## Interaction and privacy

- Support energy counts repeated user actions, including explicit +10 cheers and +1,000 boosts. It is not a count of people or signatures.
- Sharing counts button presses, not completed posts, impressions or unique people.
- Messages and optional avatars enter moderation before public display; authors can withdraw them using the same device credential. Without that credential, self-service withdrawal is unavailable.
- An HttpOnly device cookie authorizes device actions. The backend stores credential hashes and short-lived salted IP hashes for abuse prevention. It does not store raw IP addresses in the application database. Infrastructure providers may maintain their own logs.
- User content and production state are not part of this source release. Email subscriptions, account login and a formal petition are not implemented.
- The third-party market widget is display-only. Cheers do not affect stock prices.

## Structure

- `src/template.html`: Chinese text with English translations; `src/data.json`: curated content and the historical open letter.
- `src/app.js`, `src/site.css`: progressive enhancement, interaction and styling.
- `server/src/worker.js`: Cloudflare Worker, redirects, D1 API and moderation.
- `server/migrations/`: schema only; `server/test/`: isolated tests using in-memory SQLite.
- `build.py`: portable, dependency-free static build.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License and media

Project code is [MIT licensed](LICENSE). Third-party photographs are **not** covered by MIT: see [IMAGE-CREDITS.md](IMAGE-CREDITS.md) for each creator, source, CC0/CC BY/CC BY-SA license and modifications. Preserve these notices when reusing images. Names, trademarks and likenesses are not licensed by the project's software license.

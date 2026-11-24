# Contributing

Thanks for helping. Bug reports, bad-segment reports, documentation fixes and code are all
welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so the approach can be agreed
  before you spend time on it.
- Changes to the fingerprint parameters, the hash layout or the snapshot format break every
  phone's matches. They need a new snapshot version and a migration plan, and are discussed in
  an issue first.
- Changes to what the server stores or what phones send must update
  [docs/privacy.md](docs/privacy.md) in the same pull request.

## Code

- **core/**: Java 11, no dependencies, no Android classes. Every behaviour change comes with a
  test in `core/src/test`. Run `./gradlew :core:build`.
- **server/**: TypeScript for Cloudflare Workers, strict mode. Run `npm run typecheck`. A schema
  change is a new numbered file in `migrations/`; never edit one that was already applied.
- Match the surrounding style. Comments explain why, in full sentences, not what the next line
  does. No commented-out code, debug logging or unrelated reformatting.
- LF line endings, UTF-8.

## Pull requests

- One topic per pull request, with a description of what changed and how you checked it.
- CI must pass.
- By contributing you agree your work is licensed under GPL-3.0, like the rest of the project.
  Keep the notice at the top of every source file.

## Reporting a bad segment

Use the **Bad segment** issue form with the segment's number (the N in adN shown on the phone)
and the TikTok link of a video where it skipped the wrong thing. Down-voting it on the phone
also works: enough down-votes hide it for everyone.

## Conduct

Be kind and assume good faith. Harassment, spam and personal attacks get you blocked.

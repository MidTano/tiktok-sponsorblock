# Security policy

Report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this
repository. Do not open a public issue for them.

In scope: the server (anything that lets someone bypass limits or votes at scale, read stored
data, hide segments they did not vote on, or crash the Worker) and the core library (input
that crashes or hangs a phone when parsing a snapshot or matching).

Expect an answer within a week. Fixes to the public instance are deployed before the details
are published.

The account id in `X-TT-UID` is a claim the server cannot verify; that is a known limit, and
the per-address limits and votes exist because of it. Reports that only restate it are not
vulnerabilities, but ways to get around the per-address checks are.

Requests to delete your data from the public base can be sent the same way.

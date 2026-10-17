# Security and private data

Keep credentials, local connection leases, ledgers, approval journals and conversation contents on your own computer. Do not attach them to public issues. Prefer counts and fixed diagnostic labels over raw logs.

The bridge runs with the current Windows user's local privileges. Its loopback transports are for a trusted local machine; do not expose them to a LAN or the internet. Use your own Feishu application and restrict its membership and owner configuration.

If a submission or receipt is uncertain, pause and reconcile with the original conversation. Do not delete the ledger, replay a request, bypass an integrity check or disable security software to make startup succeed.

For a suspected credential leak, revoke/rotate the credential in its issuing service before reporting a redacted issue. Do not post the credential as proof. Historical code provenance and the MIT license are retained; private deployment artifacts are excluded from releases.

## Public contributions

Use your account's GitHub-provided noreply address for new public commits if you want to keep your personal email private. Changing the local commit address does not remove addresses already recorded in published history.

Use synthetic identities in examples and fixtures. Keep raw field-validation timelines, native conversation identifiers, private audit reports and exported project conversation records outside the public tree. Public validation summaries should describe the tested behavior and its limits without reproducing personal runtime data.

Repository secret scanning and push protection are enabled to help catch supported credential types. They complement review and do not establish that arbitrary text or logs contain no private information.

# Security and private data

Keep credentials, local connection leases, ledgers, approval journals and conversation contents on your own computer. Do not attach them to public issues. Prefer counts and fixed diagnostic labels over raw logs.

The bridge runs with the current Windows user's local privileges. Its loopback transports are for a trusted local machine; do not expose them to a LAN or the internet. Use your own Feishu application and restrict its membership and owner configuration.

If a submission or receipt is uncertain, pause and reconcile with the original conversation. Do not delete the ledger, replay a request, bypass an integrity check or disable security software to make startup succeed.

For a suspected credential leak, revoke/rotate the credential in its issuing service before reporting a redacted issue. Do not post the credential as proof. Historical code provenance and the MIT license are retained; private deployment artifacts are excluded from releases.

# Support

survey-cli is experimental and solo-maintained. There is no guaranteed
response time.

Before filing an issue, run:

```bash
survey doctor          # credentials, survey home, local tools
survey capabilities    # what this install can do, per command
```

Use GitHub issues for reproducible bugs and scoped proposals. Include
`survey --version`, the OS, the exact command and JSON payload, and the full
failure envelope from stderr with secrets removed.

Provider outages, quota limits, and provider account problems belong with the
provider. A failure envelope with `details.retryable: true` usually means
rerunning later will work.

Report suspected vulnerabilities through `SECURITY.md`, not public issues.

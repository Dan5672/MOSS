Put the certificate (PEM) of the authority that signs your devices' certificates here as `ca.pem`, for
Settings → Safety → "Require trusted certificates" (see docs/hardening.md). Only the certificate, never its key.
The toolbox trusts it on top of the public authorities; restart MOSS after adding it.

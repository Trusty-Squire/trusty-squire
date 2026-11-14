# No systemd. The default process is docs/container-broker/entrypoint.sh:
# it prepares a fixture session and idles. It does not start a broker.
# The first mcp server tool call starts one on demand.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
    procps \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/* \
  && if command -v systemctl >/dev/null 2>&1 || command -v systemd >/dev/null 2>&1; then \
       echo "real systemd leaked into the base image" >&2; \
       exit 1; \
     fi

WORKDIR /opt/squire

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    HOME=/root \
    TRUSTY_SQUIRE_PROFILE_DIR=/root/.trusty-squire/chrome-profile \
    TRUSTY_SQUIRE_AGENT_IDENTITY=container-broker-test

# Local mcp install, prepared by verify.sh (pnpm deploy).
COPY squire/ /opt/squire/
RUN if [ -f /opt/squire/node_modules/better-sqlite3/package.json ]; then \
      npm rebuild better-sqlite3 --foreground-scripts || true; \
    fi \
  && if command -v systemctl >/dev/null 2>&1 || command -v systemd >/dev/null 2>&1; then \
       echo "install pulled systemd" >&2; \
       exit 1; \
     fi

# Records the call and exits 1. Not a service manager and not a broker launcher.
COPY systemctl /usr/local/bin/systemctl
COPY entrypoint.sh /opt/squire/entrypoint.sh
COPY vault-stub.py /opt/squire/vault-stub.py
COPY client.mjs /opt/squire/client.mjs
RUN chmod 755 /usr/local/bin/systemctl /opt/squire/entrypoint.sh /opt/squire/vault-stub.py \
  && mkdir -p /var/log \
  && : > /var/log/systemctl-calls.log

ENTRYPOINT ["/opt/squire/entrypoint.sh"]

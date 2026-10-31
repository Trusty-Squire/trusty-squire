# No systemd. The default process is docs/container-broker/entrypoint.sh:
# it runs the broker the unit would run, then exits with that process's status.
# It does not restart the broker. docker run --restart=on-failure does.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
    xvfb \
    procps \
    lsof \
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

RUN npm install --omit=dev --no-audit --no-fund @trusty-squire/mcp@1.1.39 \
  && node -e "const v=require('./node_modules/@trusty-squire/mcp/package.json').version; if(v!=='1.1.39'){console.error(v); process.exit(1)}" \
  && ./node_modules/.bin/playwright install-deps chromium \
  && ./node_modules/.bin/patchright install chromium \
  && ./node_modules/.bin/playwright install chromium \
  && if command -v systemctl >/dev/null 2>&1 || command -v systemd >/dev/null 2>&1; then \
       echo "playwright install-deps pulled systemd" >&2; \
       exit 1; \
     fi

# Records the call and exits 1. Not a service manager and not a broker launcher.
COPY systemctl /usr/local/bin/systemctl
COPY entrypoint.sh /opt/squire/entrypoint.sh
COPY client.mjs /opt/squire/client.mjs
RUN chmod 755 /usr/local/bin/systemctl /opt/squire/entrypoint.sh \
  && mkdir -p /var/log \
  && : > /var/log/systemctl-calls.log

ENTRYPOINT ["/opt/squire/entrypoint.sh"]

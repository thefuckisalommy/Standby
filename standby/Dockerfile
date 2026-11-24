# Standby — single-container Node 24 app
# The base image is pinned by digest (the multi-arch index), so a
# rebuild of the same commit gets the same base. Dependabot
# (.github/dependabot.yml) proposes digest updates as pull requests.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

WORKDIR /app

COPY package.json ./
# Zero runtime dependencies — no `npm install` step needed.
COPY server.js ./
COPY lib ./lib
COPY public ./public
# The check-in receiver shares this image (same build, no second
# image): docker-compose runs it as a second service with a different
# command — `node checkin-receiver/server.js` — on LAN port 3101.
COPY checkin-receiver ./checkin-receiver

# Run as the image's unprivileged `node` user (UID/GID
# 1000), not root — on every install path, Umbrel included. The
# mount points are created owned by it, so an empty named volume
# starts writable; a bind-mounted host directory must be owned by
# UID 1000 (the Umbrel pre-start hook does that; the generic README
# says how). The app checks at startup and exits with the fix if a
# directory is not writable.
RUN mkdir -p /data /checkin && chown node:node /data /checkin

ENV PORT=3100
ENV DATA_DIR=/data
# The generic Docker install. The Umbrel compose overrides this to
# `umbrel`; a `node server.js` run outside Docker is `bare`.
ENV STANDBY_DEPLOYMENT=docker

USER node

EXPOSE 3100

CMD ["node", "server.js"]

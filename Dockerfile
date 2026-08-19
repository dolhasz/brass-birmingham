# Zero runtime dependencies — the whole service is stdlib Node, so there is no
# install step and no lockfile to reconcile.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

# Run unprivileged; the node image ships a `node` user for exactly this.
USER node

CMD ["node", "server/index.js"]

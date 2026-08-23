# One real dependency now: `pg` (Postgres driver) — needs an install step.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# Railway (and most PaaS hosts) inject their own PORT at runtime and the
# app already reads process.env.PORT (see src/server.js) — this default
# only applies when nothing overrides it (e.g. plain `docker run`).
ENV PORT=4000
EXPOSE 4000
CMD ["node", "src/server.js"]

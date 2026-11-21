# One real dependency now: `pg` (Postgres driver) — needs an install step.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
# The router setup script is served by /api/setup/<code>.rsc
COPY router-scripts ./router-scripts
ENV PORT=4000
EXPOSE 4000
CMD ["node", "src/server.js"]

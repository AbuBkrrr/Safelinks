# Multi-stage: build the static Vite bundle, then serve it with nginx.
# nginx also proxies /api/* to the backend container so the browser only
# ever talks to one origin (avoids CORS entirely in production).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# nginx:alpine's own entrypoint (docker-entrypoint.d/20-envsubst-on-templates.sh)
# runs automatically at container start: it envsubst's every file in
# /etc/nginx/templates/*.template into /etc/nginx/conf.d/, substituting
# only real OS environment variables — so nginx's own $host/$uri/$scheme
# variables in the config are left untouched, and only ${PORT} resolves.
# This lets the same image listen on 80 (docker-compose/VPS default)
# or on whatever dynamic port Railway assigns.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV PORT=80
EXPOSE 80

# Multi-stage: build the static Vite bundle, then serve it with nginx.
# nginx also proxies /api/* to the backend container so the browser only
# ever talks to one origin (avoids CORS entirely in production) — that
# proxy only matters when frontend and backend share one domain (the
# Caddy/VPS path). On Railway (frontend and backend on separate
# generated domains), VITE_API_URL below is what the browser actually
# uses instead, and this proxy config effectively does nothing.
FROM node:22-alpine AS build
WORKDIR /app
# Railway (and Docker generally) does NOT expose configured service
# Variables inside a build automatically — a Dockerfile build only sees
# a Variable if it's explicitly declared here with ARG. Without this,
# VITE_API_URL would silently be empty during `npm run build`, Vite
# would bake in "" (same-origin), and the deployed frontend would try
# to call itself instead of the real backend service.
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

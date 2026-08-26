# Multi-stage: build the static Vite bundle, then serve it with nginx.
# nginx also proxies /api/* to the backend container so the browser only
# ever talks to one origin (avoids CORS entirely in production) — that
# proxy only matters when frontend and backend share one domain (the
# Caddy/VPS path). On Railway (frontend and backend on separate
# generated domains), VITE_API_URL below is what the browser actually
# uses instead, and this proxy config effectively does nothing.
FROM node:22-alpine AS build
WORKDIR /app

# Railway build-time variable for API URL
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

COPY package.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# ✅ FIX: Use the PORT environment variable from Railway
# Railway sets PORT (e.g., 3600), so we listen on that port
ENV PORT 3600
RUN sed -i "s/listen 80;/listen $PORT;/g" /etc/nginx/conf.d/default.conf

# ✅ EXPOSE $PORT instead of hardcoded 80
EXPOSE $PORT

CMD ["nginx", "-g", "daemon off;"]
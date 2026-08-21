# Multi-stage: build the static Vite bundle, then serve it with nginx.
# nginx also proxies /api/* to the backend container so the browser only
# ever talks to one origin (avoids CORS entirely in production).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

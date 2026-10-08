# Multi-stage: build the static Vite bundle, then serve with nginx.
FROM node:22-alpine AS build
WORKDIR /app

# Build-time variables. MUST be declared as ARG for Railway to pass them in.
ARG VITE_API_URL
ARG VITE_GOOGLE_CLIENT_ID
ARG CACHEBUST=4

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

# Copy deps first (cache-friendly)
COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

# Copy source
COPY . .

# CACHEBUST invalidates this layer whenever we change its value.
RUN echo "Cachebust: $CACHEBUST" && npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

ENV PORT 3600
RUN sed -i "s/listen 80;/listen $PORT;/g" /etc/nginx/conf.d/default.conf
EXPOSE $PORT
CMD ["nginx", "-g", "daemon off;"]
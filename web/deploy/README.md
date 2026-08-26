# Alternative: your own nginx + certbot instead of Caddy

The root `docker-compose.yml` uses Caddy because it gets and renews a
TLS certificate with zero manual steps. If you already run your own
nginx on the VPS (e.g. it's also hosting other sites), do this instead:

1. Remove the `caddy` service from `docker-compose.yml` and change
   `frontend`'s `expose: ["80"]` to `ports: ["127.0.0.1:8080:80"]` so
   it's reachable only from localhost.
2. Point your host nginx at it:

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

3. Get a certificate and let certbot rewrite the config for HTTPS:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

4. `docker compose up -d --build` to start backend + frontend, then
   reload your host nginx (`sudo nginx -s reload`).

Everything else (env vars, first-run behavior, demo logins) is the
same either way — see the root README.

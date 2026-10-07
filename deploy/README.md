# Deploying the TMWB frontend overlay

The public Lab runs the stock upstream Velxio image with this fork's built frontend layered on top. `Dockerfile.tmwb-embed` in this folder defines that overlay. The base image is pinned by digest so the backend never changes unless you change it on purpose.

## Build and ship a new frontend

From the repo root:

```bash
cd frontend && npm run build:docker          # produces frontend/dist
tar czf /tmp/velxio-frontend-dist.tar.gz -C dist .
scp -i ~/.ssh/oracle-velxio.key /tmp/velxio-frontend-dist.tar.gz ubuntu@<server>:/home/ubuntu/
```

On the server:

```bash
cd ~ && rm -rf frontend-dist && mkdir frontend-dist
tar xzf velxio-frontend-dist.tar.gz -C frontend-dist
cp <this repo>/deploy/Dockerfile.tmwb-embed ~/Dockerfile.tmwb-embed   # first time, or after the pin changes
docker build -f Dockerfile.tmwb-embed -t velxio:tmwb-embed .          # no --pull: keep the pinned base
docker stop velxio && docker rm velxio
docker run -d --name velxio --restart unless-stopped -p 127.0.0.1:3080:80 \
  -v velxio-data:/app/data \
  -v velxio-arduino-libs:/root/.arduino15 \
  -v velxio-arduino-user-libs:/root/Arduino \
  -v velxio-ccache:/var/cache/ccache \
  -v velxio-build:/var/lib/velxio-build \
  velxio:tmwb-embed
```

The five named volumes and their paths above match the container as deployed on 2026-10-07 (confirmed with `docker inspect velxio`). Reusing the same volume names keeps saved data and the compile and library caches across redeploys. The upstream image's own environment variables apply automatically, so no `-e` flags are needed.

## Updating the upstream base on purpose

1. Merge upstream into this fork and test locally.
2. Pull the new image once and read its digest: `docker pull ghcr.io/davidmonterocrespo24/velxio:master && docker images --digests ghcr.io/davidmonterocrespo24/velxio`.
3. Replace the `sha256:` in `Dockerfile.tmwb-embed`, commit it, then rebuild as above.

Do not use `docker build --pull` with this Dockerfile unless you intend to move the pin.

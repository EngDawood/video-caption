# Build context is the project root so we can pull in ./public and ./container.

# ---- stage 1: get every font in ./public into a format libass can load ----
# .otf/.ttf pass straight through; .woff2 is a web-only container and has to be
# decompressed first, otherwise fontconfig simply will not see it.
FROM alpine:3.20 AS fontprep
RUN apk add --no-cache python3 py3-pip \
 && pip3 install --break-system-packages --no-cache-dir fonttools brotli
WORKDIR /work
COPY public/ /work/in/
RUN mkdir -p /out \
 && find /work/in -type f \( -name '*.ttf' -o -name '*.otf' \) -exec cp {} /out/ \; \
 && find /work/in -type f -name '*.woff2' | while read -r f; do \
      base=$(basename "$f" .woff2); \
      base=${base%.*}; \
      echo "converting $f -> /out/${base}.ttf"; \
      fonttools ttLib.woff2 decompress -o "/out/${base}.ttf" "$f"; \
    done \
 && ls -la /out

# ---- stage 2: the actual ffmpeg service ----
FROM alpine:3.20
RUN apk add --no-cache nodejs ffmpeg fontconfig ttf-dejavu \
 && (apk add --no-cache font-noto-arabic || apk add --no-cache font-noto || true)

# Custom fonts + rebuild the fontconfig cache so libass resolves them by family name.
COPY --from=fontprep /out/ /usr/share/fonts/custom/
RUN fc-cache -fv && fc-list : family | sort -u

WORKDIR /app
COPY container/server.js /app/server.js

ENV PORT=8080 \
    JOBS_DIR=/tmp/jobs \
    FONTS_DIR=/usr/share/fonts/custom
EXPOSE 8080
CMD ["node", "/app/server.js"]

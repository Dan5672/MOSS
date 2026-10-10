# MOSS's backup service: Postgres 17's client tools (matching the database) and Node to run
# deploy/backup/moss-backup.mjs. Build context: repo root.
FROM postgres:17-alpine
RUN apk add --no-cache nodejs openssl tar
# The release and commit this image was built from (set by deploy/upgrade.sh), written into each backup's
# manifest so restore.sh --checkout can go back to the right code.
ARG MOSS_RELEASE=dev
ARG MOSS_COMMIT=unknown
ENV MOSS_RELEASE=$MOSS_RELEASE MOSS_COMMIT=$MOSS_COMMIT
COPY deploy/backup/moss-backup.mjs /app/moss-backup.mjs
EXPOSE 7090
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:7090/health >/dev/null || exit 1
ENTRYPOINT []
CMD ["node", "/app/moss-backup.mjs"]

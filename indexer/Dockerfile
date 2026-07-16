# Multi-stage build for the CLOB indexer.
# The crate uses rustls (no OpenSSL) and runtime sqlx::query (no compile-time
# DATABASE_URL), so the build needs no native TLS libs and no database.
FROM rust:1-bookworm AS build
WORKDIR /app

# Cache deps: build against a stub main, then swap in the real sources.
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && \
    cargo build --release && rm -rf src

COPY src ./src
COPY migrations ./migrations
# Touch so cargo rebuilds against the real main.rs, not the cached stub.
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim AS runtime
# CA certificates for TLS to the devnet RPC and Postgres.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/clob-indexer /usr/local/bin/clob-indexer
# Migrations are embedded at compile time via sqlx::migrate!; this copy is
# only for reference/debugging inside the image.
COPY migrations ./migrations
ENV LISTEN_ADDR=0.0.0.0:8080
EXPOSE 8080
CMD ["clob-indexer"]

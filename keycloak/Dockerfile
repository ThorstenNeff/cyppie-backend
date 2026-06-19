# Custom Keycloak image for Cyppie (ADR-0026 / KAN-137) — bakes the SIWE Authenticator-SPI provider in
# and runs `kc build` so it starts in optimized/production mode.
#
# ⚠️ VERIFY-ON-MAC-MINI DRAFT: this image build (`kc build`), the provider classloader behaviour, and the
# final BouncyCastle/Jackson dedup vs Keycloak's bundled libs are NOT verified yet (no container engine in
# the dev env — see ../README/HARDENING). The SIWE crypto path itself IS unit-tested (siwe-provider tests).

# ── Stage 1: build the provider thin JAR + collect its (pruned) runtime libs ──
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY siwe-provider/ ./siwe-provider/
RUN cd siwe-provider && ./gradlew --no-daemon build copyProviderLibs

# ── Stage 2: bake into Keycloak + kc build ──
# Pin the same patch the provider compiles against (siwe-provider/build.gradle.kts keycloakVersion).
FROM quay.io/keycloak/keycloak:26.1.0 AS kc

# The SIWE provider + its runtime deps go into Keycloak's provider classloader directory.
# NOTE (block 2b, needs live verify): the collected libs still include bcprov/jackson that overlap
# Keycloak's bundled versions — confirm there's no classloader conflict on the Mac Mini and drop the
# duplicates (exclude in build.gradle) once verified.
COPY --from=build /src/siwe-provider/build/libs/siwe-provider-*.jar /opt/keycloak/providers/
COPY --from=build /src/siwe-provider/build/providers-libs/*.jar      /opt/keycloak/providers/

# Augment the server with the provider (required before `start --optimized`).
RUN /opt/keycloak/bin/kc.sh build

# Runtime config (DB, hostname, proxy, import) is supplied by docker-compose.

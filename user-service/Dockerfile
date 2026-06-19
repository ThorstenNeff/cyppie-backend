# Multi-stage build for the Cyppie User-Service (PRD-08). Fat jar via the Ktor Gradle plugin, run on a
# slim JRE as a non-root user. Built by docker-compose (`build: ./user-service`).

# ── Build ──
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY . .
RUN ./gradlew --no-daemon --no-configuration-cache buildFatJar

# ── Run ──
FROM eclipse-temurin:21-jre AS run
WORKDIR /app
COPY --from=build /src/build/libs/user-service-all.jar app.jar
EXPOSE 8081
# Non-root (least-privilege, NFR-1).
USER 1000:1000
ENTRYPOINT ["java", "-jar", "/app/app.jar"]

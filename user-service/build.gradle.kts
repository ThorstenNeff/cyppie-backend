// Cyppie User-Service — PRD-08 (ADR-0023). Plain Kotlin/JVM Ktor (Netty), mirroring the Cyppie `:server`
// stack for one consistent toolchain: Kotlin 2.4.0, Ktor 3.5.0, logback 1.5.34. Standalone Gradle build
// (its own repo, ./Backend) — no version catalog. The Ktor Gradle plugin provides buildFatJar/run.

plugins {
    kotlin("jvm") version "2.4.0"
    kotlin("plugin.serialization") version "2.4.0"
    id("io.ktor.plugin") version "3.5.0"
}

group = "com.tneff.cyppie.backend"
version = "0.1.0"

application {
    mainClass = "com.tneff.cyppie.backend.user.ApplicationKt"
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("io.ktor:ktor-server-core-jvm:3.5.0")
    implementation("io.ktor:ktor-server-netty-jvm:3.5.0")
    implementation("io.ktor:ktor-server-content-negotiation-jvm:3.5.0")
    implementation("io.ktor:ktor-serialization-kotlinx-json-jvm:3.5.0")
    implementation("io.ktor:ktor-server-status-pages-jvm:3.5.0")
    implementation("io.ktor:ktor-server-call-logging-jvm:3.5.0")
    // JWT validation against the Keycloak realm JWKS (RS256) — gates /v1 (ADR-0026 / KAN-137 block 3).
    implementation("io.ktor:ktor-server-auth-jvm:3.5.0")
    implementation("io.ktor:ktor-server-auth-jwt-jvm:3.5.0")
    // Loopback client to the aa-trigger Node service (KAN-163 DCA build/submit) — CIO engine + JSON.
    implementation("io.ktor:ktor-client-core-jvm:3.5.0")
    implementation("io.ktor:ktor-client-cio-jvm:3.5.0")
    implementation("io.ktor:ktor-client-content-negotiation-jvm:3.5.0")
    // Postgres profile persistence (PRD-08 §3): HikariCP pool + JDBC driver (migrations run via a small
    // packaging-robust runner in Db.kt — Flyway's scanner mis-reads resources inside the shadow/fat jar).
    implementation("com.zaxxer:HikariCP:6.2.1")
    implementation("org.postgresql:postgresql:42.7.4")
    implementation("ch.qos.logback:logback-classic:1.5.34")

    testImplementation("io.ktor:ktor-server-test-host-jvm:3.5.0")
    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(21)
}

tasks.test {
    useJUnitPlatform()
    testLogging { showStandardStreams = true } // surface e2e harness banners (DcaOrchestrationE2eTest)
}

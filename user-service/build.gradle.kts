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
    implementation("ch.qos.logback:logback-classic:1.5.34")

    testImplementation("io.ktor:ktor-server-test-host-jvm:3.5.0")
    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(21)
}

tasks.test {
    useJUnitPlatform()
}

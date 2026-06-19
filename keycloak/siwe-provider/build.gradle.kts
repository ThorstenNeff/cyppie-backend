// Cyppie SIWE Keycloak provider (ADR-0026 / KAN-137). A Keycloak Authenticator-SPI that authenticates
// a user via a Sign-In-With-Ethereum (EIP-4361) message + signature, delegating cryptographic
// verification to `com.moonstoneid:siwe-java`. Built as a thin provider JAR; its runtime dependencies
// (siwe-java + transitives) are collected separately and dropped into Keycloak's `providers/` dir
// alongside it (avoids shading BouncyCastle into Keycloak's classloader).
//
// Plain Java (no Kotlin) — a Keycloak provider runs inside Keycloak's JVM/classloader; keeping it pure
// Java avoids shipping the Kotlin stdlib into the server.

plugins {
    java
}

group = "com.tneff.cyppie.backend.keycloak"
version = "0.1.0"

java {
    toolchain { languageVersion = JavaLanguageVersion.of(21) }
}

repositories {
    mavenCentral()
}

// Keep in lockstep with the Keycloak image tag in ../Dockerfile / docker-compose.yml.
val keycloakVersion = "26.1.0"

dependencies {
    // Keycloak SPI — provided by the server at runtime (compileOnly: not bundled).
    compileOnly("org.keycloak:keycloak-server-spi:$keycloakVersion")
    compileOnly("org.keycloak:keycloak-server-spi-private:$keycloakVersion")
    compileOnly("org.keycloak:keycloak-services:$keycloakVersion")
    compileOnly("org.keycloak:keycloak-core:$keycloakVersion")
    compileOnly("jakarta.ws.rs:jakarta.ws.rs-api:3.1.0")

    // SIWE / EIP-4361 verification — bundled into providers/ (see copyProviderLibs).
    // Aggressively prune web3j's transitives we never touch (we only parse + ecrecover, never sign or
    // make RPC calls): the entire AWS SDK (web3j's KMS signing path) and the HTTP/RPC stack. This shrinks
    // the auth-image attack surface and the supply-chain set the PO wants pinned/verified.
    implementation("com.moonstoneid:siwe-java:1.0.8") {
        exclude(group = "software.amazon.awssdk")          // AWS KMS tx-signing — unused (verify-only)
        exclude(group = "com.squareup.okhttp3")            // web3j HTTP service — unused (no RPC here)
        exclude(group = "org.web3j", module = "okhttp")    // ditto, web3j's okhttp shim
    }
}

// Collect the runtime dependency JARs (siwe-java + transitives) for the Keycloak providers/ directory.
tasks.register<Copy>("copyProviderLibs") {
    from(configurations.runtimeClasspath)
    into(layout.buildDirectory.dir("providers-libs"))
}

tasks.named("build") {
    dependsOn("copyProviderLibs")
}

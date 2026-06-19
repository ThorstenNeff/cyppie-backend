package com.tneff.cyppie.backend.user

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import javax.sql.DataSource

/**
 * Postgres connectivity for the User-Service (PRD-08 §3). Optional: configured via env, absent in dev/
 * test → the service still boots and `/v1/me` falls back to echoing the verified token identity.
 */
class Db(val dataSource: DataSource) {

    /** Ordered schema migrations: version -> classpath SQL resource. Append-only. */
    private val migrations = listOf(1 to "db/migration/V1__init.sql")

    /**
     * Minimal, packaging-robust migration runner: records applied versions in `schema_version` and runs
     * each new migration in its own transaction. We read the SQL via getResourceAsStream (reliable in the
     * Ktor shadow/fat jar) instead of Flyway, whose classpath scanner mis-reads the merged resource names
     * inside that jar ("Unrecognised migration name format" for an otherwise-valid V1__init.sql).
     */
    fun migrate() {
        dataSource.connection.use { conn ->
            conn.createStatement().use {
                it.execute(
                    "CREATE TABLE IF NOT EXISTS schema_version (" +
                        "version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
                )
            }
            val applied = HashSet<Int>()
            conn.createStatement().use { st ->
                st.executeQuery("SELECT version FROM schema_version").use { rs ->
                    while (rs.next()) applied.add(rs.getInt(1))
                }
            }
            for ((version, resource) in migrations) {
                if (version in applied) continue
                val sql = readResource(resource)
                conn.autoCommit = false
                try {
                    conn.createStatement().use { it.execute(sql) }   // pg JDBC runs multi-statement SQL
                    conn.prepareStatement("INSERT INTO schema_version (version) VALUES (?)").use {
                        it.setInt(1, version)
                        it.executeUpdate()
                    }
                    conn.commit()
                } catch (e: Exception) {
                    conn.rollback()
                    throw e
                } finally {
                    conn.autoCommit = true
                }
            }
        }
    }

    fun healthy(): Boolean = runCatching {
        dataSource.connection.use { it.isValid(2) }
    }.getOrDefault(false)

    private fun readResource(path: String): String =
        javaClass.classLoader.getResourceAsStream(path)?.bufferedReader()?.use { it.readText() }
            ?: error("migration resource not found on classpath: $path")

    companion object {
        /** Build from CYPPIE_DB_URL / _USER / _PASSWORD; null when no DB is configured. */
        fun fromEnv(): Db? {
            val url = System.getenv("CYPPIE_DB_URL")?.takeIf { it.isNotBlank() } ?: return null
            val config = HikariConfig().apply {
                jdbcUrl = url
                username = System.getenv("CYPPIE_DB_USER")
                password = System.getenv("CYPPIE_DB_PASSWORD")
                maximumPoolSize = 5
                poolName = "cyppie-userservice"
            }
            return Db(HikariDataSource(config))
        }
    }
}

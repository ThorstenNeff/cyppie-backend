package com.tneff.cyppie.backend.user

import javax.sql.DataSource

/** A platform profile (PRD-08 §3). The wallet address is the identity (F1 SIWE); email/displayName are
 *  optional. No key material — Auth ≠ Custody. */
data class Profile(
    val id: String,                 // app_user UUID — the FK used by aa_session / dca_schedule
    val walletAddress: String,
    val keycloakSub: String?,
    val email: String?,
    val displayName: String?,
)

class ProfileRepository(private val dataSource: DataSource) {

    /**
     * Idempotently link the Keycloak subject to the wallet address on each sign-in and return the
     * profile (creating the row on first login). Keyed by the lowercase EVM address.
     */
    fun upsertAndGet(walletAddress: String, keycloakSub: String): Profile {
        val sql = """
            INSERT INTO app_user (wallet_address, keycloak_sub)
            VALUES (?, ?)
            ON CONFLICT (wallet_address)
            DO UPDATE SET keycloak_sub = EXCLUDED.keycloak_sub, updated_at = now()
            RETURNING id, wallet_address, keycloak_sub, email, display_name
        """.trimIndent()
        dataSource.connection.use { conn ->
            conn.prepareStatement(sql).use { ps ->
                ps.setString(1, walletAddress)
                ps.setString(2, keycloakSub)
                ps.executeQuery().use { rs ->
                    check(rs.next()) { "upsert returned no row for $walletAddress" }
                    return Profile(
                        id = rs.getString("id"),
                        walletAddress = rs.getString("wallet_address"),
                        keycloakSub = rs.getString("keycloak_sub"),
                        email = rs.getString("email"),
                        displayName = rs.getString("display_name"),
                    )
                }
            }
        }
    }
}

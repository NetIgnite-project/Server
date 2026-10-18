import { AbstractIDWithOwnerIDBasedTable } from "./base";
import { AgentSecrets } from "../../utils/auth/agentSecrets";

export namespace AgentsTable {

    export interface Model {
        id: number;
        name: string;
        type: Model.Type;
        description: string;
        /** SHA-256 hash of the agent secret (see `AgentSecrets`); the secret itself is never stored. */
        secretHash: string;
        ownerID: number;
    }

    export namespace Model {
        export type Type = "server" | "microcontroller";
    }

    export type ModelWithoutID = Omit<Model, "id">;

    /** The agent as returned by the API — without the secret hash. */
    export type PublicModel = Omit<Model, "secretHash">;

    /** Row layout in the database; the `secret` column holds the hash. */
    export interface StoredModel extends Omit<Model, "secretHash"> {
        secret: string;
    }
}

export class AgentsTable extends AbstractIDWithOwnerIDBasedTable<AgentsTable.Model, AgentsTable.StoredModel> {

    public readonly tableName = "agents";

    static toPublic(agent: AgentsTable.Model): AgentsTable.PublicModel {
        const { secretHash, ...publicAgent } = agent;
        return publicAgent;
    }

    protected decode = (row: AgentsTable.StoredModel | null): AgentsTable.Model | null => {
        if (!row) return null;
        return {
            id: row.id,
            name: row.name,
            type: row.type,
            description: row.description,
            secretHash: row.secret,
            ownerID: row.ownerID,
        };
    };

    public createTable() {
        return `
            CREATE TABLE IF NOT EXISTS agents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('server', 'microcontroller')),
                description TEXT NOT NULL,
                secret TEXT NOT NULL,
                ownerID INTEGER NOT NULL,
                FOREIGN KEY (ownerID) REFERENCES users(id)
            );
        `;
    }

    /**
     * Replaces secrets that older versions stored in plaintext with their hash. Agents keep
     * working with their existing secret.
     */
    async hashPlaintextSecrets() {
        const stmt = await this.db.execute(`SELECT id, secret FROM agents`);

        let migrated = 0;
        for (const row of stmt.rows as unknown as { id: number; secret: string }[]) {
            if (AgentSecrets.isHash(row.secret)) continue;

            await this.db.execute({
                sql: `UPDATE agents SET secret = ? WHERE id = ?`,
                args: [AgentSecrets.hash(row.secret), row.id]
            });
            migrated++;
        }
        return migrated;
    }

    /** Updates name, type and description. Returns false if the agent doesn't exist or isn't owned by `ownerID`. */
    async updateDetailsByOwner(agent: AgentsTable.PublicModel) {
        try {
            const stmt = await this.db.execute({
                sql: `
                    UPDATE agents
                    SET name = ?, type = ?, description = ?
                    WHERE id = ? AND ownerID = ?
                `,
                args: [agent.name, agent.type, agent.description, agent.id, agent.ownerID]
            });
            return stmt.rowsAffected > 0;
        } catch (error) {
            console.error("Error updating agent:", error);
            return null;
        }
    }

    /** Returns false if the agent doesn't exist or isn't owned by `ownerID`. */
    async updateSecretHashByOwner(id: number, ownerID: number, secretHash: string) {
        try {
            const stmt = await this.db.execute({
                sql: `UPDATE agents SET secret = ? WHERE id = ? AND ownerID = ?`,
                args: [secretHash, id, ownerID]
            });
            return stmt.rowsAffected > 0;
        } catch (error) {
            console.error("Error updating agent secret:", error);
            return null;
        }
    }

    async insert(agent: AgentsTable.ModelWithoutID) {
        try {
            if (!this.db) throw new Error("Database not initialized");

            const stmt = await this.db.execute({
                sql: `INSERT INTO agents (name, type, description, secret, ownerID) VALUES (?, ?, ?, ?, ?)`,
                args: [agent.name, agent.type, agent.description, agent.secretHash, agent.ownerID]
            });
            return Number(stmt.lastInsertRowid);
        } catch (error) {
            console.error("Error inserting agent:", error);
            return null;
        }
    }

}

import type { Client as DBClient } from "@libsql/core/api";

export abstract class AbstractDBTable<T extends Record<string, any>, TStored extends Record<string, any> = T> {

    abstract readonly tableName: string;

    constructor(
        protected readonly db: DBClient
    ) {}

    protected encode: (item: T) => TStored = (item: any) => item;
    protected decode: (item: TStored | null) => T | null = (item: any) => item;

    protected encodeMany(items: T[]) {
        const result: TStored[] = [];
        for (const item of items) {
            const encodedItem = this.encode(item);
            result.push(encodedItem);
        }
        return result;
    }
    protected decodeMany(items: TStored[]) {
        const result: T[] = [];
        for (const item of items) {
            const decodedItem = this.decode(item);
            if (!decodedItem) return null;
            result.push(decodedItem);
        }
        return result;
    }

    abstract createTable(): string;

    async getAll() {
        try {
            const stmt = await this.db.execute(`SELECT * FROM ${this.tableName}`);
            return this.decodeMany(stmt.rows as any);
        } catch (error) {
            console.error(`Error getting all from table ${this.tableName}:`, error);
            return null;
        }
    }

    abstract insert(item: T): Promise<number | null>;

}

export abstract class AbstractIDBasedTable<T extends Record<string, any>, TStored extends Record<string, any> = T> extends AbstractDBTable<T, TStored> {

    async getByID(id: number) {
        try {
            const stmt = await this.db.execute({
                sql: `SELECT * FROM ${this.tableName} WHERE id = ?`,
                args: [id]
            });
            return this.decode(stmt.rows[0] as any || null);
        } catch (error) {
            console.error(`Error getting by ID from table ${this.tableName}:`, error);
            return null;
        }
    }

    async deleteByID(id: number) {
        try {
            await this.db.execute({
                sql: `DELETE FROM ${this.tableName} WHERE id = ?`,
                args: [id]
            });
            return true;
        } catch (error) {
            console.error(`Error deleting by ID from table ${this.tableName}:`, error);
            return null;
        }
    }

}

export abstract class AbstractTokenBasedTable<T extends Record<string, any>, TStored extends Record<string, any> = T> extends AbstractDBTable<T, TStored> {

    async getByToken(token: string) {
        try {
            const stmt = await this.db.execute({
                sql: `SELECT * FROM ${this.tableName} WHERE token = ?`,
                args: [token]
            })
            return this.decode(stmt.rows[0] as any || null);
        } catch (error) {
            console.error(`Error getting by token from table ${this.tableName}:`, error);
            return null;
        }

    }

    async deleteByToken(token: string) {
        try {
            const stmt = await this.db.execute({
                sql: `DELETE FROM ${this.tableName} WHERE token = ?`,
                args: [token]
            });
            return true;
        } catch (error) {
            console.error(`Error deleting by token from table ${this.tableName}:`, error);
            return false;
        }
    }
}

export abstract class AbstractIDWithOwnerIDBasedTable<T extends Record<string, any>, TStored extends Record<string, any> = T> extends AbstractIDBasedTable<T, TStored> {

    async getByIDAndOwnerID(id: number, ownerID: number) {
        try {
            const stmt = await this.db.execute({
                sql: `SELECT * FROM ${this.tableName} WHERE id = ? AND ownerID = ?`,
                args: [id, ownerID]
            });
            return this.decode(stmt.rows[0] as any || null);
        } catch (error) {
            console.error(`Error getting by ID and owner ID from table ${this.tableName}:`, error);
            return null;
        }
    }

    async getAllByOwnerID(ownerID: number) {
        try {
            const stmt = await this.db.execute({
                sql: `SELECT * FROM ${this.tableName} WHERE ownerID = ?`,
                args: [ownerID]
            });
            return this.decodeMany(stmt.rows as any);
        } catch (error) {
            console.error(`Error getting all by owner ID from table ${this.tableName}:`, error);
            return null;
        }
    }

}

export namespace AbstractDBTable {

    export type ModelWithoutID<T extends Record<string, any>> = Omit<T, 'id'>;

}
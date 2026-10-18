import { createClient as createDBClient } from "@libsql/client";
import { Client as DBClient } from "@libsql/core/api";
import fs from "fs";
import { UsersTable } from "./models/users";
import { PasswordResetsTable } from "./models/password_resets";
import { AgentsTable } from "./models/agents";
import { DevicesTable } from "./models/devices";
import { AbstractDBTable } from "./models/base";

export class DBStorage {

    private static db: DBClient | null = null;

    private static readonly tables: Record<string, AbstractDBTable<any>> = {};

    private constructor() {}

    static async init() {
        if (this.db) return this.db;

        if (!fs.existsSync("./data")) {
            fs.mkdirSync("./data", { recursive: true });
        }

        this.db = createDBClient({
            url: "file:./data/db.sqlite"
        });

        await this.setup();
    }

    private static async setup() {    
        if (!this.db) throw new Error("Database not initialized");

        try {
            
            this.tables["users"] = new UsersTable(this.db);
            this.tables["password_resets"] = new PasswordResetsTable(this.db);
            this.tables["agents"] = new AgentsTable(this.db);
            this.tables["devices"] = new DevicesTable(this.db);

            // Initialize all tables
            for (const table of Object.values(this.tables)) {
                await this.db.execute(table.createTable());
            }

            const migratedSecrets = await this.Agents.hashPlaintextSecrets();
            if (migratedSecrets > 0) {
                console.log(`Hashed ${migratedSecrets} agent secret(s) stored in plaintext.`);
            }

            console.log("Database tables initialized successfully.");

        } catch (error) {
            console.error("Error setting up database tables:", error);
        }

    }

    static get Users() {
        return this.tables["users"] as DBStorage.User;
    }
    static get PasswordResets() {
        return this.tables["password_resets"] as DBStorage.PasswordReset;
    }
    static get Agents() {
        return this.tables["agents"] as DBStorage.Agent;
    }
    static get Devices() {
        return this.tables["devices"] as DBStorage.Device;
    }

}

export namespace DBStorage {

    // export interface IConfig {
    //     host: string;
    //     port: number;
    //     user: string;
    //     password: string;
    //     database: string;
    // }

    // export type ByIDTable = "agents" | "devices" | "users";
    // export type ByTokenTable = /*"sessions"*/ | "password_resets";
    // export type Table = ByIDTable | ByTokenTable;

    export import User = UsersTable;
    export import PasswordReset = PasswordResetsTable;
    export import Agent = AgentsTable;
    export import Device = DevicesTable;
    // export type Session = SessionsTable;


    export type ModelWithoutID<T> = Omit<T, "id">;

}
import Dexie, { Table } from "dexie";

export interface DiffEntity {
  id: string;
  description: string;
  diff: string;
  url: string;
  fetchedAt: number;
  summaryDeveloper?: string;
  summaryMarketing?: string;
  summaryUpdatedAt?: number;
}

class DiffDigestDB extends Dexie {
  diffs!: Table<DiffEntity, string>;

  constructor() {
    super("DiffDigestDB");
    this.version(1).stores({
      diffs: "id, fetchedAt",
    });
  }
}

export const db = new DiffDigestDB();

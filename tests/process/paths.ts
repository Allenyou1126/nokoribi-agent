import { readdir } from "node:fs/promises";
import { join } from "node:path";

export { join };

export async function findSessionFiles(home: string): Promise<string[]> {
    const root = join(home, "sessions");
    const found: string[] = [];
    async function walk(dir: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.name.endsWith(".jsonl")) found.push(path);
        }
    }
    await walk(root);
    return found;
}

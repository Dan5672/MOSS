// Fresh database for every e2e run: migrate and truncate everything.
import { createTestDb } from "@moss/db/testing";

export default async function globalSetup() {
  const { close } = await createTestDb("web_e2e");
  await close();
}

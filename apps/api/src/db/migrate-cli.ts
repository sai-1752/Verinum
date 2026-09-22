import { appFile } from "../paths";
import { migrate } from "./migrate";
import { ownerUrl } from "./owner-url";

const applied = await migrate(ownerUrl(), appFile("migrations"), (m) => console.log(m));
console.log(applied.length ? `Applied ${applied.length} migration(s).` : "Database is up to date.");

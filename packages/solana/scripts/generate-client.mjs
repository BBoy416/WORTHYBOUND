// Regenerates src/generated from the committed IDL (idl/worthybound.json).
// Refresh the IDL after changing the program: `anchor idl build -o packages/solana/idl/worthybound.json`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { createFromRoot } from "codama";

const idl = JSON.parse(readFileSync(new URL("../idl/worthybound.json", import.meta.url), "utf8"));
const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(
  renderVisitor(fileURLToPath(new URL("..", import.meta.url)), {
    generatedFolder: "src/generated",
    deleteFolderBeforeRendering: true,
    syncPackageJson: false,
    importExtension: "js",
    erasableSyntax: true,
    kitImportStrategy: "rootOnly",
  }),
);

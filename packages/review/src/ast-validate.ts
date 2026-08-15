/**
 * ast-validate.ts -- AST symbol validation for the M5 "code diagrams" gate.
 *
 * docs/03-architecture.md's "Review and teach" section, point 6:
 *   "Code diagrams -- on demand only, explicitly labelled static
 *   approximations."
 *
 * The acceptance bar for this mechanism (see the M5 milestone brief): "A
 * code diagram citing a symbol absent from the AST fails the build." This
 * module is the real, load-bearing check behind that claim -- it parses the
 * ACTUAL TypeScript AST (via `ts.createSourceFile`) rather than grepping for
 * symbol names, so a diagram can't accidentally "pass" by citing text that
 * merely appears somewhere in a comment or string literal.
 */

import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Parses a real TypeScript source file and returns every top-level-ish
 * declared symbol name: function/class/interface/type-alias/enum
 * declarations, top-level const/let/var declarations, and class/interface
 * method + property names. Best-effort but real -- walks the actual AST,
 * not a regex.
 */
export function extractDeclaredSymbols(filePath: string, sourceText: string): Set<string> {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const symbols = new Set<string>();

  function addMemberNames(members: ts.NodeArray<ts.ClassElement | ts.TypeElement>): void {
    for (const member of members) {
      if (
        (ts.isMethodDeclaration(member) ||
          ts.isPropertyDeclaration(member) ||
          ts.isMethodSignature(member) ||
          ts.isPropertySignature(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)) &&
        member.name &&
        ts.isIdentifier(member.name)
      ) {
        symbols.add(member.name.text);
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.add(node.name.text);
    } else if (ts.isClassDeclaration(node) && node.name) {
      symbols.add(node.name.text);
      addMemberNames(node.members);
    } else if (ts.isInterfaceDeclaration(node)) {
      symbols.add(node.name.text);
      addMemberNames(node.members);
    } else if (ts.isTypeAliasDeclaration(node)) {
      symbols.add(node.name.text);
    } else if (ts.isEnumDeclaration(node)) {
      symbols.add(node.name.text);
      for (const member of node.members) {
        if (ts.isIdentifier(member.name)) symbols.add(member.name.text);
      }
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) symbols.add(decl.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return symbols;
}

export interface DiagramSpec {
  /** What a "code diagram" cites: a source file (relative to some root) plus a list of symbol names it claims exist in that file. */
  file: string;
  symbols: string[];
  /** Free-form diagram content/description -- not itself validated, just carried through. */
  title: string;
  description: string;
}

export interface ValidationResult {
  file: string;
  valid: boolean;
  missingSymbols: string[]; // symbols cited that are NOT in the real AST
}

/**
 * Validates one DiagramSpec's cited symbols against the REAL parsed AST of
 * `path.join(repoRoot, spec.file)`. Throws (does not just return invalid)
 * if the file itself does not exist on disk -- a diagram citing a
 * nonexistent file is exactly the same class of failure as citing a
 * nonexistent symbol, and both must be fail-closed at build time.
 */
export function validateDiagramSpec(repoRoot: string, spec: DiagramSpec): ValidationResult {
  const fullPath = path.join(repoRoot, spec.file);
  if (!existsSync(fullPath)) {
    throw new Error(`validateDiagramSpec: cited file does not exist on disk: ${spec.file}`);
  }
  const sourceText = readFileSync(fullPath, "utf8");
  const declared = extractDeclaredSymbols(fullPath, sourceText);

  const missingSymbols = spec.symbols.filter((s) => !declared.has(s));
  return {
    file: spec.file,
    valid: missingSymbols.length === 0,
    missingSymbols,
  };
}

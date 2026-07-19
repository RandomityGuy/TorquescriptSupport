import type { AstNode, AstNodeDescription, CstNode, LangiumDocument, LocalSymbols } from 'langium';
import { AstUtils, DefaultNameProvider, DefaultScopeComputation, EMPTY_STREAM, GrammarUtils } from 'langium';
import {
    isConsoleApiModel, isDatablockStmt, isFnDecl, isObjectDecl, isPackageDecl, isStart
} from './generated/ast.js';
import { getObjectBareword } from './torquescript-expr-utils.js';

/**
 * Exports FnDecl, ConsoleClassDecl, and named object declarations (ObjectDecl/DatablockStmt) to
 * the global index.
 *
 * FnDecl/ConsoleClassDecl only ever occur at a few fixed, shallow positions, so those are found
 * with a cheap direct walk. Named objects (needed for the `%v = new X(SomeBareword)` /
 * `SomeBareword.method()` type-inference case) can occur anywhere an ObjectDecl can - including
 * deep inside .gui files' nested object trees - so finding them genuinely requires a full
 * `streamAllContents` walk. That's an inherent cost of the feature (there is no shortcut for
 * "a named object might be anywhere"), not an oversight - see the earlier indexing-performance
 * work for why the shallow walk was worth keeping for the other two types.
 */
export class TorquescriptScopeComputation extends DefaultScopeComputation {

    override async collectExportedSymbols(document: LangiumDocument): Promise<AstNodeDescription[]> {
        const exports: AstNodeDescription[] = [];
        const root = document.parseResult.value;

        if (isConsoleApiModel(root)) {
            for (const classDecl of root.classes) {
                this.addExportedSymbol(classDecl, exports, document);
            }
            for (const fnDecl of root.functions) {
                this.addExportedSymbol(fnDecl, exports, document);
            }
            return exports;
        }

        if (isStart(root)) {
            for (const decl of root.decls) {
                if (isFnDecl(decl)) {
                    this.addExportedSymbol(decl, exports, document);
                } else if (isPackageDecl(decl)) {
                    for (const fnDecl of decl.functions) {
                        this.addExportedSymbol(fnDecl, exports, document);
                    }
                }
            }
            for (const node of AstUtils.streamAllContents(root)) {
                if (isDatablockStmt(node)) {
                    this.addExportedSymbol(node, exports, document);
                } else if (isObjectDecl(node)) {
                    const bareword = getObjectBareword(node);
                    if (bareword) {
                        exports.push(this.descriptions.createDescription(node, bareword, document));
                    }
                }
            }
        }

        return exports;
    }

    /**
     * None of this language's cross-references (calledFunction, classname, parentClass) use
     * lexical/local scoping - they all resolve purely against the global index - so the default
     * implementation's full-document tree walk to build per-container local symbol tables is
     * entirely wasted work here. Skip it.
     */
    override async collectLocalSymbols(): Promise<LocalSymbols> {
        return {
            has: () => false,
            getStream: () => EMPTY_STREAM
        };
    }
}

/**
 * Gives FnDecl nodes a composite `Namespace::function` name when a classname/namespace is
 * present, matching the text captured by the `QualifiedName` cross-reference datatype rule so
 * that `Namespace::func()` calls resolve against the right FnDecl. Also gives named ObjectDecls
 * (`new X(SomeBareword)`) a name/name-node - without this, ObjectDecl has no property literally
 * called `name` (it's `objectName`), so document symbols (and anything else relying on
 * NameProvider) would never surface named objects at all - a real gap for `.gui` files, which are
 * almost entirely named-object trees.
 */
export class TorquescriptNameProvider extends DefaultNameProvider {

    override getName(node: AstNode): string | undefined {
        if (isFnDecl(node)) {
            return node.classname ? `${node.classname}::${node.name}` : node.name;
        }
        if (isObjectDecl(node)) {
            return getObjectBareword(node);
        }
        return super.getName(node);
    }

    override getNameNode(node: AstNode): CstNode | undefined {
        if (isObjectDecl(node) && getObjectBareword(node)) {
            return GrammarUtils.findNodeForProperty(node.$cstNode, 'objectName');
        }
        return super.getNameNode(node);
    }
}

